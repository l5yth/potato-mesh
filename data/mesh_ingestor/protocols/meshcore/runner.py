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
from ._constants import _AUTO_ADD_OVERWRITE_OLDEST, _DEFAULT_BAUDRATE
from .channels import _ensure_channel_names
from .connection import _make_connection
from .handlers import _make_event_handlers
from .interface import ClosedBeforeConnectedError, _MeshcoreInterface
from .telemetry import _telemetry_poll_loop


async def _ensure_autoadd_eviction(mc) -> None:
    """Assert the firmware's roster-eviction bit at startup (SPEC RF4).

    Reads the device's ``autoadd_config`` and, **only when** bit ``0x01``
    (:data:`~._constants._AUTO_ADD_OVERWRITE_OLDEST`) is unset, writes
    ``config | 0x01`` back — a read-modify-write that preserves the
    type-filter bits 1–4, and a one-byte set so the firmware leaves
    ``autoadd_max_hops`` untouched.  When the bit is already set no write is
    issued: the firmware runs ``savePrefs()`` on every set, so skipping the
    no-op write avoids a flash write per ingestor restart.

    Unconditional by design (no env/config knob); favourites are never
    evicted (firmware guarantee) and the setting persists in device flash.
    A device that does not support commands 58/59 (pre-1.16 firmware)
    answers with an ``ERROR`` event or times out — both are tolerated by the
    caller's ``try``/``except`` warning path, mirroring
    :func:`~.channels._ensure_channel_names`.

    Parameters:
        mc: Connected ``MeshCore`` instance.
    """
    evt = await mc.commands.get_autoadd_config()
    payload = getattr(evt, "payload", None) or {}
    current = payload.get("config")
    if current is None:
        # ERROR reply (unsupported command) or malformed payload — leave the
        # device untouched and surface a warning; startup continues.
        config._debug_log(
            "MeshCore autoadd config unavailable; eviction bit not asserted",
            context="meshcore.autoadd",
            severity="warning",
            always=True,
        )
        return

    current = int(current)
    if current & _AUTO_ADD_OVERWRITE_OLDEST:
        config._debug_log(
            "MeshCore roster-eviction bit already set",
            context="meshcore.autoadd",
            autoadd_config=current,
        )
        return

    desired = current | _AUTO_ADD_OVERWRITE_OLDEST
    set_evt = await mc.commands.set_autoadd_config(desired)
    if getattr(getattr(set_evt, "type", None), "name", "") == "ERROR":
        config._debug_log(
            "MeshCore rejected autoadd eviction config write",
            context="meshcore.autoadd",
            severity="warning",
            always=True,
            autoadd_config=desired,
        )
        return
    config._debug_log(
        "MeshCore roster-eviction bit asserted",
        context="meshcore.autoadd",
        severity="info",
        always=True,
        autoadd_config=desired,
    )


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

        # Enable the library's RX-log⇆message join (SPEC RF2): with channel
        # secrets registered (``_ensure_channel_names`` fetches every channel,
        # and the reader auto-registers each secret into its packet parser),
        # the lib matches each CHANNEL_MSG_RECV to its on-air frame and injects
        # RSSI / path / recv_time.  Purely local decryption with keys already
        # on the radio; a miss (no RX-log frame) simply leaves those fields
        # absent, so this degrades gracefully on firmware without RX logging.
        mc.decrypt_channels = True

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

        # Keep the contact roster live: with auto-update enabled the meshcore
        # library re-fetches changed contacts whenever an ADVERTISEMENT /
        # PATH_UPDATE push arrives (its built-in _contact_change handler), so a
        # re-advert from a known node refreshes its position / last_advert
        # without waiting for a reconnect.  Combined with the ADVERTISEMENT
        # handler (which surfaces non-roster nodes), this closes the adverts gap
        # where only startup-roster and auto-added contacts were captured.
        mc.auto_update_contacts = True

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

        # Signal readiness only after the initial contact roster has been
        # fetched so the daemon's first ``_try_send_snapshot()`` observes a
        # populated ``_contacts`` dict instead of an empty one (issue #788).
        connected_event.set()

        try:
            await _ensure_channel_names(mc)
        except Exception as exc:
            config._debug_log(
                "Failed to fetch channel names",
                context="meshcore.channels",
                severity="warning",
                error=str(exc),
            )

        # Assert the roster-eviction bit (RF4) after the readiness signal so a
        # slow or unsupported command never delays startup; errors and
        # timeouts are tolerated exactly like the channel-name fetch above.
        try:
            await _ensure_autoadd_eviction(mc)
        except Exception as exc:
            config._debug_log(
                "Failed to assert autoadd eviction config",
                context="meshcore.autoadd",
                severity="warning",
                always=True,
                error=str(exc),
            )

        await mc.start_auto_message_fetching()

        # Telemetry collection (TI-A3): host self reads over the companion
        # link plus round-robin contact pulls, cadence-bounded by config.
        poll_task = asyncio.create_task(_telemetry_poll_loop(mc, iface))
        try:
            await stop_event.wait()
        finally:
            poll_task.cancel()
            try:
                await poll_task
            except (asyncio.CancelledError, Exception):
                pass

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
