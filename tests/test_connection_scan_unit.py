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

"""Unit tests for :mod:`data.mesh_ingestor.connection_scan`."""

from __future__ import annotations

import io
import types
from typing import List

import pytest

from data.mesh_ingestor.connection import list_serial_candidates
from data.mesh_ingestor.connection_scan import (
    connection_is_ask,
    resolve_connection_ask,
)
from data.mesh_ingestor.provider import ConnectionCandidate


def test_connection_is_ask_true_for_variants():
    """Whitespace and case are ignored for the ask sentinel."""

    assert connection_is_ask("ask") is True
    assert connection_is_ask(" ASK ") is True
    assert connection_is_ask("Ask") is True


def test_connection_is_ask_false_for_other_values():
    """Non-ask values must not trigger interactive mode."""

    assert connection_is_ask(None) is False
    assert connection_is_ask("") is False
    assert connection_is_ask("/dev/ttyACM0") is False
    assert connection_is_ask("asking") is False


def test_resolve_connection_ask_requires_tty():
    """Non-interactive stdin must exit with guidance."""

    class _P:
        name = "x"

        def list_connection_candidates(self, *, ble_scan_timeout_secs: float):
            return []

    provider = _P()
    stdin = io.StringIO()
    stdout = io.StringIO()
    with pytest.raises(SystemExit, match="TTY"):
        resolve_connection_ask(provider, stdin=stdin, stdout=stdout)


def test_resolve_connection_ask_empty_candidates_manual_entry(monkeypatch):
    """When discovery finds nothing, the user may type a target."""

    class _P:
        name = "meshtastic"

        def list_connection_candidates(self, *, ble_scan_timeout_secs: float):
            return []

    stdin = io.StringIO()
    stdout = io.StringIO()
    stdin.isatty = lambda: True  # type: ignore[method-assign]
    stdin.readline = lambda: "/dev/manual\n"  # type: ignore[method-assign]

    assert resolve_connection_ask(_P(), stdin=stdin, stdout=stdout) == "/dev/manual"


def test_resolve_connection_ask_menu_numeric_choice():
    """A positive integer selects the corresponding candidate."""

    class _P:
        name = "meshtastic"

        def list_connection_candidates(self, *, ble_scan_timeout_secs: float):
            return [
                ConnectionCandidate(target="/dev/a", label="first", kind="serial"),
                ConnectionCandidate(target="AA:BB:CC:DD:EE:FF", label="b", kind="ble"),
            ]

    stdin = io.StringIO("2\n")
    stdout = io.StringIO()
    stdin.isatty = lambda: True  # type: ignore[method-assign]

    assert (
        resolve_connection_ask(_P(), stdin=stdin, stdout=stdout) == "AA:BB:CC:DD:EE:FF"
    )


def test_resolve_connection_ask_zero_then_manual():
    """Choice 0 prompts for a custom connection string."""

    class _P:
        name = "meshcore"

        def list_connection_candidates(self, *, ble_scan_timeout_secs: float):
            return [
                ConnectionCandidate(target="/dev/x", label="x", kind="serial"),
            ]

    stdin = io.StringIO("0\n10.0.0.1:4403\n")
    stdout = io.StringIO()
    stdin.isatty = lambda: True  # type: ignore[method-assign]

    assert resolve_connection_ask(_P(), stdin=stdin, stdout=stdout) == "10.0.0.1:4403"


def test_resolve_connection_ask_invalid_numeric_choice():
    """Out-of-range selection terminates with SystemExit."""

    class _P:
        name = "meshtastic"

        def list_connection_candidates(self, *, ble_scan_timeout_secs: float):
            return [
                ConnectionCandidate(target="a", label="a", kind="serial"),
            ]

    stdin = io.StringIO("9\n")
    stdout = io.StringIO()
    stdin.isatty = lambda: True  # type: ignore[method-assign]

    with pytest.raises(SystemExit, match="out of range"):
        resolve_connection_ask(_P(), stdin=stdin, stdout=stdout)


def test_resolve_connection_ask_non_numeric_choice():
    """Non-integer input is rejected."""

    class _P:
        name = "meshtastic"

        def list_connection_candidates(self, *, ble_scan_timeout_secs: float):
            return [
                ConnectionCandidate(target="a", label="a", kind="serial"),
            ]

    stdin = io.StringIO("no\n")
    stdout = io.StringIO()
    stdin.isatty = lambda: True  # type: ignore[method-assign]

    with pytest.raises(SystemExit, match="Invalid choice"):
        resolve_connection_ask(_P(), stdin=stdin, stdout=stdout)


