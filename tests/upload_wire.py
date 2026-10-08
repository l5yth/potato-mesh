# Copyright © 2025-26 l5yth & contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""A stubbed network for the upload tests (SPEC UR1-UR6).

Imported by test modules as ``upload_wire`` (pytest puts ``tests/`` on
``sys.path``, as it does for ``daemon_fakes``); a module imports the fixtures
it uses.  Only ``http.client.HTTPConnection.connect`` and its HTTPS override
are replaced, per host, so no socket is opened and no name is resolved, while
urllib's own error wrapping (``URLError`` while sending, a raw
``TimeoutError`` while reading the reply) runs unmodified.
"""

from __future__ import annotations

import http
import http.client
import io
import json
import sys
import threading
import time
import urllib.request
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import data.mesh_ingestor.config as config  # noqa: E402 - path setup
import data.mesh_ingestor.queue as queue  # noqa: E402
from data.mesh_ingestor import upload_lanes  # noqa: E402

HEALTHY = "dweb.example.test"
FLAKY = "potatomesh.example.test"
ELSEWHERE = "elsewhere.example.test"

_PROXY_VARIABLES = (
    "http_proxy",
    "HTTP_PROXY",
    "https_proxy",
    "HTTPS_PROXY",
    "all_proxy",
    "ALL_PROXY",
)


class Wire:
    """What reached each host's stubbed socket, and how each host answers.

    ``modes`` maps a host to its behaviour: ``ok`` answers 201,
    ``http-<status>`` answers that status (with ``headers[host]`` added or
    overriding), ``connect-timeout`` and ``refused`` fail the connect,
    ``fail-once`` fails one connect and then answers 201, ``read-timeout``
    takes the request and never answers, and ``hang`` blocks the connect
    until :attr:`release` is set and then times out.  :attr:`clock` is the
    virtual time the lanes read.
    """

    def __init__(self, logs: list[tuple[str, dict]]) -> None:
        """Start with no modes, headers or traffic and the clock at 1,000 s.

        Parameters:
            logs: The list the :func:`logs` fixture captures log calls into.
        """

        self.lock = threading.Lock()
        self.modes: dict[str, str] = {}
        self.headers: dict[str, dict[str, str]] = {}
        self.connects: dict[str, int] = {}
        self.requests: dict[str, list[tuple[str, str, object]]] = {}
        self.logs = logs
        self.release = threading.Event()
        self.clock = 1_000.0

    def now(self) -> float:
        """Return the virtual monotonic time."""

        with self.lock:
            return self.clock

    def advance(self, secs: float) -> None:
        """Move the virtual clock forward by ``secs``."""

        with self.lock:
            self.clock += secs

    def record(self, host: str, raw: bytes) -> None:
        """Store the request ``raw`` that reached ``host``."""

        head, _, body = raw.partition(b"\r\n\r\n")
        method, path = head.split(b"\r\n", 1)[0].split()[:2]
        with self.lock:
            self.requests.setdefault(host, []).append(
                (method.decode(), path.decode(), json.loads(body) if body else None)
            )

    def sent(self, host: str, path: str = "/api/messages", key: str = "id") -> list:
        """Return ``key`` of every record POSTed to ``host`` on ``path``, in order."""

        with self.lock:
            return [
                payload.get(key)
                for method, sent_path, payload in self.requests.get(host, [])
                if method == "POST" and sent_path == path and isinstance(payload, dict)
            ]

    def reply(self, host: str, mode: str) -> bytes:
        """Return the raw HTTP reply ``host`` sends in ``mode``."""

        status = 201 if mode == "ok" else int(mode.removeprefix("http-"))
        try:
            reason = http.HTTPStatus(status).phrase
        except ValueError:  # Cloudflare's 52x have no standard phrase
            reason = "Origin Error"
        body = b'{"status":"ok"}' if status < 300 else b'{"error":"refused"}'
        headers = {"Content-Type": "application/json", "Content-Length": str(len(body))}
        headers.update(self.headers.get(host, {}))
        lines = [f"HTTP/1.1 {status} {reason}"]
        lines += [f"{name}: {value}" for name, value in headers.items()]
        return ("\r\n".join(lines) + "\r\n\r\n").encode() + body


class _TimeoutReader:
    """Reply stream of a host that took the request and never answers."""

    def readline(self, *_args):
        """Time out instead of returning the status line."""

        raise TimeoutError("The read operation timed out")

    def close(self) -> None:
        """Nothing to release."""


class _FakeSock:
    """Socket that records the request and plays back the host's reply."""

    def __init__(self, wire: Wire, host: str, mode: str) -> None:
        """Connect to ``host``, which answers as ``mode`` says.

        Parameters:
            wire: Where the request is recorded and the reply comes from.
            host: The host the connection is to.
            mode: The host's behaviour (see :class:`Wire`).
        """

        self.wire, self.host, self.mode = wire, host, mode
        self.buf = b""

    def sendall(self, data: bytes) -> None:
        """Collect the request bytes."""

        self.buf += data

    def makefile(self, *_args, **_kwargs):
        """Record the request (it is on the wire now) and return the reply."""

        self.wire.record(self.host, self.buf)
        if self.mode == "read-timeout":
            return _TimeoutReader()
        return io.BytesIO(self.wire.reply(self.host, self.mode))

    def close(self) -> None:
        """Nothing to release."""


