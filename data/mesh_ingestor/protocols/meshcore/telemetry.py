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

"""MeshCore telemetry collection (TI-A3).

MeshCore surfaces telemetry three ways: unsolicited/tag-matched
``TELEMETRY_RESPONSE`` events carrying a decoded CayenneLPP list,
``STATUS_RESPONSE`` events carrying battery/uptime gauges, and the host-only
``BATTERY`` event.  Other nodes' telemetry is **pull-only** (there is no
broadcast the library surfaces), so this module also provides the poll loop
that round-robins the contact roster with ``req_telemetry_sync`` — one on-air
request per :data:`~data.mesh_ingestor.config.MESHCORE_TELEMETRY_POLL_SECONDS`
— and reads the host radio's own battery/sensors over the local companion
link (no airtime).  Every reading is normalised into the canonical telemetry
packet shape and flows through the shared
:func:`~data.mesh_ingestor.handlers.store_telemetry_packet` pipeline with
``protocol="meshcore"``, preserving protocol parity (SPEC Invariant IV) and
the local-LoRa apex (no broker, Invariant I).
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Mapping

from ... import config
from .interface import _MeshcoreInterface
from .messages import _derive_message_id

_LPP_TYPE_NAMES: dict[int, str] = {
    101: "illuminance",
    103: "temperature",
    104: "humidity",
    115: "barometer",
    116: "voltage",
    117: "current",
    120: "percentage",
}
"""CayenneLPP numeric type codes mapped to the library's canonical names.

Only the types with a matching telemetry column are listed; entries the
library already name-encodes (via its ``my_lpp_types`` JSON encoder) arrive as
strings and bypass this table."""

_LPP_DEVICE_FIELDS: dict[str, str] = {
    "voltage": "voltage",
    "percentage": "batteryLevel",
}
"""LPP type name → ``deviceMetrics`` field for battery-style readings."""

_LPP_ENVIRONMENT_FIELDS: dict[str, str] = {
    "temperature": "temperature",
    "humidity": "relativeHumidity",
    "barometer": "barometricPressure",
    "current": "current",
    "illuminance": "lux",
}
"""LPP type name → ``environmentMetrics`` field for sensor readings."""

_LPP_VALUE_SCALERS: dict[str, float] = {
    # CayenneLPP current is in amps; Meshtastic's EnvironmentMetrics current
    # (and therefore the shared ``current`` column) is in milliamps.  Scale so
    # one column never mixes units across protocols.
    "current": 1000.0,
}
"""LPP type name → multiplier applied before storing the value."""


def _lpp_entry_parts(entry: Mapping) -> tuple[str | None, float | None]:
    """Extract the canonical type name and numeric value from an LPP entry.

    Parameters:
        entry: One ``{"channel", "type", "value"}`` mapping from the decoded
            ``lpp`` list.  ``type`` may be the library's name string or a raw
            numeric LPP type code; ``value`` must be numeric to be usable.

    Returns:
        Tuple of ``(type_name, value)``; either element is ``None`` when the
        entry is malformed or the type is not one we map.
    """
    raw_type = entry.get("type")
    if isinstance(raw_type, str):
        type_name: str | None = raw_type.strip().lower() or None
    elif isinstance(raw_type, (int, float)) and not isinstance(raw_type, bool):
        type_name = _LPP_TYPE_NAMES.get(int(raw_type))
    else:
        type_name = None

    value = entry.get("value")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return type_name, None
    return type_name, float(value)


def _lpp_to_telemetry_section(lpp) -> dict | None:
    """Convert a decoded CayenneLPP list into a telemetry section.

    Battery-style readings land under ``deviceMetrics`` and sensor readings
    under ``environmentMetrics``; both sub-objects may be present when a node
    reports mixed sensors (the flat extraction in ``store_telemetry_packet``
    persists every field regardless of the single ``telemetry_type`` stamp).

    Parameters:
        lpp: Decoded LPP entry list from a ``TELEMETRY_RESPONSE`` payload.

    Returns:
        Telemetry section dict, or ``None`` when nothing usable was mapped.
    """
    if not isinstance(lpp, (list, tuple)):
        return None
    device: dict = {}
    environment: dict = {}
    for entry in lpp:
        if not isinstance(entry, Mapping):
            continue
        type_name, value = _lpp_entry_parts(entry)
        if type_name is None or value is None:
            continue
        value *= _LPP_VALUE_SCALERS.get(type_name, 1.0)
        if type_name in _LPP_DEVICE_FIELDS:
            device.setdefault(_LPP_DEVICE_FIELDS[type_name], value)
        elif type_name in _LPP_ENVIRONMENT_FIELDS:
            environment.setdefault(_LPP_ENVIRONMENT_FIELDS[type_name], value)
        else:
            config._debug_log(
                "Unmapped MeshCore LPP entry",
                context="meshcore.telemetry.lpp",
                lpp_type=entry.get("type"),
            )
    section: dict = {}
    if device:
        section["deviceMetrics"] = device
    if environment:
        section["environmentMetrics"] = environment
    return section or None


def _millivolts_to_volts(value) -> float | None:
    """Convert a millivolt gauge (``bat`` / ``level``) to volts.

    Parameters:
        value: Millivolt reading as reported by MeshCore firmware.

    Returns:
        Voltage in volts rounded to millivolt precision, or ``None`` when the
        input is not a positive number.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value <= 0:
        return None
    return round(float(value) / 1000.0, 3)


