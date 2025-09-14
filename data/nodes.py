import json, os, sqlite3, time, threading
from pathlib import Path

try:  # meshtastic is optional for tests
    from meshtastic.serial_interface import SerialInterface
    from meshtastic.mesh_interface import MeshInterface
except ModuleNotFoundError:  # pragma: no cover - imported lazily for hardware usage
    SerialInterface = None  # type: ignore
    MeshInterface = None  # type: ignore

DB = os.environ.get("MESH_DB", "nodes.db")

schema = Path(__file__).with_name("nodes.sql").read_text()
conn = sqlite3.connect(DB, check_same_thread=False)
conn.executescript(schema)
conn.commit()


def _get(obj, key, default=None):
    """Return value for key/attribute from dicts or objects."""
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def upsert_node(node_id, n):
    user = _get(n, "user") or {}
    met = _get(n, "deviceMetrics") or {}
    pos = _get(n, "position") or {}
    lh = _get(n, "lastHeard")
    now = int(time.time())
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
        now,
        lh or now,
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


def load_nodes_from_file(path: str | Path):
    """Populate the database from a nodes.json file."""
    nodes = json.loads(Path(path).read_text())
    for node_id, node in nodes.items():
        upsert_node(node_id, node)
    conn.commit()


def main():
    if SerialInterface is None:
        raise RuntimeError("meshtastic library not installed")
    iface = SerialInterface(
        # or whatever serial interface it is
        devPath="/dev/ttyACM0"
    )
    print("Nodes ingestor running. Ctrl+C to stop.")
    while True:
        try:
            for node_id, n in (getattr(iface, "nodes", {}) or {}).items():
                upsert_node(node_id, n)
            conn.commit()
        except Exception as e:
            print("node snapshot error:", e)
        time.sleep(30)


if __name__ == "__main__":
    main()
