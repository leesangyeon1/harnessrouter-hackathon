"""U10: the worker API and the quant worker (I4, I14)."""

import copy
import math
import secrets
import socket
import threading
import time
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, replace
from datetime import date, timedelta
from decimal import Decimal
from itertools import count
from typing import Any
from uuid import UUID, uuid4

import httpx
import jwt
import psycopg
import pytest
import uvicorn
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from finance_api.app import create_app
from finance_api.auth import IdTokenVerifier
from finance_api.plaid import PlaidClient
from finance_api.sealing import SecretBox
from finance_api.worker_api import hash_token
from finance_core.quant import (
    MODEL_IDS,
    MODEL_SET_VERSION,
    Bar,
    ModePolicy,
    TradeCosts,
    evaluate,
    select_winner,
)
from quant_worker import WorkerApi, run_once

Body = dict[str, Any]

_cycle_days = count()


@dataclass(frozen=True)
class Unit:
    id: UUID
    cycle_id: UUID
    symbol: str
    bars: list[Bar]
    policy: ModePolicy
    costs: TradeCosts


@pytest.fixture(scope="module")
def api(
    _migrated_urls: tuple[str, str], no_plaid: PlaidClient, secret_box: SecretBox
) -> Iterator[str]:
    """Base URL of the service, listening on a free loopback port."""

    def no_id_token(token: str) -> jwt.PyJWK:
        raise jwt.PyJWKClientError("no ID token is valid in these tests")

    app = create_app(
        ConnectionPool(_migrated_urls[1], open=False),
        IdTokenVerifier("demo-project", no_id_token),
        no_plaid,
        secret_box,
    )
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
    thread.start()
    try:
        while not server.started:
            assert thread.is_alive(), "the service did not start"
            time.sleep(0.01)
        yield f"http://127.0.0.1:{listener.getsockname()[1]}"
    finally:
        server.should_exit = True
        thread.join(timeout=10)


@pytest.fixture(autouse=True)
def no_unit_left_by_another_test(migrator_url: str) -> None:
    with psycopg.connect(migrator_url) as conn:
        conn.execute("DELETE FROM work_units")


def _bars(length: int = 300) -> list[Bar]:
    """Daily bars that rise and fall, to the cent."""
    bars = []
    close = 100.0
    for day in range(length):
        open_ = close
        close = round(100 + 10 * math.sin(day / 7) + 0.05 * day, 2)
        bars.append(
            Bar(
                (date(2020, 1, 1) + timedelta(days=day)).isoformat(),
                open_,
                round(max(open_, close) + 1, 2),
                round(min(open_, close) - 1, 2),
                close,
                1000.0 + day,
            )
        )
    return bars


def _seed_unit(migrator_url: str, policy: ModePolicy | None = None) -> Unit:
    """One cycle with one selected ticker, its bars and its work unit, as the cycle job would."""
    policy = policy or ModePolicy()
    costs = TradeCosts()
    bars = _bars()
    symbol = "AAA"
    with psycopg.connect(migrator_url) as conn:
        conn.execute(
            "INSERT INTO mode_policies (version, policy) VALUES (%s, %s) ON CONFLICT DO NOTHING",
            (policy.version, Jsonb(asdict(policy))),
        )
        cycle = conn.execute(
            "INSERT INTO cycles (cycle_date, model_set_version, policy_version, costs)"
            " VALUES (%s, %s, %s, %s) RETURNING id",
            (
                date(2001, 1, 1) + timedelta(days=next(_cycle_days)),
                MODEL_SET_VERSION,
                policy.version,
                Jsonb(asdict(costs)),
            ),
        ).fetchone()
        assert cycle is not None
        conn.execute(
            "INSERT INTO screening_figures (cycle_id, sector, symbol, mean_dollar_volume)"
            " VALUES (%s, 'stock', %s, 1)",
            (cycle[0], symbol),
        )
        conn.execute(
            "INSERT INTO selections (cycle_id, sector, symbol) VALUES (%s, 'stock', %s)",
            (cycle[0], symbol),
        )
        with conn.cursor() as cursor:
            cursor.executemany(
                "INSERT INTO selected_bars"
                " (cycle_id, symbol, bar_date, open, high, low, close, volume)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                [
                    (
                        cycle[0],
                        symbol,
                        date.fromisoformat(bar.date),
                        *(
                            Decimal(repr(value))
                            for value in (bar.open, bar.high, bar.low, bar.close, bar.volume)
                        ),
                    )
                    for bar in bars
                ],
            )
        unit = conn.execute(
            "INSERT INTO work_units (cycle_id, symbol) VALUES (%s, %s) RETURNING id",
            (cycle[0], symbol),
        ).fetchone()
        assert unit is not None
    return Unit(unit[0], cycle[0], symbol, bars, policy, costs)