def _status_to_telemetry_section(status: Mapping) -> dict | None:
    """Convert a ``STATUS_RESPONSE`` payload into a telemetry section.

    Parameters:
        status: Parsed status dict (``parse_status``) with ``bat`` in
            millivolts and ``uptime`` in seconds.

    Returns:
        Telemetry section with a ``deviceMetrics`` sub-object, or ``None``
        when the status carries no usable gauge.
    """
    if not isinstance(status, Mapping):
        return None
    device: dict = {}
    voltage = _millivolts_to_volts(status.get("bat"))
    if voltage is not None:
        device["voltage"] = voltage
    uptime = status.get("uptime")
    if not isinstance(uptime, bool) and isinstance(uptime, (int, float)) and uptime > 0:
        device["uptimeSeconds"] = int(uptime)
    return {"deviceMetrics": device} if device else None


def _resolve_event_node_id(iface: _MeshcoreInterface, pubkey_pre) -> str | None:
    """Resolve an event's ``pubkey_pre`` to a canonical node id.

    Contacts resolve through the roster snapshot; the host radio's own prefix
    (self-telemetry responses are tagged with it) resolves to the host node.

    Parameters:
        iface: Active MeshCore interface.
        pubkey_pre: Six-byte (12 hex char) public-key prefix from the event.

    Returns:
        Canonical ``!xxxxxxxx`` node id, or ``None`` when unknown.
    """
    if not isinstance(pubkey_pre, str) or not pubkey_pre:
        return None
    node_id = iface.lookup_node_id(pubkey_pre)
    if node_id:
        return node_id
    self_info = getattr(iface, "_self_info_payload", None) or {}
    own_key = self_info.get("public_key", "")
    if isinstance(own_key, str) and own_key.lower().startswith(pubkey_pre.lower()):
        return iface.host_node_id
    return None


