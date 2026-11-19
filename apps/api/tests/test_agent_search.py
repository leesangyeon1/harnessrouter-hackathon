"""Tests for HarnessRouter Cloud adapter and tenant-isolated Advisor & Ticker Search routes."""

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

from finance_api.agent_search import ADVISOR_HARNESS_ID, MARKET_SEARCH_HARNESS_ID
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
SID_ADV = "hsess_adv_001"
RID_ADV = "resp_adv_001"
RID_ADV_FOLLOW = "resp_adv_002"

SAMPLE_ADVISOR_MARKDOWN = (
    "## Summary\nOption B reduces total interest by $612.40.\n\n"
    "## Inputs and verification status\nCalculator outputs verified in USD.\n\n"
    "## Comparison table\n| Option | Monthly | Total Interest |\n|---|---|---|\n"
    "| Current 24.49% APR | $250.00 | $684.10 |\n"
    "| 0% 15m Transfer (3% fee) | $214.62 | $71.70 |\n\n"
    "## Tradeoffs and conditional recommendation\n"
    "Pay off within 15 months before promo expires.\n\n"
    "## Missing information and next steps\nConfirm post-promo APR and transfer eligibility."
)

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


def _completed_response(
    resp_id: str = RID,
    session_id: str = SID,
    final_text: str | None = None,
) -> dict[str, Any]:
    body_text = final_text if final_text is not None else json.dumps(SAMPLE_AGENT_JSON)
    return {
        "id": resp_id,
        "object": "response",
        "status": "completed",
        "metadata": {"session_id": session_id},
        "output": [
            {
                "type": "message",
                "role": "assistant",
                "content": [
                    {"type": "output_text", "text": "Working on analysis...", "annotations": []}
                ],
            },
            {
                "type": "message",
                "role": "assistant",
                "content": [
                    {
                        "type": "output_text",
                        "text": body_text,
                        "annotations": [
                            {
                                "type": "container_file_citation",
                                "container_id": session_id,
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


def test_agent_routes_support_advisor_and_search_harnesses_with_tenancy_and_files(
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
            recorded_posts.append({"headers": dict(req.headers), "body": payload})
            is_advisor = payload["metadata"]["harness_id"] == ADVISOR_HARNESS_ID
            sid = SID_ADV if is_advisor else SID
            if is_advisor:
                rid = RID_ADV_FOLLOW if payload.get("previous_response_id") else RID_ADV
                text = SAMPLE_ADVISOR_MARKDOWN
            else:
                rid = RID_FOLLOW if payload.get("previous_response_id") else RID
                text = json.dumps(SAMPLE_AGENT_JSON)
            created = {
                "id": rid,
                "status": "in_progress",
                "metadata": {"session_id": sid},
                "output": [],
            }
            return httpx.Response(
                200,
                headers={"Content-Type": "text/event-stream"},
                content=_sse_bytes(
                    [
                        {"type": "response.created", "response": created},
                        {
                            "type": "response.completed",
                            "response": _completed_response(rid, sid, text),
                        },
                    ]
                ),
            )
        if req.method == "GET" and (
            req.url.path.startswith(f"/v1/sessions/{SID}/files")
            or req.url.path.startswith(f"/v1/sessions/{SID_ADV}/files")
        ):
            return httpx.Response(200, json={"session_id": SID, "files": FILES})
        if req.method == "GET" and (
            req.url.path == f"/v1/containers/{SID}/files/cfile_html/content"
            or req.url.path == f"/v1/containers/{SID_ADV}/files/cfile_html/content"
        ):
            return httpx.Response(
                200,
                headers={"Content-Type": "text/html"},
                content=b"<!doctype html><h1>Verified Report</h1>",
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
        # Unauthenticated calls and client-supplied harness_id or user are rejected.
        assert client.post("/v1/agent-tasks", json={"input": "Compare cards"}).status_code == 401
        assert (
            client.post(
                "/v1/agent-tasks",
                headers=alice_headers,
                json={"input": "Compare cards", "harness_id": "chrn_evil"},
            ).status_code
            == 422
        )
        assert (
            client.post(
                "/v1/agent-tasks",
                headers=alice_headers,
                json={"input": "Compare cards", "user": "spoofed"},
            ).status_code
            == 422
        )

        # 1. Default / advisor feature sends ADVISOR_HARNESS_ID + user=alice.
        adv_resp = client.post(
            "/v1/agent-tasks",
            headers=alice_headers,
            json={"input": "Compare 24.49% APR vs 0% 15-month balance transfer (verified)"},
        )
        assert adv_resp.status_code == 201
        adv_id = adv_resp.json()["id"]
        assert adv_resp.json()["feature_key"] == "advisor"
        assert UUID(adv_id)

        adv_detail: dict[str, Any] = {}
        for _ in range(40):
            adv_detail = client.get(f"/v1/agent-tasks/{adv_id}", headers=alice_headers).json()
            if adv_detail.get("status") == "completed":
                break
            time.sleep(0.05)

        assert adv_detail["status"] == "completed"
        assert adv_detail["feature_key"] == "advisor"
        assert "## Summary" in adv_detail["answer"]
        assert "## Comparison table" in adv_detail["answer"]
        assert adv_detail["structured_result"] is None
        assert adv_detail["can_continue"] is True

        # Cross-feature follow-up is rejected so sessions never mix Harnesses.
        assert (
            client.post(
                "/v1/agent-tasks",
                headers=alice_headers,
                json={
                    "input": "Try switching feature",
                    "feature_key": "search",
                    "follow_up_task_id": adv_id,
                },
            ).status_code
            == 409
        )

        # Advisor follow-up sends previous_response_id + session_id + user=alice.
        adv_follow = client.post(
            "/v1/agent-tasks",
            headers=alice_headers,
            json={"input": "What if my monthly budget is $300?", "follow_up_task_id": adv_id},
        )
        assert adv_follow.status_code == 201
        adv_follow_id = adv_follow.json()["id"]
        for _ in range(40):
            af_detail = client.get(f"/v1/agent-tasks/{adv_follow_id}", headers=alice_headers).json()
            if af_detail.get("status") == "completed":
                break
            time.sleep(0.05)

        # 2. Search feature sends MARKET_SEARCH_HARNESS_ID + user=alice.
        created_resp = client.post(
            "/v1/agent-tasks",
            headers=alice_headers,
            json={"input": "Verify TLT bond ETF", "feature_key": "search"},
        )
        assert created_resp.status_code == 201
        task_id = created_resp.json()["id"]
        assert created_resp.json()["feature_key"] == "search"

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
        raw_detail_str = json.dumps([adv_detail, detail])
        for secret_or_id in (
            test_hr_key,
            ADVISOR_HARNESS_ID,
            MARKET_SEARCH_HARNESS_ID,
            SID,
            SID_ADV,
            RID,
            RID_ADV,
            "download_url",
        ):
            assert secret_or_id not in raw_detail_str

        # Per-feature list filtering works and stays isolated per user.
        adv_list = client.get("/v1/agent-tasks?feature_key=advisor", headers=alice_headers).json()[
            "tasks"
        ]
        search_list = client.get(
            "/v1/agent-tasks?feature_key=search", headers=alice_headers
        ).json()["tasks"]
        assert len(adv_list) == 2
        assert all(t["feature_key"] == "advisor" for t in adv_list)
        assert len(search_list) == 1
        assert search_list[0]["feature_key"] == "search"

        # Verify file download & signed sandboxed HTML preview for owner Alice.
        dl_path = adv_detail["files"][0]["download_path"]
        dl_resp = client.get(dl_path, headers=alice_headers)
        assert dl_resp.status_code == 200
        assert dl_resp.content == b"<!doctype html><h1>Verified Report</h1>"
        assert 'attachment; filename="report.html"' in dl_resp.headers["Content-Disposition"]

        preview_url = adv_detail["preview_url"]
        assert preview_url is not None
        prev_resp = client.get(preview_url)
        assert prev_resp.status_code == 200
        assert prev_resp.content == b"<!doctype html><h1>Verified Report</h1>"
        for h_key, h_val in PREVIEW_HEADERS.items():
            assert prev_resp.headers[h_key] == h_val

        # Tampered preview token fails closed with 404.
        tampered_url = preview_url.replace("/out/report.html", "x/out/report.html")
        assert client.get(tampered_url).status_code == 404

        # Second tenant Bob is strictly denied across detail, list, follow-up, cancel, and download.
        assert client.get("/v1/agent-tasks", headers=bob_headers).json() == {"tasks": []}
        assert client.get("/v1/agent-tasks?feature_key=advisor", headers=bob_headers).json() == {
            "tasks": []
        }
        assert client.get(f"/v1/agent-tasks/{adv_id}", headers=bob_headers).status_code == 404
        assert (
            client.get(f"/v1/agent-tasks/{adv_id}/events", headers=bob_headers).status_code == 404
        )
        assert (
            client.post(f"/v1/agent-tasks/{adv_id}/cancel", headers=bob_headers).status_code == 404
        )
        assert client.get(dl_path, headers=bob_headers).status_code == 404
        assert (
            client.post(
                "/v1/agent-tasks",
                headers=bob_headers,
                json={"input": "Follow up", "follow_up_task_id": adv_id},
            ).status_code
            == 404
        )

    assert len(recorded_posts) == 3
    adv_first, adv_second, search_first = recorded_posts
    assert adv_first["headers"]["uhp-version"] == "2026-09-28"
    assert adv_first["body"]["user"] == alice
    assert adv_first["body"]["metadata"] == {"harness_id": ADVISOR_HARNESS_ID}
    assert "previous_response_id" not in adv_first["body"]

    assert adv_second["body"]["user"] == alice
    assert adv_second["body"]["previous_response_id"] == RID_ADV
    assert adv_second["body"]["metadata"] == {
        "harness_id": ADVISOR_HARNESS_ID,
        "session_id": SID_ADV,
    }

    assert search_first["body"]["user"] == alice
    assert search_first["body"]["metadata"] == {"harness_id": MARKET_SEARCH_HARNESS_ID}
    assert "previous_response_id" not in search_first["body"]


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
        resp = client.post(
            "/v1/agent-tasks", headers=alice_headers, json={"input": "Compare refinance"}
        )
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
