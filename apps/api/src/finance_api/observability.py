"""Structured Cloud Logging, correlation IDs, and secret redaction."""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import time
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from starlette.types import ASGIApp, Message, Receive, Scope, Send

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
task_id_var: ContextVar[str | None] = ContextVar("task_id", default=None)
cycle_id_var: ContextVar[str | None] = ContextVar("cycle_id", default=None)
trace_id_var: ContextVar[str | None] = ContextVar("trace_id", default=None)

_SAFE_ID = re.compile(r"^[A-Za-z0-9._:/-]{1,128}$")

_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+"), "Bearer [REDACTED]"),
    (re.compile(r"\bsk-(?:hr-)?[A-Za-z0-9_-]{12,}"), "sk-[REDACTED]"),
    (re.compile(r"\baccess-sandbox-[A-Za-z0-9_-]+"), "access-sandbox-[REDACTED]"),
    (re.compile(r"\bpublic-sandbox-[A-Za-z0-9_-]+"), "public-sandbox-[REDACTED]"),
    (
        re.compile(r"postgres(?:ql)?://[^:/@\s]+:[^@\s]+@"),
        "postgresql://[REDACTED]@",
    ),
    (
        re.compile(
            r"(?i)(plaid_secret|secret_box_key|worker_token|alpaca_secret_key|"
            r"apca-api-secret-key|harnessrouter_api_key|tokenrouter_api_key|"
            r"access_token|paper_key|private_key)(\s*[\"']?\s*[:=]\s*[\"']?)([^\s\"',}&]+)"
        ),
        r"\1\2[REDACTED]",
    ),
)

_literal_secrets: set[str] = set()


def register_secret_for_redaction(*values: str | None) -> None:
    """Register runtime secret values so they are scrubbed if ever logged."""
    for value in values:
        if value and len(value) >= 8:
            _literal_secrets.add(value)


def redact_text(text: str) -> str:
    """Scrub bearer tokens, provider secrets, and database URL passwords."""
    scrubbed = text
    for pattern, replacement in _PATTERNS:
        scrubbed = pattern.sub(replacement, scrubbed)
    for secret in sorted(_literal_secrets, key=len, reverse=True):
        if secret in scrubbed:
            scrubbed = scrubbed.replace(secret, "[REDACTED]")
    return scrubbed


class RedactingFilter(logging.Filter):
    """Ensure log records never carry credentials or sealed-token material."""

    def filter(self, record: logging.LogRecord) -> bool:
        rendered = record.getMessage()
        scrubbed = redact_text(rendered)
        if scrubbed != rendered:
            record.msg = scrubbed
            record.args = ()
        return True


class CloudLoggingFormatter(logging.Formatter):
    """Single-line JSON log formatter understood by Google Cloud Logging."""

    def __init__(self, project_id: str | None = None) -> None:
        super().__init__()
        self._project_id = project_id

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "severity": record.levelname,
            "logger": record.name,
            "message": redact_text(record.getMessage()),
        }
        req_id = getattr(record, "request_id", None) or request_id_var.get()
        t_id = getattr(record, "task_id", None) or task_id_var.get()
        c_id = getattr(record, "cycle_id", None) or cycle_id_var.get()
        tr_id = trace_id_var.get()
        if req_id:
            payload["request_id"] = req_id
        if t_id:
            payload["task_id"] = t_id
        if c_id:
            payload["cycle_id"] = c_id
        if tr_id and self._project_id:
            payload["logging.googleapis.com/trace"] = f"projects/{self._project_id}/traces/{tr_id}"
        for extra_key in ("http_method", "http_path", "http_status", "duration_ms", "job_name"):
            extra_val = getattr(record, extra_key, None)
            if extra_val is not None:
                payload[extra_key] = extra_val
        if record.exc_info:
            payload["exception"] = redact_text(self.formatException(record.exc_info))
        return json.dumps(payload, separators=(",", ":"))


def configure_cloud_logging(project_id: str | None = None) -> None:
    """Enable JSON stdout logging when running in Cloud Run or when LOG_FORMAT=json."""
    log_format = os.environ.get("LOG_FORMAT", "").lower()
    in_cloud_run = bool(os.environ.get("K_SERVICE") or os.environ.get("CLOUD_RUN_JOB"))
    root = logging.getLogger()
    if not any(isinstance(f, RedactingFilter) for f in root.filters):
        root.addFilter(RedactingFilter())
    if log_format != "json" and not in_cloud_run:
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(CloudLoggingFormatter(project_id or os.environ.get("GCP_PROJECT_ID")))
    handler.addFilter(RedactingFilter())
    root.handlers = [handler]
    level_name = os.environ.get("LOG_LEVEL", "INFO").upper()
    root.setLevel(getattr(logging, level_name, logging.INFO))
    # Prevent httpx from logging full query strings or headers at DEBUG/INFO if tweaked.
    logging.getLogger("httpx").addFilter(RedactingFilter())


def _clean_header(headers: dict[bytes, bytes], name: bytes) -> str | None:
    raw = headers.get(name)
    if raw is None:
        return None
    decoded = raw.decode("latin1", errors="ignore").strip()
    if _SAFE_ID.match(decoded):
        return decoded
    return None


def _extract_trace_id(headers: dict[bytes, bytes]) -> str | None:
    raw = headers.get(b"x-cloud-trace-context")
    if raw is None:
        return None
    trace_part = raw.decode("latin1", errors="ignore").split("/", 1)[0].strip()
    if _SAFE_ID.match(trace_part):
        return trace_part
    return None


class CorrelationMiddleware:
    """Bind request/task/cycle correlation IDs per HTTP request and emit request logs."""

    def __init__(self, app: ASGIApp) -> None:
        self._app = app
        self._logger = logging.getLogger("finance_api.request")

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return

        headers = dict(scope.get("headers") or [])
        req_id = _clean_header(headers, b"x-request-id") or uuid4().hex
        task_id = _clean_header(headers, b"x-cloudtasks-taskname") or _clean_header(
            headers, b"x-task-id"
        )
        cycle_id = _clean_header(headers, b"x-cycle-id")
        trace_id = _extract_trace_id(headers)

        req_tok = request_id_var.set(req_id)
        task_tok = task_id_var.set(task_id)
        cycle_tok = cycle_id_var.set(cycle_id)
        trace_tok = trace_id_var.set(trace_id)

        started = time.monotonic()
        status_code = 500

        async def send_with_correlation(message: Message) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = int(message["status"])
                out_headers = list(message.get("headers") or [])
                out_headers.append((b"x-request-id", req_id.encode("ascii")))
                message = {**message, "headers": out_headers}
            await send(message)

        try:
            await self._app(scope, receive, send_with_correlation)
        finally:
            duration_ms = round((time.monotonic() - started) * 1000, 2)
            path = str(scope.get("path") or "")
            method = str(scope.get("method") or "")
            if path != "/health/live" or status_code != 200:
                self._logger.info(
                    "%s %s -> %d (%.2fms)",
                    method,
                    path,
                    status_code,
                    duration_ms,
                    extra={
                        "http_method": method,
                        "http_path": path,
                        "http_status": status_code,
                        "duration_ms": duration_ms,
                    },
                )
            request_id_var.reset(req_tok)
            task_id_var.reset(task_tok)
            cycle_id_var.reset(cycle_tok)
            trace_id_var.reset(trace_tok)
