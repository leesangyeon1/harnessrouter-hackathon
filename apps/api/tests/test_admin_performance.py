"""Admin quant performance log endpoint and worker telemetry tests."""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import asdict
from datetime import date, timedelta
from decimal import Decimal
from typing import Any
from uuid import uuid4

import psycopg
from fastapi.testclient import TestClient
from psycopg.types.json import Jsonb

from finance_api.app import create_app
from finance_api.auth import IdTokenVerifier
from finance_api.db import create_pool
from finance_api.plaid import PlaidClient
from finance_api.sealing import SecretBox
from finance_core.quant import (
    MODEL_IDS,
    MODEL_SET_VERSION,
    Bar,
    ModePolicy,
    TradeCosts,
    evaluate,
    select_winner,
)


def _set_role(migrator_url: str, user_id: str, role: str | None) -> None:
    with psycopg.connect(migrator_url) as conn:
        conn.execute("SELECT set_config('app.user_id', %s, true)", (user_id,))
        conn.execute("DELETE FROM user_roles WHERE user_id = %s", (user_id,))
        if role is not None:
            conn.execute("INSERT INTO user_roles (user_id, role) VALUES (%s, %s)", (user_id, role))


def _sample_bars(length: int = 280) -> list[Bar]:
    bars: list[Bar] = []
    close = 100.0
    for idx in range(length):
        open_ = close
        close = round(100 + 8 * math.sin(idx / 6) + 0.08 * idx, 2)
        bars.append(
            Bar(
                (date(2024, 1, 1) + timedelta(days=idx)).isoformat(),
                open_,
                round(max(open_, close) + 1.0, 2),
                round(min(open_, close) - 1.0, 2),
                close,
                5000.0 + idx,
            )
        )
    return bars


