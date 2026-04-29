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

"""Channel-name probing for MeshCore devices."""

from __future__ import annotations

import sys

from ... import config
from ._constants import _CHANNEL_PROBE_FALLBACK_MAX


async def _ensure_channel_names(mc: object) -> None:
    """Probe channel names from the device and populate the channel cache.

    Queries the device for its authoritative channel count via
    :meth:`~meshcore.MeshCore.commands.send_device_query` (``max_channels``
    field of the ``DEVICE_INFO`` response), then iterates every index from 0
    through ``max_channels - 1``, requesting each via
    :meth:`~meshcore.MeshCore.commands.get_channel`.  The responses arrive as
    :attr:`~meshcore.EventType.CHANNEL_INFO` events and are registered into
    the shared channel cache via :func:`~data.mesh_ingestor.channels.register_channel`.

    Falls back to a probe bound of :data:`_CHANNEL_PROBE_FALLBACK_MAX` when the
    device query fails or returns an older firmware that omits ``max_channels``.

    Probes every index without early-stopping on ``ERROR`` responses, so sparse
    configurations (e.g. slots 0 and 5 configured, slots 1–4 empty) are handled
    correctly.  Only a hard exception (connection loss, timeout) aborts the loop.

    Parameters:
        mc: Connected :class:`~meshcore.MeshCore` instance.
    """
    # Deferred — see _make_event_handlers for the circular-dependency note.
    from ... import channels as _channels

    # Look up ``EventType`` via the parent package so that test fakes installed
    # via ``monkeypatch.setattr(mod, "EventType", ...)`` apply at call time.
    pkg = sys.modules["data.mesh_ingestor.protocols.meshcore"]
    EventType = pkg.EventType

    max_idx = _CHANNEL_PROBE_FALLBACK_MAX
    try:
        dev_evt = await mc.commands.send_device_query()
        if dev_evt.type == EventType.DEVICE_INFO:
            reported = (dev_evt.payload or {}).get("max_channels")
            if isinstance(reported, int) and reported > 0:
                max_idx = reported
    except Exception as exc:
        config._debug_log(
            "Device query failed; using fallback channel probe bound",
            context="meshcore.channels",
            severity="warning",
            fallback_max=max_idx,
            error=str(exc),
        )

    for idx in range(max_idx):
        try:
            evt = await mc.commands.get_channel(idx)
            if evt.type == EventType.CHANNEL_INFO:
                name = (evt.payload or {}).get("channel_name", "")
                if name:
                    _channels.register_channel(idx, name)
            # ERROR response — unconfigured slot; continue to next index
        except Exception as exc:
            config._debug_log(
                "Channel probe failed",
                context="meshcore.channels",
                severity="warning",
                channel_idx=idx,
                error=str(exc),
            )
            break
