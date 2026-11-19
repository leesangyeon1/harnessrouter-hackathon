"""Authenticated Advisor, Quant Evaluator & Ticker Search routes on HarnessRouter Cloud.

Maps product features strictly on the server:
- `advisor`    -> `chrn_e353c7f7ce02811c763f7150b10b3139` (`Personal Finance Advisor`, `hermes`,
  `deepseek-v4-pro`, per-user memory via signed-in `user_id`)
- `quant_eval` -> `chrn_938e9e9f916aeaf09c789c506172c27b` (`Quant strategy evaluator`, `hermes`,
  `deepseek-v4-pro`, isolated CPU execution of supplied `finance_core` Python code)
- `search`     -> `chrn_b431839c5f1318c5ab641703b8cd0279` (`Market ticker search`, `hermes`,
  `deepseek-v4-pro`)

Keeps `HR_API_KEY`, `harness_id`, `response_id`, `session_id`, and upstream `download_url`s
strictly on the server and enforces PostgreSQL Forced RLS per user.
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import logging
import math
import re
import threading
from collections.abc import AsyncIterator, Callable
from dataclasses import asdict
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Annotated, Any, Literal
from uuid import UUID, uuid4

from cryptography.fernet import InvalidToken
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, Response, status
from fastapi.responses import StreamingResponse
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, ConfigDict, Field

import finance_core.quant as fc_quant
from finance_api.advisor_demo_db import AdvisorContextSelection, analysis_input, read_scenario
from finance_api.auth import current_user
from finance_api.db import tenant_transaction
from finance_api.harnessrouter_adapter import (
    TERMINAL_STATUSES,
    HarnessRouter,
    HRError,
    Json,
    answer_text,
    download_file,
    preview_file,
    produced_files,
    publish_progress,
    safe_rel_path,
    sign_preview,
    subscribe,
    to_progress,
    verify_preview,
)
from finance_api.sealing import SecretBox
from finance_core.quant import (
    DEFAULT_COSTS,
    DEFAULT_POLICY,
    MODEL_SET_VERSION,
    Bar,
    ModePolicy,
    TradeCosts,
    bars_digest,
)

logger = logging.getLogger(__name__)

ADVISOR_HARNESS_ID = "chrn_e353c7f7ce02811c763f7150b10b3139"
QUANT_EVAL_HARNESS_ID = "chrn_938e9e9f916aeaf09c789c506172c27b"
MARKET_SEARCH_HARNESS_ID = "chrn_b431839c5f1318c5ab641703b8cd0279"

FeatureKey = Literal["advisor", "quant_eval", "search"]

HARNESS_BY_FEATURE: dict[FeatureKey, str] = {
    "advisor": ADVISOR_HARNESS_ID,
    "quant_eval": QUANT_EVAL_HARNESS_ID,
    "search": MARKET_SEARCH_HARNESS_ID,
}

BOND_ETFS = frozenset({"TLT", "IEF", "SHY", "LQD", "HYG", "BND", "TIP"})
DEFAULT_COST_CAP_USD = Decimal("1.00")
DEFAULT_TIMEOUT_SECONDS = 600

router = APIRouter(prefix="/v1/agent-tasks")
User = Annotated[str, Depends(current_user)]

_active_tasks: set[str] = set()
_active_lock = threading.Lock()
_FINANCE_CORE_QUANT_SOURCE = inspect.getsource(fc_quant)


class CreateAgentTaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    input: str = Field(min_length=1, max_length=250_000)
    feature_key: FeatureKey | None = None
    follow_up_task_id: UUID | None = None
    advisor_context: AdvisorContextSelection | None = None


def _resolve_feature_key(raw_kind: Any) -> FeatureKey:
    val = str(raw_kind)
    if val == "search":
        return "search"
    if val == "quant_eval":
        return "quant_eval"
    return "advisor"


def _sanitize_file_entries(raw_files: list[Json]) -> list[dict[str, Any]]:
    """Strip upstream `download_url` and keep only safe relative metadata in PostgreSQL."""
    cleaned: list[dict[str, Any]] = []
    seen_paths: set[str] = set()
    for item in raw_files:
        raw_path = str(item.get("path") or item.get("filename") or "")
        rel = safe_rel_path(raw_path)
        file_id = item.get("id") or item.get("file_id")
        if not rel or not isinstance(file_id, str) or not file_id or rel in seen_paths:
            continue
        seen_paths.add(rel)
        filename = rel.rsplit("/", 1)[-1]
        size_val = item.get("bytes")
        cleaned.append(
            {
                "id": file_id,
                "path": rel,
                "filename": str(item.get("filename") or filename),
                "bytes": int(size_val) if isinstance(size_val, int) else None,
                "media_type": str(item.get("media_type") or "application/octet-stream"),
            }
        )
    return cleaned


_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL | re.IGNORECASE)


def _extract_json_dict(raw_text: str | None) -> dict[str, Any] | None:
    if not raw_text:
        return None
    stripped = raw_text.strip()
    candidates: list[str] = [stripped]
    for match in _JSON_FENCE_RE.finditer(stripped):
        candidates.insert(0, match.group(1).strip())
    first_brace = stripped.find("{")
    last_brace = stripped.rfind("}")
    if 0 <= first_brace < last_brace:
        candidates.append(stripped[first_brace : last_brace + 1])
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            continue
    return None


def parse_structured_answer(raw_text: str | None) -> dict[str, Any] | None:
    """Parse JSON response matching the Market Ticker Search output contract if valid."""
    parsed = _extract_json_dict(raw_text)
    if parsed is None:
        return None
    if not isinstance(parsed.get("status"), str) or not isinstance(parsed.get("results"), list):
        return None
    return parsed


def parse_quant_evaluation_answer(raw_text: str | None) -> dict[str, Any] | None:
    """Parse JSON response matching the Quant Strategy Evaluator output contract if valid."""
    parsed = _extract_json_dict(raw_text)
    if parsed is None:
        return None
    if not isinstance(parsed.get("status"), str) or not isinstance(parsed.get("evaluations"), list):
        return None
    return parsed


def _infer_sector(symbol: str) -> str:
    upper = symbol.upper()
    if "/" in upper or upper.endswith("-USD"):
        return "crypto"
    if upper in BOND_ETFS:
        return "bond"
    return "stock"


def _synthetic_pinned_bars(symbol: str, count: int = 260) -> list[Bar]:
    """Generate deterministic ascending daily OHLCV bars (>= 250) for standalone CPU simulation."""
    seed_int = int(hashlib.sha256(symbol.upper().encode("utf-8")).hexdigest()[:8], 16)
    base_price = (
        64000.0
        if _infer_sector(symbol) == "crypto"
        else (92.0 if symbol.upper() in BOND_ETFS else 185.0)
    )
    price = base_price + (seed_int % 17)
    cur_day = date(2025, 7, 1)
    bars: list[Bar] = []
    idx = 0
    while len(bars) < count:
        if cur_day.weekday() < 5:
            drift = 0.0014
            wave = 0.0085 * math.sin((idx + (seed_int % 11)) * 0.21) + 0.004 * math.cos(idx * 0.09)
            open_p = round(price, 4)
            close_p = round(max(1.0, open_p * (1.0 + drift + wave)), 4)
            high_p = round(max(open_p, close_p) * 1.006, 4)
            low_p = round(min(open_p, close_p) * 0.994, 4)
            vol = float(1_500_000 + ((seed_int + idx * 97_531) % 3_200_000))
            bars.append(Bar(cur_day.isoformat(), open_p, high_p, low_p, close_p, vol))
            price = close_p
            idx += 1
        cur_day += timedelta(days=1)
    return bars


def _build_quant_eval_prompt(
    *,
    cycle_id: str,
    symbol: str,
    sector: str,
    policy: ModePolicy,
    costs: TradeCosts,
    bars: list[Bar],
    data_origin: str,
) -> tuple[str, dict[str, Any]]:
    window_bars = bars[-500:]
    b_hash = bars_digest(window_bars)
    p_hash = policy.digest
    c_hash = costs.digest
    cost_per_side = costs.for_sector(sector)

    pinned_identities = {
        "cycle_id": cycle_id,
        "symbol": symbol,
        "sector": sector,
        "data_origin": data_origin,
        "model_set_version": MODEL_SET_VERSION,
        "candidate_models": ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M10", "M11"],
        "baseline_model": "M00",
        "policy_version": policy.version,
        "policy": asdict(policy),
        "policy_hash": p_hash,
        "costs": asdict(costs),
        "costs_hash": c_hash,
        "cost_per_side": cost_per_side,
        "bars_count": len(window_bars),
        "bars_hash": b_hash,
        "warmup_start_index": 61,
        "confirmation_bars": policy.confirmation_bars,
    }

    input_payload = {
        "cycle_id": cycle_id,
        "symbol": symbol,
        "sector": sector,
        "pinned_identities": pinned_identities,
        "bars": [asdict(b) for b in window_bars],
    }

    prompt = (
        f"Evaluate finance_core daily-v1 models M01-M08, M10 and M11 (with M00 as baseline only) "
        f"for cycle_id={cycle_id} and symbol={symbol} ({sector}).\n\n"
        f"Execute ONLY the supplied verbatim `finance_core/quant.py` Python module below in your "
        f"isolated execution environment against the supplied pinned JSON input payload, verify "
        f"`bars_hash`, `policy_hash`, `costs_hash`, `model_set_version`, and `policy_version`, "
        f"and return ONLY the required JSON object "
        f"(`status`, `simulation_label`, `evaluations`, `issues`).\n\n"
        f"### Supplied `finance_core/quant.py`\n"
        f"```python\n{_FINANCE_CORE_QUANT_SOURCE}\n```\n\n"
        f"### Supplied Pinned Evaluation Input JSON\n"
        f"```json\n{json.dumps(input_payload, separators=(',', ':'))}\n```"
    )
    return prompt, pinned_identities


def _seal_preview_subject(box: SecretBox, task_id: UUID, user_id: str) -> str:
    payload = json.dumps({"t": str(task_id), "u": user_id}, separators=(",", ":"))
    sealed = box.seal(payload).decode("ascii").rstrip("=")
    return sealed


def _open_preview_subject(box: SecretBox, subject_token: str) -> tuple[UUID, str] | None:
    padded = subject_token + "=" * (-len(subject_token) % 4)
    try:
        decoded = json.loads(box.open(padded.encode("ascii")))
        return UUID(str(decoded["t"])), str(decoded["u"])
    except (InvalidToken, ValueError, KeyError, TypeError):
        return None


def _summarize_stored_query(feature_key: FeatureKey, raw_query: str) -> str:
    if feature_key == "quant_eval" and len(raw_query) > 240:
        first_line = raw_query.splitlines()[0].strip()
        return first_line[:240]
    return raw_query


def _format_task_for_browser(
    row: dict[str, Any],
    *,
    user_id: str,
    box: SecretBox,
    signing_key: bytes,
) -> dict[str, Any]:
    task_id: UUID = row["id"]
    feature_key = _resolve_feature_key(row.get("kind"))
    raw_status = str(row["status"])
    hide_answer = raw_status in ("failed", "cancelled")
    answer = "" if hide_answer else str(row.get("result_text") or "")
    raw_files_col = row.get("files")
    stored_files: list[Any] = raw_files_col if isinstance(raw_files_col, list) else []

    public_files: list[dict[str, Any]] = []
    html_entry: str | None = None
    for f_item in stored_files:
        if not isinstance(f_item, dict):
            continue
        rel = safe_rel_path(str(f_item.get("path") or ""))
        if not rel:
            continue
        if html_entry is None and rel.lower().endswith((".html", ".htm")):
            html_entry = rel
        public_files.append(
            {
                "path": rel,
                "filename": str(f_item.get("filename") or rel.rsplit("/", 1)[-1]),
                "bytes": f_item.get("bytes"),
                "media_type": str(f_item.get("media_type") or "application/octet-stream"),
                "download_path": f"/v1/agent-tasks/{task_id}/files/{rel}",
            }
        )

    preview_url: str | None = None
    if html_entry is not None and row.get("session_id"):
        subj = _seal_preview_subject(box, task_id, user_id)
        signed = sign_preview(subj, signing_key=signing_key, ttl_seconds=3600)
        preview_url = f"/v1/agent-preview/{signed}/{html_entry}"

    has_response_id = bool(row.get("harness_task_id"))
    created_at: datetime = row["created_at"]
    updated_at: datetime = row.get("updated_at") or created_at

    structured = (
        parse_structured_answer(answer) if feature_key == "search" and not hide_answer else None
    )
    quant_result = (
        parse_quant_evaluation_answer(answer)
        if feature_key == "quant_eval" and not hide_answer
        else None
    )

    return {
        "id": str(task_id),
        "feature_key": feature_key,
        "status": raw_status,
        "incomplete_reason": row.get("incomplete_reason"),
        "query": _summarize_stored_query(feature_key, str(row.get("query_text") or "")),
        "parent_task_id": None if row.get("parent_task_id") is None else str(row["parent_task_id"]),
        "answer": answer,
        "structured_result": structured,
        "quant_result": quant_result,
        "files": public_files,
        "preview_url": preview_url,
        "can_continue": raw_status in ("completed", "incomplete") and has_response_id,
        "created_at": created_at.isoformat(),
        "updated_at": updated_at.isoformat(),
    }


def _settle_response_in_db(
    pool: ConnectionPool,
    hr: HarnessRouter,
    user_id: str,
    task_id: UUID,
    resp_obj: Json,
    known_session_id: str = "",
) -> None:
    response_id = str(resp_obj.get("id") or "")
    rmeta = resp_obj.get("metadata")
    sid = known_session_id or (
        str(rmeta.get("session_id") or "") if isinstance(rmeta, dict) else ""
    )
    final_status = str(resp_obj.get("status") or "failed")
    if final_status not in TERMINAL_STATUSES:
        final_status = "failed"

    raw_files: list[Json] = []
    if sid and final_status != "cancelled":
        try:
            raw_files = hr.list_files(sid, changed=True)
        except HRError:
            raw_files = []
    if not raw_files:
        raw_files = produced_files(resp_obj)
    clean_files = _sanitize_file_entries(raw_files)

    inc_details = resp_obj.get("incomplete_details")
    inc_reason = (
        str(inc_details.get("reason") or "") if isinstance(inc_details, dict) else ""
    ) or None
    text = "" if final_status in ("failed", "cancelled") else answer_text(resp_obj)
    if final_status == "failed":
        logger.warning(
            "HarnessRouter task %s ended with status=failed (response_id=%s)",
            task_id,
            response_id,
        )

    settled_usd = Decimal("0")
    usage = resp_obj.get("usage")
    if isinstance(usage, dict) and usage.get("cost_usd") is not None:
        try:
            settled_usd = max(Decimal("0"), Decimal(str(usage["cost_usd"])))
        except Exception:
            settled_usd = Decimal("0")

    with tenant_transaction(pool, user_id) as conn:
        conn.execute(
            "UPDATE agent_tasks"
            " SET status = %s,"
            "     harness_task_id = COALESCE(NULLIF(%s, ''), harness_task_id),"
            "     session_id = COALESCE(NULLIF(%s, ''), session_id),"
            "     result_text = %s,"
            "     files = %s,"
            "     incomplete_reason = %s,"
            "     updated_at = now()"
            " WHERE id = %s AND status NOT IN ('cancelled')",
            (
                final_status,
                response_id,
                sid,
                text,
                Jsonb(clean_files),
                inc_reason,
                task_id,
            ),
        )
        conn.execute(
            "UPDATE agent_spend SET settled_usd = %s WHERE task_id = %s AND settled_usd IS NULL",
            (settled_usd, task_id),
        )


def _run_task_worker_thread(
    pool: ConnectionPool,
    get_hr: Callable[[], HarnessRouter],
    *,
    task_id: UUID,
    feature_key: FeatureKey,
    harness_id: str,
    user_id: str,
    idempotency_key: str,
    user_input: str,
    previous_response_id: str | None,
    session_id: str | None,
    cost_cap_usd: Decimal,
    timeout_seconds: int,
) -> None:
    key_str = str(task_id)
    with _active_lock:
        _active_tasks.add(key_str)
    captured_sid = session_id or ""
    connected_labels: dict[FeatureKey, str] = {
        "advisor": "Connected to finance advisor",
        "quant_eval": "Connected to CPU quant evaluator",
        "search": "Connected to research agent",
    }
    connected_label = connected_labels[feature_key]
    try:
        hr = get_hr()

        def on_ids(rid: str, sid: str) -> None:
            nonlocal captured_sid
            captured_sid = sid or captured_sid
            with tenant_transaction(pool, user_id) as conn:
                conn.execute(
                    "UPDATE agent_tasks"
                    " SET harness_task_id = %s, session_id = %s, status = 'in_progress',"
                    "     updated_at = now()"
                    " WHERE id = %s AND status NOT IN ('cancelled', 'completed', 'failed')",
                    (rid, captured_sid, task_id),
                )
            publish_progress(key_str, {"kind": "activity", "label": connected_label})

        def on_event(ev: Json) -> None:
            prog = to_progress(ev)
            if prog is not None:
                publish_progress(key_str, prog)

        terminal = hr.run_streamed(
            harness_id,
            user_input,
            previous_response_id=previous_response_id,
            session_id=session_id,
            idempotency_key=idempotency_key,
            user=user_id,
            on_ids=on_ids,
            on_event=on_event,
            timeout_seconds=timeout_seconds,
            max_cost_usd=float(cost_cap_usd),
        )
        _settle_response_in_db(pool, hr, user_id, task_id, terminal, captured_sid)
        publish_progress(
            key_str,
            {"kind": "done", "status": str(terminal.get("status") or "completed")},
        )
    except Exception:
        logger.exception("Agent task %s (%s) failed", task_id, feature_key)
        with tenant_transaction(pool, user_id) as conn:
            conn.execute(
                "UPDATE agent_tasks SET status = 'failed', updated_at = now()"
                " WHERE id = %s AND status NOT IN ('cancelled', 'completed')",
                (task_id,),
            )
            conn.execute(
                "UPDATE agent_spend SET settled_usd = 0 WHERE task_id = %s AND settled_usd IS NULL",
                (task_id,),
            )
        publish_progress(key_str, {"kind": "done", "status": "failed"})
    finally:
        with _active_lock:
            _active_tasks.discard(key_str)


def _get_hr_from_request(request: Request) -> HarnessRouter:
    hr: HarnessRouter | None = getattr(request.app.state, "harness_router", None)
    if hr is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "The finance agent service is not configured yet.",
        )
    return hr


def _fetch_owned_task(pool: ConnectionPool, user_id: str, task_id: UUID) -> dict[str, Any]:
    with tenant_transaction(pool, user_id) as conn, conn.cursor(row_factory=dict_row) as cur:
        row = cur.execute(
            "SELECT id, kind, idempotency_key, cost_cap_usd, timeout_seconds,"
            " harness_task_id, session_id, status, query_text, parent_task_id,"
            " result_text, files, incomplete_reason, created_at, updated_at"
            " FROM agent_tasks WHERE id = %s AND kind IN ('advisor', 'search', 'quant_eval')",
            (task_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Task not found.")
    return row


@router.get("/advisor-context")
def stored_advisor_context(
    request: Request,
    user_id: User,
    scenario_id: Annotated[str, Query(min_length=1, max_length=80)] = "balance-transfer",
) -> dict[str, Any]:
    """Retrieve an immutable synthetic DB record, without account or provider access."""
    pool: ConnectionPool = request.app.state.pool
    with tenant_transaction(pool, user_id) as conn:
        return read_scenario(conn, scenario_id)


@router.get("/quant-bundle")
def build_quant_evaluation_bundle(
    request: Request,
    _user_id: User,
    symbol: Annotated[str, Query(min_length=1, max_length=24)] = "AAPL",
    mode: Annotated[Literal["auto", "stored", "sample"], Query()] = "auto",
) -> dict[str, Any]:
    """Build a self-contained `finance_core` Python + pinned bars evaluation bundle."""
    clean_symbol = symbol.strip().upper()
    pool: ConnectionPool = request.app.state.pool

    available_cycle_symbols: list[str] = []
    stored_match: dict[str, Any] | None = None

    with pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        latest_cycle = cur.execute(
            "SELECT c.id, c.cycle_date, c.model_set_version, c.costs, c.policy_version, p.policy"
            " FROM cycles c"
            " JOIN mode_policies p ON p.version = c.policy_version"
            " ORDER BY c.cycle_date DESC, c.created_at DESC LIMIT 1"
        ).fetchone()

        if latest_cycle is not None:
            sym_rows = cur.execute(
                "SELECT s.symbol, s.sector, count(b.bar_date) AS bar_count"
                " FROM selections s"
                " LEFT JOIN selected_bars b"
                "   ON b.cycle_id = s.cycle_id AND b.symbol = s.symbol"
                " WHERE s.cycle_id = %s"
                " GROUP BY s.symbol, s.sector"
                " HAVING count(b.bar_date) >= 250"
                " ORDER BY s.symbol LIMIT 16",
                (latest_cycle["id"],),
            ).fetchall()
            available_cycle_symbols = [str(r["symbol"]) for r in sym_rows]

            if mode in ("auto", "stored"):
                matched_sel = next(
                    (r for r in sym_rows if str(r["symbol"]).upper() == clean_symbol),
                    None,
                )
                if matched_sel is not None:
                    bar_rows = cur.execute(
                        "SELECT bar_date, open, high, low, close, volume"
                        " FROM selected_bars"
                        " WHERE cycle_id = %s AND symbol = %s"
                        " ORDER BY bar_date",
                        (latest_cycle["id"], matched_sel["symbol"]),
                    ).fetchall()
                    bars_list = [
                        Bar(
                            r["bar_date"].isoformat(),
                            float(r["open"]),
                            float(r["high"]),
                            float(r["low"]),
                            float(r["close"]),
                            float(r["volume"]),
                        )
                        for r in bar_rows
                    ]
                    stored_match = {
                        "cycle_id": str(latest_cycle["id"]),
                        "symbol": str(matched_sel["symbol"]),
                        "sector": str(matched_sel["sector"]),
                        "policy": ModePolicy(**latest_cycle["policy"]),
                        "costs": TradeCosts(**latest_cycle["costs"]),
                        "bars": bars_list,
                    }

    if mode == "stored" and stored_match is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"No stored cycle with >= 250 pinned bars found for {clean_symbol}.",
        )

    if stored_match is not None:
        prompt, pinned = _build_quant_eval_prompt(
            cycle_id=stored_match["cycle_id"],
            symbol=stored_match["symbol"],
            sector=stored_match["sector"],
            policy=stored_match["policy"],
            costs=stored_match["costs"],
            bars=stored_match["bars"],
            data_origin="stored_cycle",
        )
    else:
        sector = _infer_sector(clean_symbol)
        sample_cycle_id = f"sim-cycle-2026-11-18-{clean_symbol.lower().replace('/', '-')}"
        synth_bars = _synthetic_pinned_bars(clean_symbol, count=260)
        prompt, pinned = _build_quant_eval_prompt(
            cycle_id=sample_cycle_id,
            symbol=clean_symbol,
            sector=sector,
            policy=DEFAULT_POLICY,
            costs=DEFAULT_COSTS,
            bars=synth_bars,
            data_origin="synthetic_pinned_260d",
        )

    return {
        "prompt": prompt,
        "pinned_identities": pinned,
        "available_cycle_symbols": available_cycle_symbols,
    }


@router.post("", status_code=status.HTTP_201_CREATED)
def create_agent_task(
    payload: CreateAgentTaskRequest,
    request: Request,
    user_id: User,
) -> dict[str, Any]:
    """Start a new agent task (`advisor`, `quant_eval`, or `search`) or follow up an owned task."""
    _ = _get_hr_from_request(request)
    cleaned_input = payload.input.strip()
    if not cleaned_input:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Please enter a request.")

    pool: ConnectionPool = request.app.state.pool
    box: SecretBox = request.app.state.box
    signing_key: bytes = request.app.state.preview_signing_key

    prev_response_id: str | None = None
    prev_session_id: str | None = None
    parent_id = payload.follow_up_task_id
    resolved_feature: FeatureKey = payload.feature_key or "advisor"

    with tenant_transaction(pool, user_id) as conn, conn.cursor(row_factory=dict_row) as cur:
        if payload.advisor_context is not None:
            if resolved_feature != "advisor" or parent_id is not None:
                raise HTTPException(422, "A DB scenario applies only to a new advisor analysis.")
            selected = payload.advisor_context
            snapshot = read_scenario(conn, selected.scenario_id)
            if (
                selected.scenario_version != snapshot["payload"]["scenario_version"]
                or selected.sha256 != snapshot["sha256"]
            ):
                raise HTTPException(409, "The stored scenario changed. Reload it before analyzing.")
            cleaned_input = analysis_input(cleaned_input, snapshot)
        if parent_id is not None:
            parent = cur.execute(
                "SELECT id, kind, status, harness_task_id, session_id"
                " FROM agent_tasks WHERE id = %s AND kind IN ('advisor', 'search', 'quant_eval')",
                (parent_id,),
            ).fetchone()
            if parent is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Original task not found.")
            parent_feature = _resolve_feature_key(parent["kind"])
            if payload.feature_key is not None and payload.feature_key != parent_feature:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "A follow-up must continue on the same feature as the original task.",
                )
            if parent["status"] not in ("completed", "incomplete") or not parent["harness_task_id"]:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Wait for the current task to finish before sending a follow-up.",
                )
            resolved_feature = parent_feature
            prev_response_id = str(parent["harness_task_id"])
            prev_session_id = str(parent["session_id"]) if parent["session_id"] else None

        target_harness_id = HARNESS_BY_FEATURE[resolved_feature]
        idem_key = str(uuid4())
        inserted = cur.execute(
            "INSERT INTO agent_tasks"
            " (user_id, kind, idempotency_key, cost_cap_usd, timeout_seconds, status,"
            "  query_text, parent_task_id, session_id)"
            " VALUES (%s, %s, %s, %s, %s, 'starting', %s, %s, %s)"
            " RETURNING id, kind, idempotency_key, cost_cap_usd, timeout_seconds,"
            " harness_task_id, session_id, status, query_text, parent_task_id,"
            " result_text, files, incomplete_reason, created_at, updated_at",
            (
                user_id,
                resolved_feature,
                idem_key,
                DEFAULT_COST_CAP_USD,
                DEFAULT_TIMEOUT_SECONDS,
                cleaned_input,
                parent_id,
                prev_session_id,
            ),
        ).fetchone()
        assert inserted is not None  # noqa: S101
        cur.execute(
            "INSERT INTO agent_spend (user_id, task_id, spend_day, reserved_usd)"
            " VALUES (%s, %s, CURRENT_DATE, %s)",
            (user_id, inserted["id"], DEFAULT_COST_CAP_USD),
        )

    app_ref = request.app

    def get_current_hr() -> HarnessRouter:
        hr_client: HarnessRouter = app_ref.state.harness_router
        return hr_client

    worker = threading.Thread(
        target=_run_task_worker_thread,
        kwargs={
            "pool": pool,
            "get_hr": get_current_hr,
            "task_id": inserted["id"],
            "feature_key": resolved_feature,
            "harness_id": target_harness_id,
            "user_id": user_id,
            "idempotency_key": idem_key,
            "user_input": cleaned_input,
            "previous_response_id": prev_response_id,
            "session_id": prev_session_id,
            "cost_cap_usd": DEFAULT_COST_CAP_USD,
            "timeout_seconds": DEFAULT_TIMEOUT_SECONDS,
        },
        daemon=True,
    )
    worker.start()

    return _format_task_for_browser(inserted, user_id=user_id, box=box, signing_key=signing_key)


@router.get("")
def list_agent_tasks(
    request: Request,
    user_id: User,
    feature_key: Annotated[FeatureKey | None, Query()] = None,
) -> dict[str, Any]:
    """Return the signed-in user's recent agent tasks, optionally filtered by `feature_key`."""
    pool: ConnectionPool = request.app.state.pool
    box: SecretBox = request.app.state.box
    signing_key: bytes = request.app.state.preview_signing_key
    with tenant_transaction(pool, user_id) as conn, conn.cursor(row_factory=dict_row) as cur:
        if feature_key is not None:
            rows = cur.execute(
                "SELECT id, kind, idempotency_key, cost_cap_usd, timeout_seconds,"
                " harness_task_id, session_id, status, query_text, parent_task_id,"
                " result_text, files, incomplete_reason, created_at, updated_at"
                " FROM agent_tasks WHERE kind = %s"
                " ORDER BY created_at DESC, id DESC LIMIT 20",
                (feature_key,),
            ).fetchall()
        else:
            rows = cur.execute(
                "SELECT id, kind, idempotency_key, cost_cap_usd, timeout_seconds,"
                " harness_task_id, session_id, status, query_text, parent_task_id,"
                " result_text, files, incomplete_reason, created_at, updated_at"
                " FROM agent_tasks WHERE kind IN ('advisor', 'search', 'quant_eval')"
                " ORDER BY created_at DESC, id DESC LIMIT 20"
            ).fetchall()
    return {
        "tasks": [
            _format_task_for_browser(row, user_id=user_id, box=box, signing_key=signing_key)
            for row in rows
        ]
    }