@pytest.fixture
def logs(monkeypatch):
    """Capture every ``config._debug_log`` call as ``(message, fields)``."""

    captured: list[tuple[str, dict]] = []
    monkeypatch.setattr(config, "DEBUG", False)
    monkeypatch.setattr(
        config, "_debug_log", lambda msg, **kw: captured.append((msg, kw))
    )
    return captured


@pytest.fixture
def wire(monkeypatch, logs):
    """Stub the socket layer per host and make the lanes' clock virtual.

    Yields:
        The :class:`Wire`.  A hung connect is let go on teardown.
    """

    w = Wire(logs)

    def fake_connect(conn):
        """Behave as ``w.modes`` says for ``conn.host``."""

        with w.lock:
            mode = w.modes.get(conn.host, "refused")
            w.connects[conn.host] = w.connects.get(conn.host, 0) + 1
            if mode == "fail-once":
                w.modes[conn.host] = "ok"
        if mode == "hang":
            w.release.wait(timeout=10)
            raise TimeoutError("timed out")
        if mode in ("connect-timeout", "fail-once"):
            raise TimeoutError("timed out")
        if mode == "refused":
            raise ConnectionRefusedError(111, "Connection refused")
        conn.sock = _FakeSock(w, conn.host, mode)

    for name in _PROXY_VARIABLES:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(urllib.request, "_opener", None)
    monkeypatch.setattr(queue, "_UPLOAD_OPENER", None)
    monkeypatch.setattr(http.client.HTTPConnection, "connect", fake_connect)
    monkeypatch.setattr(http.client.HTTPSConnection, "connect", fake_connect)
    monkeypatch.setattr(upload_lanes, "_now", w.now)
    yield w
    w.release.set()


def configure_instances(monkeypatch, *hosts: str) -> None:
    """Configure one target instance per host, each with its own token."""

    monkeypatch.setattr(
        config,
        "INSTANCES",
        tuple((f"http://{host}", f"tok-{n}") for n, host in enumerate(hosts)),
    )


@pytest.fixture
def lanes(wire, monkeypatch):
    """Start the delivery threads of a fresh queue for the given hosts.

    Yields:
        ``start(*hosts)``, returning the started :class:`queue.QueueState`.
        Every state is stopped on teardown, after any hung connect is let go.
    """

    states: list[queue.QueueState] = []

    def start(*hosts: str) -> queue.QueueState:
        """Point the ingestor at ``hosts`` and start delivering."""

        configure_instances(monkeypatch, *hosts)
        state = queue.QueueState()
        queue._start_queue_drainer(state)
        states.append(state)
        return state

    yield start
    wire.release.set()
    for state in states:
        queue._stop_queue_drainer(state)


def wait(done, timeout: float = 3.0) -> bool:
    """Poll ``done()`` in real time, without moving any virtual clock.

    Returns:
        Whether ``done()`` held before ``timeout`` seconds passed.
    """

    end = time.monotonic() + timeout
    while not done():
        if time.monotonic() >= end:
            return False
        time.sleep(0.005)
    return True


def _refused(_instance, _api_token, _path, _body) -> upload_lanes.SendResult:
    """Default lane transport of :func:`lane_set`: nothing is ever taken."""

    return upload_lanes.SendResult(upload_lanes.SendOutcome.UNSENT)


def lane_set(*instances: str, send=_refused) -> upload_lanes.LaneSet:
    """Return idle lanes for ``instances``, sending through ``send``."""

    return upload_lanes.LaneSet(
        [(instance, "tok") for instance in instances],
        send=send,
        max_retries=queue._MAX_SEND_RETRIES,
        depth_warning=queue._QUEUE_DEPTH_WARNING_THRESHOLD,
    )
