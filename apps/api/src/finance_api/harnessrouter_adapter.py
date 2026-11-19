"""Server-only HarnessRouter Cloud adapter (UHP-Version 2026-09-28).

Adapted from the official HarnessRouter Python server template:
- Calls `https://api.harnessrouter.ai` with `follow_redirects=False` so `HR_API_KEY` never follows
  a redirect to another origin.
- Parses SSE frames, extracts terminal answer text and produced file citations, forwards sanitized
  progress events, polls for stream recovery, and verifies signed sandboxed HTML preview tokens.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
import urllib.parse
import uuid
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import httpx

API_BASE = "https://api.harnessrouter.ai"
UHP_VERSION = "2026-09-28"
TERMINAL_STATUSES = frozenset({"completed", "incomplete", "failed", "cancelled"})
TERMINAL_EVENTS = frozenset({"response.completed", "response.incomplete", "response.failed"})

Json = dict[str, Any]


class HRError(Exception):
    """Non-2xx answer from HarnessRouter Cloud."""

    def __init__(
        self,
        status_code: int,
        body: Any = None,
        retry_after: str | None = None,
    ) -> None:
        env: dict[str, Any] = body if isinstance(body, dict) else {}
        raw_err = env.get("error")
        err: dict[str, Any] = raw_err if isinstance(raw_err, dict) else {}
        detail = env.get("detail") if isinstance(env.get("detail"), str) else ""
        self.status = status_code
        self.code = str(err.get("code") or ("not_found" if status_code == 404 else "unknown"))
        self.type = str(err.get("type") or "")
        self.param = err.get("param")
        self.message = str(err.get("message") or detail or f"HTTP {status_code}")
        try:
            self.retry_after_seconds: float | None = float(retry_after) if retry_after else None
        except ValueError:
            self.retry_after_seconds = None
        super().__init__(self.message)

    @property
    def retryable(self) -> bool:
        return self.status in (429, 502, 503, 504)


def load_api_key(project_root: str = ".") -> str:
    """Load `HR_API_KEY` (falling back to `HARNESSROUTER_API_KEY` or `.env.harnessrouter`)."""
    for var_name in ("HR_API_KEY", "HARNESSROUTER_API_KEY"):
        val = os.environ.get(var_name, "").strip()
        if val and val != "unconfigured-replace-in-secret-manager":
            return val
    env_file = Path(project_root) / ".env.harnessrouter"
    if not env_file.is_file():
        raise ValueError("HR_API_KEY is not configured in the backend environment")
    lines = [line for line in env_file.read_text(encoding="utf-8").splitlines() if line.strip()]
    if len(lines) != 1 or not lines[0].startswith("HR_API_KEY="):
        raise ValueError(".env.harnessrouter must hold exactly one HR_API_KEY line")
    return lines[0][len("HR_API_KEY=") :].strip()


def parse_sse(lines: Iterable[bytes | str]) -> Iterator[Json]:
    """Split SSE frames on blank lines, join `data:` lines, and yield parsed JSON events."""
    data: list[str] = []

    def flush() -> Json | None:
        payload = "\n".join(data).strip()
        data.clear()
        if not payload or payload == "[DONE]":
            return None
        try:
            ev = json.loads(payload)
        except json.JSONDecodeError:
            return None
        return ev if isinstance(ev, dict) and isinstance(ev.get("type"), str) else None

    for raw in lines:
        line = (
            raw.decode("utf-8", "replace").rstrip("\r\n")
            if isinstance(raw, bytes)
            else str(raw).rstrip("\r\n")
        )
        if line == "":
            ev = flush()
            if ev is not None:
                yield ev
        elif line.startswith("data:"):
            rest = line[5:]
            data.append(rest[1:] if rest.startswith(" ") else rest)
    tail = flush()
    if tail is not None:
        yield tail


def answer_text(resp_obj: Json) -> str:
    """Return `output_text` of the last `message` item in `output`."""
    msgs = [
        item
        for item in (resp_obj.get("output") or [])
        if isinstance(item, dict) and item.get("type") == "message"
    ]
    if not msgs:
        return ""
    return "".join(
        str(part.get("text") or "")
        for part in (msgs[-1].get("content") or [])
        if isinstance(part, dict) and part.get("type") == "output_text"
    )


def produced_files(resp_obj: Json) -> list[Json]:
    """Return `container_file_citation` annotations from message items."""
    out: list[Json] = []
    for item in resp_obj.get("output") or []:
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        for part in item.get("content") or []:
            if not isinstance(part, dict):
                continue
            for ann in part.get("annotations") or []:
                if isinstance(ann, dict) and ann.get("type") == "container_file_citation":
                    out.append(ann)
    return out


_UPSTREAM_ERR_RE = re.compile(r"model provider refused|\(request id:", re.IGNORECASE)


def to_progress(ev: Json) -> Json | None:
    """Convert an upstream SSE event into a sanitized progress frame safe for browsers."""
    ev_type = ev.get("type")
    if ev_type == "response.output_text.delta" and isinstance(ev.get("delta"), str):
        if _UPSTREAM_ERR_RE.search(ev["delta"]):
            return None
        return {"kind": "text", "delta": ev["delta"]}
    item = ev.get("item")
    if ev_type == "response.output_item.added" and isinstance(item, dict):
        if item.get("type") == "function_call":
            fn_name = str(item.get("name") or "").lower()
            if re.search(r"write|edit|patch", fn_name):
                label = "Writing files"
            elif re.search(r"read|grep|glob|ls", fn_name):
                label = "Reading files"
            elif re.search(r"bash|shell|exec|terminal|python", fn_name):
                label = "Running isolated verification step"
            elif re.search(r"search|fetch|browse|web|http", fn_name):
                label = "Checking authoritative public sources"
            else:
                label = "Verifying instruments"
            return {"kind": "activity", "label": label}
    if ev_type in TERMINAL_EVENTS:
        resp_obj = ev.get("response")
        terminal_status = (
            str(resp_obj.get("status") or "failed") if isinstance(resp_obj, dict) else "failed"
        )
        return {"kind": "done", "status": terminal_status}
    return None


class HarnessRouter:
    """Server-side client for HarnessRouter Cloud (`follow_redirects=False` enforced)."""

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str = API_BASE,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._key = api_key if api_key is not None else load_api_key()
        self.base_url = base_url.rstrip("/")
        self._transport = transport
        self._sleep = sleep

    def _client(self, timeout_s: float = 60.0) -> httpx.Client:
        return httpx.Client(
            base_url=self.base_url,
            follow_redirects=False,
            timeout=httpx.Timeout(timeout_s, connect=20.0),
            transport=self._transport,
        )

    def _base_headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self._key}",
            "UHP-Version": UHP_VERSION,
            "Accept": "application/json",
        }
        if extra:
            headers.update(extra)
        return headers

    def _raise_for_error(self, resp: httpx.Response) -> None:
        if 200 <= resp.status_code < 300:
            return
        if 300 <= resp.status_code < 400:
            raise HRError(
                502,
                {"error": {"code": "redirect_refused", "message": "Refused upstream redirect"}},
            )
        try:
            parsed = resp.json()
        except ValueError:
            parsed = None
        raise HRError(resp.status_code, parsed, resp.headers.get("Retry-After"))

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        headers: dict[str, str] | None = None,
        timeout: float = 60.0,
    ) -> Any:
        with self._client(timeout) as client:
            resp = client.request(
                method,
                path,
                json=body,
                headers=self._base_headers(headers),
            )
            self._raise_for_error(resp)
            if not resp.content:
                return None
            return resp.json()

    def bases(self) -> Json:
        res: Json = self.request("GET", "/v1/bases")
        return res

    def me(self) -> Json:
        res: Json = self.request("GET", "/v1/me")
        return res

    def get_harness(self, harness_id: str) -> tuple[Json, str | None]:
        quoted = urllib.parse.quote(harness_id, safe="")
        with self._client(60.0) as client:
            resp = client.get(f"/v1/harnesses/{quoted}", headers=self._base_headers())
            self._raise_for_error(resp)
            return resp.json(), resp.headers.get("ETag")

    def replace_harness(self, harness_id: str, body: Json, etag: str | None = None) -> Json:
        quoted = urllib.parse.quote(harness_id, safe="")
        extra = {"If-Match": etag} if etag else None
        res: Json = self.request("PUT", f"/v1/harnesses/{quoted}", body, extra)
        return res

    @staticmethod
    def task_body(
        harness_id: str,
        user_input: Any,
        mode: str,
        previous_response_id: str | None = None,
        session_id: str | None = None,
        user: str | None = None,
        **budgets: Any,
    ) -> Json:
        meta: dict[str, str] = {"harness_id": harness_id}
        if session_id:
            meta["session_id"] = session_id
        body: Json = {"input": user_input, "metadata": meta}
        if user:
            body["user"] = user
        if previous_response_id:
            body["previous_response_id"] = previous_response_id
        for key in ("max_step", "timeout_seconds", "max_cost_usd", "model"):
            if budgets.get(key) is not None:
                body[key] = budgets[key]
        if mode == "stream":
            body["stream"] = True
        elif mode == "background":
            body["background"] = True
        return body

    def run_streamed(
        self,
        harness_id: str,
        user_input: Any,
        *,
        previous_response_id: str | None = None,
        session_id: str | None = None,
        idempotency_key: str | None = None,
        user: str | None = None,
        on_ids: Callable[[str, str], None] | None = None,
        on_event: Callable[[Json], None] | None = None,
        **budgets: Any,
    ) -> Json:
        body = self.task_body(
            harness_id,
            user_input,
            "stream",
            previous_response_id,
            session_id,
            user,
            **budgets,
        )
        timeout_budget = float(budgets.get("timeout_seconds") or 7200) + 300.0
        req_headers = self._base_headers(
            {
                "Accept": "text/event-stream",
                "Idempotency-Key": idempotency_key or str(uuid.uuid4()),
            }
        )
        response_id = ""
        sid = ""
        terminal: Json | None = None

        for attempt in range(4):
            try:
                with (
                    self._client(timeout_budget) as client,
                    client.stream("POST", "/v1/responses", json=body, headers=req_headers) as resp,
                ):
                    if not (200 <= resp.status_code < 300):
                        resp.read()
                        self._raise_for_error(resp)
                    for ev in parse_sse(resp.iter_lines()):
                        r = ev.get("response")
                        if isinstance(r, dict):
                            rid = r.get("id")
                            if isinstance(rid, str) and rid and not response_id:
                                response_id = rid
                            rmeta = r.get("metadata")
                            s_val = rmeta.get("session_id") if isinstance(rmeta, dict) else None
                            if isinstance(s_val, str) and s_val and not sid:
                                sid = s_val
                                if on_ids and response_id:
                                    on_ids(response_id, sid)
                            if ev.get("type") in TERMINAL_EVENTS:
                                terminal = r
                        if on_event:
                            on_event(ev)
                break
            except HRError as err:
                if response_id or not err.retryable or attempt == 3:
                    raise
                delay = min(max(err.retry_after_seconds or (3.0 * (attempt + 1)), 1.0), 30.0)
                self._sleep(delay)
            except httpx.HTTPError:
                if response_id:
                    break
                if attempt == 3:
                    raise
                self._sleep(3.0 * (attempt + 1))

        if terminal is not None:
            return terminal
        if not response_id:
            raise HRError(
                502,
                {
                    "error": {
                        "code": "stream_ended",
                        "message": "The stream ended before the task started.",
                    }
                },
            )
        return self.wait_for_response(response_id)

    def start_background(
        self,
        harness_id: str,
        user_input: Any,
        *,
        idempotency_key: str | None = None,
        **kw: Any,
    ) -> Json:
        body = self.task_body(harness_id, user_input, "background", **kw)
        res: Json = self.request(
            "POST",
            "/v1/responses",
            body,
            {"Idempotency-Key": idempotency_key or str(uuid.uuid4())},
        )
        return res

    def get_response(self, response_id: str) -> Json:
        quoted = urllib.parse.quote(response_id, safe="")
        res: Json = self.request("GET", f"/v1/responses/{quoted}")
        return res

    def wait_for_response(self, response_id: str, timeout_s: float = 7260.0) -> Json:
        start = time.monotonic()
        while True:
            try:
                resp = self.get_response(response_id)
                if resp.get("status") in TERMINAL_STATUSES:
                    return resp
            except HRError as err:
                if not err.retryable:
                    raise
            elapsed = time.monotonic() - start
            if elapsed > timeout_s:
                raise HRError(
                    504,
                    {
                        "error": {
                            "code": "poll_timeout",
                            "message": "The task did not finish in time.",
                        }
                    },
                )
            self._sleep(10.0 if elapsed > 60 else 3.0)

    def cancel_response(self, response_id: str) -> Json:
        quoted = urllib.parse.quote(response_id, safe="")
        res: Json = self.request("POST", f"/v1/responses/{quoted}/cancel", {})
        return res

    def list_files(self, session_id: str, changed: bool = False) -> list[Json]:
        quoted = urllib.parse.quote(session_id, safe="")
        suffix = "?changed=true" if changed else ""
        res = self.request("GET", f"/v1/sessions/{quoted}/files{suffix}")
        files = res.get("files") if isinstance(res, dict) else None
        return [item for item in (files or []) if isinstance(item, dict)]

    def fetch_file(self, session_id: str, file_id: str, view: str = "content") -> tuple[bytes, str]:
        s_quoted = urllib.parse.quote(session_id, safe="")
        f_quoted = urllib.parse.quote(file_id, safe="")
        v_quoted = urllib.parse.quote(view, safe="")
        path = f"/v1/containers/{s_quoted}/files/{f_quoted}/{v_quoted}"
        with self._client(60.0) as client:
            resp = client.get(path, headers=self._base_headers({"Accept": "*/*"}))
            self._raise_for_error(resp)
            ctype = resp.headers.get("Content-Type") or "application/octet-stream"
            return resp.content, ctype


@dataclass
class TaskRecord:
    task_id: str
    user_id: str
    harness_id: str
    idempotency_key: str
    status: str = "starting"
    response_id: str = ""
    session_id: str = ""
    answer: str = ""
    files: list[Json] = field(default_factory=list)
    incomplete_reason: str = ""
    updated_at: float = 0.0


class MemoryTaskStore:
    """In-memory store for isolated unit tests."""

    def __init__(self) -> None:
        self._m: dict[str, TaskRecord] = {}
        self._lock = threading.Lock()

    def get(self, task_id: str) -> TaskRecord | None:
        with self._lock:
            rec = self._m.get(task_id)
            return replace(rec) if rec else None

    def put(self, rec: TaskRecord) -> None:
        with self._lock:
            self._m[rec.task_id] = replace(rec)


_listeners: dict[str, list[Callable[[Json], None]]] = {}
_listeners_lock = threading.Lock()


def subscribe(task_id: str, fn: Callable[[Json], None]) -> Callable[[], None]:
    with _listeners_lock:
        _listeners.setdefault(task_id, []).append(fn)

    def leave() -> None:
        with _listeners_lock:
            fns = _listeners.get(task_id, [])
            if fn in fns:
                fns.remove(fn)
            if not fns:
                _listeners.pop(task_id, None)

    return leave


def publish_progress(task_id: str, payload: Json) -> None:
    with _listeners_lock:
        fns = list(_listeners.get(task_id, []))
    for fn in fns:
        try:
            fn(payload)
        except Exception:  # noqa: S110
            pass


_process_secret = secrets.token_bytes(32)


def preview_secret(fallback_key: str | None = None) -> bytes:
    raw = os.environ.get("PREVIEW_SIGNING_SECRET", "").strip()
    if raw:
        if re.fullmatch(r"[0-9a-fA-F]{64}", raw):
            return bytes.fromhex(raw)
        return base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
    if fallback_key:
        return hashlib.sha256(fallback_key.encode("utf-8")).digest()
    return _process_secret


def _mac(signing_key: bytes, msg: str) -> str:
    digest = hmac.new(signing_key, msg.encode("utf-8"), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def sign_preview(
    subject_token: str,
    signing_key: bytes | None = None,
    ttl_seconds: int = 3600,
    now: float | None = None,
) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,512}", subject_token):
        raise ValueError("subject_token must match [A-Za-z0-9_-]")
    exp = int(now if now is not None else time.time()) + ttl_seconds
    key = signing_key or preview_secret()
    return f"{subject_token}.{exp}.{_mac(key, f'{subject_token}.{exp}')}"


def verify_preview(
    token: str,
    signing_key: bytes | None = None,
    now: float | None = None,
) -> str | None:
    match = re.fullmatch(r"([A-Za-z0-9_-]{1,512})\.(\d{1,12})\.([A-Za-z0-9_-]{43})", token or "")
    if not match:
        return None
    subject_token, exp, sig = match.groups()
    if int(exp) < (now if now is not None else time.time()):
        return None
    key = signing_key or preview_secret()
    want = _mac(key, f"{subject_token}.{exp}")
    return subject_token if hmac.compare_digest(want, sig) else None


PREVIEW_TYPES: dict[str, str] = {
    "html": "text/html; charset=utf-8",
    "htm": "text/html; charset=utf-8",
    "css": "text/css; charset=utf-8",
    "js": "text/javascript; charset=utf-8",
    "mjs": "text/javascript; charset=utf-8",
    "json": "application/json",
    "txt": "text/plain; charset=utf-8",
    "md": "text/plain; charset=utf-8",
    "svg": "image/svg+xml",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "ico": "image/x-icon",
    "woff": "font/woff",
    "woff2": "font/woff2",
    "ttf": "font/ttf",
    "otf": "font/otf",
}

PREVIEW_HEADERS: dict[str, str] = {
    "Content-Security-Policy": (
        "sandbox allow-scripts allow-forms; default-src 'self' data: blob:; "
        "script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' data: https://fonts.gstatic.com; "
        "img-src 'self' data: blob:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'"
    ),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "private, no-store",
}

_NOT_FOUND: tuple[int, dict[str, str], bytes] = (
    404,
    {"Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store"},
    b"Not found",
)


def safe_rel_path(raw_path: str) -> str | None:
    unquoted = urllib.parse.unquote(raw_path or "")
    if not unquoted or "\\" in unquoted or "\0" in unquoted or unquoted.startswith("/"):
        return None
    parts = unquoted.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return None
    return "/".join(parts)


def preview_file(
    hr: HarnessRouter, session_id: str, root: str, rel_path: str
) -> tuple[int, dict[str, str], bytes]:
    rel = safe_rel_path(rel_path or "index.html")
    if not rel:
        return _NOT_FOUND
    ext = rel.rsplit(".", 1)[-1].lower() if "." in rel else ""
    ctype = PREVIEW_TYPES.get(ext)
    if not ctype:
        return _NOT_FOUND
    want = f"{root.rstrip('/')}/{rel}" if root else rel
    found = next(
        (item for item in hr.list_files(session_id) if item.get("path") == want),
        None,
    )
    if not found or not isinstance(found.get("id"), str):
        return _NOT_FOUND
    body, _ = hr.fetch_file(session_id, found["id"])
    return 200, {**PREVIEW_HEADERS, "Content-Type": ctype}, body


def download_file(
    hr: HarnessRouter, session_id: str, path: str
) -> tuple[int, dict[str, str], bytes]:
    rel = safe_rel_path(path)
    if not rel:
        return _NOT_FOUND
    found = next(
        (item for item in hr.list_files(session_id) if item.get("path") == rel),
        None,
    )
    if not found or not isinstance(found.get("id"), str):
        return _NOT_FOUND
    body, ctype = hr.fetch_file(session_id, found["id"])
    safe_name = re.sub(r'["\r\n\\]', "_", str(found.get("filename") or "download"))
    headers = {
        "Content-Type": ctype,
        "Content-Disposition": f'attachment; filename="{safe_name}"',
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
    }
    return 200, headers, body