def test_quant_performance_requires_admin_and_reports_cycle_metrics_and_events(
    api_url: str,
    migrator_url: str,
    verifier: IdTokenVerifier,
    make_token: Callable[..., str],
    no_plaid: PlaidClient,
    secret_box: SecretBox,
) -> None:
    with psycopg.connect(migrator_url) as conn:
        conn.execute("DELETE FROM job_events")
        conn.execute("DELETE FROM winners")
        conn.execute("DELETE FROM model_results")
        conn.execute("DELETE FROM work_units")
        conn.execute("DELETE FROM selected_bars")
        conn.execute("DELETE FROM selections")
        conn.execute("DELETE FROM screening_figures")
        conn.execute("DELETE FROM cycles")

    app = create_app(create_pool(api_url, open_pool=False), verifier, no_plaid, secret_box)
    admin_uid = f"perf-admin-{uuid4().hex[:8]}"
    user_uid = f"perf-user-{uuid4().hex[:8]}"
    _set_role(migrator_url, admin_uid, "admin")

    admin_headers = {"Authorization": f"Bearer {make_token(sub=admin_uid)}"}
    user_headers = {"Authorization": f"Bearer {make_token(sub=user_uid)}"}

    with TestClient(app) as client:
        assert client.get("/v1/admin/quant-performance").status_code == 401
        assert client.get("/v1/admin/quant-performance", headers=user_headers).status_code == 403

        empty_resp = client.get("/v1/admin/quant-performance", headers=admin_headers)
        assert empty_resp.status_code == 200
        assert empty_resp.json()["cycles"] == []
        assert empty_resp.json()["selected_cycle"] is None

        # Seed one evaluation cycle with one stock selection and 280 daily bars.
        policy = ModePolicy()
        costs = TradeCosts()
        bars = _sample_bars()
        symbol = "NVDA"
        cycle_day = date(2026, 11, 18)
        with psycopg.connect(migrator_url) as conn:
            conn.execute(
                "INSERT INTO mode_policies (version, policy)"
                " VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (policy.version, Jsonb(asdict(policy))),
            )
            c_row = conn.execute(
                "INSERT INTO cycles (cycle_date, model_set_version, policy_version, costs, screens)"
                " VALUES (%s, %s, %s, %s, %s) RETURNING id",
                (
                    cycle_day,
                    MODEL_SET_VERSION,
                    policy.version,
                    Jsonb(asdict(costs)),
                    Jsonb(
                        {
                            "stock": {
                                "universe": "alpaca_us_equity",
                                "feed": "iex",
                                "coverage": {"provider_listed": 50, "selected": 1},
                            }
                        }
                    ),
                ),
            ).fetchone()
            assert c_row is not None
            cycle_id = c_row[0]
            conn.execute(
                "INSERT INTO screening_figures"
                " (cycle_id, sector, symbol, mean_dollar_volume, mean_abs_move)"
                " VALUES (%s, 'stock', %s, %s, %s)",
                (cycle_id, symbol, Decimal("125000000.50"), Decimal("0.03125")),
            )
            conn.execute(
                "INSERT INTO selections (cycle_id, sector, symbol) VALUES (%s, 'stock', %s)",
                (cycle_id, symbol),
            )
            with conn.cursor() as cur:
                cur.executemany(
                    "INSERT INTO selected_bars"
                    " (cycle_id, symbol, bar_date, open, high, low, close, volume)"
                    " VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                    [
                        (
                            cycle_id,
                            symbol,
                            date.fromisoformat(b.date),
                            Decimal(repr(b.open)),
                            Decimal(repr(b.high)),
                            Decimal(repr(b.low)),
                            Decimal(repr(b.close)),
                            Decimal(repr(b.volume)),
                        )
                        for b in bars
                    ],
                )
            u_row = conn.execute(
                "INSERT INTO work_units (cycle_id, symbol) VALUES (%s, %s) RETURNING id",
                (cycle_id, symbol),
            ).fetchone()
            assert u_row is not None
            unit_id = u_row[0]

        # Issue worker token, claim unit, trigger a rejected upload, then upload valid metrics.
        issued = client.post("/v1/admin/worker-tokens", headers=admin_headers)
        assert issued.status_code == 201
        worker_headers = {"Authorization": f"Bearer {issued.json()['token']}"}

        claimed = client.post("/worker/v1/claim", headers=worker_headers)
        assert claimed.status_code == 200
        assert claimed.json()["unit_id"] == str(unit_id)

        evaluated = evaluate(
            bars, sector="stock", policy_version=policy.version, policy=policy, costs=costs
        )
        stable_w = select_winner(evaluated, "stable", policy=policy, costs=costs)
        aggr_w = select_winner(evaluated, "aggressive", policy=policy, costs=costs)

        valid_payload: dict[str, Any] = {
            "results": [
                {
                    "model_id": r.model_id,
                    "model_set_version": r.model_set_version,
                    "policy_version": r.policy_version,
                    "bars_hash": r.bars_hash,
                    "selection": asdict(r.selection),
                    "confirmation": asdict(r.confirmation),
                    "next_position": r.next_position,
                    "policy_hash": r.policy_hash,
                    "costs_hash": r.costs_hash,
                    "sector": r.sector,
                    "cost_per_side": r.cost_per_side,
                }
                for r in evaluated
            ],
            "winners": {
                "stable": None if stable_w is None else stable_w.model_id,
                "aggressive": None if aggr_w is None else aggr_w.model_id,
            },
        }
        bad_payload = {
            **valid_payload,
            "results": [
                {**valid_payload["results"][0], "model_set_version": "tampered-v9"},
                *valid_payload["results"][1:],
            ],
        }
        assert (
            client.post(
                f"/worker/v1/units/{unit_id}/result",
                headers=worker_headers,
                json=bad_payload,
            ).status_code
            == 422
        )
        assert (
            client.post(
                f"/worker/v1/units/{unit_id}/result",
                headers=worker_headers,
                json=valid_payload,
            ).status_code
            == 204
        )

        perf = client.get(f"/v1/admin/quant-performance?cycle_id={cycle_id}", headers=admin_headers)
        assert perf.status_code == 200
        body = perf.json()
        assert len(body["cycles"]) == 1
        sel = body["selected_cycle"]
        assert sel["id"] == str(cycle_id)
        assert sel["policy_hash"] == policy.digest
        assert sel["costs_hash"] == costs.digest
        assert sel["summary"]["units_total"] == 1
        assert sel["summary"]["units_completed"] == 1
        assert sel["summary"]["completion_pct"] == 100.0
        assert sel["summary"]["model_evaluations_stored"] == len(MODEL_IDS)
        assert len(sel["model_results"]) == len(MODEL_IDS)
        assert len(sel["model_summaries"]) == len(MODEL_IDS)
        assert sel["work_units"][0]["mean_dollar_volume"] == "125000000.50"
        assert sel["work_units"][0]["status"] == "completed"
        assert sel["work_units"][0]["leased_to"] == issued.json()["id"]

        events = {item["event"] for item in body["event_log"]}
        assert {"unit_claimed", "unit_rejected", "unit_completed"} <= events

        assert (
            client.get(
                f"/v1/admin/quant-performance?cycle_id={uuid4()}", headers=admin_headers
            ).status_code
            == 404
        )

        # Removing admin role revokes access immediately without a new token (D25).
        _set_role(migrator_url, admin_uid, None)
        assert client.get("/v1/admin/quant-performance", headers=admin_headers).status_code == 403
