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

"""Connection routing and asyncio exception logging for MeshCore."""

from __future__ import annotations

import asyncio
import sys

from ... import config
from ...connection import parse_ble_target, parse_tcp_target


def _make_connection(target: str, baudrate: int) -> object:
    """Create the appropriate MeshCore connection object for *target*.

    Routes to the correct ``meshcore`` connection class based on the target
    string format:

    * BLE MAC / UUID → :class:`meshcore.BLEConnection`
    * ``host:port`` / ``[ipv6]:port`` → :class:`meshcore.TCPConnection`
    * anything else → :class:`meshcore.SerialConnection`

    Parameters:
        target: Resolved, non-empty connection target.
        baudrate: Baud rate for serial connections (ignored for BLE/TCP).

    Returns:
        An unconnected ``meshcore`` connection object.
    """
    # Look up connection classes via the parent package so that test fakes
    # installed via ``monkeypatch.setattr(mod, "BLEConnection", ...)`` apply.
    pkg = sys.modules["data.mesh_ingestor.protocols.meshcore"]
    ble_addr = parse_ble_target(target)
    if ble_addr:
        return pkg.BLEConnection(address=ble_addr)

    tcp_target = parse_tcp_target(target)
    if tcp_target:
        host, port = tcp_target
        return pkg.TCPConnection(host, port)

    return pkg.SerialConnection(target, baudrate)


def _log_unhandled_loop_exception(
    loop: asyncio.AbstractEventLoop, context: dict
) -> None:
    """Route asyncio's "unhandled task exception" warnings through our logger.

    The upstream ``meshcore`` library spawns detached
    ``asyncio.create_task`` tasks for every inbound radio frame.  When one
    of those tasks raises and nobody awaits the future, asyncio's default
    handler writes ``Task exception was never retrieved`` to stderr.  That
    bypasses our structured log pipeline and clutters container logs.
    This handler preserves the same information under
    ``context=asyncio.unhandled`` so operators grep for one place.

    Parameters:
        loop: Event loop that surfaced the exception (unused but required
            by the asyncio handler signature).
        context: Asyncio exception-context dictionary.  Fields we care
            about: ``message`` (human summary) and ``exception`` (the raw
            exception object, when available).
    """
    del loop
    exception = context.get("exception")
    task = context.get("task")
    task_name = None
    if task is not None:
        # Prefer the friendly ``get_name()``; fall back to ``repr`` for any
        # future Task-like object that does not implement it.
        get_name = getattr(task, "get_name", None)
        task_name = get_name() if callable(get_name) else repr(task)
    config._debug_log(
        context.get("message") or "Unhandled asyncio task exception",
        context="asyncio.unhandled",
        severity="error",
        always=True,
        error_class=type(exception).__name__ if exception else None,
        error_message=str(exception) if exception else None,
        task=task_name,
    )