def _worker_token(migrator_url: str) -> str:
    token = secrets.token_urlsafe(32)
    with psycopg.connect(migrator_url) as conn:
        conn.execute("INSERT INTO worker_tokens (token_hash) VALUES (%s)", (hash_token(token),))
    return token


def _expire_lease(migrator_url: str, unit_id: UUID) -> None:
    with psycopg.connect(migrator_url) as conn:
        conn.execute(
            "UPDATE work_units SET lease_expires_at = now() - interval '1 second' WHERE id = %s",
            (unit_id,),
        )


def _rows(migrator_url: str, query: str, unit: Unit) -> list[tuple[Any, ...]]:
    with psycopg.connect(migrator_url) as conn:
        return conn.execute(query.encode(), (unit.cycle_id, unit.symbol)).fetchall()


def _stored_results(migrator_url: str, unit: Unit) -> list[tuple[Any, ...]]:
    return _rows(
        migrator_url,
        "SELECT model_id, selection_net_return, selection_sharpe, selection_max_drawdown,"
        " confirmation_net_return, position FROM model_results"
        " WHERE cycle_id = %s AND symbol = %s ORDER BY model_id",
        unit,
    )


def _stored_winners(migrator_url: str, unit: Unit) -> dict[str, str | None]:
    query = "SELECT mode, model_id FROM winners WHERE cycle_id = %s AND symbol = %s"
    return dict(_rows(migrator_url, query, unit))


def _is_completed(migrator_url: str, unit: Unit) -> bool:
    query = "SELECT completed_at IS NOT NULL FROM work_units WHERE cycle_id = %s AND symbol = %s"
    completed: bool = _rows(migrator_url, query, unit)[0][0]
    return completed


def _call(api: str, token: str, method: str, path: str, body: Body | None = None) -> httpx.Response:
    return httpx.request(
        method,
        f"{api}{path}",
        headers={"Authorization": f"Bearer {token}"},
        json=body,
        timeout=30,
    )


def _claim(api: str, token: str) -> Body | None:
    response = _call(api, token, "POST", "/worker/v1/claim")
    if response.status_code == 204:
        return None
    assert response.status_code == 200, response.text
    claimed: Body = response.json()
    return claimed


def _upload(api: str, token: str, claimed: Body, body: Body) -> httpx.Response:
    return _call(api, token, "POST", f"/worker/v1/units/{claimed['unit_id']}/result", body)


def _result_body(api: str, token: str, claimed: Body) -> Body:
    """What a node computes for a claimed unit."""
    policy = ModePolicy(**claimed["policy"])
    costs = TradeCosts(**claimed["costs"])
    response = _call(api, token, "GET", f"/worker/v1/units/{claimed['unit_id']}/bars")
    assert response.status_code == 200, response.text
    bars = [Bar(**row) for row in response.json()["bars"]]
    results = evaluate(bars, sector=claimed["sector"], policy=policy, costs=costs)
    winners = {}
    for mode in ("stable", "aggressive"):
        winner = select_winner(results, mode, policy=policy, costs=costs)
        winners[mode] = None if winner is None else winner.model_id
    return {"results": [asdict(result) for result in results], "winners": winners}


def _exact(value: float | None) -> Decimal | None:
    return None if value is None else Decimal(repr(value))


def test_claim_hands_out_the_unit_with_the_inputs_its_cycle_pinned(
    api: str, migrator_url: str
) -> None:
    unit = _seed_unit(migrator_url)

    claimed = _claim(api, _worker_token(migrator_url))

    assert claimed is not None
    assert claimed["unit_id"] == str(unit.id)
    assert (claimed["symbol"], claimed["sector"]) == ("AAA", "stock")
    assert claimed["model_set_version"] == MODEL_SET_VERSION
    assert ModePolicy(**claimed["policy"]) == unit.policy
    assert TradeCosts(**claimed["costs"]) == unit.costs


