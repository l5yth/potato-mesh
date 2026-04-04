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

"""Parse connection targets; mirrors ``mesh_ingestor.connection`` for wizard-only use."""

from __future__ import annotations

import re

DEFAULT_TCP_PORT: int = 4403

BLE_ADDRESS_RE = re.compile(
    r"^(?:"
    r"(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}|"
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
    r")$"
)


def parse_ble_target(value: str) -> str | None:
    if not value:
        return None
    value = value.strip()
    if not value:
        return None
    if BLE_ADDRESS_RE.fullmatch(value):
        return value.upper()
    return None


def parse_tcp_target(value: str) -> tuple[str, int] | None:
    if not value:
        return None
    value = value.strip()
    if not value:
        return None
    if "://" in value:
        value = value.split("://", 1)[1]
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
    if value.count(":") != 1:
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


def connection_kind(target: str) -> str:
    """Return ``"ble"``, ``"tcp"``, or ``"serial"`` for a non-empty target string."""

    t = (target or "").strip()
    if not t:
        return "serial"
    if parse_ble_target(t):
        return "ble"
    if parse_tcp_target(t):
        return "tcp"
    return "serial"
