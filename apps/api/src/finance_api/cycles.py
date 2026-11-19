"""The latest cycle's screen, as stored (U5). Shared by every signed-in user."""

from typing import Any

from fastapi import APIRouter, HTTPException, Request, status
from psycopg_pool import ConnectionPool

router = APIRouter(prefix="/v1/cycles")


@router.get("/latest")
def latest_cycle(request: Request) -> dict[str, Any]:
    """Each sector's selections with the universe, feed and coverage it was screened on (I12)."""
    pool: ConnectionPool = request.app.state.pool
    with pool.connection() as conn:
        cycle = conn.execute(
            "SELECT id, cycle_date, model_set_version, policy_version, screens FROM cycles"
            " ORDER BY cycle_date DESC LIMIT 1"
        ).fetchone()
        if cycle is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "no cycle has been created")
        cycle_id, cycle_date, model_set_version, policy_version, screens = cycle
        selected = conn.execute(
            "SELECT f.sector, f.symbol, f.mean_dollar_volume, f.mean_abs_move"
            " FROM selections s JOIN screening_figures f USING (cycle_id, sector, symbol)"
            " WHERE s.cycle_id = %s ORDER BY f.sector, f.mean_abs_move DESC, f.symbol",
            (cycle_id,),
        ).fetchall()
    sectors = {sector: {**screen, "selections": []} for sector, screen in screens.items()}
    for sector, symbol, dollar_volume, move in selected:
        # Figures travel as decimal strings: a JSON number would round them.
        sectors[sector]["selections"].append(
            {"symbol": symbol, "mean_dollar_volume": str(dollar_volume), "mean_abs_move": str(move)}
        )
    return {
        "cycle_date": cycle_date.isoformat(),
        "model_set_version": model_set_version,
        "policy_version": policy_version,
        "sectors": sectors,
    }
