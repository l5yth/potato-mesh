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
connected via serial port or BLE.  TCP/IP targets are not supported by
MeshCore and will be rejected at connect time.

The provider runs MeshCore's ``asyncio`` event loop in a background daemon
thread so that incoming events are dispatched without blocking the
synchronous daemon loop.  Received contacts, channel messages, and direct
messages are forwarded to the shared HTTP ingest queue via the same
:mod:`~data.mesh_ingestor.handlers` helpers used by the Meshtastic provider.

Node identities are derived from the first four bytes (eight hex characters)
of each contact's 32-byte public key, formatted as ``!xxxxxxxx`` to match
the canonical node-ID schema used across the system.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from .. import config

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

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_TCP_TARGET_RE = re.compile(r"[^:]+:\d{1,5}")
"""Pattern matching a ``host:port`` TCP target (exactly one colon, port 1–5 digits).

Using ``fullmatch`` ensures BLE MAC addresses (``AA:BB:CC:DD:EE:12``) are not
mistaken for TCP targets — the multiple colons in a MAC prevent a full match
against the ``[^:]+:\\d{1,5}`` pattern.
"""


def _is_tcp_target(target: str) -> bool:
    """Return ``True`` when *target* looks like a TCP ``host:port`` address.

    BLE MAC addresses such as ``AA:BB:CC:DD:EE:12`` are correctly rejected
    because they contain more than one colon, which prevents a full match
    against the ``[^:]+:\\d{1,5}`` pattern.
    """
    return bool(_TCP_TARGET_RE.fullmatch(target))


def _meshcore_node_id(public_key_hex: str) -> str | None:
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
            include ``public_key``, ``adv_name``, ``last_advert``,
            ``adv_lat``, and ``adv_lon``.

    Returns:
        Node dict compatible with the ``POST /api/nodes`` payload format.
    """
    pub_key = contact.get("public_key", "")
    name = (contact.get("adv_name") or "").strip()
    node: dict = {
        "lastHeard": contact.get("last_advert"),
        "user": {
            "longName": name,
            "shortName": name[:4] if name else "",
            "publicKey": pub_key,
        },
    }
    lat = contact.get("adv_lat")
    lon = contact.get("adv_lon")
    if lat is not None and lon is not None and (lat != 0.0 or lon != 0.0):
        node["position"] = {"latitude": lat, "longitude": lon}
    return node


def _self_info_to_node_dict(self_info: dict) -> dict:
    """Convert a MeshCore ``SELF_INFO`` payload to a Meshtastic-ish node dict.

    Parameters:
        self_info: Payload dict from the ``SELF_INFO`` event.  Expected keys
            include ``name``, ``public_key``, ``adv_lat``, and ``adv_lon``.

    Returns:
        Node dict compatible with the ``POST /api/nodes`` payload format.
    """
    name = (self_info.get("name") or "").strip()
    pub_key = self_info.get("public_key", "")
    node: dict = {
        "lastHeard": int(time.time()),
        "user": {
            "longName": name,
            "shortName": name[:4] if name else "",
            "publicKey": pub_key,
        },
    }
    lat = self_info.get("adv_lat")
    lon = self_info.get("adv_lon")
    if lat is not None and lon is not None and (lat != 0.0 or lon != 0.0):
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
    from .. import handlers as _handlers

    async def on_self_info(evt) -> None:
        payload = evt.payload or {}
        pub_key = payload.get("public_key", "")
        node_id = _meshcore_node_id(pub_key)
        if node_id:
            iface.host_node_id = node_id
            _handlers.register_host_node_id(node_id)
            _handlers.upsert_node(node_id, _self_info_to_node_dict(payload))
        _handlers._mark_packet_seen()
        config._debug_log(
            "MeshCore self-info received",
            context="meshcore.self_info",
            node_id=node_id,
            name=payload.get("name"),
        )

    async def on_contacts(evt) -> None:
        contacts = evt.payload or {}
        for pub_key, contact in contacts.items():
            node_id = _meshcore_node_id(pub_key)
            if node_id is None:
                continue
            iface._update_contact(contact)
            _handlers.upsert_node(node_id, _contact_to_node_dict(contact))
        _handlers._mark_packet_seen()

    async def on_contact_update(evt) -> None:
        contact = evt.payload or {}
        pub_key = contact.get("public_key", "")
        node_id = _meshcore_node_id(pub_key)
        if node_id is None:
            return
        iface._update_contact(contact)
        _handlers.upsert_node(node_id, _contact_to_node_dict(contact))
        _handlers._mark_packet_seen()
        config._debug_log(
            "MeshCore contact updated",
            context="meshcore.contact",
            node_id=node_id,
            name=contact.get("adv_name"),
        )

    async def on_channel_msg(evt) -> None:
        payload = evt.payload or {}
        sender_ts = payload.get("sender_timestamp")
        text = payload.get("text")
        if sender_ts is None or not text:
            return

        rx_time = int(time.time())
        channel_idx = payload.get("channel_idx", 0)

        packet = {
            "id": sender_ts,
            "rxTime": rx_time,
            "rx_time": rx_time,
            "from_id": None,
            "to_id": "^all",
            "channel": channel_idx,
            "snr": payload.get("SNR"),
            "rssi": payload.get("RSSI"),
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
            "id": sender_ts,
            "rxTime": rx_time,
            "rx_time": rx_time,
            "from_id": from_id,
            "to_id": iface.host_node_id,
            "channel": 0,
            "snr": payload.get("SNR"),
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
            severity="warn",
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


async def _run_meshcore(
    iface: _MeshcoreInterface,
    target: str | None,
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
        target: Serial port path or BLE address to connect to.
        connected_event: Threading event signalled when the connection
            succeeds or fails, to unblock the calling ``connect()`` method.
        error_holder: Single-element list; set to the raised exception when
            the connection attempt fails so the caller can re-raise it.
    """
    from meshcore import EventType, MeshCore, SerialConnection

    mc: MeshCore | None = None
    try:
        cx = SerialConnection(target, _DEFAULT_BAUDRATE)
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
                severity="warn",
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

    Connects to a MeshCore node via serial port or BLE.  TCP/IP connections
    are not supported by the MeshCore protocol and will raise
    :exc:`ValueError`.

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
        """Connect to a MeshCore node via serial or BLE.

        Starts an asyncio event loop in a background daemon thread, performs
        the MeshCore companion-protocol handshake, and blocks until the node's
        self-info is received or the timeout expires.

        Parameters:
            active_candidate: Previously resolved connection target, or
                ``None`` to fall back to
                :data:`~data.mesh_ingestor.config.CONNECTION`.

        Returns:
            ``(iface, resolved_target, next_active_candidate)`` matching the
            :class:`~data.mesh_ingestor.provider.Provider` contract.

        Raises:
            ValueError: When *target* looks like a TCP ``host:port`` address,
                since MeshCore does not support IP connections.
            ConnectionError: When the node does not complete the handshake
                within :data:`_CONNECT_TIMEOUT_SECS` seconds.
        """
        target = active_candidate or config.CONNECTION

        if target and _is_tcp_target(target):
            raise ValueError(
                f"MeshCore does not support TCP/IP targets: {target!r}. "
                "Provide a serial port (e.g. /dev/ttyUSB0) or BLE address."
            )

        config._debug_log(
            "Connecting to MeshCore node",
            context="meshcore.connect",
            target=target or "auto",
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

        thread = threading.Thread(
            target=_run_loop, name="meshcore-loop", daemon=True
        )
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