def _queue_meshcore_telemetry(
    handlers: object, node_id: str | None, section: Mapping | None, kind: str
) -> bool:
    """Queue one normalised MeshCore telemetry packet.

    Parameters:
        handlers: The ``data.mesh_ingestor.handlers`` module (passed in to
            avoid circular imports, matching the other MeshCore handlers).
        node_id: Canonical node the reading belongs to.
        section: Telemetry section (``deviceMetrics``/``environmentMetrics``).
        kind: Discriminator for the packet-id fingerprint (``"lpp"``,
            ``"status"``, ``"battery"``) so distinct sources heard in the same
            second cannot collide, while re-reads of the same source collapse
            into one row via the web app's ``telemetry.id`` upsert.

    Returns:
        ``True`` when a packet was queued, ``False`` when skipped.
    """
    if not node_id or not section:
        return False
    rx_time = int(time.time())
    packet = {
        "id": _derive_message_id(node_id, rx_time, f"tel-{kind}", ""),
        "rxTime": rx_time,
        "rx_time": rx_time,
        "fromId": node_id,
        "from_id": node_id,
        "protocol": "meshcore",
        "decoded": {
            "portnum": "TELEMETRY_APP",
            "telemetry": {**section, "time": rx_time},
        },
    }
    handlers._mark_packet_seen()
    handlers.store_packet_dict(packet)
    config._debug_log(
        "MeshCore telemetry queued",
        context="meshcore.telemetry",
        node_id=node_id,
        kind=kind,
    )
    return True


def _make_telemetry_handlers(iface: _MeshcoreInterface, handlers: object) -> dict:
    """Build the telemetry-related MeshCore event callbacks.

    Parameters:
        iface: Active MeshCore interface (node-id resolution + host id).
        handlers: The ``data.mesh_ingestor.handlers`` module.

    Returns:
        Mapping of ``EventType`` member name → async callback, merged into the
        provider's main handler map by ``_make_event_handlers``.
    """

    async def on_telemetry_response(evt) -> None:
        payload = evt.payload or {}
        node_id = _resolve_event_node_id(iface, payload.get("pubkey_pre"))
        _queue_meshcore_telemetry(
            handlers, node_id, _lpp_to_telemetry_section(payload.get("lpp")), "lpp"
        )

    async def on_status_response(evt) -> None:
        payload = evt.payload or {}
        node_id = _resolve_event_node_id(iface, payload.get("pubkey_pre"))
        _queue_meshcore_telemetry(
            handlers, node_id, _status_to_telemetry_section(payload), "status"
        )

    async def on_battery(evt) -> None:
        # BATTERY is host-only: the response to get_bat() on the companion link.
        payload = evt.payload or {}
        voltage = _millivolts_to_volts(payload.get("level"))
        section = {"deviceMetrics": {"voltage": voltage}} if voltage else None
        _queue_meshcore_telemetry(handlers, iface.host_node_id, section, "battery")

    return {
        "TELEMETRY_RESPONSE": on_telemetry_response,
        "STATUS_RESPONSE": on_status_response,
        "BATTERY": on_battery,
    }


def _next_poll_contact(iface: _MeshcoreInterface, state: dict) -> dict | None:
    """Pick the next roster contact for a telemetry poll, round-robin.

    Parameters:
        iface: Active MeshCore interface holding the contact snapshot.
        state: Mutable poll-loop state carrying the ``cursor`` position.

    Returns:
        The next contact dict, or ``None`` when the roster is empty.
    """
    with iface._contacts_lock:
        contacts = [iface._contacts[key] for key in sorted(iface._contacts)]
    if not contacts:
        return None
    cursor = state.get("cursor", 0) % len(contacts)
    state["cursor"] = cursor + 1
    return contacts[cursor]


async def _poll_self_telemetry(mc, iface: _MeshcoreInterface, handlers: object) -> None:
    """Read the host radio's battery and sensors over the companion link.

    Both commands return their matching event object directly; the payload is
    processed inline (subscriptions also fire for these events — the derived
    packet id collapses the duplicate).  Errors are logged and swallowed so a
    firmware without a command never kills the poll loop.

    Parameters:
        mc: Connected MeshCore instance.
        iface: Active interface (host node id).
        handlers: The ``data.mesh_ingestor.handlers`` module.
    """
    try:
        evt = await mc.commands.get_bat()
        payload = getattr(evt, "payload", None) or {}
        voltage = _millivolts_to_volts(payload.get("level"))
        section = {"deviceMetrics": {"voltage": voltage}} if voltage else None
        _queue_meshcore_telemetry(handlers, iface.host_node_id, section, "battery")
    except Exception as exc:
        config._debug_log(
            "MeshCore self battery read failed",
            context="meshcore.telemetry.self",
            severity="warning",
            error=str(exc),
        )
    try:
        evt = await mc.commands.get_self_telemetry()
        payload = getattr(evt, "payload", None) or {}
        _queue_meshcore_telemetry(
            handlers,
            iface.host_node_id,
            _lpp_to_telemetry_section(payload.get("lpp")),
            "lpp",
        )
    except Exception as exc:
        config._debug_log(
            "MeshCore self telemetry read failed",
            context="meshcore.telemetry.self",
            severity="warning",
            error=str(exc),
        )