def test_resolve_connection_ask_eof_on_choice():
    """EOF while reading must exit cleanly."""

    class _P:
        name = "meshtastic"

        def list_connection_candidates(self, *, ble_scan_timeout_secs: float):
            return [
                ConnectionCandidate(target="a", label="a", kind="serial"),
            ]

    stdin = io.StringIO()
    stdout = io.StringIO()
    stdin.isatty = lambda: True  # type: ignore[method-assign]

    with pytest.raises(SystemExit, match="EOF"):
        resolve_connection_ask(_P(), stdin=stdin, stdout=stdout)


def test_resolve_connection_ask_uses_ask_ble_scan_secs_env(monkeypatch):
    """ASK_BLE_SCAN_SECS configures the timeout passed to the provider."""

    monkeypatch.setenv("ASK_BLE_SCAN_SECS", "11")

    captured: List[float] = []

    class _P:
        name = "meshtastic"

        def list_connection_candidates(self, *, ble_scan_timeout_secs: float):
            captured.append(ble_scan_timeout_secs)
            return []

    stdin = io.StringIO("/dev/x\n")
    stdout = io.StringIO()
    stdin.isatty = lambda: True  # type: ignore[method-assign]

    resolve_connection_ask(_P(), stdin=stdin, stdout=stdout)
    assert captured == [11.0]


def test_resolve_connection_ask_invalid_ask_ble_scan_secs_uses_default(monkeypatch):
    """Non-numeric ASK_BLE_SCAN_SECS falls back to the default timeout."""

    monkeypatch.setenv("ASK_BLE_SCAN_SECS", "not-a-number")

    captured: List[float] = []

    class _P:
        name = "meshtastic"

        def list_connection_candidates(self, *, ble_scan_timeout_secs: float):
            captured.append(ble_scan_timeout_secs)
            return []

    stdin = io.StringIO("/dev/x\n")
    stdout = io.StringIO()
    stdin.isatty = lambda: True  # type: ignore[method-assign]

    resolve_connection_ask(_P(), stdin=stdin, stdout=stdout)
    assert captured == [8.0]


def test_resolve_connection_ask_clamps_ble_scan_secs_env(monkeypatch):
    """Very large ASK_BLE_SCAN_SECS values are capped."""

    monkeypatch.setenv("ASK_BLE_SCAN_SECS", "500")

    captured: List[float] = []

    class _P:
        name = "meshtastic"

        def list_connection_candidates(self, *, ble_scan_timeout_secs: float):
            captured.append(ble_scan_timeout_secs)
            return []

    stdin = io.StringIO("/dev/x\n")
    stdout = io.StringIO()
    stdin.isatty = lambda: True  # type: ignore[method-assign]

    resolve_connection_ask(_P(), stdin=stdin, stdout=stdout)
    assert captured == [120.0]


def test_resolve_connection_ask_respects_ble_timeout_override():
    """Explicit ble_scan_timeout_secs must reach list_connection_candidates."""

    captured: List[float] = []

    class _P:
        name = "meshtastic"

        def list_connection_candidates(self, *, ble_scan_timeout_secs: float):
            captured.append(ble_scan_timeout_secs)
            return []

    stdin = io.StringIO("/dev/x\n")
    stdout = io.StringIO()
    stdin.isatty = lambda: True  # type: ignore[method-assign]

    resolve_connection_ask(
        _P(),
        stdin=stdin,
        stdout=stdout,
        ble_scan_timeout_secs=3.5,
    )
    assert captured == [3.5]


def test_list_serial_candidates_ignores_comport_errors(monkeypatch):
    """Exceptions from comports() are swallowed; glob paths still apply."""

    import data.mesh_ingestor.connection as conn

    monkeypatch.setattr(conn, "default_serial_targets", lambda: ["/dev/stable"])

    fake_lp = types.ModuleType("list_ports")

    def _boom():
        raise OSError("permission denied")

    fake_lp.comports = _boom
    assert list_serial_candidates(_list_ports_module=fake_lp) == ["/dev/stable"]


def test_list_serial_candidates_merges_comports(monkeypatch):
    """USB serial devices from pyserial are merged with glob results."""

    import data.mesh_ingestor.connection as conn

    monkeypatch.setattr(conn, "default_serial_targets", lambda: ["/dev/one"])

    class _Port:
        def __init__(self, device: str) -> None:
            self.device = device

    fake_lp = types.ModuleType("list_ports")

    def _comports():
        return [_Port("/dev/two"), _Port("")]

    fake_lp.comports = _comports
    assert list_serial_candidates(_list_ports_module=fake_lp) == [
        "/dev/one",
        "/dev/two",
    ]