def test_unit_is_claimed_by_one_of_two_workers_that_ask_together(
    api: str, migrator_url: str
) -> None:
    tokens = [_worker_token(migrator_url), _worker_token(migrator_url)]

    for _ in range(10):
        with psycopg.connect(migrator_url) as conn:
            conn.execute("DELETE FROM work_units")
        _seed_unit(migrator_url)
        together = threading.Barrier(2)

        def ask(token: str, together: threading.Barrier = together) -> Body | None:
            together.wait()
            return _claim(api, token)

        with ThreadPoolExecutor(2) as workers:
            answers = list(workers.map(ask, tokens))

        assert sum(answer is not None for answer in answers) == 1


def test_expired_lease_returns_the_unit_to_be_claimed(api: str, migrator_url: str) -> None:
    unit = _seed_unit(migrator_url)
    first, second = _worker_token(migrator_url), _worker_token(migrator_url)
    assert _claim(api, first) is not None
    assert _claim(api, second) is None

    _expire_lease(migrator_url, unit.id)

    claimed = _claim(api, second)
    assert claimed is not None
    assert claimed["unit_id"] == str(unit.id)


def test_bars_a_worker_reads_equal_the_stored_bars(api: str, migrator_url: str) -> None:
    unit = _seed_unit(migrator_url)
    token = _worker_token(migrator_url)
    claimed = _claim(api, token)
    assert claimed is not None

    response = _call(api, token, "GET", f"/worker/v1/units/{claimed['unit_id']}/bars")

    assert [Bar(**row) for row in response.json()["bars"]] == unit.bars


def test_bars_are_refused_to_a_worker_that_does_not_hold_the_lease(
    api: str, migrator_url: str
) -> None:
    unit = _seed_unit(migrator_url)
    assert _claim(api, _worker_token(migrator_url)) is not None

    other = _worker_token(migrator_url)
    response = _call(api, other, "GET", f"/worker/v1/units/{unit.id}/bars")

    assert response.status_code == 409


def test_accepted_result_is_stored_as_uploaded(api: str, migrator_url: str) -> None:
    unit = _seed_unit(migrator_url)
    token = _worker_token(migrator_url)
    claimed = _claim(api, token)
    assert claimed is not None
    body = _result_body(api, token, claimed)

    response = _upload(api, token, claimed, body)

    assert response.status_code == 204, response.text
    uploaded = sorted(body["results"], key=lambda result: result["model_id"])
    assert _stored_results(migrator_url, unit) == [
        (
            result["model_id"],
            _exact(result["selection"]["net_return"]),
            _exact(result["selection"]["sharpe"]),
            _exact(result["selection"]["max_drawdown"]),
            _exact(result["confirmation"]["net_return"]),
            _exact(result["next_position"]),
        )
        for result in uploaded
    ]
    assert [result["model_id"] for result in uploaded] == sorted(MODEL_IDS)
    assert _stored_winners(migrator_url, unit) == body["winners"]
    assert _is_completed(migrator_url, unit)


def test_upload_repeated_after_a_lost_response_adds_no_rows(api: str, migrator_url: str) -> None:
    unit = _seed_unit(migrator_url)
    token = _worker_token(migrator_url)
    claimed = _claim(api, token)
    assert claimed is not None
    body = _result_body(api, token, claimed)
    assert _upload(api, token, claimed, body).status_code == 204
    first = _stored_results(migrator_url, unit)

    repeat = _upload(api, token, claimed, body)

    assert repeat.status_code == 409
    assert _stored_results(migrator_url, unit) == first
    assert len(_stored_winners(migrator_url, unit)) == 2


def test_second_result_for_a_unit_is_refused_and_the_first_stands(
    api: str, migrator_url: str
) -> None:
    unit = _seed_unit(migrator_url)
    token = _worker_token(migrator_url)
    claimed = _claim(api, token)
    assert claimed is not None
    body = _result_body(api, token, claimed)
    assert _upload(api, token, claimed, body).status_code == 204
    first = _stored_results(migrator_url, unit)

    other = copy.deepcopy(body)
    other["results"][1]["selection"]["net_return"] += 1
    second = _upload(api, token, claimed, other)

    assert second.status_code == 409
    assert _stored_results(migrator_url, unit) == first


