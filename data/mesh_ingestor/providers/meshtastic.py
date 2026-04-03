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

"""Meshtastic provider implementation."""

from __future__ import annotations

import asyncio
import time

from pubsub import pub

from .. import config, daemon as _daemon, handlers, interfaces
from ..connection import list_serial_candidates
from ..provider import ConnectionCandidate

_MESHTASTIC_BLE_SERVICE_UUID = "6ba1b218-15a8-461f-9fa8-5dcae273eafd"
"""Meshtastic GATT service UUID used to filter BLE scan results."""


def _meshtastic_ble_candidates(
    ble_scan_timeout_secs: float,
) -> list[ConnectionCandidate]:
    """Return BLE devices advertising the Meshtastic service."""

    try:
        from bleak import BleakScanner  # type: ignore[import-untyped]
    except Exception as exc:  # pragma: no cover - optional dependency paths
        config._debug_log(
            "BLE scan skipped (bleak unavailable)",
            context="meshtastic.scan",
            severity="warn",
            error_class=exc.__class__.__name__,
        )
        return []

    async def _discover():
        return await BleakScanner.discover(
            timeout=ble_scan_timeout_secs,
            service_uuids=[_MESHTASTIC_BLE_SERVICE_UUID],
        )

    try:
        devices = asyncio.run(_discover())
    except RuntimeError as exc:
        # Nested event loop (e.g. some test environments): skip BLE gracefully.
        config._debug_log(
            "BLE scan skipped (async runtime)",
            context="meshtastic.scan",
            severity="warn",
            error_message=str(exc),
        )
        return []
    except Exception as exc:  # pragma: no cover - hardware / OS dependent
        config._debug_log(
            "BLE scan failed",
            context="meshtastic.scan",
            severity="warn",
            error_class=exc.__class__.__name__,
            error_message=str(exc),
        )
        return []

    by_target: dict[str, ConnectionCandidate] = {}
    for device in devices:
        addr = (getattr(device, "address", None) or "").strip()
        if not addr:
            continue
        target = addr.upper() if ":" in addr else addr
        name = (getattr(device, "name", None) or "").strip() or "(no name)"
        rssi = getattr(device, "rssi", None)
        rssi_part = f" RSSI={rssi} dBm" if rssi is not None else ""
        label = f"{name} — {target}{rssi_part}"
        by_target[target] = ConnectionCandidate(target=target, label=label, kind="ble")
    return sorted(by_target.values(), key=lambda c: c.label.casefold())


class MeshtasticProvider:
    """Meshtastic ingestion provider (current default)."""

    name = "meshtastic"

    def __init__(self):
        self._subscribed: list[str] = []

    def subscribe(self) -> list[str]:
        """Subscribe Meshtastic pubsub receive topics."""

        if self._subscribed:
            return list(self._subscribed)

        subscribed = []
        for topic in _daemon._RECEIVE_TOPICS:
            try:
                pub.subscribe(handlers.on_receive, topic)
                subscribed.append(topic)
            except Exception as exc:  # pragma: no cover
                config._debug_log(f"failed to subscribe to {topic!r}: {exc}")
        self._subscribed = subscribed
        return list(subscribed)

    def connect(
        self, *, active_candidate: str | None
    ) -> tuple[object, str | None, str | None]:
        """Create a Meshtastic interface using the existing interface helpers."""

        iface = None
        resolved_target = None
        next_candidate = active_candidate

        if active_candidate:
            iface, resolved_target = interfaces._create_serial_interface(
                active_candidate
            )
        else:
            iface, resolved_target = interfaces._create_default_interface()
            next_candidate = resolved_target

        interfaces._ensure_radio_metadata(iface)
        interfaces._ensure_channel_metadata(iface)

        return iface, resolved_target, next_candidate

    def extract_host_node_id(self, iface: object) -> str | None:
        return interfaces._extract_host_node_id(iface)

    def node_snapshot_items(self, iface: object) -> list[tuple[str, object]]:
        nodes = getattr(iface, "nodes", {}) or {}
        for _ in range(3):
            try:
                return list(nodes.items())
            except RuntimeError as err:
                if "dictionary changed size during iteration" not in str(err):
                    raise
                time.sleep(0)
        config._debug_log(
            "Skipping node snapshot due to concurrent modification",
            context="meshtastic.snapshot",
        )
        return []

    def list_connection_candidates(
        self, *, ble_scan_timeout_secs: float
    ) -> list[ConnectionCandidate]:
        """List serial ports and Meshtastic BLE peripherals."""

        serial_rows = [
            ConnectionCandidate(target=path, label=path, kind="serial")
            for path in list_serial_candidates()
        ]
        ble_rows = _meshtastic_ble_candidates(ble_scan_timeout_secs)
        return [*serial_rows, *ble_rows]


__all__ = ["MeshtasticProvider"]
