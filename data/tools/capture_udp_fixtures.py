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

"""Capture Meshtastic "Mesh via UDP" multicast datagrams as replayable test fixtures.

Passive and receive-only: it never sends anything and never connects to the
node's API — it just joins the LAN multicast group the node broadcasts to and
records raw datagram bytes. It saves each datagram as base64 in a JSONL file so
the exact bytes can be replayed in unit tests, and — when ``meshtastic`` and
``cryptography`` are importable — prints a live decoded summary so the operator
can watch the primary channel decode with the default key in real time.

This is an operator/developer tool, not part of the shipped ingestor runtime.
Its socket-join and decrypt logic intentionally mirror
``data/mesh_ingestor/protocols/meshtastic_udp_socket.py`` and
``meshtastic_udp_decode.py`` so a live capture doubles as a validation of those
modules; once they exist this tool may be refactored to import them directly.

Privacy: raw bytes of private-channel packets stay encrypted (their keys are
not available, so nothing readable is captured). Use ``--primary-only`` to save
ONLY packets that decrypt with the default key (i.e. the public/primary
channel).

Usage (run on any host on the same LAN as the node, e.g. the gateway Pi)::

    python3 data/tools/capture_udp_fixtures.py --seconds 120 --out fixtures.jsonl
    python3 data/tools/capture_udp_fixtures.py --seconds 120 --primary-only --out fixtures.jsonl

The live summary and ``--primary-only`` require ``pip install meshtastic
cryptography``; raw capture works with the standard library alone.
"""

from __future__ import annotations

import argparse
import base64
import json
import socket
import sys
import time

DEFAULT_GROUP = "224.0.0.69"
DEFAULT_PORT = 4403
DEFAULT_KEY_B64 = "AQ=="
#: 15-byte prefix Meshtastic prepends to a 1-byte PSK (0x01..0x07) to form the key.
_ONE_BYTE_PSK_PREFIX = bytes.fromhex("d4f1bb3a20290759f0bcffabcf4e69")

# Optional decode support -------------------------------------------------------
try:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from meshtastic.protobuf import mesh_pb2, portnums_pb2

    HAVE_DECODE = True
except Exception:  # pragma: no cover - environment dependent
    HAVE_DECODE = False