@router.get("/{task_id}")
def get_agent_task(task_id: UUID, request: Request, user_id: User) -> dict[str, Any]:
    """Return one owned task, recovering via upstream poll if no local stream is active."""
    pool: ConnectionPool = request.app.state.pool
    box: SecretBox = request.app.state.box
    signing_key: bytes = request.app.state.preview_signing_key

    row = _fetch_owned_task(pool, user_id, task_id)
    with _active_lock:
        locally_running = str(task_id) in _active_tasks

    if (
        not locally_running
        and row["status"] not in TERMINAL_STATUSES
        and row.get("harness_task_id")
        and getattr(request.app.state, "harness_router", None) is not None
    ):
        hr: HarnessRouter = request.app.state.harness_router
        try:
            upstream = hr.get_response(str(row["harness_task_id"]))
            if upstream.get("status") in TERMINAL_STATUSES:
                _settle_response_in_db(
                    pool,
                    hr,
                    user_id,
                    task_id,
                    upstream,
                    str(row.get("session_id") or ""),
                )
                row = _fetch_owned_task(pool, user_id, task_id)
        except HRError:
            pass

    return _format_task_for_browser(row, user_id=user_id, box=box, signing_key=signing_key)


@router.get("/{task_id}/events")
async def stream_agent_task_events(
    task_id: UUID, request: Request, user_id: User
) -> StreamingResponse:
    """Stream sanitized SSE progress frames for an owned task."""
    pool: ConnectionPool = request.app.state.pool
    row = await asyncio.to_thread(_fetch_owned_task, pool, user_id, task_id)
    feature_key = _resolve_feature_key(row.get("kind"))
    starting_labels: dict[FeatureKey, str] = {
        "advisor": "Starting financial analysis",
        "quant_eval": "Starting isolated CPU quant evaluation",
        "search": "Starting verification",
    }
    starting_label = starting_labels[feature_key]

    async def event_generator() -> AsyncIterator[bytes]:
        if row["status"] in TERMINAL_STATUSES:
            done_frame = json.dumps({"kind": "done", "status": row["status"]})
            yield f"data: {done_frame}\n\n".encode()
            return

        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[Json] = asyncio.Queue()

        def push(item: Json) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, item)

        unsubscribe = subscribe(str(task_id), push)
        try:
            latest = await asyncio.to_thread(_fetch_owned_task, pool, user_id, task_id)
            if latest["status"] in TERMINAL_STATUSES:
                done_frame = json.dumps({"kind": "done", "status": latest["status"]})
                yield f"data: {done_frame}\n\n".encode()
                return

            start_frame = json.dumps({"kind": "activity", "label": starting_label})
            yield f"data: {start_frame}\n\n".encode()
            while True:
                try:
                    ev = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield f"data: {json.dumps(ev)}\n\n".encode()
                    if ev.get("kind") == "done":
                        break
                except TimeoutError:
                    refreshed = await asyncio.to_thread(_fetch_owned_task, pool, user_id, task_id)
                    if refreshed["status"] in TERMINAL_STATUSES:
                        done_frame = json.dumps({"kind": "done", "status": refreshed["status"]})
                        yield f"data: {done_frame}\n\n".encode()
                        break
                    yield b": keepalive\n\n"
        finally:
            unsubscribe()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "private, no-store",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/{task_id}/cancel")
