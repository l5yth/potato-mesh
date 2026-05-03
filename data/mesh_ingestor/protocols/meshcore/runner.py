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

"""Asyncio entry point that drives a MeshCore connection from a worker thread."""

from __future__ import annotations

import asyncio
import sys
import threading

from ... import config
from ._constants import _DEFAULT_BAUDRATE
from .channels import _ensure_channel_names
from .connection import _make_connection
from .handlers import _make_event_handlers
from .interface import ClosedBeforeConnectedError, _MeshcoreInterface


async def _run_meshcore(
    iface: _MeshcoreInterface,
    target: str,
    connected_event: threading.Event,
    error_holder: list,
) -> None:
    """Connect to a MeshCore node and keep the event loop running until closed.

    This coroutine is the single entry point for the background asyncio thread.
    It connects the MeshCore library, registers event handlers, fetches the
    initial contact list, starts auto-message polling, and then waits for the
    :attr:`_MeshcoreInterface._stop_event` to be set.

    Parameters:
        iface: Shared interface object for state and contact tracking.
        target: Resolved, non-empty connection target (serial, BLE, or TCP).
        connected_event: Threading event signalled when the connection
            succeeds or fails, to unblock the calling ``connect()`` method.
        error_holder: Single-element list; set to the raised exception when
            the connection attempt fails so the caller can re-raise it.
    """
    # Install early so :meth:`_MeshcoreInterface.close` can signal shutdown with
    # ``stop_event.set()`` instead of ``loop.stop()`` while ``connect()`` or the
    # ``finally`` disconnect is still running (avoids RuntimeError from
    # :meth:`asyncio.loop.run_until_complete`).
    stop_event = asyncio.Event()
    iface._stop_event = stop_event

    # Resolve meshcore-library symbols via the parent package so test fakes
    # installed via ``monkeypatch.setattr(mod, "MeshCore", ...)`` apply.
    pkg = sys.modules["data.mesh_ingestor.protocols.meshcore"]
    MeshCore = pkg.MeshCore
    EventType = pkg.EventType

    mc = None
    try:
        cx = _make_connection(target, _DEFAULT_BAUDRATE)
        mc = MeshCore(cx)
        iface._mc = mc

        handlers_map = _make_event_handlers(iface, target)
        for event_name, callback in handlers_map.items():
            mc.subscribe(EventType[event_name], callback)

        _handled_types = frozenset(EventType[n] for n in handlers_map)
        # Bookkeeping events that require no action and should not be logged.
        _silent_types = frozenset(
            {
                EventType.CONNECTED,
                EventType.ACK,
                EventType.OK,
                EventType.ERROR,
                EventType.NO_MORE_MSGS,
                EventType.MESSAGES_WAITING,
                EventType.MSG_SENT,
                EventType.CURRENT_TIME,
            }
        )

        async def _on_unhandled(evt) -> None:
            if evt.type in _handled_types or evt.type in _silent_types:
                return
            # Look up via the parent package so test fakes installed via
            # ``monkeypatch.setattr(mod, "_record_meshcore_message", ...)`` apply.
            pkg._record_meshcore_message(
                evt.payload,
                source=f"{target or 'auto'}:{evt.type.name}",
            )

        mc.subscribe(None, _on_unhandled)

        result = await mc.connect()
        if result is None:
            raise ConnectionError(
                f"MeshCore node at {target!r} did not respond to the appstart "
                "handshake.  Ensure the device is running MeshCore companion-mode "
                "firmware."
            )

        if stop_event.is_set():
            raise ClosedBeforeConnectedError(
                "Mesh interface close was requested before the connection could be completed."
            )

        iface.isConnected = True
        connected_event.set()

        try:
            await mc.ensure_contacts()
        except Exception as exc:
            config._debug_log(
                "Failed to fetch initial contacts",
                context="meshcore.contacts",
                severity="warning",
                always=True,
                error=str(exc),
            )

        try:
            await _ensure_channel_names(mc)
        except Exception as exc:
            config._debug_log(
                "Failed to fetch channel names",
                context="meshcore.channels",
                severity="warning",
                error=str(exc),
            )

        await mc.start_auto_message_fetching()

        await stop_event.wait()

    except Exception as exc:
        if not connected_event.is_set():
            error_holder[0] = exc
            connected_event.set()
    finally:
        if mc is not None:
            try:
                await mc.disconnect()
            except Exception:
                pass
