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

"""Interactive debugging helpers for live Meshtastic sessions."""

import time, json, base64, threading
from pubsub import pub  # comes with meshtastic
from meshtastic.serial_interface import SerialInterface
from google.protobuf.json_format import MessageToDict
from google.protobuf.message import Message as ProtoMessage

PORT = "/dev/ttyACM0"

packet_count = 0
last_rx_ts = None
stop = threading.Event()


def to_jsonable(obj):
    """Recursively convert complex objects into JSON-serialisable structures.

    Parameters:
        obj: Any Meshtastic-related payload or protobuf message.

    Returns:
        A structure composed of standard Python types.
    """
    if obj is None:
        return None
    if isinstance(obj, ProtoMessage):
        # Convert protobuf to dict; bytes become base64 by default
        return MessageToDict(
            obj, preserving_proto_field_name=True, use_integers_for_enums=False
        )
    if isinstance(obj, bytes):
        return {"__bytes_b64__": base64.b64encode(obj).decode("ascii")}
    if isinstance(obj, (str, int, float, bool)):
        return obj
    if isinstance(obj, dict):
        return {str(k): to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_jsonable(v) for v in obj]
    # fallback
    return str(obj)


def extract_text(d):
    """Best-effort pull of decoded text from :func:`to_jsonable` output.

    Parameters:
        d: Mapping derived from :func:`to_jsonable`.

    Returns:
        The decoded text when available, otherwise ``None``.
    """
    dec = d.get("decoded") or {}
    # Text packets usually at decoded.payload.text
    payload = dec.get("payload") or {}
    if isinstance(payload, dict) and "text" in payload:
        return payload.get("text")
    # Some versions flatten 'text' at decoded.text
    if "text" in dec:
        return dec.get("text")
    return None


def on_receive(packet, interface):
    """Display human-readable output for each received packet.

    Parameters:
        packet: Packet instance supplied by Meshtastic.
        interface: Interface that produced the packet.
    """
    global packet_count, last_rx_ts
    packet_count += 1
    last_rx_ts = time.time()

    d = to_jsonable(packet)
    text = extract_text(d)
    frm = d.get("from") or d.get("from_id") or d.get("fromId")
    to = d.get("to") or d.get("to_id") or d.get("toId")
    portnum = (d.get("decoded") or {}).get("portnum")

    print(f"\n=== PACKET #{packet_count} RECEIVED ===")
    if text:
        print(f"[summary] {frm} → {to} port={portnum} text={text!r}")
    else:
        print(f"[summary] {frm} → {to} port={portnum} (no text)")

    try:
        print(json.dumps(d, indent=2, ensure_ascii=False))
    except Exception as e:
        # Shouldn't happen after to_jsonable, but keep a guard
        print("[warn] JSON dump failed even after conversion:", e)


def on_connected(interface, *args, **kwargs):
    """Log when a connection is established."""

    print("[info] connection established")


def on_disconnected(interface, *args, **kwargs):
    """Log when the interface disconnects."""

    print("[info] disconnected")


def main():
    """Run the interactive debugging loop."""

    print(f"Opening Meshtastic on {PORT} …")

    # Use PubSub topics (reliable in current meshtastic)
    pub.subscribe(on_receive, "meshtastic.receive")
    pub.subscribe(on_connected, "meshtastic.connection.established")
    pub.subscribe(on_disconnected, "meshtastic.connection.lost")

    iface = SerialInterface(devPath=PORT)

    try:
        last_heartbeat = time.time()
        while not stop.is_set():
            time.sleep(0.5)
            now = time.time()
            if now - last_heartbeat >= 5:
                since = (
                    "never" if last_rx_ts is None else f"{int(now - last_rx_ts)}s ago"
                )
                print(
                    f"[heartbeat] alive; packets={packet_count} (last packet {since})"
                )
                last_heartbeat = now
    except KeyboardInterrupt:
        pass
    finally:
        try:
            iface.close()
        except Exception:
            pass
        print("\nExiting.")


if __name__ == "__main__":
    main()
