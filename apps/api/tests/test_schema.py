"""U1: tables, forced row-level security and tenant isolation (I8)."""

from collections.abc import Iterator
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg_pool import ConnectionPool

from finance_api.db import tenant_transaction

# The plan's U1 lists, by table name.
TENANT_TABLES = [
    "plaid_items",
    "plaid_accounts",
    "plaid_transactions",
    "plaid_liabilities",
    "plaid_holdings",
    "reports",
    "agent_tasks",
    "agent_spend",
    "broker_links",
    "portfolios",
    "runs",
    "targets",
    "orders",
    "fills",
]
SHARED_TABLES = [
    "advisor_demo_scenarios",  # Owner4e7f6f26: global, read-only synthetic comparison seed.
    "assets",
    "bond_etf_list",
    "cycles",
    "screening_figures",
    "selections",
    "selected_bars",
    "work_units",
    "model_results",
    "winners",
    "mode_policies",
    "rewards_rates",
    "reference_rates",
    "worker_tokens",
    "job_events",
]
# D25 keeps roles in PostgreSQL; U1's lists name no table for them.
ROW_SECURED = [*TENANT_TABLES, "user_roles"]


@pytest.fixture
def pool(api_url: str) -> Iterator[ConnectionPool]:
    """The API's pool, held to one connection so every transaction reuses it."""
    with ConnectionPool(api_url, min_size=1, max_size=1) as api_pool:
        yield api_pool


def _add_item(pool: ConnectionPool, user_id: str) -> UUID:
    with tenant_transaction(pool, user_id) as conn:
        row = conn.execute(
            "INSERT INTO plaid_items (user_id, plaid_item_id, access_token_enc)"
            " VALUES (%s, %s, %s) RETURNING id",
            (user_id, f"item-{user_id}", b"ciphertext"),
        ).fetchone()
    assert row is not None
    item_id: UUID = row[0]
    return item_id


def _count_items(conn: psycopg.Connection) -> int:
    row = conn.execute("SELECT count(*) FROM plaid_items").fetchone()
    assert row is not None
    count: int = row[0]
    return count


def test_the_schema_holds_the_planned_tables_and_no_other(migrator_url: str) -> None:
    with psycopg.connect(migrator_url) as conn:
        tables = {
            row[0]
            for row in conn.execute("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
        }

    assert tables == {*TENANT_TABLES, *SHARED_TABLES, "user_roles", "schema_migrations"}


@pytest.mark.parametrize("table", ROW_SECURED)
def test_row_level_security_is_forced(migrator_url: str, table: str) -> None:
    with psycopg.connect(migrator_url) as conn:
        row = conn.execute(
            "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = to_regclass(%s)",
            (f"public.{table}",),
        ).fetchone()

    assert row == (True, True)


def test_every_row_secured_table_has_the_one_tenant_policy(migrator_url: str) -> None:
    with psycopg.connect(migrator_url) as conn:
        policies = conn.execute(
            "SELECT tablename, permissive, roles, cmd, qual, with_check"
            " FROM pg_policies WHERE schemaname = 'public'"
        ).fetchall()

    assert sorted(row[0] for row in policies) == sorted(ROW_SECURED)
    for table, permissive, roles, cmd, qual, with_check in policies:
        assert (permissive, roles, cmd) == ("PERMISSIVE", ["public"], "ALL"), table
        assert qual == with_check, table
    # One expression everywhere; the tests below show that it isolates.
    assert len({row[4] for row in policies}) == 1


def test_api_role_owns_no_table_and_cannot_bypass_rls(api_url: str) -> None:
    with psycopg.connect(api_url) as conn:
        flags = conn.execute(
            "SELECT rolsuper, rolbypassrls FROM pg_roles"
            " WHERE rolname IN (current_user, 'finance_api')"
        ).fetchall()
        owned = conn.execute(
            "SELECT count(*) FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner"
            " WHERE r.rolname IN (current_user, 'finance_api')"
        ).fetchone()

    assert flags == [(False, False), (False, False)]
    assert owned == (0,)


def test_read_across_tenants_returns_no_rows_on_a_reused_connection(
    pool: ConnectionPool,
) -> None:
    alice, bob = uuid4().hex, uuid4().hex
    _add_item(pool, alice)

    with tenant_transaction(pool, bob) as conn:
        assert _count_items(conn) == 0
    with tenant_transaction(pool, alice) as conn:
        assert _count_items(conn) == 1


def test_connection_with_no_tenant_set_sees_no_rows(pool: ConnectionPool) -> None:
    _add_item(pool, uuid4().hex)

    with pool.connection() as conn:
        assert _count_items(conn) == 0


def test_connection_with_no_tenant_set_can_write_no_row(pool: ConnectionPool) -> None:
    _add_item(pool, uuid4().hex)  # leaves the reused connection's setting empty, not absent

    with pytest.raises(psycopg.errors.InsufficientPrivilege), pool.connection() as conn:
        conn.execute(
            "INSERT INTO plaid_items (user_id, plaid_item_id, access_token_enc)"
            " VALUES ('', 'item', %s)",
            (b"ciphertext",),
        )


def test_writing_a_row_for_another_tenant_is_refused(pool: ConnectionPool) -> None:
    alice, bob = uuid4().hex, uuid4().hex

    with pytest.raises(psycopg.errors.InsufficientPrivilege), tenant_transaction(pool, bob) as conn:
        conn.execute(
            "INSERT INTO plaid_items (user_id, plaid_item_id, access_token_enc)"
            " VALUES (%s, 'item', %s)",
            (alice, b"ciphertext"),
        )


def test_child_row_cannot_point_at_another_tenants_row(pool: ConnectionPool) -> None:
    alice, bob = uuid4().hex, uuid4().hex
    alices_item = _add_item(pool, alice)

    with pytest.raises(psycopg.errors.ForeignKeyViolation), tenant_transaction(pool, bob) as conn:
        conn.execute(
            "INSERT INTO plaid_accounts (user_id, item_id, plaid_account_id, type)"
            " VALUES (%s, %s, 'account', 'depository')",
            (bob, alices_item),
        )


def test_table_owner_is_bound_by_the_policy_too(migrator_url: str, pool: ConnectionPool) -> None:
    _add_item(pool, uuid4().hex)

    with psycopg.connect(migrator_url) as conn:
        assert _count_items(conn) == 0


def test_api_role_cannot_grant_itself_a_role(pool: ConnectionPool) -> None:
    user = uuid4().hex

    with (
        pytest.raises(psycopg.errors.InsufficientPrivilege),
        tenant_transaction(pool, user) as conn,
    ):
        conn.execute("INSERT INTO user_roles (user_id, role) VALUES (%s, 'admin')", (user,))
