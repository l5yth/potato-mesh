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

"""Decode Meshtastic protobuf payloads from stdin JSON."""

from __future__ import annotations

import base64
import json
import os
import sys
from typing import Any, Dict, Tuple

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR in sys.path:
    sys.path.remove(SCRIPT_DIR)

from google.protobuf.json_format import MessageToDict
from meshtastic.protobuf import mesh_pb2, telemetry_pb2


PORTNUM_MAP: Dict[int, Tuple[str, Any]] = {
    3: ("POSITION_APP", mesh_pb2.Position),
    4: ("NODEINFO_APP", mesh_pb2.NodeInfo),
    5: ("ROUTING_APP", mesh_pb2.Routing),
    67: ("TELEMETRY_APP", telemetry_pb2.Telemetry),
    70: ("TRACEROUTE_APP", mesh_pb2.RouteDiscovery),
    71: ("NEIGHBORINFO_APP", mesh_pb2.NeighborInfo),
}


def _decode_payload(portnum: int, payload_b64: str) -> dict[str, Any]:
    if portnum not in PORTNUM_MAP:
        return {"error": "unsupported-port", "portnum": portnum}
    try:
        payload_bytes = base64.b64decode(payload_b64, validate=True)
    except Exception as exc:
        return {"error": f"invalid-payload: {exc}"}

    name, message_cls = PORTNUM_MAP[portnum]
    msg = message_cls()
    try:
        msg.ParseFromString(payload_bytes)
    except Exception as exc:
        return {"error": f"decode-failed: {exc}", "portnum": portnum, "type": name}

    decoded = MessageToDict(msg, preserving_proto_field_name=True)
    return {"portnum": portnum, "type": name, "payload": decoded}


def main() -> int:
    raw = sys.stdin.read()
    try:
        request = json.loads(raw)
    except json.JSONDecodeError as exc:
        sys.stdout.write(json.dumps({"error": f"invalid-json: {exc}"}))
        return 1

    portnum = request.get("portnum")
    payload_b64 = request.get("payload_b64")

    if not isinstance(portnum, int):
        sys.stdout.write(json.dumps({"error": "missing-portnum"}))
        return 1
    if not isinstance(payload_b64, str):
        sys.stdout.write(json.dumps({"error": "missing-payload"}))
        return 1

    result = _decode_payload(portnum, payload_b64)
    sys.stdout.write(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
