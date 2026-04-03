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

"""Provider-agnostic connection target helpers.

This module contains utilities shared by all ingestor providers for
parsing and auto-discovering connection targets.  It is intentionally
free of any provider-specific imports so that Meshtastic, MeshCore,
and future providers can all rely on the same logic.
"""

from __future__ import annotations

import glob
import re
import types

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_TCP_PORT: int = 4403
"""Default TCP port used when no port is explicitly supplied."""

DEFAULT_SERIAL_PATTERNS: tuple[str, ...] = (
    "/dev/ttyACM*",
    "/dev/ttyUSB*",
    "/dev/tty.usbmodem*",
    "/dev/tty.usbserial*",
    "/dev/cu.usbmodem*",
    "/dev/cu.usbserial*",
)
"""Glob patterns for common serial device paths on Linux and macOS."""

# Support both MAC addresses (Linux/Windows) and UUIDs (macOS).
BLE_ADDRESS_RE = re.compile(
    r"^(?:"
    r"(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}|"  # MAC address format
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"  # UUID format
    r")$"
)
"""Compiled regex matching a BLE MAC address or UUID."""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def parse_ble_target(value: str) -> str | None:
    """Return a normalised BLE address (MAC or UUID) when ``value`` matches the format.

    Parameters:
        value: User-provided target string.

    Returns:
        The normalised MAC address (upper-cased) or UUID, or ``None`` when
        the value does not match a recognised BLE address format.
    """
    if not value:
        return None
    value = value.strip()
    if not value:
        return None
    if BLE_ADDRESS_RE.fullmatch(value):
        return value.upper()
    return None


def parse_tcp_target(value: str) -> tuple[str, int] | None:
    """Parse a TCP ``host:port`` target, accepting both IPs and hostnames.

    Unlike the Meshtastic-specific helper in :mod:`interfaces`, hostnames are
    accepted here because MeshCore companions may be reached over a local
    network by name (e.g. ``meshcore-node.local:4403``).

    BLE MAC addresses (five colons) and bare serial port paths (no colon) are
    correctly rejected — they cannot produce a valid ``host:port`` pair.

    Parameters:
        value: User-provided target string.

    Returns:
        ``(host, port)`` on success, or ``None`` when *value* does not look
        like a TCP target.
    """
    if not value:
        return None
    value = value.strip()
    if not value:
        return None

    # Strip URL scheme prefix (e.g. ``tcp://host:4403`` or ``http://host:4403``).
    if "://" in value:
        value = value.split("://", 1)[1]

    # Handle bracketed IPv6: ``[::1]:4403``.
    if value.startswith("["):
        bracket_end = value.find("]")
        if bracket_end == -1:
            return None
        host = value[1:bracket_end]
        rest = value[bracket_end + 1 :]
        if rest.startswith(":"):
            try:
                port = int(rest[1:])
            except ValueError:
                return None
            if not (1 <= port <= 65535):
                return None
        else:
            port = DEFAULT_TCP_PORT
        if not host:
            return None
        return host, port

    # For non-bracketed addresses require exactly one colon so that BLE MACs
    # (five colons) and bare serial paths (no colon) are rejected.
    colon_count = value.count(":")
    if colon_count != 1:
        return None

    host, _, port_str = value.partition(":")
    if not host:
        return None
    try:
        port = int(port_str)
    except ValueError:
        return None
    if not (1 <= port <= 65535):
        return None
    return host, port


def default_serial_targets() -> list[str]:
    """Return candidate serial device paths for auto-discovery.

    Globs for common USB serial device paths on Linux and macOS.  Always
    includes ``/dev/ttyACM0`` as a final fallback so callers have at least
    one candidate even on systems without any attached hardware.

    Returns:
        Ordered list of candidate device paths, deduplicated.
    """
    candidates: list[str] = []
    seen: set[str] = set()
    for pattern in DEFAULT_SERIAL_PATTERNS:
        for path in sorted(glob.glob(pattern)):
            if path not in seen:
                candidates.append(path)
                seen.add(path)
    if "/dev/ttyACM0" not in seen:
        candidates.append("/dev/ttyACM0")
    return candidates


def list_serial_candidates(
    *, _list_ports_module: types.ModuleType | None = None
) -> list[str]:
    """Return serial device paths for interactive connection selection.

    Combines :func:`default_serial_targets` with ``pyserial`` port enumeration
    when ``serial.tools.list_ports`` is available (bundled with Meshtastic).

    Parameters:
        _list_ports_module: For unit tests only; when set, used instead of
            importing ``serial.tools.list_ports``.

    Returns:
        Sorted unique device paths suitable for ``CONNECTION``.
    """

    seen: dict[str, None] = {}
    for path in default_serial_targets():
        seen[path] = None
    list_ports = _list_ports_module
    if list_ports is None:
        try:
            from serial.tools import list_ports as _lp  # type: ignore[import-untyped]

            list_ports = _lp
        except Exception:
            return sorted(seen.keys())
    try:
        comports = getattr(list_ports, "comports", None)
        if not callable(comports):
            return sorted(seen.keys())
        for port in comports():
            dev = (port.device or "").strip()
            if dev:
                seen.setdefault(dev, None)
    except Exception:
        pass
    return sorted(seen.keys())