def cancel_agent_task(task_id: UUID, request: Request, user_id: User) -> dict[str, Any]:
    """Cancel an owned in-progress task."""
    pool: ConnectionPool = request.app.state.pool
    box: SecretBox = request.app.state.box
    signing_key: bytes = request.app.state.preview_signing_key
    row = _fetch_owned_task(pool, user_id, task_id)

    if row["status"] not in TERMINAL_STATUSES:
        hr: HarnessRouter | None = getattr(request.app.state, "harness_router", None)
        if hr is not None and row.get("harness_task_id"):
            try:
                hr.cancel_response(str(row["harness_task_id"]))
            except HRError:
                pass
        with tenant_transaction(pool, user_id) as conn:
            conn.execute(
                "UPDATE agent_tasks SET status = 'cancelled', updated_at = now() WHERE id = %s",
                (task_id,),
            )
            conn.execute(
                "UPDATE agent_spend SET settled_usd = 0 WHERE task_id = %s AND settled_usd IS NULL",
                (task_id,),
            )
        publish_progress(str(task_id), {"kind": "done", "status": "cancelled"})
        row = _fetch_owned_task(pool, user_id, task_id)

    return _format_task_for_browser(row, user_id=user_id, box=box, signing_key=signing_key)


@router.get("/{task_id}/files/{file_path:path}")
def download_agent_task_file(
    task_id: UUID, file_path: str, request: Request, user_id: User
) -> Response:
    """Owner-checked server-side download for a produced session file."""
    hr = _get_hr_from_request(request)
    pool: ConnectionPool = request.app.state.pool
    row = _fetch_owned_task(pool, user_id, task_id)
    sid = str(row.get("session_id") or "")
    if not sid:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found.")
    try:
        st_code, headers, content = download_file(hr, sid, file_path)
    except HRError as err:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "The file could not be retrieved."
        ) from err
    if st_code == 404:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found.")
    return Response(content=content, status_code=st_code, headers=headers)


