#!/usr/bin/env python3
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

CONNECTION = os.environ.get("CONNECTION") or os.environ.get(
    "MESH_SERIAL", "/dev/ttyACM0"
)
"""Connection target opened to capture Meshtastic traffic."""
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
iface: MeshInterface = SerialInterface(CONNECTION)


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
            "port": CONNECTION,
            "my_node_num": getattr(my, "my_node_num", None) if my else None,
        },
    )
except Exception as e:
    write("meta", {"event": "started", "port": CONNECTION, "error": str(e)})


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
