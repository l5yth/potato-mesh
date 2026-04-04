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

"""MeshCore provider implementation.

This module defines :class:`MeshcoreProvider`, which satisfies the
:class:`~data.mesh_ingestor.provider.Provider` protocol for MeshCore nodes
connected via serial port, BLE, or TCP/IP.

The provider runs MeshCore's ``asyncio`` event loop in a background daemon
thread so that incoming events are dispatched without blocking the
synchronous daemon loop.  Received contacts, channel messages, and direct
messages are forwarded to the shared HTTP ingest queue via the same
:mod:`~data.mesh_ingestor.handlers` helpers used by the Meshtastic provider.

Connection type is detected automatically from the target string:

* **BLE** — MAC address (``AA:BB:CC:DD:EE:FF``) or UUID (macOS format).
* **TCP** — ``host:port`` or ``[ipv6]:port`` (accepts hostnames).
* **Serial** — any other non-empty string (e.g. ``/dev/ttyUSB0``).
* **Auto** — ``None`` or empty: tries serial candidates from
  :func:`~data.mesh_ingestor.connection.default_serial_targets`.

Node identities are derived from the first four bytes (eight hex characters)
of each contact's 32-byte public key, formatted as ``!xxxxxxxx`` to match
the canonical node-ID schema used across the system.  Ingested
``user.shortName`` is the first four hex digits of that key (two bytes),
not the advertised name.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from .. import config
from ..connection import default_serial_targets, parse_ble_target, parse_tcp_target

# ---------------------------------------------------------------------------
# Debug log file
# ---------------------------------------------------------------------------

_IGNORED_MESSAGE_LOG_PATH = Path(__file__).resolve().parents[3] / "ignored-meshcore.txt"
"""Filesystem path that stores raw MeshCore messages when ``DEBUG=1``."""

_IGNORED_MESSAGE_LOCK = threading.Lock()
"""Lock guarding writes to :data:`_IGNORED_MESSAGE_LOG_PATH`."""

# ---------------------------------------------------------------------------
# Connection constants
# ---------------------------------------------------------------------------

_CONNECT_TIMEOUT_SECS: float = 30.0
"""Seconds to wait for the MeshCore node to respond to the appstart handshake."""

_DEFAULT_BAUDRATE: int = 115200
"""Default baud rate for MeshCore serial connections."""

# MeshCore ``ADV_TYPE_*`` (``AdvertDataHelpers.h``) → ``user.role`` for POST /api/nodes.
_MESHCORE_ADV_TYPE_ROLE: dict[int, str] = {
    1: "COMPANION",  # ADV_TYPE_CHAT
    2: "REPEATER",  # ADV_TYPE_REPEATER
    3: "ROOM_SERVER",  # ADV_TYPE_ROOM_SERVER
    4: "SENSOR",  # ADV_TYPE_SENSOR
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _derive_message_id(sender_ts: int, discriminator: str, text: str) -> int:
    """Derive a stable 32-bit message ID from available MeshCore fields.

    MeshCore does not assign firmware-side packet IDs.  This function
    produces a deterministic 32-bit integer so that re-delivered messages
    resolve to the same database row via the UPSERT ON CONFLICT path, while
    messages that differ in timestamp, channel/peer, or text content produce
    distinct IDs.

    Parameters:
        sender_ts: Unix timestamp from the sender's clock.
        discriminator: Channel index (``"c<N>"`` for channel messages) or
            pubkey prefix (for direct messages) to separate messages with
            the same timestamp.
        text: Message text.

    Returns:
        A non-negative 32-bit integer suitable for the ``id`` column.
    """
    data = f"{sender_ts}:{discriminator}:{text}".encode("utf-8", errors="replace")
    return int.from_bytes(hashlib.sha256(data).digest()[:4], "big")


def _meshcore_node_id(public_key_hex: str | None) -> str | None:
    """Derive a canonical ``!xxxxxxxx`` node ID from a MeshCore public key.

    Uses the first four bytes (eight hex characters) of the 32-byte public
    key, formatted as ``!xxxxxxxx``.

    Parameters:
        public_key_hex: 64-character lowercase hex string for the node's
            public key as returned by the MeshCore library.

    Returns:
        Canonical ``!xxxxxxxx`` node ID string, or ``None`` when the key is
        absent or too short.
    """
    if not public_key_hex or len(public_key_hex) < 8:
        return None
    return "!" + public_key_hex[:8].lower()


def _meshcore_short_name(public_key_hex: str | None) -> str:
    """Return the first four hex digits of a MeshCore public key as short name.

    Meshtastic-style ``shortName`` fields are four characters wide; MeshCore
    ingest uses the leading two bytes of the 32-byte public key in lowercase
    hex so the label is stable and unique per key prefix.

    Parameters:
        public_key_hex: Full public key as a hex string from the MeshCore API.

    Returns:
        Four lowercase hex characters (e.g. ``"aabb"``), or an empty string
        when the key is missing or shorter than four hex characters.
    """
    if not public_key_hex or len(public_key_hex) < 4:
        return ""
    return public_key_hex[:4].lower()


def _meshcore_adv_type_to_role(adv_type: object) -> str | None:
    """Map MeshCore ``ADV_TYPE_*`` (contact ``type`` / self ``adv_type``) to ingest role.

    Values match MeshCore firmware ``AdvertDataHelpers.h`` (``ADV_TYPE_CHAT``,
    ``ADV_TYPE_REPEATER``, …).  Role strings match the MeshCore palette keys
    used by the web dashboard (``COMPANION``, ``REPEATER``, …).

    Parameters:
        adv_type: Raw type byte from meshcore_py (typically ``int`` 0–4).
            Non-integer values (e.g. ``float``, ``None``) are rejected and
            return ``None``.  Future firmware type codes not yet in the mapping
            also return ``None`` until the table is updated.

    Returns:
        Uppercase role string, or ``None`` when the value is unknown or should
        not override the web default (``ADV_TYPE_NONE`` / unrecognised).
    """
    if not isinstance(adv_type, int):
        return None
    return _MESHCORE_ADV_TYPE_ROLE.get(adv_type)


def _pubkey_prefix_to_node_id(contacts: dict, pubkey_prefix: str) -> str | None:
    """Look up a canonical node ID by six-byte public-key prefix.

    Parameters:
        contacts: Mapping of full ``public_key`` hex strings to contact dicts.
        pubkey_prefix: Twelve-character hex string (six bytes) as used in
            MeshCore direct-message events.

    Returns:
        Canonical ``!xxxxxxxx`` node ID for the first matching contact, or
        ``None`` when no contact's public key starts with *pubkey_prefix*.
    """
    for pub_key in contacts:
        if pub_key.startswith(pubkey_prefix):
            return _meshcore_node_id(pub_key)
    return None


def _contact_to_node_dict(contact: dict) -> dict:
    """Convert a MeshCore contact dict to a Meshtastic-ish node dict.

    Parameters:
        contact: Contact dict from the MeshCore library.  Expected keys
            include ``public_key``, ``type`` (``ADV_TYPE_*``), ``adv_name``,
            ``last_advert``, ``adv_lat``, and ``adv_lon``.

    Returns:
        Node dict compatible with the ``POST /api/nodes`` payload format.
    """
    pub_key = contact.get("public_key", "")
    name = (contact.get("adv_name") or "").strip()
    role = _meshcore_adv_type_to_role(contact.get("type"))
    node: dict = {
        "lastHeard": contact.get("last_advert"),
        "user": {
            "longName": name,
            "shortName": _meshcore_short_name(pub_key),
            "publicKey": pub_key,
            **({"role": role} if role is not None else {}),
        },
    }
    lat = contact.get("adv_lat")
    lon = contact.get("adv_lon")
    if lat is not None and lon is not None and (lat or lon):
        node["position"] = {"latitude": lat, "longitude": lon}
    return node


def _self_info_to_node_dict(self_info: dict) -> dict:
    """Convert a MeshCore ``SELF_INFO`` payload to a Meshtastic-ish node dict.

    Parameters:
        self_info: Payload dict from the ``SELF_INFO`` event.  Expected keys
            include ``name``, ``public_key``, ``adv_type`` (``ADV_TYPE_*``),
            ``adv_lat``, and ``adv_lon``.

    Returns:
        Node dict compatible with the ``POST /api/nodes`` payload format.
    """
    name = (self_info.get("name") or "").strip()
    pub_key = self_info.get("public_key", "")
    role = _meshcore_adv_type_to_role(self_info.get("adv_type"))
    node: dict = {
        "lastHeard": int(time.time()),
        "user": {
            "longName": name,
            "shortName": _meshcore_short_name(pub_key),
            "publicKey": pub_key,
            **({"role": role} if role is not None else {}),
        },
    }
    lat = self_info.get("adv_lat")
    lon = self_info.get("adv_lon")
    if lat is not None and lon is not None and (lat or lon):
        node["position"] = {"latitude": lat, "longitude": lon}
    return node


def _to_json_safe(value: object) -> object:
    """Recursively convert *value* to a JSON-serialisable form.

    Handles the common types present in mesh protocol messages: dicts, lists,
    bytes (base64-encoded), and primitives.  Anything else is coerced via
    ``str()``.
    """
    if isinstance(value, dict):
        return {str(k): _to_json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_to_json_safe(v) for v in value]
    if isinstance(value, bytes):
        return base64.b64encode(value).decode("ascii")
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _record_meshcore_message(message: object, *, source: str) -> None:
    """Persist a MeshCore message to :data:`ignored-meshcore.txt` when ``DEBUG=1``.

    When ``DEBUG`` is not set the function returns immediately without any
    I/O so that production deployments are not burdened by file writes.

    Parameters:
        message: The raw message object received from the MeshCore node.
        source: A short label describing where the message originated (e.g.
            a serial port path or BLE address).
    """
    if not config.DEBUG:
        return

    timestamp = datetime.now(timezone.utc).isoformat()
    entry = {
        "message": _to_json_safe(message),
        "source": source,
        "timestamp": timestamp,
    }
    payload = json.dumps(entry, ensure_ascii=False, sort_keys=True)
    with _IGNORED_MESSAGE_LOCK:
        _IGNORED_MESSAGE_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with _IGNORED_MESSAGE_LOG_PATH.open("a", encoding="utf-8") as fh:
            fh.write(f"{payload}\n")


# ---------------------------------------------------------------------------
# Interface
# ---------------------------------------------------------------------------


class _MeshcoreInterface:
    """Live MeshCore interface managing an asyncio event loop in a background thread.

    Holds connection state, a thread-safe snapshot of known contacts, and the
    handles needed to shut down cleanly when the daemon requests a disconnect.
    """

    host_node_id: str | None = None
    """Canonical ``!xxxxxxxx`` identifier for the connected host device."""

    def __init__(self, *, target: str | None) -> None:
        """Initialise the interface with the connection *target*."""
        self._target = target
        self._mc: object | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._stop_event: asyncio.Event | None = None
        self._contacts_lock = threading.Lock()
        self._contacts: dict = {}
        self.isConnected: bool = False

    # ------------------------------------------------------------------
    # Contact management (called from the asyncio thread)
    # ------------------------------------------------------------------

    def _update_contact(self, contact: dict) -> None:
        """Thread-safely add or update a contact in the local snapshot.

        Parameters:
            contact: Contact dict from a ``CONTACTS``, ``NEW_CONTACT``, or
                ``NEXT_CONTACT`` event.
        """
        pub_key = contact.get("public_key")
        if pub_key:
            with self._contacts_lock:
                self._contacts[pub_key] = contact

    def contacts_snapshot(self) -> list[tuple[str, dict]]:
        """Return a thread-safe snapshot of all known contacts as node entries.

        Returns:
            List of ``(canonical_node_id, node_dict)`` pairs, skipping any
            contact whose public key cannot be mapped to a valid node ID.
        """
        with self._contacts_lock:
            items = list(self._contacts.items())
        result = []
        for pub_key, contact in items:
            node_id = _meshcore_node_id(pub_key)
            if node_id is not None:
                result.append((node_id, _contact_to_node_dict(contact)))
        return result

    def lookup_node_id(self, pubkey_prefix: str) -> str | None:
        """Return the canonical node ID for the contact matching *pubkey_prefix*.

        Parameters:
            pubkey_prefix: Twelve-character hex string (six bytes) from a
                ``CONTACT_MSG_RECV`` event.

        Returns:
            Canonical ``!xxxxxxxx`` node ID, or ``None`` when no match.
        """
        with self._contacts_lock:
            return _pubkey_prefix_to_node_id(self._contacts, pubkey_prefix)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def close(self) -> None:
        """Signal the background event loop to stop and wait for the thread.

        Safe to call multiple times and from any thread.
        """
        self.isConnected = False
        loop = self._loop
        stop_event = self._stop_event
        if loop is not None and not loop.is_closed():
            try:
                if stop_event is not None:
                    loop.call_soon_threadsafe(stop_event.set)
                else:
                    loop.call_soon_threadsafe(loop.stop)
            except RuntimeError:
                pass
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=5.0)


# ---------------------------------------------------------------------------
# Handler logic helpers (module-level to keep _make_event_handlers lean)
# ---------------------------------------------------------------------------


def _process_self_info(
    payload: dict, iface: _MeshcoreInterface, handlers: object
) -> None:
    """Apply a ``SELF_INFO`` payload: set host_node_id and upsert the host node.

    Parameters:
        payload: Event payload dict containing at minimum ``public_key`` and
            optionally ``name``, ``adv_lat``, ``adv_lon``.
        iface: Active interface whose :attr:`host_node_id` will be updated.
        handlers: Module reference for :func:`~data.mesh_ingestor.handlers`
            functions (passed to avoid circular-import issues).
    """
    pub_key = payload.get("public_key", "")
    node_id = _meshcore_node_id(pub_key)
    if node_id:
        iface.host_node_id = node_id
        handlers.register_host_node_id(node_id)
        handlers.upsert_node(node_id, _self_info_to_node_dict(payload))
    handlers._mark_packet_seen()
    config._debug_log(
        "MeshCore self-info received",
        context="meshcore.self_info",
        node_id=node_id,
        name=payload.get("name"),
    )


def _process_contacts(
    contacts: dict, iface: _MeshcoreInterface, handlers: object
) -> None:
    """Apply a bulk ``CONTACTS`` payload: update the local snapshot and upsert nodes.

    Parameters:
        contacts: Mapping of full ``public_key`` hex strings to contact dicts.
        iface: Active interface whose contact snapshot will be updated.
        handlers: Module reference for :func:`~data.mesh_ingestor.handlers`.
    """
    for pub_key, contact in contacts.items():
        node_id = _meshcore_node_id(pub_key)
        if node_id is None:
            continue
        iface._update_contact(contact)
        handlers.upsert_node(node_id, _contact_to_node_dict(contact))
    handlers._mark_packet_seen()


def _process_contact_update(
    contact: dict, iface: _MeshcoreInterface, handlers: object
) -> None:
    """Apply a single ``NEW_CONTACT`` or ``NEXT_CONTACT`` event.

    Parameters:
        contact: Contact dict containing at minimum ``public_key``.
        iface: Active interface whose contact snapshot will be updated.
        handlers: Module reference for :func:`~data.mesh_ingestor.handlers`.
    """
    pub_key = contact.get("public_key", "")
    node_id = _meshcore_node_id(pub_key)
    if node_id is None:
        return
    iface._update_contact(contact)
    handlers.upsert_node(node_id, _contact_to_node_dict(contact))
    handlers._mark_packet_seen()
    config._debug_log(
        "MeshCore contact updated",
        context="meshcore.contact",
        node_id=node_id,
        name=contact.get("adv_name"),
    )


# ---------------------------------------------------------------------------
# Async event handlers
# ---------------------------------------------------------------------------


def _make_event_handlers(iface: _MeshcoreInterface, target: str | None) -> dict:
    """Build async callbacks for each relevant MeshCore event type.

    All callbacks are closures over *iface* and *target* so they can update
    connection state and forward data to the ingest queue without global state.

    Parameters:
        iface: The active :class:`_MeshcoreInterface` instance.
        target: Human-readable connection target for log messages.

    Returns:
        Mapping of ``EventType`` member name → async callback coroutine.
    """
    # Deferred import to avoid a circular dependency: meshcore.py is imported by
    # providers/__init__.py which is imported by the top-level mesh_ingestor
    # package, while handlers.py imports from that same package.
    from .. import handlers as _handlers

    async def on_self_info(evt) -> None:
        _process_self_info(evt.payload or {}, iface, _handlers)

    async def on_contacts(evt) -> None:
        _process_contacts(evt.payload or {}, iface, _handlers)

    async def on_contact_update(evt) -> None:
        _process_contact_update(evt.payload or {}, iface, _handlers)

    async def on_channel_msg(evt) -> None:
        payload = evt.payload or {}
        sender_ts = payload.get("sender_timestamp")
        text = payload.get("text")
        if sender_ts is None or not text:
            return

        rx_time = int(time.time())
        channel_idx = payload.get("channel_idx", 0)

        packet = {
            "id": _derive_message_id(sender_ts, f"c{channel_idx}", text),
            "rxTime": rx_time,
            "rx_time": rx_time,
            "from_id": None,
            "to_id": "^all",
            "channel": channel_idx,
            "snr": payload.get("SNR"),
            "rssi": payload.get("RSSI"),
            "protocol": "meshcore",
            "decoded": {
                "portnum": "TEXT_MESSAGE_APP",
                "text": text,
                "channel": channel_idx,
            },
        }
        _handlers._mark_packet_seen()
        _handlers.store_packet_dict(packet)
        config._debug_log(
            "MeshCore channel message",
            context="meshcore.channel_msg",
            channel=channel_idx,
        )

    async def on_contact_msg(evt) -> None:
        payload = evt.payload or {}
        sender_ts = payload.get("sender_timestamp")
        text = payload.get("text")
        if sender_ts is None or not text:
            return

        rx_time = int(time.time())
        pubkey_prefix = payload.get("pubkey_prefix", "")
        from_id = iface.lookup_node_id(pubkey_prefix)

        packet = {
            "id": _derive_message_id(sender_ts, pubkey_prefix or "", text),
            "rxTime": rx_time,
            "rx_time": rx_time,
            "from_id": from_id,
            "to_id": iface.host_node_id,
            "channel": 0,
            "snr": payload.get("SNR"),
            "protocol": "meshcore",
            "decoded": {
                "portnum": "TEXT_MESSAGE_APP",
                "text": text,
                "channel": 0,
            },
        }
        _handlers._mark_packet_seen()
        _handlers.store_packet_dict(packet)

    async def on_disconnected(evt) -> None:
        iface.isConnected = False
        config._debug_log(
            "MeshCore node disconnected",
            context="meshcore.disconnect",
            target=target or "unknown",
            severity="warning",
            always=True,
        )

    return {
        "SELF_INFO": on_self_info,
        "CONTACTS": on_contacts,
        "NEW_CONTACT": on_contact_update,
        "NEXT_CONTACT": on_contact_update,
        "CHANNEL_MSG_RECV": on_channel_msg,
        "CONTACT_MSG_RECV": on_contact_msg,
        "DISCONNECTED": on_disconnected,
    }


# ---------------------------------------------------------------------------
# Asyncio entry point (runs inside background thread)
# ---------------------------------------------------------------------------


def _make_connection(target: str, baudrate: int) -> object:
    """Create the appropriate MeshCore connection object for *target*.

    Routes to the correct ``meshcore`` connection class based on the target
    string format:

    * BLE MAC / UUID → :class:`meshcore.BLEConnection`
    * ``host:port`` / ``[ipv6]:port`` → :class:`meshcore.TCPConnection`
    * anything else → :class:`meshcore.SerialConnection`

    Parameters:
        target: Resolved, non-empty connection target.
        baudrate: Baud rate for serial connections (ignored for BLE/TCP).

    Returns:
        An unconnected ``meshcore`` connection object.
    """
    from meshcore import BLEConnection, SerialConnection, TCPConnection

    ble_addr = parse_ble_target(target)
    if ble_addr:
        return BLEConnection(address=ble_addr)

    tcp_target = parse_tcp_target(target)
    if tcp_target:
        host, port = tcp_target
        return TCPConnection(host, port)

    return SerialConnection(target, baudrate)


async def _run_meshcore(
    iface: _MeshcoreInterface,
    target: str,
    connected_event: threading.Event,
    error_holder: list,
) -> None:
    """Connect to a MeshCore node and keep the event loop running until closed.

    This coroutine is the single entry point for the background asyncio thread.
    It connects the MeshCore library, registers event handlers, fetches the
    initial contact list, starts auto-message polling, and then waits for the
    :attr:`_MeshcoreInterface._stop_event` to be set.

    Parameters:
        iface: Shared interface object for state and contact tracking.
        target: Resolved, non-empty connection target (serial, BLE, or TCP).
        connected_event: Threading event signalled when the connection
            succeeds or fails, to unblock the calling ``connect()`` method.
        error_holder: Single-element list; set to the raised exception when
            the connection attempt fails so the caller can re-raise it.
    """
    from meshcore import EventType, MeshCore

    mc: MeshCore | None = None
    try:
        cx = _make_connection(target, _DEFAULT_BAUDRATE)
        mc = MeshCore(cx)
        iface._mc = mc

        handlers_map = _make_event_handlers(iface, target)
        for event_name, callback in handlers_map.items():
            mc.subscribe(EventType[event_name], callback)

        _handled_types = frozenset(EventType[n] for n in handlers_map)
        # Bookkeeping events that require no action and should not be logged.
        _silent_types = frozenset(
            {
                EventType.CONNECTED,
                EventType.ACK,
                EventType.OK,
                EventType.ERROR,
                EventType.NO_MORE_MSGS,
                EventType.MESSAGES_WAITING,
                EventType.MSG_SENT,
                EventType.CURRENT_TIME,
            }
        )

        async def _on_unhandled(evt) -> None:
            if evt.type in _handled_types or evt.type in _silent_types:
                return
            _record_meshcore_message(
                evt.payload,
                source=f"{target or 'auto'}:{evt.type.name}",
            )

        mc.subscribe(None, _on_unhandled)

        result = await mc.connect()
        if result is None:
            raise ConnectionError(
                f"MeshCore node at {target!r} did not respond to the appstart "
                "handshake.  Ensure the device is running MeshCore companion-mode "
                "firmware."
            )

        iface.isConnected = True
        connected_event.set()

        try:
            await mc.ensure_contacts()
        except Exception as exc:
            config._debug_log(
                "Failed to fetch initial contacts",
                context="meshcore.contacts",
                severity="warning",
                always=True,
                error=str(exc),
            )

        await mc.start_auto_message_fetching()

        stop_event = asyncio.Event()
        iface._stop_event = stop_event
        await stop_event.wait()

    except Exception as exc:
        if not connected_event.is_set():
            error_holder[0] = exc
            connected_event.set()
    finally:
        if mc is not None:
            try:
                await mc.disconnect()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------


class MeshcoreProvider:
    """MeshCore ingestion provider.

    Connects to a MeshCore node via serial port, BLE, or TCP/IP.  The
    connection type is inferred from the target string; see :meth:`connect`
    for routing rules.

    The provider runs MeshCore's ``asyncio`` event loop in a background daemon
    thread.  Incoming ``SELF_INFO``, ``CONTACTS``, ``NEW_CONTACT``,
    ``CHANNEL_MSG_RECV``, and ``CONTACT_MSG_RECV`` events are forwarded to the
    HTTP ingest queue via the shared handler functions.
    """

    name = "meshcore"

    def subscribe(self) -> list[str]:
        """Return subscribed topic names.

        MeshCore uses an ``asyncio`` event system rather than a pubsub bus,
        so there are no topics to register at startup.
        """
        return []

    def connect(
        self, *, active_candidate: str | None
    ) -> tuple[object, str | None, str | None]:
        """Connect to a MeshCore node via serial, BLE, or TCP.

        Starts an asyncio event loop in a background daemon thread, performs
        the MeshCore companion-protocol handshake, and blocks until the node's
        self-info is received or the timeout expires.

        Connection type is inferred from *active_candidate* (or
        :data:`~data.mesh_ingestor.config.CONNECTION`):

        * BLE MAC / UUID → :class:`meshcore.BLEConnection`
        * ``host:port`` → :class:`meshcore.TCPConnection`
        * serial path → :class:`meshcore.SerialConnection`
        * ``None`` / empty → first candidate from
          :func:`~data.mesh_ingestor.connection.default_serial_targets`

        Parameters:
            active_candidate: Previously resolved connection target, or
                ``None`` to fall back to
                :data:`~data.mesh_ingestor.config.CONNECTION`.

        Returns:
            ``(iface, resolved_target, next_active_candidate)`` matching the
            :class:`~data.mesh_ingestor.provider.Provider` contract.

        Raises:
            ConnectionError: When the node does not complete the handshake
                within :data:`_CONNECT_TIMEOUT_SECS` seconds.
        """
        target: str | None = active_candidate or config.CONNECTION

        if not target:
            candidates = default_serial_targets()
            target = candidates[0] if candidates else "/dev/ttyACM0"

        config._debug_log(
            "Connecting to MeshCore node",
            context="meshcore.connect",
            target=target,
        )

        iface = _MeshcoreInterface(target=target)
        connected_event = threading.Event()
        error_holder: list = [None]

        def _run_loop() -> None:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            iface._loop = loop
            try:
                loop.run_until_complete(
                    _run_meshcore(iface, target, connected_event, error_holder)
                )
            finally:
                loop.close()

        thread = threading.Thread(target=_run_loop, name="meshcore-loop", daemon=True)
        iface._thread = thread
        thread.start()

        if not connected_event.wait(timeout=_CONNECT_TIMEOUT_SECS):
            iface.close()
            raise ConnectionError(
                f"Timed out waiting for MeshCore node at {target!r} "
                f"after {_CONNECT_TIMEOUT_SECS:g}s."
            )

        if error_holder[0] is not None:
            iface.close()
            raise error_holder[0]

        return iface, target, target

    def extract_host_node_id(self, iface: object) -> str | None:
        """Return the canonical ``!xxxxxxxx`` host node ID from the interface.

        Parameters:
            iface: Active :class:`_MeshcoreInterface` returned by
                :meth:`connect`.
        """
        return getattr(iface, "host_node_id", None)

    def node_snapshot_items(self, iface: object) -> list[tuple[str, dict]]:
        """Return a snapshot of all known MeshCore contacts as node entries.

        Parameters:
            iface: Active :class:`_MeshcoreInterface` instance.  Any other
                object type causes an empty list to be returned.

        Returns:
            List of ``(canonical_node_id, node_dict)`` pairs suitable for
            passing to :func:`~data.mesh_ingestor.handlers.upsert_node`.
        """
        if not isinstance(iface, _MeshcoreInterface):
            return []
        return iface.contacts_snapshot()


__all__ = ["MeshcoreProvider"]