def _in_one_result(field: str, value: Any) -> Callable[[Body], None]:
    def change(body: Body) -> None:
        body["results"][3][field] = value

    return change


def _drop_a_model(body: Body) -> None:
    body["results"].pop()


def _name_a_model_twice(body: Body) -> None:
    body["results"][1] = copy.deepcopy(body["results"][2])


def _winner(mode: str, model_id: str) -> Callable[[Body], None]:
    def change(body: Body) -> None:
        body["winners"][mode] = model_id

    return change


MISMATCHES: dict[str, Callable[[Body], None]] = {
    "lacks a model": _drop_a_model,
    "names a model twice": _name_a_model_twice,
    "another model-set version": _in_one_result("model_set_version", "daily-v0"),
    "another policy version": _in_one_result("policy_version", 99),
    "another policy": _in_one_result("policy_hash", "0" * 64),
    "other costs": _in_one_result("costs_hash", "0" * 64),
    "another cost per side": _in_one_result("cost_per_side", 0.5),
    "another set of bars": _in_one_result("bars_hash", "0" * 64),
    "another sector": _in_one_result("sector", "crypto"),
    "a position above one": _in_one_result("next_position", 1.5),
    "a field the contract does not have": _in_one_result("extra", 1),
    "a winner that cannot win": _winner("stable", "M00"),
    "a winner outside the model set": _winner("aggressive", "M99"),
}


@pytest.mark.parametrize("change", MISMATCHES.values(), ids=MISMATCHES.keys())
def test_result_that_does_not_match_the_cycle_is_refused(
    api: str, migrator_url: str, change: Callable[[Body], None]
) -> None:
    unit = _seed_unit(migrator_url)
    token = _worker_token(migrator_url)
    claimed = _claim(api, token)
    assert claimed is not None
    body = _result_body(api, token, claimed)
    mismatched = copy.deepcopy(body)
    change(mismatched)

    refused = _upload(api, token, claimed, mismatched)

    assert refused.status_code == 422, refused.text
    assert _stored_results(migrator_url, unit) == []
    assert _stored_winners(migrator_url, unit) == {}
    assert not _is_completed(migrator_url, unit)
    # The refusal leaves the unit open: the matching result is still accepted.
    assert _upload(api, token, claimed, body).status_code == 204


def test_only_the_result_computed_under_the_cycles_policy_version_is_accepted(
    api: str, migrator_url: str
) -> None:
    newer = replace(ModePolicy(), version=2, stable_max_drawdown=0.1)
    unit = _seed_unit(migrator_url, policy=newer)
    token = _worker_token(migrator_url)
    claimed = _claim(api, token)
    assert claimed is not None
    under_old_policy = _result_body(api, token, claimed | {"policy": asdict(ModePolicy())})
    under_cycle_policy = _result_body(api, token, claimed)

    assert _upload(api, token, claimed, under_old_policy).status_code == 422
    assert _upload(api, token, claimed, under_cycle_policy).status_code == 204
    assert len(_stored_results(migrator_url, unit)) == len(MODEL_IDS)


def test_upload_under_an_expired_lease_is_refused(api: str, migrator_url: str) -> None:
    unit = _seed_unit(migrator_url)
    token = _worker_token(migrator_url)
    claimed = _claim(api, token)
    assert claimed is not None
    body = _result_body(api, token, claimed)

    _expire_lease(migrator_url, unit.id)
    response = _upload(api, token, claimed, body)

    assert response.status_code == 409
    assert _stored_results(migrator_url, unit) == []


def test_upload_under_a_lease_that_passed_to_another_worker_is_refused(
    api: str, migrator_url: str
) -> None:
    unit = _seed_unit(migrator_url)
    first, second = _worker_token(migrator_url), _worker_token(migrator_url)
    claimed = _claim(api, first)
    assert claimed is not None
    body = _result_body(api, first, claimed)
    _expire_lease(migrator_url, unit.id)
    assert _claim(api, second) is not None

    late = _upload(api, first, claimed, body)

    assert late.status_code == 409
    assert _stored_results(migrator_url, unit) == []
    assert _upload(api, second, claimed, body).status_code == 204


