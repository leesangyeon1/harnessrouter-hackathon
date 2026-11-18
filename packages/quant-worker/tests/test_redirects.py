"""The worker token goes to the configured worker API and nowhere else (I14)."""

import http.server
import threading
import urllib.error
from collections.abc import Callable, Iterator
from typing import Any

import pytest

from quant_worker import WorkerApi

TOKEN = "synthetic-worker-token"  # noqa: S105


class _Server(http.server.HTTPServer):
    """Records the Authorization header of every request, and answers as told."""

    def __init__(self, status: int, location: str | None = None) -> None:
        super().__init__(("127.0.0.1", 0), _Handler)
        self.status = status
        self.location = location
        self.authorizations: list[str | None] = []

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server_address[1]}"


class _Handler(http.server.BaseHTTPRequestHandler):
    server: _Server

    def _answer(self) -> None:
        self.server.authorizations.append(self.headers.get("Authorization"))
        self.send_response(self.server.status)
        if self.server.location is not None:
            self.send_header("Location", self.server.location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    do_GET = do_POST = _answer

    def log_message(self, format: str, *args: Any) -> None:
        pass


def _serving(server: _Server) -> Iterator[_Server]:
    thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
    )
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=10)


@pytest.fixture
def elsewhere() -> Iterator[_Server]:
    """An origin that is not the worker API."""
    yield from _serving(_Server(204))


def _claim(api: WorkerApi) -> object:
    return api.claim()


def _bars(api: WorkerApi) -> object:
    return api.bars("unit")


@pytest.mark.parametrize("call", [_claim, _bars], ids=["POST", "GET"])
@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
def test_redirect_to_another_origin_is_refused_and_the_token_does_not_follow_it(
    elsewhere: _Server, status: int, call: Callable[[WorkerApi], object]
) -> None:
    redirecting = _Server(status, location=f"{elsewhere.url}/worker/v1/claim")
    for worker_api in _serving(redirecting):
        with pytest.raises(urllib.error.HTTPError) as refused:
            call(WorkerApi(worker_api.url, TOKEN))

    assert refused.value.code == status
    assert redirecting.authorizations == [f"Bearer {TOKEN}"]
    assert elsewhere.authorizations == []


def test_redirect_within_the_worker_api_is_refused_too(elsewhere: _Server) -> None:
    elsewhere.status = 307
    elsewhere.location = f"{elsewhere.url}/worker/v1/claim"

    with pytest.raises(urllib.error.HTTPError):
        WorkerApi(elsewhere.url, TOKEN).claim()

    assert elsewhere.authorizations == [f"Bearer {TOKEN}"]


def test_error_answer_leaves_no_connection_open(elsewhere: _Server) -> None:
    elsewhere.status = 409

    with pytest.raises(urllib.error.HTTPError) as refused:
        WorkerApi(elsewhere.url, TOKEN).claim()

    assert refused.value.fp.closed