def create_agent_preview_app(
    pool: ConnectionPool,
    box: SecretBox,
    signing_key: bytes,
    get_hr: Callable[[], HarnessRouter | None],
) -> FastAPI:
    """Sandboxed signed preview app mounted outside bearer-token routes for opaque iframes."""
    preview_app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @preview_app.get("/{token}/{rel_path:path}")
    def serve_preview(token: str, rel_path: str) -> Response:
        not_found = Response(
            content=b"Not found",
            status_code=status.HTTP_404_NOT_FOUND,
            headers={"Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store"},
        )
        subj = verify_preview(token, signing_key=signing_key)
        if subj is None:
            return not_found
        opened = _open_preview_subject(box, subj)
        if opened is None:
            return not_found
        task_id, user_id = opened
        hr = get_hr()
        if hr is None:
            return not_found

        with tenant_transaction(pool, user_id) as conn:
            row = conn.execute(
                "SELECT session_id FROM agent_tasks"
                " WHERE id = %s AND kind IN ('advisor', 'search', 'quant_eval')",
                (task_id,),
            ).fetchone()
        if row is None or not row[0]:
            return not_found
        try:
            st_code, headers, content = preview_file(hr, str(row[0]), "", rel_path)
        except HRError:
            return not_found
        return Response(content=content, status_code=st_code, headers=headers)

    return preview_app


def execute_worker_harness_task(
    pool: ConnectionPool,
    hr: HarnessRouter,
    user_id: str,
    task_id: UUID,
    task_meta: dict[str, Any],
) -> str:
    """Runner compatible with `task_worker.create_task_worker_app` for Cloud Tasks execution."""
    with tenant_transaction(pool, user_id) as conn:
        row = conn.execute(
            "SELECT kind, idempotency_key, query_text, session_id FROM agent_tasks WHERE id = %s",
            (task_id,),
        ).fetchone()
    if row is None:
        raise RuntimeError(f"agent_task {task_id} missing")
    kind, idem_key, query_text, sid = row
    feature_key = _resolve_feature_key(kind)
    target_harness_id = HARNESS_BY_FEATURE[feature_key]
    prompt = str(query_text or "Analyze requested financial scenario")
    terminal = hr.run_streamed(
        target_harness_id,
        prompt,
        session_id=str(sid) if sid else None,
        idempotency_key=str(idem_key),
        user=user_id,
        timeout_seconds=int(task_meta["timeout_seconds"]),
        max_cost_usd=float(task_meta["cost_cap_usd"]),
    )
    _settle_response_in_db(pool, hr, user_id, task_id, terminal, str(sid or ""))
    return answer_text(terminal)
