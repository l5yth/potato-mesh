#!/usr/bin/env python3

# Copyright (C) 2025 l5yth
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

"""Mesh daemon helpers for synchronising Meshtastic data.

This module wraps the Meshtastic serial interface and exposes helper
functions that serialise nodes and text messages to JSON before forwarding
them to the accompanying web API.  It also provides the long-running daemon
entry point that performs these synchronisation tasks.
"""

import dataclasses
import heapq
import itertools
import json, os, time, threading, signal, urllib.request, urllib.error
from collections.abc import Mapping

from meshtastic.serial_interface import SerialInterface
from pubsub import pub
from google.protobuf.json_format import MessageToDict
from google.protobuf.message import Message as ProtoMessage

# --- Config (env overrides) ---------------------------------------------------
PORT = os.environ.get("MESH_SERIAL", "/dev/ttyACM0")
SNAPSHOT_SECS = int(os.environ.get("MESH_SNAPSHOT_SECS", "60"))
CHANNEL_INDEX = int(os.environ.get("MESH_CHANNEL_INDEX", "0"))
DEBUG = os.environ.get("DEBUG") == "1"
INSTANCE = os.environ.get("POTATOMESH_INSTANCE", "").rstrip("/")
API_TOKEN = os.environ.get("API_TOKEN", "")


# --- Serial interface helpers --------------------------------------------------


class _DummySerialInterface:
    """In-memory replacement for ``meshtastic.serial_interface.SerialInterface``.

    The GitHub Actions release tests run the ingestor container without access
    to a serial device.  When ``MESH_SERIAL`` is set to ``"mock"`` (or similar)
    we provide this stub interface so the daemon can start and exercise its
    background loop without failing due to missing hardware.
    """

    def __init__(self):
        self.nodes = {}

    def close(self):
        """Mirror the real interface API."""
        pass


def _create_serial_interface(port: str):
    """Return an appropriate serial interface for ``port``.

    Passing ``mock`` (case-insensitive) or an empty value skips hardware access
    and returns :class:`_DummySerialInterface`.  This makes it possible to run
    the container in CI environments that do not expose serial devices while
    keeping production behaviour unchanged.
    """

    port_value = (port or "").strip()
    if port_value.lower() in {"", "mock", "none", "null", "disabled"}:
        if DEBUG:
            print(f"[debug] using dummy serial interface for port={port_value!r}")
        return _DummySerialInterface()
    return SerialInterface(devPath=port_value)


# --- POST queue ----------------------------------------------------------------
_POST_QUEUE_LOCK = threading.Lock()
_POST_QUEUE = []
_POST_QUEUE_COUNTER = itertools.count()
_POST_QUEUE_ACTIVE = False

_NODE_POST_PRIORITY = 0
_MESSAGE_POST_PRIORITY = 10
_DEFAULT_POST_PRIORITY = 50


def _get(obj, key, default=None):
    """Return a key or attribute value from ``obj``.

    Args:
        obj: Mapping or object containing the desired value.
        key: Key or attribute name to look up.
        default: Value returned when the key is missing.

    Returns:
        The resolved value if present, otherwise ``default``.
    """
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


# --- HTTP helpers -------------------------------------------------------------
def _post_json(path: str, payload: dict):
    """Send a JSON payload to the configured web API.

    Args:
        path: API path relative to the configured ``INSTANCE``.
        payload: Mapping serialised to JSON for the request body.
    """

    if not INSTANCE:
        return
    url = f"{INSTANCE}{path}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}
    )
    if API_TOKEN:
        req.add_header("Authorization", f"Bearer {API_TOKEN}")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
    except Exception as e:
        if DEBUG:
            print(f"[warn] POST {url} failed: {e}")


def _enqueue_post_json(path: str, payload: dict, priority: int):
    """Store a POST request in the priority queue."""

    with _POST_QUEUE_LOCK:
        heapq.heappush(
            _POST_QUEUE, (priority, next(_POST_QUEUE_COUNTER), path, payload)
        )


def _drain_post_queue():
    """Process queued POST requests in priority order."""

    global _POST_QUEUE_ACTIVE
    while True:
        with _POST_QUEUE_LOCK:
            if not _POST_QUEUE:
                _POST_QUEUE_ACTIVE = False
                return
            _priority, _idx, path, payload = heapq.heappop(_POST_QUEUE)
        _post_json(path, payload)


def _queue_post_json(
    path: str, payload: dict, *, priority: int = _DEFAULT_POST_PRIORITY
):
    """Queue a POST request and start processing if idle."""

    global _POST_QUEUE_ACTIVE
    _enqueue_post_json(path, payload, priority)
    with _POST_QUEUE_LOCK:
        if _POST_QUEUE_ACTIVE:
            return
        _POST_QUEUE_ACTIVE = True
    _drain_post_queue()


def _clear_post_queue():
    """Clear the pending POST queue (used by tests)."""

    global _POST_QUEUE_ACTIVE
    with _POST_QUEUE_LOCK:
        _POST_QUEUE.clear()
        _POST_QUEUE_ACTIVE = False


