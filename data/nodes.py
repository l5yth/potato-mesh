import json, sqlite3, time, threading
from pathlib import Path
from meshtastic.serial_interface import SerialInterface
from meshtastic.mesh_interface import MeshInterface

DB = "nodes.db"

schema = Path("nodes.sql").read_text()
conn = sqlite3.connect(DB, check_same_thread=False)
conn.executescript(schema)
conn.commit()

def upsert_node(node_id, n):
    user = (n.get("user") or {})
    met  = (n.get("deviceMetrics") or {})
    pos  = (n.get("position") or {})
    row = (
        node_id,
        n.get("num"),
        user.get("shortName"),
        user.get("longName"),
        user.get("macaddr"),
        user.get("hwModel") or n.get("hwModel"),
        user.get("role"),
        user.get("publicKey"),
        user.get("isUnmessagable"),
        n.get("isFavorite"),
        n.get("hopsAway"),
        n.get("snr"),
        n.get("lastHeard"),
        met.get("batteryLevel"),
        met.get("voltage"),
        met.get("channelUtilization"),
        met.get("airUtilTx"),
        met.get("uptimeSeconds"),
        pos.get("time"),
        pos.get("locationSource"),
        pos.get("latitude"),
        pos.get("longitude"),
        pos.get("altitude"),
        json.dumps(n, ensure_ascii=False)
    )
    conn.execute("""
    INSERT INTO nodes(node_id,num,short_name,long_name,macaddr,hw_model,role,public_key,is_unmessagable,is_favorite,
                      hops_away,snr,last_heard,battery_level,voltage,channel_utilization,air_util_tx,uptime_seconds,
                      position_time,location_source,latitude,longitude,altitude,node_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(node_id) DO UPDATE SET
      num=excluded.num, short_name=excluded.short_name, long_name=excluded.long_name, macaddr=excluded.macaddr,
      hw_model=excluded.hw_model, role=excluded.role, public_key=excluded.public_key, is_unmessagable=excluded.is_unmessagable,
      is_favorite=excluded.is_favorite, hops_away=excluded.hops_away, snr=excluded.snr, last_heard=excluded.last_heard,
      battery_level=excluded.battery_level, voltage=excluded.voltage, channel_utilization=excluded.channel_utilization,
      air_util_tx=excluded.air_util_tx, uptime_seconds=excluded.uptime_seconds, position_time=excluded.position_time,
      location_source=excluded.location_source, latitude=excluded.latitude, longitude=excluded.longitude,
      altitude=excluded.altitude, node_json=excluded.node_json
    """, row)

def snapshot_nodes_periodically(iface: MeshInterface, every_sec=30):
    time.sleep(5)  # let the library sync initial node DB
    while True:
        try:
            for node_id, n in (getattr(iface, "nodes", {}) or {}).items():
                upsert_node(node_id, n)
            conn.commit()
        except Exception as e:
            print("node snapshot error:", e)
        time.sleep(every_sec)

def main():
    iface = SerialInterface(devPath="/dev/ttyACM0")
    threading.Thread(target=snapshot_nodes_periodically, args=(iface, 30), daemon=True).start()
    print("Nodes ingestor running. Ctrl+C to stop.")
    try:
        while True: time.sleep(300)
    except KeyboardInterrupt:
        pass

if __name__ == "__main__":
    main()
