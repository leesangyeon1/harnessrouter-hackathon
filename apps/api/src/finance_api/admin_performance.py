"""Admin quant performance log & evaluation cycle telemetry.

Protected strictly by `require_admin` (database role verified on every request, D25).
Scoped by evaluation cycle (`cycle_id`) with pinned `model_set_version`, `policy_version`,
`policy_hash`, and `costs_hash`—never conflated with tenant portfolio executor runs.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Annotated, Any
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from finance_api.auth import require_admin
from finance_core.quant import MODEL_IDS, ModePolicy, TradeCosts

router = APIRouter(prefix="/v1/admin", dependencies=[Depends(require_admin)])

MODEL_LABELS: dict[str, str] = {
    "M00": "Buy & Hold Benchmark",
    "M01": "SMA 20/50 Crossover",
    "M02": "EMA 12/26 Crossover",
    "M03": "MACD 12/26/9 Signal",
    "M04": "RSI-14 Mean Reversion",
    "M05": "Bollinger Band Reversion",
    "M06": "Donchian 20/10 Breakout",
    "M07": "60-Day Time-Series Momentum",
    "M08": "Volatility-Scaled Momentum",
    "M10": "Stochastic %D Reversion",
    "M11": "5-Day Short-Term Reversal",
}


def _dec(val: Decimal | None) -> str | None:
    return None if val is None else str(val)


def _iso(val: datetime | None) -> str | None:
    return None if val is None else val.isoformat()


_CYCLES_OVERVIEW_SQL = """
    SELECT
        c.id,
        c.cycle_date,
        c.created_at,
        c.model_set_version,
        c.policy_version,
        COUNT(DISTINCT u.id) AS units_total,
        COUNT(DISTINCT u.id) FILTER (WHERE u.completed_at IS NOT NULL) AS units_completed,
        COUNT(DISTINCT u.id) FILTER (
            WHERE u.completed_at IS NULL AND u.lease_expires_at > now()
        ) AS units_leased,
        COUNT(DISTINCT u.id) FILTER (
            WHERE u.completed_at IS NULL
              AND (u.lease_expires_at IS NULL OR u.lease_expires_at <= now())
        ) AS units_queued,
        (
            SELECT COUNT(*) FROM winners w
            WHERE w.cycle_id = c.id AND w.mode = 'stable' AND w.model_id IS NOT NULL
        ) AS stable_winners_count,
        (
            SELECT COUNT(*) FROM winners w
            WHERE w.cycle_id = c.id AND w.mode = 'aggressive' AND w.model_id IS NOT NULL
        ) AS aggressive_winners_count
    FROM cycles c
    LEFT JOIN work_units u ON u.cycle_id = c.id
    GROUP BY c.id
    ORDER BY c.cycle_date DESC
    LIMIT 30
"""

_CYCLE_DETAIL_SQL = """
    SELECT
        c.id,
        c.cycle_date,
        c.created_at,
        c.model_set_version,
        c.policy_version,
        c.costs,
        c.screens,
        p.policy
    FROM cycles c
    JOIN mode_policies p ON p.version = c.policy_version
    WHERE c.id = %s
"""

_UNITS_SQL = """
    SELECT
        u.id AS unit_id,
        u.symbol,
        s.sector,
        f.mean_dollar_volume,
        f.mean_abs_move,
        u.leased_to,
        u.lease_expires_at,
        u.completed_at,
        CASE
            WHEN u.completed_at IS NOT NULL THEN 'completed'
            WHEN u.lease_expires_at > now() THEN 'leased'
            WHEN u.lease_expires_at IS NOT NULL THEN 'lease_expired'
            ELSE 'queued'
        END AS unit_status,
        (
            SELECT COUNT(*) FROM selected_bars b
            WHERE b.cycle_id = u.cycle_id AND b.symbol = u.symbol
        ) AS bar_count,
        ws.model_id AS stable_winner,
        wa.model_id AS aggressive_winner
    FROM work_units u
    JOIN selections s ON s.cycle_id = u.cycle_id AND s.symbol = u.symbol
    JOIN screening_figures f
      ON f.cycle_id = s.cycle_id AND f.sector = s.sector AND f.symbol = s.symbol
    LEFT JOIN winners ws
      ON ws.cycle_id = u.cycle_id AND ws.symbol = u.symbol AND ws.mode = 'stable'
    LEFT JOIN winners wa
      ON wa.cycle_id = u.cycle_id AND wa.symbol = u.symbol AND wa.mode = 'aggressive'
    WHERE u.cycle_id = %s
    ORDER BY s.sector, u.symbol
