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
"""Unit tests for :mod:`data.mesh_ingestor.connection`."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from data.mesh_ingestor.connection import (  # noqa: E402
    BLE_ADDRESS_RE,
    DEFAULT_TCP_PORT,
    default_serial_targets,
    parse_ble_target,
    parse_tcp_target,
)

# ---------------------------------------------------------------------------
# parse_ble_target
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value,expected",
    [
        # MAC addresses — returned upper-cased
        ("AA:BB:CC:DD:EE:FF", "AA:BB:CC:DD:EE:FF"),
        ("aa:bb:cc:dd:ee:ff", "AA:BB:CC:DD:EE:FF"),
        ("AA:BB:CC:DD:EE:12", "AA:BB:CC:DD:EE:12"),
        # UUID (macOS format)
        (
            "12345678-1234-1234-1234-123456789abc",
            "12345678-1234-1234-1234-123456789ABC",
        ),
        (
            "12345678-1234-1234-1234-123456789ABC",
            "12345678-1234-1234-1234-123456789ABC",
        ),
    ],
)
def test_parse_ble_target_accepts_ble_addresses(value, expected):
    """parse_ble_target must return the normalised address for valid BLE formats."""
    assert parse_ble_target(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        "/dev/ttyUSB0",
        "/dev/ttyACM0",
        "COM3",
        "hostname:4403",
        "192.168.1.1:4403",
        "",
        "   ",
        "AA:BB:CC:DD:EE",  # too short — only 5 groups
        "ZZ:BB:CC:DD:EE:FF",  # invalid hex
    ],
)
def test_parse_ble_target_rejects_non_ble(value):
    """parse_ble_target must return None for serial paths, TCP targets, and malformed inputs."""
    assert parse_ble_target(value) is None


def test_parse_ble_target_none_input():
    """parse_ble_target must return None for None input."""
    assert parse_ble_target(None) is None  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# parse_tcp_target
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value,expected_host,expected_port",
    [
        # hostname:port
        ("meshcore-node.local:4403", "meshcore-node.local", 4403),
        ("meshnode.local:4403", "meshnode.local", 4403),
        ("hostname:1234", "hostname", 1234),
        ("otherhost:80", "otherhost", 80),
        # IP:port
        ("192.168.1.1:4403", "192.168.1.1", 4403),
        ("10.0.0.1:9000", "10.0.0.1", 9000),
        # With scheme prefix
        ("tcp://meshnode.local:4403", "meshnode.local", 4403),
        ("http://192.168.1.1:4403", "192.168.1.1", 4403),
        # IPv6 with brackets
        ("[::1]:4403", "::1", 4403),
        ("[2001:db8::1]:8080", "2001:db8::1", 8080),
    ],
)
def test_parse_tcp_target_accepts_tcp(value, expected_host, expected_port):
    """parse_tcp_target must return (host, port) for valid TCP target strings."""
    result = parse_tcp_target(value)
    assert result is not None
    host, port = result
    assert host == expected_host
    assert port == expected_port


@pytest.mark.parametrize(
    "value",
    [
        # Serial paths
        "/dev/ttyUSB0",
        "/dev/ttyACM0",
        "COM3",
        # BLE MACs — multiple colons, no valid port
        "AA:BB:CC:DD:EE:FF",
        "AA:BB:CC:DD:EE:12",
        # UUIDs — hyphens, no colon
        "12345678-1234-1234-1234-123456789abc",
        # Bare hostname without port
        "meshcore-node.local",
        # Empty / whitespace
        "",
        "   ",
        # Port out of range
        "host:0",
        "host:65536",
        # Non-numeric port
        "host:notaport",
    ],
)
def test_parse_tcp_target_rejects_non_tcp(value):
    """parse_tcp_target must return None for serial paths, BLE addresses, and malformed inputs."""
    assert parse_tcp_target(value) is None


def test_parse_tcp_target_none_input():
    """parse_tcp_target must return None for None input."""
    assert parse_tcp_target(None) is None  # type: ignore[arg-type]


def test_parse_tcp_target_default_port_for_bracketed_ipv6_no_port():
    """parse_tcp_target must use DEFAULT_TCP_PORT for bracketed IPv6 without port."""
    result = parse_tcp_target("[::1]")
    assert result == ("::1", DEFAULT_TCP_PORT)


# ---------------------------------------------------------------------------
# default_serial_targets
# ---------------------------------------------------------------------------


def test_default_serial_targets_returns_list():
    """default_serial_targets must return a non-empty list."""
    targets = default_serial_targets()
    assert isinstance(targets, list)
    assert len(targets) > 0


def test_default_serial_targets_includes_fallback():
    """default_serial_targets always includes /dev/ttyACM0 as a fallback."""
    targets = default_serial_targets()
    assert "/dev/ttyACM0" in targets


def test_default_serial_targets_no_duplicates():
    """default_serial_targets must not return duplicate paths."""
    targets = default_serial_targets()
    assert len(targets) == len(set(targets))


# ---------------------------------------------------------------------------
# BLE_ADDRESS_RE sanity
# ---------------------------------------------------------------------------


def test_ble_address_re_mac():
    """BLE_ADDRESS_RE matches a canonical 6-byte MAC address."""
    assert BLE_ADDRESS_RE.fullmatch("AA:BB:CC:DD:EE:FF") is not None


def test_ble_address_re_uuid():
    """BLE_ADDRESS_RE matches a standard 128-bit UUID."""
    assert (
        BLE_ADDRESS_RE.fullmatch("12345678-1234-1234-1234-123456789abc") is not None
    )


def test_ble_address_re_rejects_tcp():
    """BLE_ADDRESS_RE must not match a hostname:port string."""
    assert BLE_ADDRESS_RE.fullmatch("hostname:4403") is None


def test_ble_address_re_rejects_partial_mac():
    """BLE_ADDRESS_RE must not match an incomplete MAC address."""
    assert BLE_ADDRESS_RE.fullmatch("AA:BB:CC:DD:EE") is None
