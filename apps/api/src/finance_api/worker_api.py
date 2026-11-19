"""The worker API (U10): a node claims a unit, reads its bars and uploads its result.

A node holds one worker token and nothing else (I14). Every route here requires it, no route
here accepts an ID token, and no route elsewhere accepts a worker token.
"""

import hashlib
from dataclasses import asdict
from typing import Annotated, Any
from uuid import UUID

import psycopg
from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, ConfigDict, Field, FiniteFloat

from finance_api.db import exact
from finance_core.quant import MODEL_IDS, Bar, ModePolicy, TradeCosts, bars_digest

# Assumed. U0 (e) measures how long the models take on a node.
LEASE_SECONDS = 600

_bearer = HTTPBearer(auto_error=False)


def hash_token(token: str) -> bytes:
    """What is stored for a worker token. The token itself is shown once and never stored."""
    return hashlib.sha256(token.encode()).digest()


def current_worker(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> UUID:
    """The id of the caller's worker token. Refuses the request without a live one."""
    pool: ConnectionPool = request.app.state.pool
    if credentials is not None:
        with pool.connection() as conn:
            row = conn.execute(
                "SELECT id FROM worker_tokens WHERE token_hash = %s AND revoked_at IS NULL",
                (hash_token(credentials.credentials),),
            ).fetchone()
        if row is not None:
            worker_id: UUID = row[0]
            return worker_id
    raise HTTPException(
        status.HTTP_401_UNAUTHORIZED, "worker token required", {"WWW-Authenticate": "Bearer"}
    )


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class MetricsIn(_Strict):
    net_return: FiniteFloat
    sharpe: FiniteFloat | None
    max_drawdown: FiniteFloat


class ResultIn(_Strict):
    """One finance_core ModelResult, every identity field included."""

    model_id: str
    model_set_version: str
    policy_version: int
    bars_hash: str
    selection: MetricsIn
    confirmation: MetricsIn
    next_position: Annotated[float, Field(ge=0, le=1)]
    policy_hash: str
    costs_hash: str
    sector: str
    cost_per_side: FiniteFloat


class WinnersIn(_Strict):
    stable: str | None
    aggressive: str | None


class ResultUpload(_Strict):
    results: list[ResultIn]
    winners: WinnersIn


_CLAIM = """
    UPDATE work_units
    SET leased_to = %s, lease_expires_at = now() + make_interval(secs => %s)
    WHERE id = (
        SELECT u.id
        FROM work_units u
        JOIN cycles c ON c.id = u.cycle_id
        WHERE u.completed_at IS NULL
          AND (u.lease_expires_at IS NULL OR u.lease_expires_at <= now())
        ORDER BY c.cycle_date DESC, u.symbol
        LIMIT 1
        FOR UPDATE OF u SKIP LOCKED
    )
    RETURNING id
"""

_UNIT = """
    SELECT u.id, u.cycle_id, u.symbol, u.leased_to, u.lease_expires_at,
           u.completed_at IS NOT NULL AS completed,
           u.lease_expires_at > now() AS lease_live,
           s.sector, c.cycle_date, c.model_set_version, c.costs, c.policy_version, p.policy
    FROM work_units u
    JOIN cycles c ON c.id = u.cycle_id
    JOIN mode_policies p ON p.version = c.policy_version
    JOIN selections s ON s.cycle_id = u.cycle_id AND s.symbol = u.symbol
    WHERE u.id = %s
    FOR UPDATE OF u
"""


def _held_unit(conn: psycopg.Connection, unit_id: UUID, worker_id: UUID) -> dict[str, Any]:
    """The unit with its cycle's pinned inputs, locked, if this worker holds its lease."""
    with conn.cursor(row_factory=dict_row) as cursor:
        unit = cursor.execute(_UNIT, (unit_id,)).fetchone()
    if unit is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such unit")
    if unit["completed"]:
        raise HTTPException(status.HTTP_409_CONFLICT, "the unit already has a result")
    if unit["leased_to"] != worker_id or not unit["lease_live"]:
        raise HTTPException(status.HTTP_409_CONFLICT, "the unit's lease is not held")
    return unit


def _stored_bars(conn: psycopg.Connection, unit: dict[str, Any]) -> list[Bar]:
    rows = conn.execute(
        "SELECT bar_date, open, high, low, close, volume FROM selected_bars"
        " WHERE cycle_id = %s AND symbol = %s ORDER BY bar_date",
        (unit["cycle_id"], unit["symbol"]),
    ).fetchall()
    return [Bar(day.isoformat(), *(float(value) for value in values)) for day, *values in rows]


def _mismatch(unit: dict[str, Any], bars: list[Bar], upload: ResultUpload) -> str | None:
    """Why the result cannot belong to this unit's cycle, or None when it can (I4, I14)."""
    policy = ModePolicy(**unit["policy"])
    costs = TradeCosts(**unit["costs"])
    pinned = (
        unit["model_set_version"],
        unit["policy_version"],
        policy.digest,
        costs.digest,
        bars_digest(bars[-500:]),  # the models use the last 500 bars (D16)
        unit["sector"],
        costs.for_sector(unit["sector"]),
    )
    for result in upload.results:
        named = (
            result.model_set_version,
            result.policy_version,
            result.policy_hash,
            result.costs_hash,
            result.bars_hash,
            result.sector,
            result.cost_per_side,
        )
        if named != pinned:
            return (
                f"{result.model_id} names another model set, policy, costs, sector or set of bars"
            )
    if sorted(result.model_id for result in upload.results) != sorted(MODEL_IDS):
        return "the result must hold each model of the set once"
    for winner in (upload.winners.stable, upload.winners.aggressive):
        if winner is not None and (winner not in MODEL_IDS or winner == "M00"):
            return f"{winner} cannot be a winner"
    return None


def create_worker_app(pool: ConnectionPool) -> FastAPI:
    app = FastAPI(
        dependencies=[Depends(current_worker)], docs_url=None, redoc_url=None, openapi_url=None
    )
    app.state.pool = pool
    worker = Annotated[UUID, Depends(current_worker)]

    @app.post("/claim", response_model=None)
    def claim(worker_id: worker) -> dict[str, Any] | Response:
        """Lease the next unit that has no result and no live lease."""
        with pool.connection() as conn:
            claimed = conn.execute(_CLAIM, (worker_id, LEASE_SECONDS)).fetchone()
            if claimed is None:
                return Response(status_code=status.HTTP_204_NO_CONTENT)
            unit = _held_unit(conn, claimed[0], worker_id)
            conn.execute(
                "INSERT INTO job_events (source, event, detail)"
                " VALUES ('quant_worker', 'unit_claimed', %s)",
                (
                    Jsonb(
                        {
                            "unit_id": str(unit["id"]),
                            "cycle_id": str(unit["cycle_id"]),
                            "cycle_date": unit["cycle_date"].isoformat(),
                            "symbol": unit["symbol"],
                            "sector": unit["sector"],
                            "worker_id": str(worker_id),
                            "lease_expires_at": unit["lease_expires_at"].isoformat(),
                        }
                    ),
                ),
            )
        return {
            "unit_id": str(unit["id"]),
            "cycle_date": unit["cycle_date"].isoformat(),
            "symbol": unit["symbol"],
            "sector": unit["sector"],
            "model_set_version": unit["model_set_version"],
            "policy": unit["policy"],
            "costs": unit["costs"],
            "lease_expires_at": unit["lease_expires_at"].isoformat(),
        }

    @app.get("/units/{unit_id}/bars")
    def bars(unit_id: UUID, worker_id: worker) -> dict[str, Any]:
        with pool.connection() as conn:
            unit = _held_unit(conn, unit_id, worker_id)
            return {"bars": [asdict(bar) for bar in _stored_bars(conn, unit)]}

    @app.post("/units/{unit_id}/result", status_code=status.HTTP_204_NO_CONTENT)
    def upload_result(unit_id: UUID, upload: ResultUpload, worker_id: worker) -> None:
        """Store the unit's result as uploaded. Nothing is computed here (D19)."""
        rejected_detail: dict[str, Any] | None = None
        with pool.connection() as conn:
            unit = _held_unit(conn, unit_id, worker_id)
            reason = _mismatch(unit, _stored_bars(conn, unit), upload)
            if reason is not None:
                rejected_detail = {
                    "unit_id": str(unit_id),
                    "cycle_id": str(unit["cycle_id"]),
                    "cycle_date": unit["cycle_date"].isoformat(),
                    "symbol": unit["symbol"],
                    "sector": unit["sector"],
                    "worker_id": str(worker_id),
                    "reason": reason,
                }
            else:
                ticker = (unit["cycle_id"], unit["symbol"])
                with conn.cursor() as cursor:
                    cursor.executemany(
                        "INSERT INTO model_results (cycle_id, symbol, model_id,"
                        " selection_net_return, selection_sharpe, selection_max_drawdown,"
                        " confirmation_net_return, position)"
                        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                        [
                            (
                                *ticker,
                                result.model_id,
                                exact(result.selection.net_return),
                                exact(result.selection.sharpe),
                                exact(result.selection.max_drawdown),
                                exact(result.confirmation.net_return),
                                exact(result.next_position),
                            )
                            for result in upload.results
                        ],
                    )
                    cursor.executemany(
                        "INSERT INTO winners (cycle_id, symbol, mode, model_id)"
                        " VALUES (%s, %s, %s, %s)",
                        [
                            (*ticker, "stable", upload.winners.stable),
                            (*ticker, "aggressive", upload.winners.aggressive),
                        ],
                    )
                conn.execute("UPDATE work_units SET completed_at = now() WHERE id = %s", (unit_id,))
                conn.execute(
                    "INSERT INTO job_events (source, event, detail)"
                    " VALUES ('quant_worker', 'unit_completed', %s)",
                    (
                        Jsonb(
                            {
                                "unit_id": str(unit_id),
                                "cycle_id": str(unit["cycle_id"]),
                                "cycle_date": unit["cycle_date"].isoformat(),
                                "symbol": unit["symbol"],
                                "sector": unit["sector"],
                                "worker_id": str(worker_id),
                                "models_evaluated": len(upload.results),
                                "stable_winner": upload.winners.stable,
                                "aggressive_winner": upload.winners.aggressive,
                            }
                        ),
                    ),
                )
        if rejected_detail is not None:
            with pool.connection() as log_conn:
                log_conn.execute(
                    "INSERT INTO job_events (source, event, detail)"
                    " VALUES ('quant_worker', 'unit_rejected', %s)",
                    (Jsonb(rejected_detail),),
                )
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, str(rejected_detail["reason"])
            )

    return app
