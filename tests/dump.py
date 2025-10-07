#!/usr/bin/env python3
"""Utility script to dump Meshtastic traffic for offline analysis."""

from __future__ import annotations

import json
import os
import signal
import sys
import time
from datetime import datetime, timezone

from meshtastic.mesh_interface import MeshInterface
from meshtastic.serial_interface import SerialInterface
from pubsub import pub

PORT = os.environ.get("MESH_SERIAL", "/dev/ttyACM0")
OUT = os.environ.get("MESH_DUMP_FILE", "meshtastic-dump.ndjson")

# line-buffered append so you can tail -f safely
f = open(OUT, "a", buffering=1, encoding="utf-8")


def now() -> str:
    """Return the current UTC timestamp in ISO 8601 format."""

    return datetime.now(timezone.utc).isoformat()


def write(kind: str, payload: dict) -> None:
    """Append a JSON record to the dump file.

    Parameters:
        kind: Logical record type such as ``"packet"`` or ``"node"``.
        payload: Serializable payload containing the record body.
    """

    rec = {"ts": now(), "kind": kind, **payload}
    f.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")


# Connect to the node
iface: MeshInterface = SerialInterface(PORT)


# Packet callback: every RF/Mesh packet the node receives/decodes lands here
def on_packet(packet, iface):
    """Write packet metadata whenever the radio receives a frame.

    Parameters:
        packet: Meshtastic packet object or dictionary.
        iface: Interface instance delivering the packet.
    """

    # 'packet' already includes decoded fields when available (portnum, payload, position, telemetry, etc.)
    write("packet", {"packet": packet})


# Node callback: topology/metadata updates (nodeinfo, hops, lastHeard, etc.)
def on_node(node, iface):
    """Write node metadata updates produced by Meshtastic.

    Parameters:
        node: Meshtastic node object or mapping.
        iface: Interface instance emitting the update.
    """

    write("node", {"node": node})


iface.onReceive = on_packet
pub.subscribe(on_node, "meshtastic.node")

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
    """Handle termination signals by flushing buffers and exiting."""

    write("meta", {"event": "stopping"})
    try:
        try:
            pub.unsubscribe(on_node, "meshtastic.node")
        except Exception:
            pass
        iface.close()
    finally:
        f.close()
    sys.exit(0)


signal.signal(signal.SIGINT, _stop)
signal.signal(signal.SIGTERM, _stop)

# Simple sleep loop; avoids busy-wait
while True:
    time.sleep(1)