def test_worker_on_an_older_version_is_refused_and_a_current_one_completes_the_unit(
    api: str, migrator_url: str
) -> None:
    unit = _seed_unit(migrator_url)
    older, current = _worker_token(migrator_url), _worker_token(migrator_url)
    claimed = _claim(api, older)
    assert claimed is not None
    body = _result_body(api, older, claimed)
    from_older_version = copy.deepcopy(body)
    for result in from_older_version["results"]:
        result["model_set_version"] = "daily-v0"

    assert _upload(api, older, claimed, from_older_version).status_code == 422

    _expire_lease(migrator_url, unit.id)
    assert _claim(api, current) is not None
    assert _upload(api, current, claimed, body).status_code == 204
    assert _is_completed(migrator_url, unit)


def test_request_with_no_worker_token_is_refused(api: str) -> None:
    assert httpx.post(f"{api}/worker/v1/claim", timeout=30).status_code == 401


def test_unknown_worker_token_is_refused(api: str) -> None:
    assert _call(api, secrets.token_urlsafe(32), "POST", "/worker/v1/claim").status_code == 401


def test_revoked_worker_token_is_refused(api: str, migrator_url: str) -> None:
    token = _worker_token(migrator_url)
    assert _call(api, token, "POST", "/worker/v1/claim").status_code == 204

    with psycopg.connect(migrator_url) as conn:
        conn.execute(
            "UPDATE worker_tokens SET revoked_at = now() WHERE token_hash = %s",
            (hash_token(token),),
        )

    assert _call(api, token, "POST", "/worker/v1/claim").status_code == 401


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/v1/me"),
        ("GET", "/v1/admin/worker-tokens"),
        ("POST", "/v1/admin/worker-tokens"),
        ("DELETE", f"/v1/admin/worker-tokens/{uuid4()}"),
    ],
)
def test_worker_token_is_refused_outside_the_worker_api(
    api: str, migrator_url: str, method: str, path: str
) -> None:
    assert _call(api, _worker_token(migrator_url), method, path).status_code == 401


def test_policy_row_must_name_its_own_version(migrator_url: str) -> None:
    mislabelled = Jsonb(asdict(replace(ModePolicy(), version=7)))

    with pytest.raises(psycopg.errors.CheckViolation), psycopg.connect(migrator_url) as conn:
        conn.execute("INSERT INTO mode_policies (version, policy) VALUES (8, %s)", (mislabelled,))


def test_worker_computes_and_uploads_the_unit_it_claims(api: str, migrator_url: str) -> None:
    unit = _seed_unit(migrator_url)

    worked = run_once(WorkerApi(api, _worker_token(migrator_url)))

    assert worked
    expected = evaluate(unit.bars, sector="stock", policy=unit.policy, costs=unit.costs)
    assert _stored_results(migrator_url, unit) == [
        (
            result.model_id,
            _exact(result.selection.net_return),
            _exact(result.selection.sharpe),
            _exact(result.selection.max_drawdown),
            _exact(result.confirmation.net_return),
            _exact(result.next_position),
        )
        for result in sorted(expected, key=lambda result: result.model_id)
    ]
    winners = {}
    for mode in ("stable", "aggressive"):
        winner = select_winner(expected, mode, policy=unit.policy, costs=unit.costs)
        winners[mode] = None if winner is None else winner.model_id
    assert _stored_winners(migrator_url, unit) == winners
    assert _is_completed(migrator_url, unit)


def test_worker_with_nothing_to_claim_does_not_fail(api: str, migrator_url: str) -> None:
    assert run_once(WorkerApi(api, _worker_token(migrator_url))) is False


def test_worker_learns_that_its_upload_was_not_accepted(api: str, migrator_url: str) -> None:
    unit = _seed_unit(migrator_url)
    token = _worker_token(migrator_url)
    claimed = _claim(api, token)
    assert claimed is not None
    body = _result_body(api, token, claimed)
    _expire_lease(migrator_url, unit.id)

    accepted = WorkerApi(api, token).upload(claimed["unit_id"], body)

    assert accepted is False


def test_worker_refuses_an_address_that_is_neither_https_nor_loopback() -> None:
    with pytest.raises(ValueError, match="HTTPS"):
        WorkerApi("http://example.com", "token")
