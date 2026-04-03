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

"""Unit tests for :mod:`data.mesh_ingestor.target_selection`."""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from data.mesh_ingestor.target_selection import (  # noqa: E402
    DEFAULT_BLE_SCAN_SECS,
    ble_scan_timeout_seconds,
    gather_connection_choices,
    interactive_pick_connection_target,
    meshcore_ble_advertisement_match,
)


def test_ble_scan_timeout_reads_ble_scan_secs(monkeypatch):
    monkeypatch.setenv("BLE_SCAN_SECS", "3.25")
    assert ble_scan_timeout_seconds() == 3.25


def test_ble_scan_timeout_skips_invalid_env(monkeypatch):
    monkeypatch.setenv("BLE_SCAN_SECS", "nope")
    assert ble_scan_timeout_seconds() == DEFAULT_BLE_SCAN_SECS


def test_ble_scan_timeout_default_when_unset(monkeypatch):
    monkeypatch.delenv("BLE_SCAN_SECS", raising=False)
    assert ble_scan_timeout_seconds() == DEFAULT_BLE_SCAN_SECS


def test_ble_scan_timeout_negative_clamped(monkeypatch):
    monkeypatch.setenv("BLE_SCAN_SECS", "-3")
    assert ble_scan_timeout_seconds() == 0.0


def test_ble_scan_timeout_custom_env_keys_order(monkeypatch):
    """Explicit *env_keys* remains supported for tests and special cases."""
    monkeypatch.setenv("FIRST", "bad")
    monkeypatch.setenv("SECOND", "2")
    assert ble_scan_timeout_seconds(env_keys=("FIRST", "SECOND")) == 2.0


def test_gather_skips_missing_serial_when_required(monkeypatch):
    """Interactive serial filtering must omit absent /dev nodes."""
    import data.mesh_ingestor.target_selection as ts

    monkeypatch.setattr(
        ts, "default_serial_targets", lambda: ["/dev/ghost", "/dev/real"]
    )
    monkeypatch.setattr(ts.os.path, "exists", lambda p: p == "/dev/real")
    rows = gather_connection_choices(
        include_ble=False,
        ble_scan_timeout=0.0,
        ble_match_fn=meshcore_ble_advertisement_match,
        ble_context="test.ble",
        ble_thread_name="test-ble",
        require_existing_serial_paths=True,
    )
    assert [r[0] for r in rows] == ["/dev/real"]


def test_interactive_pick_single_usb_autopicks_without_input(monkeypatch):
    """A sole serial path must still auto-select (no BLE ambiguity)."""

    def _no_input(*_a, **_k):
        raise AssertionError("input() must not be called for a sole USB target")

    monkeypatch.setattr("builtins.input", _no_input)
    out = interactive_pick_connection_target(
        [("/dev/only", "USB  only")],
        provider_label="Test",
        log_context="test.pick",
        refresh_choices=None,
    )
    assert out == "/dev/only"


def test_interactive_pick_single_ble_requires_menu_input(monkeypatch):
    """A sole BLE row must not auto-pick; user confirms from the menu."""
    monkeypatch.setattr("builtins.input", lambda _p="": "1")
    out = interactive_pick_connection_target(
        [("AA:BB:CC:DD:EE:FF", "BLE  x  (AA:BB:CC:DD:EE:FF)")],
        provider_label="Test",
        log_context="test.pick",
        refresh_choices=None,
    )
    assert out == "AA:BB:CC:DD:EE:FF"


def test_interactive_pick_blank_line_calls_refresh(monkeypatch):
    """Empty input with *refresh_choices* re-gathers and redraws the menu."""
    refresh_calls = [0]

    def refresh() -> list[tuple[str, str]]:
        refresh_calls[0] += 1
        return [
            ("11:22:33:44:55:66", "BLE  a"),
            ("AA:BB:CC:DD:EE:FF", "BLE  b"),
            ("CC:DD:EE:FF:00:11", "BLE  c"),
        ]

    initial = [
        ("11:22:33:44:55:66", "BLE  a"),
        ("AA:BB:CC:DD:EE:FF", "BLE  b"),
    ]
    inputs = iter(["", "3"])
    monkeypatch.setattr("builtins.input", lambda _p="": next(inputs))
    monkeypatch.setattr(
        "data.mesh_ingestor.target_selection.config._debug_log", lambda *_a, **_k: None
    )
    out = interactive_pick_connection_target(
        initial,
        provider_label="Test",
        log_context="test.pick",
        refresh_choices=refresh,
    )
    assert out == "CC:DD:EE:FF:00:11"
    assert refresh_calls[0] == 1
