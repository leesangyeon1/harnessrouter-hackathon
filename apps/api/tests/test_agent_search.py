"""Tests for HarnessRouter Cloud adapter and tenant-isolated Market Ticker Search routes."""

from __future__ import annotations

import json
import secrets
import time
from collections.abc import Callable
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from finance_api.agent_search import MARKET_SEARCH_HARNESS_ID
from finance_api.app import create_app
from finance_api.auth import IdTokenVerifier
from finance_api.db import create_pool
from finance_api.harnessrouter_adapter import (
    PREVIEW_HEADERS,
    HarnessRouter,
    HRError,
    answer_text,
    load_api_key,
    parse_sse,
    produced_files,
    safe_rel_path,
    sign_preview,
    to_progress,
    verify_preview,
)
from finance_api.plaid import PlaidClient
from finance_api.sealing import SecretBox

SID = "hsess_test_001"
RID = "resp_test_001"
RID_FOLLOW = "resp_test_002"

SAMPLE_AGENT_JSON = {
    "status": "ok",
    "query": "TLT",
    "results": [
        {
            "name": "iShares 20+ Year Treasury Bond ETF",
            "asset_type": "bond_etf",
            "symbol": "TLT",
            "exchange_or_venue": "NASDAQ",
            "quote_currency": "USD",
            "verification_status": "verified",
            "quote": None,
            "screening_evidence": None,
            "citations": [
                {
                    "URL": "https://www.ishares.com/us/products/239454/",
                    "source_title": "iShares 20+ Year Treasury Bond ETF",
                    "supported_facts": ["Ticker TLT", "NASDAQ listing", "USD currency"],
                }
            ],
        }
    ],
    "limitations": [],
    "clarification": None,
}

FILES = [
    {
        "object": "file",
        "id": "cfile_html",
        "file_id": "cfile_html",
        "container_id": SID,
        "filename": "report.html",
        "path": "out/report.html",
        "bytes": 28,
        "media_type": "text/html",
        "download_url": f"https://api.harnessrouter.ai/v1/containers/{SID}/files/cfile_html/content",
    }
]


def _sse_bytes(events: list[dict[str, Any]]) -> bytes:
    return "".join(f"data: {json.dumps(ev)}\n\n" for ev in events).encode("utf-8")


def _completed_response(resp_id: str = RID) -> dict[str, Any]:
    return {
        "id": resp_id,
        "object": "response",
        "status": "completed",
        "metadata": {"session_id": SID},
        "output": [
            {
                "type": "message",
                "role": "assistant",
                "content": [
                    {"type": "output_text", "text": "Checking issuer page...", "annotations": []}
                ],
            },
            {
                "type": "message",
                "role": "assistant",
                "content": [
                    {
                        "type": "output_text",
                        "text": json.dumps(SAMPLE_AGENT_JSON),
                        "annotations": [
                            {
                                "type": "container_file_citation",
                                "container_id": SID,
                                "file_id": "cfile_html",
                                "filename": "out/report.html",
                                "download_url": FILES[0]["download_url"],
                                "start_index": 0,
                                "end_index": 5,
                            }
                        ],
                    }
                ],
            },
        ],
    }