# --- Node upsert --------------------------------------------------------------
def _node_to_dict(n) -> dict:
    """Convert Meshtastic node or user structures into plain dictionaries.

    Args:
        n: ``dict``, dataclass or protobuf message describing a node or user.

    Returns:
        JSON serialisable representation of ``n``.
    """

    def _convert(value):
        """Recursively convert dataclasses and protobuf messages."""
        if isinstance(value, dict):
            return {k: _convert(v) for k, v in value.items()}
        if isinstance(value, (list, tuple, set)):
            return [_convert(v) for v in value]
        if dataclasses.is_dataclass(value):
            return {k: _convert(getattr(value, k)) for k in value.__dataclass_fields__}
        if isinstance(value, ProtoMessage):
            return MessageToDict(
                value, preserving_proto_field_name=True, use_integers_for_enums=False
            )
        if isinstance(value, bytes):
            try:
                return value.decode()
            except Exception:
                return value.hex()
        if isinstance(value, (str, int, float, bool)) or value is None:
            return value
        try:
            return json.loads(json.dumps(value, default=str))
        except Exception:
            return str(value)

    return _convert(n)


def upsert_node(node_id, n):
    """Forward a node snapshot to the web API.

    Args:
        node_id: Unique identifier of the node in the mesh.
        n: Node object obtained from the Meshtastic serial interface.
    """

    ndict = _node_to_dict(n)
    _queue_post_json("/api/nodes", {node_id: ndict}, priority=_NODE_POST_PRIORITY)

    if DEBUG:
        user = _get(ndict, "user") or {}
        short = _get(user, "shortName")
        print(f"[debug] upserted node {node_id} shortName={short!r}")


