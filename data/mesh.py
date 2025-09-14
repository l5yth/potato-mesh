#!/usr/bin/env python3
import json, os, sqlite3, time, threading, signal
from pathlib import Path

try:  # meshtastic is optional for tests
    from meshtastic.serial_interface import SerialInterface
    from meshtastic.mesh_interface import MeshInterface
except ModuleNotFoundError:  # pragma: no cover - imported lazily for hardware usage
    SerialInterface = None  # type: ignore
    MeshInterface = None  # type: ignore

# --- Config (env overrides) ---------------------------------------------------
DB = os.environ.get("MESH_DB", "mesh.db")
PORT = os.environ.get("MESH_SERIAL", "/dev/ttyACM0")
SNAPSHOT_SECS = int(os.environ.get("MESH_SNAPSHOT_SECS", "30"))
CHANNEL_INDEX = int(os.environ.get("MESH_CHANNEL_INDEX", "0"))  # main #MediumFast

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
        _get(pos, "time"),
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

# --- Nodes.json loader (unchanged) -------------------------------------------
def load_nodes_from_file(path: str | Path):
    """Populate the database from a nodes.json file."""
    nodes = json.loads(Path(path).read_text())
    for node_id, node in nodes.items():
        upsert_node(node_id, node)
    with DB_LOCK:
        conn.commit()

# --- Message logging via the same SerialInterface -----------------------------
def _iso(ts: int | float) -> str:
    import datetime
    return datetime.datetime.utcfromtimestamp(int(ts)).isoformat() + "Z"

def store_packet(packet: dict):
    """Store a received packet into messages table (filtered by channel)."""
    dec = packet.get("decoded") or {}
    ch = dec.get("channel", packet.get("channel"))
    if ch is None:
        ch = 0  # default to main if radio didn't annotate
    try:
        ch = int(ch)
    except Exception:
        ch = 0

    # if ch != CHANNEL_INDEX:
    #     return  # only log main channel (override via env if needed)

    rx_time = int(packet.get("rxTime") or time.time())
    from_id = packet.get("fromId")
    to_id   = packet.get("toId")
    portnum = dec.get("portnum")  # can be enum name or numeric
    text    = dec.get("text")
    snr     = packet.get("snr")
    rssi    = packet.get("rssi")
    hop     = packet.get("hopLimit") or packet.get("hop_limit")

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
        # json.dumps(packet, ensure_ascii=False),
    )
    with DB_LOCK:
        conn.execute(
            """INSERT INTO messages
               (rx_time, rx_iso, from_id, to_id, channel, portnum, text, snr, rssi, hop_limit)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            row,
        )

# --- Main ---------------------------------------------------------------------
def main():
    if SerialInterface is None:
        raise RuntimeError("meshtastic library not installed")

    iface = SerialInterface(devPath=PORT)

    # Packet callback runs in iface reader thread
    def on_receive(packet, _interface):
        try:
            store_packet(packet)
        except Exception as e:
            # Keep daemon resilient
            print(f"[warn] failed to store packet: {e}")

    iface.onReceive = on_receive

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
            print("node snapshot error:", e)
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