def test_adapter_sse_parsing_preview_signing_paths_and_redirect_refusal(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    created = {"id": RID, "status": "in_progress", "metadata": {"session_id": SID}, "output": []}
    final = _completed_response()
    raw = (
        b": keepalive\r\n\r\n"
        + _sse_bytes(
            [
                {"type": "response.created", "response": created},
                {
                    "type": "response.output_item.added",
                    "item": {"type": "function_call", "name": "browser_search"},
                },
                {"type": "response.output_text.delta", "delta": '{"status":"ok"}'},
                {"type": "response.completed", "response": final},
            ]
        ).replace(b"\n", b"\r\n")
        + b"data: [DONE]\n\ndata: invalid-json\n\n"
    )
    events = list(parse_sse(raw.splitlines()))
    assert [e["type"] for e in events] == [
        "response.created",
        "response.output_item.added",
        "response.output_text.delta",
        "response.completed",
    ]
    assert answer_text(final) == json.dumps(SAMPLE_AGENT_JSON)
    assert [a["filename"] for a in produced_files(final)] == ["out/report.html"]
    assert to_progress(events[1]) == {
        "kind": "activity",
        "label": "Checking authoritative public sources",
    }
    assert (
        to_progress(
            {
                "type": "response.output_text.delta",
                "delta": (
                    "The model provider refused the request (403: Forbidden. (request id: 99))"
                ),
            }
        )
        is None
    )

    key_bytes = b"\x11" * 32
    tok = sign_preview("subj_abc", signing_key=key_bytes, ttl_seconds=60, now=1_900_000_000)
    assert verify_preview(tok, signing_key=key_bytes, now=1_900_000_000) == "subj_abc"
    assert verify_preview(tok, signing_key=b"\x22" * 32, now=1_900_000_000) is None
    assert verify_preview(tok, signing_key=key_bytes, now=1_900_000_061) is None
    assert safe_rel_path("out/report.html") == "out/report.html"
    for unsafe in ("../secret", "a/../b", "/etc/passwd", "a\\b", "%2e%2e/x", ""):
        assert safe_rel_path(unsafe) is None

    # Redirects must be refused rather than forwarding Authorization header.
    redirect_hr = HarnessRouter(
        api_key="sk-hr-" + secrets.token_hex(8),
        transport=httpx.MockTransport(
            lambda _req: httpx.Response(302, headers={"Location": "https://evil.example.org"})
        ),
    )
    with pytest.raises(HRError) as exc_info:
        redirect_hr.me()
    assert exc_info.value.code == "redirect_refused"

    # Key loader checks HR_API_KEY env or single-line .env.harnessrouter.
    monkeypatch.delenv("HR_API_KEY", raising=False)
    monkeypatch.delenv("HARNESSROUTER_API_KEY", raising=False)
    env_file = tmp_path / ".env.harnessrouter"
    sample_k = "sk-hr-" + secrets.token_hex(8)
    env_file.write_text(f"HR_API_KEY={sample_k}\n", encoding="utf-8")
    assert load_api_key(str(tmp_path)) == sample_k


def test_stream_without_terminal_recovers_by_polling_without_resending() -> None:
    created = {"id": RID, "status": "in_progress", "metadata": {"session_id": SID}, "output": []}
    final = _completed_response()
    calls: list[tuple[str, str]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append((req.method, req.url.path))
        if req.method == "POST":
            return httpx.Response(
                200,
                headers={"Content-Type": "text/event-stream"},
                content=_sse_bytes([{"type": "response.created", "response": created}]),
            )
        return httpx.Response(200, json=created if len(calls) < 3 else final)

    hr = HarnessRouter(
        api_key="sk-hr-" + secrets.token_hex(8),
        transport=httpx.MockTransport(handler),
        sleep=lambda _s: None,
    )
    res = hr.run_streamed(MARKET_SEARCH_HARNESS_ID, "Verify TLT", user="u-1")
    assert res["status"] == "completed"
    assert [m for m, _ in calls].count("POST") == 1
    assert all(p == f"/v1/responses/{RID}" for m, p in calls if m == "GET")


def test_agent_search_routes_enforce_tenancy_followup_files_and_preview(
    api_url: str,
    verifier: IdTokenVerifier,
    make_token: Callable[..., str],
    no_plaid: PlaidClient,
    secret_box: SecretBox,
) -> None:
    recorded_posts: list[dict[str, Any]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        if req.method == "POST" and req.url.path == "/v1/responses":
            payload = json.loads(req.content.decode("utf-8"))
            recorded_posts.append(
                {
                    "headers": dict(req.headers),
                    "body": payload,
                }
            )
            rid = RID_FOLLOW if payload.get("previous_response_id") else RID
            created = {
                "id": rid,
                "status": "in_progress",
                "metadata": {"session_id": SID},
                "output": [],
            }
            return httpx.Response(
                200,
                headers={"Content-Type": "text/event-stream"},
                content=_sse_bytes(
                    [
                        {"type": "response.created", "response": created},
                        {"type": "response.completed", "response": _completed_response(rid)},
                    ]
                ),
            )
        if req.method == "GET" and req.url.path.startswith(f"/v1/sessions/{SID}/files"):
            return httpx.Response(200, json={"session_id": SID, "files": FILES})
        if req.method == "GET" and req.url.path == f"/v1/containers/{SID}/files/cfile_html/content":
            return httpx.Response(
                200,
                headers={"Content-Type": "text/html"},
                content=b"<!doctype html><h1>Verified TLT</h1>",
            )
        return httpx.Response(404, json={"detail": "not found"})

    test_hr_key = "sk-hr-" + secrets.token_hex(12)
    hr = HarnessRouter(
        api_key=test_hr_key,
        transport=httpx.MockTransport(handler),
        sleep=lambda _s: None,
    )
    signing_key = b"\x55" * 32
    app = create_app(
        create_pool(api_url, open_pool=False),
        verifier,
        no_plaid,
        secret_box,
        harness_router=hr,
        preview_signing_key=signing_key,
    )

    alice = f"alice-{uuid4().hex[:8]}"
    bob = f"bob-{uuid4().hex[:8]}"
    alice_headers = {"Authorization": f"Bearer {make_token(sub=alice)}"}
    bob_headers = {"Authorization": f"Bearer {make_token(sub=bob)}"}

    with TestClient(app) as client:
        # Unauthenticated calls and client-supplied harness_id are rejected.
        assert client.post("/v1/agent-tasks", json={"input": "TLT"}).status_code == 401
        assert (
            client.post(
                "/v1/agent-tasks",
                headers=alice_headers,
                json={"input": "TLT", "harness_id": "chrn_evil"},
            ).status_code
            == 422
        )

        created_resp = client.post(
            "/v1/agent-tasks",
            headers=alice_headers,
            json={"input": "Verify TLT bond ETF"},
        )
        assert created_resp.status_code == 201
        task_id = created_resp.json()["id"]
        assert UUID(task_id)

        # Wait briefly for background daemon thread to settle in PostgreSQL.
        detail: dict[str, Any] = {}
        for _ in range(40):
            detail = client.get(f"/v1/agent-tasks/{task_id}", headers=alice_headers).json()
            if detail.get("status") == "completed":
                break
            time.sleep(0.05)

        assert detail["status"] == "completed"
        assert detail["structured_result"]["status"] == "ok"
        assert detail["structured_result"]["results"][0]["symbol"] == "TLT"
        assert detail["can_continue"] is True
        # Ensure zero upstream secrets or internal IDs leak to browser.
        raw_detail_str = json.dumps(detail)
        assert test_hr_key not in raw_detail_str
        assert MARKET_SEARCH_HARNESS_ID not in raw_detail_str
        assert SID not in raw_detail_str
        assert RID not in raw_detail_str
        assert "download_url" not in raw_detail_str

        # Verify file download & signed sandboxed HTML preview for owner Alice.
        dl_path = detail["files"][0]["download_path"]
        dl_resp = client.get(dl_path, headers=alice_headers)
        assert dl_resp.status_code == 200
        assert dl_resp.content == b"<!doctype html><h1>Verified TLT</h1>"
        assert 'attachment; filename="report.html"' in dl_resp.headers["Content-Disposition"]

        preview_url = detail["preview_url"]
        assert preview_url is not None
        prev_resp = client.get(preview_url)
        assert prev_resp.status_code == 200
        assert prev_resp.content == b"<!doctype html><h1>Verified TLT</h1>"
        for h_key, h_val in PREVIEW_HEADERS.items():
            assert prev_resp.headers[h_key] == h_val

        # Tampered preview token fails closed with 404.
        tampered_url = preview_url.replace("/out/report.html", "x/out/report.html")
        assert client.get(tampered_url).status_code == 404

        # Second tenant Bob is strictly denied across detail, list, follow-up, cancel, and download.
        assert client.get("/v1/agent-tasks", headers=bob_headers).json() == {"tasks": []}
        assert client.get(f"/v1/agent-tasks/{task_id}", headers=bob_headers).status_code == 404
        assert (
            client.get(f"/v1/agent-tasks/{task_id}/events", headers=bob_headers).status_code == 404
        )
        assert (
            client.post(f"/v1/agent-tasks/{task_id}/cancel", headers=bob_headers).status_code == 404
        )
        assert client.get(dl_path, headers=bob_headers).status_code == 404
        assert (
            client.post(
                "/v1/agent-tasks",
                headers=bob_headers,
                json={"input": "Follow up", "follow_up_task_id": task_id},
            ).status_code
            == 404
        )

        # Follow-up by owner Alice sends previous_response_id + session_id + user=alice.
        follow = client.post(
            "/v1/agent-tasks",
            headers=alice_headers,
            json={"input": "Also verify IEF", "follow_up_task_id": task_id},
        )
        assert follow.status_code == 201
        follow_id = follow.json()["id"]
        for _ in range(40):
            f_detail = client.get(f"/v1/agent-tasks/{follow_id}", headers=alice_headers).json()
            if f_detail.get("status") == "completed":
                break
            time.sleep(0.05)

    assert len(recorded_posts) == 2
    first_call, second_call = recorded_posts
    assert first_call["headers"]["uhp-version"] == "2026-09-28"
    assert first_call["body"]["user"] == alice
    assert first_call["body"]["metadata"] == {"harness_id": MARKET_SEARCH_HARNESS_ID}
    assert "previous_response_id" not in first_call["body"]

    assert second_call["body"]["user"] == alice
    assert second_call["body"]["previous_response_id"] == RID
    assert second_call["body"]["metadata"] == {
        "harness_id": MARKET_SEARCH_HARNESS_ID,
        "session_id": SID,
    }


def test_failed_response_strips_raw_upstream_error_from_browser_payload(
    api_url: str,
    verifier: IdTokenVerifier,
    make_token: Callable[..., str],
    no_plaid: PlaidClient,
    secret_box: SecretBox,
) -> None:
    upstream_err_text = (
        "The model provider refused the request (403: Forbidden. (request id: req_secret_403))"
    )

    def handler(_req: httpx.Request) -> httpx.Response:
        created = {
            "id": RID,
            "status": "in_progress",
            "metadata": {"session_id": SID},
            "output": [],
        }
        failed = {
            "id": RID,
            "object": "response",
            "status": "failed",
            "metadata": {"session_id": SID},
            "error": {"code": "turn_failed", "message": upstream_err_text},
            "output": [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": upstream_err_text}],
                }
            ],
        }
        return httpx.Response(
            200,
            headers={"Content-Type": "text/event-stream"},
            content=_sse_bytes(
                [
                    {"type": "response.created", "response": created},
                    {"type": "response.failed", "response": failed},
                ]
            ),
        )

    hr = HarnessRouter(
        api_key="sk-hr-" + secrets.token_hex(12),
        transport=httpx.MockTransport(handler),
        sleep=lambda _s: None,
    )
    app = create_app(
        create_pool(api_url, open_pool=False),
        verifier,
        no_plaid,
        secret_box,
        harness_router=hr,
        preview_signing_key=b"\x66" * 32,
    )
    alice = f"alice-fail-{uuid4().hex[:8]}"
    alice_headers = {"Authorization": f"Bearer {make_token(sub=alice)}"}

    with TestClient(app) as client:
        resp = client.post("/v1/agent-tasks", headers=alice_headers, json={"input": "Verify TLT"})
        assert resp.status_code == 201
        task_id = resp.json()["id"]
        detail: dict[str, Any] = {}
        for _ in range(40):
            detail = client.get(f"/v1/agent-tasks/{task_id}", headers=alice_headers).json()
            if detail.get("status") == "failed":
                break
            time.sleep(0.05)

        assert detail["status"] == "failed"
        assert detail["answer"] == ""
        assert detail["structured_result"] is None
        assert detail["can_continue"] is False
        serialized = json.dumps(detail)
        assert "403" not in serialized
        assert "req_secret_403" not in serialized
        assert "model provider refused" not in serialized.lower()