"""

_MODEL_RESULTS_SQL = """
    SELECT
        r.symbol,
        s.sector,
        r.model_id,
        r.selection_net_return,
        r.selection_sharpe,
        r.selection_max_drawdown,
        r.confirmation_net_return,
        r.position AS next_position,
        (ws.model_id IS NOT DISTINCT FROM r.model_id AND ws.model_id IS NOT NULL)
            AS is_stable_winner,
        (wa.model_id IS NOT DISTINCT FROM r.model_id AND wa.model_id IS NOT NULL)
            AS is_aggressive_winner
    FROM model_results r
    JOIN selections s ON s.cycle_id = r.cycle_id AND s.symbol = r.symbol
    LEFT JOIN winners ws
      ON ws.cycle_id = r.cycle_id AND ws.symbol = r.symbol AND ws.mode = 'stable'
    LEFT JOIN winners wa
      ON wa.cycle_id = r.cycle_id AND wa.symbol = r.symbol AND wa.mode = 'aggressive'
    WHERE r.cycle_id = %s
    ORDER BY s.sector, r.symbol, r.model_id
"""

_MODEL_AGG_SQL = """
    SELECT
        r.model_id,
        COUNT(*) AS evaluated_symbols,
        COUNT(*) FILTER (WHERE r.confirmation_net_return > 0) AS positive_confirmation_count,
        AVG(r.selection_net_return) AS mean_selection_net_return,
        AVG(r.selection_sharpe) AS mean_selection_sharpe,
        MAX(r.selection_max_drawdown) AS worst_selection_max_drawdown,
        AVG(r.confirmation_net_return) AS mean_confirmation_net_return,
        AVG(r.position) AS mean_next_position,
        (
            SELECT COUNT(*) FROM winners w
            WHERE w.cycle_id = %s AND w.mode = 'stable' AND w.model_id = r.model_id
        ) AS stable_wins,
        (
            SELECT COUNT(*) FROM winners w
            WHERE w.cycle_id = %s AND w.mode = 'aggressive' AND w.model_id = r.model_id
        ) AS aggressive_wins
    FROM model_results r
    WHERE r.cycle_id = %s
    GROUP BY r.model_id
"""

_WORKER_NODES_SQL = """
    SELECT
        wt.id AS worker_id,
        wt.created_at,
        wt.revoked_at,
        COUNT(u.id) FILTER (
            WHERE u.completed_at IS NULL AND u.lease_expires_at > now()
        ) AS active_leases,
        COUNT(u.id) FILTER (
            WHERE u.completed_at IS NOT NULL AND (%s::uuid IS NULL OR u.cycle_id = %s::uuid)
        ) AS completed_units_in_cycle,
        COUNT(u.id) FILTER (WHERE u.completed_at IS NOT NULL) AS completed_units_total,
        MAX(u.completed_at) AS last_completed_at
    FROM worker_tokens wt
    LEFT JOIN work_units u ON u.leased_to = wt.id
    GROUP BY wt.id
    ORDER BY wt.created_at DESC, wt.id
"""

_JOB_EVENTS_SQL = """
    SELECT id, occurred_at, source, event, detail
    FROM job_events
    ORDER BY occurred_at DESC, id DESC
    LIMIT 100
