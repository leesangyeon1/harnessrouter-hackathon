"""Idempotently provision pure-SQL non-privileged login roles after schema migrations.

On Cloud SQL for PostgreSQL, users created via the Cloud SQL Admin API automatically
receive `cloudsqlsuperuser` (which carries `BYPASSRLS`). Creating runtime login roles
purely via SQL as `finance_migrator` ensures `rolsuper = false` and `rolbypassrls = false`.
"""

from __future__ import annotations

import os

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict

from finance_api.migrate import apply_migrations
from finance_api.observability import configure_cloud_logging, register_secret_for_redaction

_RUNTIME_URL_ENVS: tuple[tuple[str, str], ...] = (
    ("BOOTSTRAP_API_DB_URL", "finance_api"),
    ("BOOTSTRAP_CYCLE_DB_URL", "finance_cycle"),
    ("BOOTSTRAP_EXECUTOR_DB_URL", "finance_executor"),
)


def ensure_runtime_login_role(
    conn: psycopg.Connection, login_name: str, password: str, group_role: str
) -> None:
    """Create or update a pure-SQL login role with NOBYPASSRLS and grant group_role."""
    exists = conn.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (login_name,)).fetchone()
    if exists is None:
        conn.execute(
            sql.SQL(
                "CREATE ROLE {} LOGIN PASSWORD {} NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB"
            ).format(sql.Identifier(login_name), sql.Literal(password))
        )
    else:
        # Non-superuser CREATEROLE roles in PostgreSQL 16 cannot specify [NO]SUPERUSER
        # or [NO]BYPASSRLS in ALTER ROLE; verify they remain false instead.
        conn.execute(
            sql.SQL("ALTER ROLE {} WITH LOGIN PASSWORD {} NOCREATEROLE NOCREATEDB").format(
                sql.Identifier(login_name), sql.Literal(password)
            )
        )
    flags = conn.execute(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = %s",
        (login_name,),
    ).fetchone()
    if flags != (False, False):
        raise RuntimeError(f"runtime login role {login_name} has unsafe privilege flags {flags}")
    conn.execute(
        sql.SQL("GRANT {} TO {}").format(sql.Identifier(group_role), sql.Identifier(login_name))
    )


def migrate_and_bootstrap_from_env() -> list[str]:
    configure_cloud_logging()
    migrator_url = os.environ["DATABASE_URL"]
    register_secret_for_redaction(
        migrator_url,
        *(os.environ.get(env_name) for env_name, _ in _RUNTIME_URL_ENVS),
    )
    with psycopg.connect(migrator_url) as conn:
        applied = apply_migrations(conn)
        with conn.transaction():
            for env_name, group_role in _RUNTIME_URL_ENVS:
                raw_url = os.environ.get(env_name, "").strip()
                if not raw_url:
                    continue
                parsed = conninfo_to_dict(raw_url)
                user = parsed.get("user")
                password = parsed.get("password")
                if (
                    not isinstance(user, str)
                    or not isinstance(password, str)
                    or not user
                    or not password
                ):
                    raise ValueError(f"{env_name} must include user and password")
                ensure_runtime_login_role(conn, user, password, group_role)
    return applied


if __name__ == "__main__":
    for version in migrate_and_bootstrap_from_env():
        print(version)
