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

"""Short MeshCore sessions to query channel names via ``get_channel`` (no mesh_ingestor imports)."""

from __future__ import annotations

import asyncio

from .connection_parse import parse_ble_target, parse_tcp_target

_DEFAULT_BAUDRATE = 115200
_MAX_CHANNEL_PROBE = 32


def _make_connection(target: str, baudrate: int = _DEFAULT_BAUDRATE):
    from meshcore import BLEConnection, SerialConnection, TCPConnection

    ble_addr = parse_ble_target(target)
    if ble_addr:
        return BLEConnection(address=ble_addr)
    tcp_target = parse_tcp_target(target)
    if tcp_target:
        host, port = tcp_target
        return TCPConnection(host, port)
    return SerialConnection(target, baudrate)


async def _probe_async(target: str) -> tuple[list[tuple[int, str]], str | None]:
    from meshcore import MeshCore
    from meshcore.events import EventType

    rows: list[tuple[int, str]] = []
    err: str | None = None
    mc = None
    try:
        cx = _make_connection(target.strip(), _DEFAULT_BAUDRATE)
        mc = MeshCore(cx)
        res = await mc.connect()
        if res is None:
            return [], "MeshCore node did not complete the appstart handshake."

        for idx in range(_MAX_CHANNEL_PROBE):
            try:
                evt = await mc.commands.get_channel(idx)
            except Exception as exc:
                err = str(exc)
                break
            if evt.type == EventType.ERROR:
                continue
            if evt.type != EventType.CHANNEL_INFO:
                continue
            payload = evt.payload or {}
            name = (payload.get("channel_name") or "").strip()
            if name:
                rows.append((int(payload.get("channel_idx", idx)), name))

        rows.sort(key=lambda x: x[0])
        return rows, err
    except Exception as exc:
        return [], str(exc)
    finally:
        if mc is not None:
            try:
                await mc.disconnect()
            except Exception:
                pass


def probe_channels(target: str) -> tuple[list[tuple[int, str]], str | None]:
    """Run :func:`_probe_async` in a fresh event loop (wizard is synchronous at top level)."""

    return asyncio.run(_probe_async(target))
