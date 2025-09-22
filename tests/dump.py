#!/usr/bin/env python3
import json, os, signal, sys, time, threading
from datetime import datetime, timezone

from meshtastic.serial_interface import SerialInterface
from meshtastic.mesh_interface import MeshInterface

PORT = os.environ.get("MESH_SERIAL", "/dev/ttyACM0")
OUT = os.environ.get("MESH_DUMP_FILE", "meshtastic-dump.ndjson")

# line-buffered append so you can tail -f safely
f = open(OUT, "a", buffering=1, encoding="utf-8")


def now():
    return datetime.now(timezone.utc).isoformat()


def write(kind, payload):
    rec = {"ts": now(), "kind": kind, **payload}
    f.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")


# Connect to the node
iface: MeshInterface = SerialInterface(PORT)


# Packet callback: every RF/Mesh packet the node receives/decodes lands here
def on_packet(packet, iface):
    # 'packet' already includes decoded fields when available (portnum, payload, position, telemetry, etc.)
    write("packet", {"packet": packet})


# Node callback: topology/metadata updates (nodeinfo, hops, lastHeard, etc.)
def on_node(node, iface):
    write("node", {"node": node})


iface.setPacketHandler(on_packet)
iface.setNodeHandler(on_node)

# Write a little header so you know what you captured
try:
    my = getattr(iface, "myInfo", None)
    write(
        "meta",
        {
            "event": "started",
            "port": PORT,
            "my_node_num": getattr(my, "my_node_num", None) if my else None,
        },
    )
except Exception as e:
    write("meta", {"event": "started", "port": PORT, "error": str(e)})


# Keep the process alive until Ctrl-C
def _stop(signum, frame):
    write("meta", {"event": "stopping"})
    try:
        iface.close()
    finally:
        f.close()
    sys.exit(0)


signal.signal(signal.SIGINT, _stop)
signal.signal(signal.SIGTERM, _stop)

# Simple sleep loop; avoids busy-wait
while True:
    time.sleep(1)