async def _poll_contact_telemetry(
    mc, iface: _MeshcoreInterface, handlers: object, state: dict
) -> None:
    """Send one on-air telemetry pull to the next roster contact.

    Falls back to a status request when the telemetry pull yields nothing, so
    sensor-less nodes still report battery/uptime.  One contact per call keeps
    airtime bounded to a single request per poll interval regardless of roster
    size; the meshcore library serialises mesh requests internally.

    Parameters:
        mc: Connected MeshCore instance.
        iface: Active interface (roster + node-id resolution).
        handlers: The ``data.mesh_ingestor.handlers`` module.
        state: Mutable poll-loop state (round-robin cursor).
    """
    contact = _next_poll_contact(iface, state)
    if contact is None:
        return
    node_id = iface.lookup_node_id((contact.get("public_key") or "")[:12])
    if node_id is None:
        return
    try:
        lpp = await mc.commands.req_telemetry_sync(contact)
    except Exception as exc:
        config._debug_log(
            "MeshCore contact telemetry poll failed",
            context="meshcore.telemetry.poll",
            node_id=node_id,
            error=str(exc),
        )
        return
    if _queue_meshcore_telemetry(
        handlers, node_id, _lpp_to_telemetry_section(lpp), "lpp"
    ):
        return
    try:
        status = await mc.commands.req_status_sync(contact)
    except Exception as exc:
        config._debug_log(
            "MeshCore contact status poll failed",
            context="meshcore.telemetry.poll",
            node_id=node_id,
            error=str(exc),
        )
        return
    _queue_meshcore_telemetry(
        handlers, node_id, _status_to_telemetry_section(status), "status"
    )


async def _telemetry_poll_loop(mc, iface: _MeshcoreInterface) -> None:
    """Drive periodic self and contact telemetry collection until cancelled.

    Cadence comes from :data:`~data.mesh_ingestor.config` —
    ``MESHCORE_SELF_TELEMETRY_SECONDS`` (local, no airtime; ``<= 0`` disables)
    and ``MESHCORE_TELEMETRY_POLL_SECONDS`` (one on-air request per interval;
    ``<= 0`` disables).  The loop wakes once per second-granularity deadline
    rather than busy-polling.

    Parameters:
        mc: Connected MeshCore instance.
        iface: Active interface.
    """
    from ... import handlers as _handlers

    self_interval = config.MESHCORE_SELF_TELEMETRY_SECONDS
    poll_interval = config.MESHCORE_TELEMETRY_POLL_SECONDS
    if self_interval <= 0 and poll_interval <= 0:
        return

    state: dict = {}
    next_self = time.monotonic() if self_interval > 0 else None
    # Delay the first on-air poll by one full interval so a restart storm
    # cannot burst-request the roster.
    next_poll = time.monotonic() + poll_interval if poll_interval > 0 else None
    while True:
        now = time.monotonic()
        if next_self is not None and now >= next_self:
            await _poll_self_telemetry(mc, iface, _handlers)
            next_self = now + self_interval
        if next_poll is not None and now >= next_poll:
            await _poll_contact_telemetry(mc, iface, _handlers, state)
            next_poll = now + poll_interval
        deadlines = [d for d in (next_self, next_poll) if d is not None]
        await asyncio.sleep(max(1.0, min(deadlines) - time.monotonic()))
