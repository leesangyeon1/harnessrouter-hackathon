"""Apply the SQL files of finance_api.migrations, each once, in name order."""

import os
from importlib.resources import files

import psycopg


def apply_migrations(conn: psycopg.Connection) -> list[str]:
    """Apply every migration not yet recorded, in one transaction.

    Returns the versions this call applied.
    """
    newly_applied: list[str] = []
    with conn.transaction():
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            "version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
        )
        recorded = {row[0] for row in conn.execute("SELECT version FROM schema_migrations")}
        migrations = sorted(files("finance_api.migrations").iterdir(), key=lambda entry: entry.name)
        for migration in migrations:
            if not migration.name.endswith(".sql") or migration.name in recorded:
                continue
            conn.execute(migration.read_bytes())
            conn.execute("INSERT INTO schema_migrations (version) VALUES (%s)", (migration.name,))
            newly_applied.append(migration.name)
    return newly_applied


if __name__ == "__main__":
    with psycopg.connect(os.environ["DATABASE_URL"]) as connection:
        for version in apply_migrations(connection):
            print(version)
