#!/usr/bin/env python3
import json, os, sqlite3, time, threading, signal
from pathlib import Path

from meshtastic.serial_interface import SerialInterface
from meshtastic.mesh_interface import MeshInterface
from pubsub import pub
from google.protobuf.json_format import MessageToDict
from google.protobuf.message import Message as ProtoMessage

# --- Config (env overrides) ---------------------------------------------------
DB = os.environ.get("MESH_DB", "mesh.db")
PORT = os.environ.get("MESH_SERIAL", "/dev/ttyACM0")
SNAPSHOT_SECS = int(os.environ.get("MESH_SNAPSHOT_SECS", "30"))
CHANNEL_INDEX = int(os.environ.get("MESH_CHANNEL_INDEX", "0"))
DEBUG = os.environ.get("DEBUG") == "1"

# --- DB setup -----------------------------------------------------------------
nodeSchema = Path(__file__).with_name("nodes.sql").read_text()
conn = sqlite3.connect(DB, check_same_thread=False)
conn.executescript(nodeSchema)
msgSchema = Path(__file__).with_name("messages.sql").read_text()
conn.executescript(msgSchema)
conn.commit()

DB_LOCK = threading.Lock()


def _get(obj, key, default=None):
    """Return value for key/attribute from dicts or objects."""
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


# --- Node upsert --------------------------------------------------------------
def upsert_node(node_id, n):
    user = _get(n, "user") or {}
    met = _get(n, "deviceMetrics") or {}
    pos = _get(n, "position") or {}
    lh = _get(n, "lastHeard")
    pt = _get(pos, "time")
    now = int(time.time())
    if pt is not None and pt > now:
        pt = None
    if lh is not None and lh > now:
        lh = now
    if pt is not None and (lh is None or lh < pt):
        lh = pt
    row = (
        node_id,
        _get(n, "num"),
        _get(user, "shortName"),
        _get(user, "longName"),
        _get(user, "macaddr"),
        _get(user, "hwModel") or _get(n, "hwModel"),
        _get(user, "role"),
        _get(user, "publicKey"),
        _get(user, "isUnmessagable"),
        _get(n, "isFavorite"),
        _get(n, "hopsAway"),
        _get(n, "snr"),
        lh,
        lh,
        _get(met, "batteryLevel"),
        _get(met, "voltage"),
        _get(met, "channelUtilization"),
        _get(met, "airUtilTx"),
        _get(met, "uptimeSeconds"),
        pt,
        _get(pos, "locationSource"),
        _get(pos, "latitude"),
        _get(pos, "longitude"),
        _get(pos, "altitude"),
    )
    with DB_LOCK:
        conn.execute(
            """
        INSERT INTO nodes(node_id,num,short_name,long_name,macaddr,hw_model,role,public_key,is_unmessagable,is_favorite,
                          hops_away,snr,last_heard,first_heard,battery_level,voltage,channel_utilization,air_util_tx,uptime_seconds,
                          position_time,location_source,latitude,longitude,altitude)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(node_id) DO UPDATE SET
          num=excluded.num, short_name=excluded.short_name, long_name=excluded.long_name, macaddr=excluded.macaddr,
          hw_model=excluded.hw_model, role=excluded.role, public_key=excluded.public_key, is_unmessagable=excluded.is_unmessagable,
          is_favorite=excluded.is_favorite, hops_away=excluded.hops_away, snr=excluded.snr, last_heard=excluded.last_heard,
          battery_level=excluded.battery_level, voltage=excluded.voltage, channel_utilization=excluded.channel_utilization,
          air_util_tx=excluded.air_util_tx, uptime_seconds=excluded.uptime_seconds, position_time=excluded.position_time,
          location_source=excluded.location_source, latitude=excluded.latitude, longitude=excluded.longitude,
          altitude=excluded.altitude
        """,
            row,
        )

    if DEBUG:
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


def _first(d: dict, *names, default=None):
    """Return first present key from names (supports nested 'a.b' lookups)."""
    for name in names:
        cur = d
        parts = name.split(".")
        ok = True
        for p in parts:
            if isinstance(cur, dict) and p in cur:
                cur = cur[p]
            else:
                ok = False
                break
        if ok:
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
    Store only TEXT messages (decoded.payload.text) to the DB.
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
    rx_time = int(_first(p, "rxTime", "rx_time", default=time.time()))
    from_id = _first(p, "fromId", "from_id", "from", default=None)
    to_id = _first(p, "toId", "to_id", "to", default=None)

    # link metrics
    snr = _first(p, "snr", "rx_snr", "rxSnr", default=None)
    rssi = _first(p, "rssi", "rx_rssi", "rxRssi", default=None)
    hop = _first(p, "hopLimit", "hop_limit", default=None)

    row = (
        rx_time,
        _iso(rx_time),
        from_id,
        to_id,
        ch,
        str(portnum) if portnum is not None else None,
        text,
        float(snr) if snr is not None else None,
        int(rssi) if rssi is not None else None,
        int(hop) if hop is not None else None,
    )
    with DB_LOCK:
        conn.execute(
            """INSERT INTO messages
               (rx_time, rx_iso, from_id, to_id, channel, portnum, text, snr, rssi, hop_limit)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            row,
        )
        conn.commit()

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
def main():
    # Subscribe to PubSub topics (reliable in current meshtastic)
    pub.subscribe(on_receive, "meshtastic.receive")

    iface = SerialInterface(devPath=PORT)

    stop = threading.Event()

    def handle_sig(*_):
        stop.set()

    signal.signal(signal.SIGINT, handle_sig)
    signal.signal(signal.SIGTERM, handle_sig)

    print(f"Mesh daemon: nodes+messages → {DB} | port={PORT} | channel={CHANNEL_INDEX}")
    while not stop.is_set():
        try:
            nodes = getattr(iface, "nodes", {}) or {}
            for node_id, n in nodes.items():
                upsert_node(node_id, n)
            with DB_LOCK:
                conn.commit()
        except Exception as e:
            print(f"[warn] failed to update node snapshot: {e}")
        stop.wait(SNAPSHOT_SECS)

    try:
        iface.close()
    except Exception:
        pass
    with DB_LOCK:
        conn.commit()
    conn.close()


if __name__ == "__main__":
    main()