def open_multicast_socket(group: str, port: int) -> socket.socket:
    """Join *group* on *port* for passive multicast reception (receive-only).

    Parameters:
        group: IPv4 multicast group address to join.
        port: UDP port the group publishes on.

    Returns:
        A bound, group-joined datagram socket with a 1-second receive timeout.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if hasattr(socket, "SO_REUSEPORT"):
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        except OSError:
            pass
    sock.bind(("", port))
    mreq = socket.inet_aton(group) + socket.inet_aton("0.0.0.0")
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
    sock.settimeout(1.0)
    return sock


def _expand_key(key_b64: str) -> bytes:
    """Return the 16-byte AES key for *key_b64*, expanding 1-byte Meshtastic PSKs."""
    raw = base64.b64decode(key_b64)
    if len(raw) == 1 and 0x01 <= raw[0] <= 0x07:
        return _ONE_BYTE_PSK_PREFIX + raw
    return raw


def _portnum_name(portnum: int) -> str:
    """Return the ``PortNum`` enum name, or ``"UNKNOWN_APP"`` when out of range.

    ``PortNum`` is a proto3 open enum, so a datagram may carry a portnum with no
    registered name (newer firmware, or garbage on the multicast group).
    ``PortNum.Name`` raises ``ValueError`` on those; this maps them to a stable
    sentinel so the capture tool never crashes on an unexpected packet.
    """
    try:
        return portnums_pb2.PortNum.Name(portnum)
    except ValueError:
        return "UNKNOWN_APP"


def summarize(raw: bytes, key_b64: str) -> dict | None:
    """Return a human-readable summary of a datagram, decrypting the primary channel.

    Parameters:
        raw: Raw datagram bytes as received from the multicast socket.
        key_b64: Base64 PSK used to attempt decryption of encrypted packets.

    Returns:
        A summary dict, or ``None`` when decode support is unavailable.
    """
    if not HAVE_DECODE:
        return None
    mp = mesh_pb2.MeshPacket()
    try:
        mp.ParseFromString(raw)
    except Exception:
        return {"parse": "FAILED (not a MeshPacket?)"}
    portnum = None
    decoded_ok = False
    if mp.HasField("decoded"):
        portnum = _portnum_name(mp.decoded.portnum)
        decoded_ok = True
    elif mp.HasField("encrypted"):
        try:
            key = _expand_key(key_b64)
            nonce = mp.id.to_bytes(8, "little") + getattr(mp, "from").to_bytes(
                8, "little"
            )
            dec = Cipher(algorithms.AES(key), modes.CTR(nonce)).decryptor()
            clear = dec.update(mp.encrypted) + dec.finalize()
            data = mesh_pb2.Data()
            data.ParseFromString(clear)
            if data.portnum or data.payload:
                portnum = _portnum_name(data.portnum)
                decoded_ok = True
        except Exception:
            portnum = None
    return {
        "id": mp.id,
        "from": "!%08x" % (getattr(mp, "from") & 0xFFFFFFFF),
        "to": "!%08x" % (mp.to & 0xFFFFFFFF),
        "chan_hash": mp.channel,
        "encrypted": mp.HasField("encrypted"),
        "portnum": portnum,
        "primary_decodable": decoded_ok,
    }


def main() -> int:
    """Parse arguments, capture datagrams, and write JSONL fixtures.

    Returns:
        Process exit code: ``0`` on success, ``2`` for invalid option combos.
    """
    ap = argparse.ArgumentParser(description="Capture Mesh-via-UDP fixtures.")
    ap.add_argument("--group", default=DEFAULT_GROUP)
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument(
        "--key", default=DEFAULT_KEY_B64, help="primary channel PSK (base64)"
    )
    ap.add_argument("--seconds", type=float, default=120.0, help="capture duration")
    ap.add_argument("--max", type=int, default=500, help="max datagrams to save")
    ap.add_argument(
        "--primary-only",
        action="store_true",
        help="save only packets that decrypt with the default key",
    )
    ap.add_argument("--out", default="fixtures.jsonl")
    args = ap.parse_args()

    if args.primary_only and not HAVE_DECODE:
        print(
            "--primary-only needs meshtastic + cryptography installed", file=sys.stderr
        )
        return 2

    sock = open_multicast_socket(args.group, args.port)
    print(
        f"Listening on {args.group}:{args.port} for {args.seconds:.0f}s "
        f"(decode={'on' if HAVE_DECODE else 'off'}) — Ctrl-C to stop early"
    )

    saved = 0
    seen = 0
    primary = 0
    deadline = time.monotonic() + args.seconds
    with open(args.out, "w") as fh:
        try:
            while time.monotonic() < deadline and saved < args.max:
                try:
                    raw, addr = sock.recvfrom(65535)
                except socket.timeout:
                    continue
                seen += 1
                info = summarize(raw, args.key)
                is_primary = bool(info and info.get("primary_decodable"))
                if is_primary:
                    primary += 1
                if info is not None:
                    print(
                        f"  #{seen:<4} {info.get('portnum') or '?':<22} "
                        f"from={info.get('from')} enc={info.get('encrypted')} "
                        f"primary={is_primary}"
                    )
                if args.primary_only and not is_primary:
                    continue
                fh.write(
                    json.dumps(
                        {
                            "raw_b64": base64.b64encode(raw).decode("ascii"),
                            "len": len(raw),
                            "src": addr[0],
                        }
                    )
                    + "\n"
                )
                saved += 1
        except KeyboardInterrupt:
            print("\nstopped")
        finally:
            try:
                sock.close()
            except Exception:
                pass

    print(
        f"\nDone. datagrams seen={seen}, primary-decodable={primary}, "
        f"saved={saved} -> {args.out}"
    )
    if HAVE_DECODE and seen and primary == 0:
        print(
            "WARNING: nothing decoded with the default key. Is your primary "
            "channel using a custom PSK? Re-run with --key <your base64 psk>."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
