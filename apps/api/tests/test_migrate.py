from importlib.resources import files

import psycopg

from finance_api.migrate import apply_migrations


def _migration_files() -> list[str]:
    return sorted(
        entry.name
        for entry in files("finance_api.migrations").iterdir()
        if entry.name.endswith(".sql")
    )


def test_apply_records_every_migration_in_order(fresh_database_url: str) -> None:
    with psycopg.connect(fresh_database_url) as conn:
        applied = apply_migrations(conn)
        recorded = [
            row[0] for row in conn.execute("SELECT version FROM schema_migrations ORDER BY version")
        ]

    assert applied, "no migration was applied to an empty database"
    assert applied == _migration_files()
    assert recorded == applied


def test_second_apply_changes_nothing(fresh_database_url: str) -> None:
    with psycopg.connect(fresh_database_url) as conn:
        apply_migrations(conn)

    with psycopg.connect(fresh_database_url) as conn:
        assert apply_migrations(conn) == []
