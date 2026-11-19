"""Database access, connection pool hardening, and runtime role checks."""

import os
from collections.abc import Iterator
from contextlib import contextmanager

import psycopg
from psycopg_pool import ConnectionPool


def reset_tenant_context(conn: psycopg.Connection) -> None:
    """Clear any session-level tenant setting before returning a connection to the pool."""
    with conn.transaction():
        conn.execute("SELECT set_config('app.user_id', '', false)")


def create_pool(
    conninfo: str,
    *,
    open_pool: bool = False,
    min_size: int | None = None,
    max_size: int | None = None,
    timeout: float | None = None,
) -> ConnectionPool:
    """Create a bounded connection pool that scrubs tenant state on every return."""
    resolved_min = (
        min_size if min_size is not None else int(os.environ.get("DB_POOL_MIN_SIZE", "1"))
    )
    resolved_max = (
        max_size if max_size is not None else int(os.environ.get("DB_POOL_MAX_SIZE", "6"))
    )
    resolved_timeout = (
        timeout if timeout is not None else float(os.environ.get("DB_POOL_TIMEOUT", "10.0"))
    )
    if resolved_min < 0 or resolved_max < 1 or resolved_min > resolved_max:
        raise ValueError("invalid DB pool size bounds")
    return ConnectionPool(
        conninfo,
        open=open_pool,
        min_size=resolved_min,
        max_size=resolved_max,
        timeout=resolved_timeout,
        max_lifetime=1800.0,
        max_idle=300.0,
        reset=reset_tenant_context,
    )


def verify_runtime_role(conn: psycopg.Connection, required_role: str | None = None) -> str | None:
    """Return None if current_user is a non-owner, non-superuser, NOBYPASSRLS runtime role."""
    privileged = conn.execute(
        "SELECT EXISTS ("
        "  SELECT 1 FROM pg_roles"
        "  WHERE pg_has_role(current_user, oid, 'USAGE')"
        "    AND (rolsuper OR rolbypassrls)"
        ")"
    ).fetchone()
    if privileged is None or privileged[0]:
        return "superuser_or_bypassrls"

    owns_tables = conn.execute(
        "SELECT EXISTS ("
        "  SELECT 1 FROM pg_class c"
        "  JOIN pg_namespace n ON n.oid = c.relnamespace"
        "  WHERE n.nspname = 'public'"
        "    AND c.relkind IN ('r', 'p')"
        "    AND pg_has_role(current_user, c.relowner, 'USAGE')"
        ")"
    ).fetchone()
    if owns_tables is None or owns_tables[0]:
        return "owns_public_tables"

    if required_role is not None:
        has_role = conn.execute(
            "SELECT EXISTS ("
            "  SELECT 1 FROM pg_roles"
            "  WHERE rolname = %s AND pg_has_role(current_user, oid, 'USAGE')"
            ")",
            (required_role,),
        ).fetchone()
        if has_role is None or not has_role[0]:
            return "missing_required_role"

    return None


@contextmanager
def tenant_transaction(pool: ConnectionPool, user_id: str) -> Iterator[psycopg.Connection]:
    """One transaction that reads and writes the rows of user_id only (I8).

    The tenant is set for this transaction alone, so the pooled connection
    carries nothing to the next request.
    """
    with pool.connection() as conn, conn.transaction():
        conn.execute("SELECT set_config('app.user_id', %s, true)", (user_id,))
        yield conn