# --- Message logging via PubSub -----------------------------------------------
def _iso(ts: int | float) -> str:
    """Return an ISO-8601 timestamp string for ``ts``.

    Args:
        ts: POSIX timestamp as ``int`` or ``float``.

    Returns:
        Timestamp formatted with a trailing ``Z`` to denote UTC.
    """

    import datetime

    return (
        datetime.datetime.fromtimestamp(int(ts), datetime.UTC)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _first(d, *names, default=None):
    """Return the first non-empty key from ``names`` (supports nested lookups).

    Keys that resolve to ``None`` or an empty string are skipped so callers can
    provide multiple potential field names without accidentally capturing an
    explicit ``null`` value.

    Args:
        d: Mapping or object to query.
        *names: Candidate field names using dotted paths for nesting.
        default: Value returned when all candidates are missing.

    Returns:
        The first matching value or ``default`` if none resolve to content.
    """

    def _mapping_get(obj, key):
        if isinstance(obj, Mapping) and key in obj:
            return True, obj[key]
        if hasattr(obj, "__getitem__"):
            try:
                return True, obj[key]
            except Exception:
                pass
        if hasattr(obj, key):
            return True, getattr(obj, key)
        return False, None

    for name in names:
        cur = d
        ok = True
        for part in name.split("."):
            ok, cur = _mapping_get(cur, part)
            if not ok:
                break
        if ok:
            if cur is None:
                continue
            if isinstance(cur, str) and cur == "":
                continue
            return cur
    return default


def _pkt_to_dict(packet) -> dict:
    """Normalise a received packet into a JSON-friendly dictionary.

    Args:
        packet: Protobuf ``MeshPacket`` or dictionary received from the daemon.

    Returns:
        Packet data ready for JSON serialisation.
    """
    if isinstance(packet, dict):
        return packet
    if isinstance(packet, ProtoMessage):
        return MessageToDict(
            packet, preserving_proto_field_name=True, use_integers_for_enums=False
        )
    # Last resort: try to read attributes
    try:
        return json.loads(json.dumps(packet, default=lambda o: str(o)))
    except Exception:
        return {"_unparsed": str(packet)}


def store_packet_dict(p: dict):
    """Persist text messages extracted from a decoded packet.

    Only packets from the ``TEXT_MESSAGE_APP`` port are forwarded to the
    web API. Field lookups tolerate camelCase and snake_case variants for
    compatibility across Meshtastic releases.

    Args:
        p: Packet dictionary produced by ``_pkt_to_dict``.
    """
    dec = p.get("decoded") or {}
    text = _first(dec, "payload.text", "text", default=None)
    if not text:
        return  # ignore non-text packets

    # port filter: only keep packets from the TEXT_MESSAGE_APP port
    portnum_raw = _first(dec, "portnum", default=None)
    portnum = str(portnum_raw).upper() if portnum_raw is not None else None
    if portnum and portnum not in {"1", "TEXT_MESSAGE_APP"}:
        return  # ignore non-text-message ports

    # channel (prefer decoded.channel if present; else top-level)
    ch = _first(dec, "channel", default=None)
    if ch is None:
        ch = _first(p, "channel", default=0)
    try:
        ch = int(ch)
    except Exception:
        ch = 0

    # timestamps & ids
    pkt_id = _first(p, "id", "packet_id", "packetId", default=None)
    if pkt_id is None:
        return  # ignore packets without an id
    rx_time = int(_first(p, "rxTime", "rx_time", default=time.time()))
    from_id = _first(p, "fromId", "from_id", "from", default=None)
    to_id = _first(p, "toId", "to_id", "to", default=None)

    if (from_id is None or str(from_id) == "") and DEBUG:
        try:
            raw = json.dumps(p, default=str)
        except Exception:
            raw = str(p)
        print(f"[debug] packet missing from_id: {raw}")

    # link metrics
    snr = _first(p, "snr", "rx_snr", "rxSnr", default=None)
    rssi = _first(p, "rssi", "rx_rssi", "rxRssi", default=None)
    hop = _first(p, "hopLimit", "hop_limit", default=None)

    msg = {
        "id": int(pkt_id),
        "rx_time": rx_time,
        "rx_iso": _iso(rx_time),
        "from_id": from_id,
        "to_id": to_id,
        "channel": ch,
        "portnum": str(portnum) if portnum is not None else None,
        "text": text,
        "snr": float(snr) if snr is not None else None,
        "rssi": int(rssi) if rssi is not None else None,
        "hop_limit": int(hop) if hop is not None else None,
    }
    _queue_post_json("/api/messages", msg, priority=_MESSAGE_POST_PRIORITY)

    if DEBUG:
        print(
            f"[debug] stored message from {from_id!r} to {to_id!r} ch={ch} text={text!r}"
        )


# PubSub receive handler
def on_receive(packet, interface):
    """PubSub callback that stores inbound text messages.

    Args:
        packet: Packet received from the Meshtastic interface.
        interface: Serial interface instance (unused).
    """

    p = None
    try:
        p = _pkt_to_dict(packet)
        store_packet_dict(p)
    except Exception as e:
        info = list(p.keys()) if isinstance(p, dict) else type(packet)
        print(f"[warn] failed to store packet: {e} | info: {info}")


# --- Main ---------------------------------------------------------------------
def _node_items_snapshot(nodes_obj, retries: int = 3):
    """Return a snapshot list of ``(node_id, node)`` pairs.

    The Meshtastic ``SerialInterface`` updates ``iface.nodes`` from another
    thread. When that happens during iteration Python raises ``RuntimeError``.
    To keep the daemon quiet we retry a few times and, if it keeps changing,
    bail out for this loop.

    Args:
        nodes_obj: Container mapping node IDs to node objects.
        retries: Number of attempts performed before giving up.

    Returns:
        Snapshot of node entries or ``None`` when retries were exhausted because
        the container kept mutating.
    """

    if not nodes_obj:
        return []

    items_callable = getattr(nodes_obj, "items", None)
    if callable(items_callable):
        for _ in range(max(1, retries)):
            try:
                return list(items_callable())
            except RuntimeError as err:
                if "dictionary changed size during iteration" not in str(err):
                    raise
                time.sleep(0)
        return None

    if hasattr(nodes_obj, "__iter__") and hasattr(nodes_obj, "__getitem__"):
        for _ in range(max(1, retries)):
            try:
                keys = list(nodes_obj)
                return [(k, nodes_obj[k]) for k in keys]
            except RuntimeError as err:
                if "dictionary changed size during iteration" not in str(err):
                    raise
                time.sleep(0)
        return None

    return []


def main():
    """Run the mesh synchronisation daemon."""

    # Subscribe to PubSub topics (reliable in current meshtastic)
    pub.subscribe(on_receive, "meshtastic.receive")

    iface = _create_serial_interface(PORT)

    stop = threading.Event()

    def handle_sig(*_):
        """Stop the daemon when a termination signal is received."""

        stop.set()

    signal.signal(signal.SIGINT, handle_sig)
    signal.signal(signal.SIGTERM, handle_sig)

    target = INSTANCE or "(no POTATOMESH_INSTANCE)"
    print(
        f"Mesh daemon: nodes+messages → {target} | port={PORT} | channel={CHANNEL_INDEX}"
    )
    while not stop.is_set():
        try:
            nodes = getattr(iface, "nodes", {}) or {}
            node_items = _node_items_snapshot(nodes)
            if node_items is None:
                if DEBUG:
                    print(
                        "[debug] skipping node snapshot; nodes changed during iteration"
                    )
            else:
                for node_id, n in node_items:
                    try:
                        upsert_node(node_id, n)
                    except Exception as e:
                        print(
                            f"[warn] failed to update node snapshot for {node_id}: {e}"
                        )
                        if DEBUG:
                            print(f"[debug] node object: {n!r}")
        except Exception as e:
            print(f"[warn] failed to update node snapshot: {e}")
        stop.wait(SNAPSHOT_SECS)

    try:
        iface.close()
    except Exception:
        pass


if __name__ == "__main__":
    main()
