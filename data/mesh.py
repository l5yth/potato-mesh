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

import dataclasses
import json, os, time, threading, signal, urllib.request, urllib.error
from collections.abc import Mapping

from meshtastic.serial_interface import SerialInterface
from pubsub import pub
from google.protobuf.json_format import MessageToDict
from google.protobuf.message import Message as ProtoMessage

# --- Config (env overrides) ---------------------------------------------------
PORT = os.environ.get("MESH_SERIAL", "/dev/ttyACM0")
SNAPSHOT_SECS = int(os.environ.get("MESH_SNAPSHOT_SECS", "30"))
CHANNEL_INDEX = int(os.environ.get("MESH_CHANNEL_INDEX", "0"))
DEBUG = os.environ.get("DEBUG") == "1"
INSTANCE = os.environ.get("POTATOMESH_INSTANCE", "").rstrip("/")
API_TOKEN = os.environ.get("API_TOKEN", "")


def _get(obj, key, default=None):
    """Return value for key/attribute from dicts or objects."""
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


# --- HTTP helpers -------------------------------------------------------------
def _post_json(path: str, payload: dict):
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


# --- Node upsert --------------------------------------------------------------
def _node_to_dict(n) -> dict:
    """Convert Meshtastic node/user objects into plain dicts."""

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
    ndict = _node_to_dict(n)
    _post_json("/api/nodes", {node_id: ndict})

    if DEBUG:
        user = _get(ndict, "user") or {}
        short = _get(user, "shortName")
        print(f"[debug] upserted node {node_id} shortName={short!r}")


# --- Message logging via PubSub -----------------------------------------------
def _iso(ts: int | float) -> str:
    import datetime

    return (
        datetime.datetime.fromtimestamp(int(ts), datetime.UTC)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _first(d, *names, default=None):
    """Return first non-empty key from names (supports nested 'a.b' lookups).

    Keys that resolve to ``None`` or an empty string are skipped so callers can
    provide multiple potential field names without accidentally capturing an
    explicit ``null`` value.
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
    """Convert protobuf MeshPacket or already-dict into a JSON-friendly dict."""
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
    """
    Store only TEXT messages (decoded.payload.text) by posting to the API.
    Safe against snake/camel case differences.
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
    _post_json("/api/messages", msg)

    if DEBUG:
        print(
            f"[debug] stored message from {from_id!r} to {to_id!r} ch={ch} text={text!r}"
        )


# PubSub receive handler
def on_receive(packet, interface):
    p = None
    try:
        p = _pkt_to_dict(packet)
        store_packet_dict(p)
    except Exception as e:
        info = list(p.keys()) if isinstance(p, dict) else type(packet)
        print(f"[warn] failed to store packet: {e} | info: {info}")


# --- Main ---------------------------------------------------------------------
def _node_items_snapshot(nodes_obj, retries: int = 3):
    """Return a snapshot list of (node_id, node) pairs.

    The SerialInterface updates ``iface.nodes`` from another thread. When that
    happens while we iterate over the dictionary Python raises ``RuntimeError``
    because the dictionary changed size during iteration. To keep the daemon
    quiet we retry a few times and, if it keeps changing, bail out for this loop
    iteration.
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
    # Subscribe to PubSub topics (reliable in current meshtastic)
    pub.subscribe(on_receive, "meshtastic.receive")

    iface = SerialInterface(devPath=PORT)

    stop = threading.Event()

    def handle_sig(*_):
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