"""


def _build_selected_cycle(conn: psycopg.Connection, target_id: UUID) -> dict[str, Any]:
    with conn.cursor(row_factory=dict_row) as cur:
        detail = cur.execute(_CYCLE_DETAIL_SQL, (target_id,)).fetchone()
        if detail is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "no evaluation cycle has this id")

        policy_obj = ModePolicy(**detail["policy"])
        costs_obj = TradeCosts(**detail["costs"])

        unit_rows = cur.execute(_UNITS_SQL, (target_id,)).fetchall()
        result_rows = cur.execute(_MODEL_RESULTS_SQL, (target_id,)).fetchall()
        agg_rows = {
            row["model_id"]: row
            for row in cur.execute(_MODEL_AGG_SQL, (target_id, target_id, target_id)).fetchall()
        }

    cycle_created_at: datetime = detail["created_at"]
    work_units: list[dict[str, Any]] = []
    completed_timestamps: list[datetime] = []
    status_counts = {"completed": 0, "leased": 0, "lease_expired": 0, "queued": 0}
    stable_confirmed = 0
    aggressive_confirmed = 0

    for row in unit_rows:
        u_status = str(row["unit_status"])
        status_counts[u_status] = status_counts.get(u_status, 0) + 1
        completed_at: datetime | None = row["completed_at"]
        turnaround: float | None = None
        if completed_at is not None:
            completed_timestamps.append(completed_at)
            turnaround = round(max(0.0, (completed_at - cycle_created_at).total_seconds()), 2)
        if row["stable_winner"] is not None:
            stable_confirmed += 1
        if row["aggressive_winner"] is not None:
            aggressive_confirmed += 1
        work_units.append(
            {
                "unit_id": str(row["unit_id"]),
                "symbol": row["symbol"],
                "sector": row["sector"],
                "mean_dollar_volume": str(row["mean_dollar_volume"]),
                "mean_abs_move": _dec(row["mean_abs_move"]),
                "bar_count": int(row["bar_count"]),
                "status": u_status,
                "leased_to": None if row["leased_to"] is None else str(row["leased_to"]),
                "lease_expires_at": _iso(row["lease_expires_at"]),
                "completed_at": _iso(completed_at),
                "turnaround_seconds": turnaround,
                "stable_winner": row["stable_winner"],
                "aggressive_winner": row["aggressive_winner"],
            }
        )

    units_total = len(work_units)
    units_completed = status_counts["completed"]
    completion_pct = round((units_completed / units_total) * 100.0, 1) if units_total else 0.0

    model_summaries: list[dict[str, Any]] = []
    for mid in MODEL_IDS:
        agg = agg_rows.get(mid)
        model_summaries.append(
            {
                "model_id": mid,
                "label": MODEL_LABELS.get(mid, mid),
                "is_benchmark": mid == "M00",
                "evaluated_symbols": int(agg["evaluated_symbols"]) if agg else 0,
                "stable_wins": int(agg["stable_wins"]) if agg else 0,
                "aggressive_wins": int(agg["aggressive_wins"]) if agg else 0,
                "positive_confirmation_count": (
                    int(agg["positive_confirmation_count"]) if agg else 0
                ),
                "mean_selection_net_return": (
                    _dec(agg["mean_selection_net_return"]) if agg else None
                ),
                "mean_selection_sharpe": _dec(agg["mean_selection_sharpe"]) if agg else None,
                "worst_selection_max_drawdown": (
                    _dec(agg["worst_selection_max_drawdown"]) if agg else None
                ),
                "mean_confirmation_net_return": (
                    _dec(agg["mean_confirmation_net_return"]) if agg else None
                ),
                "mean_next_position": _dec(agg["mean_next_position"]) if agg else None,
            }
        )

    model_results: list[dict[str, Any]] = [
        {
            "symbol": row["symbol"],
            "sector": row["sector"],
            "model_id": row["model_id"],
            "model_label": MODEL_LABELS.get(row["model_id"], row["model_id"]),
            "selection_net_return": str(row["selection_net_return"]),
            "selection_sharpe": _dec(row["selection_sharpe"]),
            "selection_max_drawdown": str(row["selection_max_drawdown"]),
            "confirmation_net_return": str(row["confirmation_net_return"]),
            "next_position": str(row["next_position"]),
            "is_stable_winner": bool(row["is_stable_winner"]),
            "is_aggressive_winner": bool(row["is_aggressive_winner"]),
        }
        for row in result_rows
    ]

    return {
        "id": str(detail["id"]),
        "cycle_date": detail["cycle_date"].isoformat(),
        "created_at": cycle_created_at.isoformat(),
        "model_set_version": detail["model_set_version"],
        "policy_version": int(detail["policy_version"]),
        "policy": detail["policy"],
        "policy_hash": policy_obj.digest,
        "costs": detail["costs"],
        "costs_hash": costs_obj.digest,
        "screens": detail["screens"] or {},
        "summary": {
            "units_total": units_total,
            "units_completed": units_completed,
            "units_leased": status_counts["leased"],
            "units_lease_expired": status_counts["lease_expired"],
            "units_queued": status_counts["queued"],
            "completion_pct": completion_pct,
            "model_evaluations_stored": len(model_results),
            "stable_confirmed_count": stable_confirmed,
            "aggressive_confirmed_count": aggressive_confirmed,
            "first_completed_at": _iso(min(completed_timestamps)) if completed_timestamps else None,
            "last_completed_at": _iso(max(completed_timestamps)) if completed_timestamps else None,
        },
        "model_summaries": model_summaries,
        "work_units": work_units,
        "model_results": model_results,
    }


@router.get("/quant-performance")
def get_quant_performance(
    request: Request,
    cycle_id: Annotated[UUID | None, Query()] = None,
) -> dict[str, Any]:
    """Return evaluation-cycle-scoped quant performance metrics, worker stats, and event log."""
    pool: ConnectionPool = request.app.state.pool
    with pool.connection() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cycle_rows = cur.execute(_CYCLES_OVERVIEW_SQL).fetchall()
            event_rows = cur.execute(_JOB_EVENTS_SQL).fetchall()

        cycles_list: list[dict[str, Any]] = [
            {
                "id": str(row["id"]),
                "cycle_date": row["cycle_date"].isoformat(),
                "created_at": row["created_at"].isoformat(),
                "model_set_version": row["model_set_version"],
                "policy_version": int(row["policy_version"]),
                "units_total": int(row["units_total"]),
                "units_completed": int(row["units_completed"]),
                "units_leased": int(row["units_leased"]),
                "units_queued": int(row["units_queued"]),
                "stable_winners_count": int(row["stable_winners_count"]),
                "aggressive_winners_count": int(row["aggressive_winners_count"]),
            }
            for row in cycle_rows
        ]

        chosen_id: UUID | None = cycle_id
        if chosen_id is None and cycle_rows:
            chosen_id = cycle_rows[0]["id"]

        selected_cycle = None if chosen_id is None else _build_selected_cycle(conn, chosen_id)

        with conn.cursor(row_factory=dict_row) as cur:
            worker_rows = cur.execute(_WORKER_NODES_SQL, (chosen_id, chosen_id)).fetchall()

    worker_nodes: list[dict[str, Any]] = [
        {
            "worker_id": str(row["worker_id"]),
            "created_at": row["created_at"].isoformat(),
            "revoked_at": _iso(row["revoked_at"]),
            "active_leases": int(row["active_leases"]),
            "completed_units_in_cycle": int(row["completed_units_in_cycle"]),
            "completed_units_total": int(row["completed_units_total"]),
            "last_completed_at": _iso(row["last_completed_at"]),
        }
        for row in worker_rows
    ]

    event_log: list[dict[str, Any]] = [
        {
            "id": f"evt-{row['id']}",
            "occurred_at": row["occurred_at"].isoformat(),
            "source": row["source"],
            "event": row["event"],
            "detail": row["detail"] or {},
        }
        for row in event_rows
    ]

    # Include cycle creation milestones so cycles ingested before event logging appear in timeline.
    logged_cycle_ids = {
        str(item["detail"].get("cycle_id"))
        for item in event_log
        if isinstance(item["detail"], dict) and item["event"] == "job_succeeded"
    }
    for c_item in cycles_list:
        if c_item["id"] not in logged_cycle_ids:
            event_log.append(
                {
                    "id": f"cycle-{c_item['id']}",
                    "occurred_at": c_item["created_at"],
                    "source": "market-ingest",
                    "event": "cycle_published",
                    "detail": {
                        "cycle_id": c_item["id"],
                        "cycle_date": c_item["cycle_date"],
                        "model_set_version": c_item["model_set_version"],
                        "policy_version": c_item["policy_version"],
                        "units_total": c_item["units_total"],
                    },
                }
            )
    event_log.sort(key=lambda entry: str(entry["occurred_at"]), reverse=True)

    return {
        "cycles": cycles_list,
        "selected_cycle": selected_cycle,
        "worker_nodes": worker_nodes,
        "event_log": event_log[:100],
    }
