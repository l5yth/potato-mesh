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
"""Daemon test doubles shared by the ingestor test modules.

Imported by test modules as ``daemon_fakes`` (pytest puts ``tests/`` on
``sys.path``, as it does for ``meshtastic_protobuf_stub``).
"""

from __future__ import annotations

import sys
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from data.mesh_ingestor import daemon  # noqa: E402 - path setup


class FakeEvent:
    """Test double for :class:`threading.Event` that can auto-set itself."""

    instances: list["FakeEvent"] = []

    def __init__(self, *, auto_set_on_wait: bool = False):
        """Create an unset event and register it in :attr:`instances`.

        Parameters:
            auto_set_on_wait: Whether each :meth:`wait` sets the event.
        """

        self._is_set = False
        self._auto_set_on_wait = auto_set_on_wait
        self.wait_calls: list[Any] = []
        FakeEvent.instances.append(self)

    def set(self) -> None:
        """Mark the event as set."""

        self._is_set = True

    def is_set(self) -> bool:
        """Return whether the event is currently set."""

        return self._is_set

    def wait(self, timeout: float | None = None) -> bool:
        """Record waits and optionally auto-set the flag."""

        self.wait_calls.append(timeout)
        if self._auto_set_on_wait:
            self._is_set = True
        return self._is_set


def daemon_threading(event_cls: type) -> SimpleNamespace:
    """Return a stand-in for the daemon's ``threading`` whose ``Event`` is ``event_cls``.

    A test sets it as ``daemon.threading`` only, never on the shared
    :mod:`threading` module, and ``Thread``, ``current_thread`` and
    ``main_thread`` stay the real ones: the threads ``daemon.main()`` starts
    (one per upload lane, SPEC UR1) must get real events, and patching the
    shared ``threading.Event`` broke ``Thread.start()`` (Known gap C2).

    Parameters:
        event_cls: The class the daemon creates its events from.

    Returns:
        A namespace with ``Event``, ``Thread``, ``current_thread`` and
        ``main_thread``.
    """

    return SimpleNamespace(
        Event=event_cls,
        Thread=threading.Thread,
        current_thread=threading.current_thread,
        main_thread=threading.main_thread,
    )


def make_state(**overrides):
    """Return a :class:`daemon._DaemonState` with sensible defaults.

    Any keyword argument is forwarded as a field override via ``setattr``
    after construction, so callers only need to supply fields under test.
    """
    state = daemon._DaemonState(
        provider=None,  # type: ignore[arg-type]
        stop=FakeEvent(),  # type: ignore[arg-type]
        configured_port=None,
        inactivity_reconnect_secs=0.0,
        energy_saving_enabled=False,
        energy_online_secs=0.0,
        energy_sleep_secs=0.0,
        retry_delay=0.0,
        last_seen_packet_monotonic=None,
        active_candidate=None,
    )
    for key, val in overrides.items():
        setattr(state, key, val)
    return state


__all__ = ["FakeEvent", "daemon_threading", "make_state"]
