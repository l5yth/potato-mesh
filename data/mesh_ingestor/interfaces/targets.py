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

"""Network target parsing helpers for Meshtastic interfaces."""

from __future__ import annotations

import ipaddress
import urllib.parse

from ..connection import DEFAULT_TCP_PORT

_DEFAULT_TCP_TARGET = "http://127.0.0.1"


def _parse_network_target(value: str) -> tuple[str, int] | None:
    """Return ``(host, port)`` when ``value`` is a numeric IP address string.

    Only literal IPv4 or IPv6 addresses are accepted, optionally paired with a
    port or scheme. Callers that start from hostnames should resolve them to an
    address before invoking this helper.

    Parameters:
        value: Numeric IP literal or URL describing the TCP interface.

    Returns:
        A ``(host, port)`` tuple or ``None`` when parsing fails.
    """

    if not value:
        return None

    value = value.strip()
    if not value:
        return None

    def _validated_result(host: str | None, port: int | None) -> tuple[str, int] | None:
        if not host:
            return None
        try:
            ipaddress.ip_address(host)
        except ValueError:
            return None
        return host, port or DEFAULT_TCP_PORT

    parsed_values = []
    if "://" in value:
        parsed_values.append(urllib.parse.urlparse(value, scheme="tcp"))
    parsed_values.append(urllib.parse.urlparse(f"//{value}", scheme="tcp"))

    for parsed in parsed_values:
        try:
            port = parsed.port
        except ValueError:
            port = None
        result = _validated_result(parsed.hostname, port)
        if result:
            return result

    # For bare "host:port" strings that urlparse may misparse, try a manual
    # partition. The `startswith("[")` guard excludes IPv6 bracket notation
    # (e.g. "[::1]:8080") because those already succeed via urlparse above.
    if value.count(":") == 1 and not value.startswith("["):
        host, _, port_text = value.partition(":")
        try:
            port = int(port_text) if port_text else None
        except ValueError:
            port = None
        result = _validated_result(host, port)
        if result:  # pragma: no cover - urlparse handles all currently-known forms
            return result

    return _validated_result(value, None)
