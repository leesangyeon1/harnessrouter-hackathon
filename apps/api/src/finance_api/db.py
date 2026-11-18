"""Database access for the API."""

from collections.abc import Iterator
from contextlib import contextmanager

import psycopg
from psycopg_pool import ConnectionPool


@contextmanager
def tenant_transaction(pool: ConnectionPool, user_id: str) -> Iterator[psycopg.Connection]:
    """One transaction that reads and writes the rows of user_id only (I8).

    The tenant is set for this transaction alone, so the pooled connection
    carries nothing to the next request.
    """
    with pool.connection() as conn, conn.transaction():
        conn.execute("SELECT set_config('app.user_id', %s, true)", (user_id,))
        yield conn
