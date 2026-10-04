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
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from data.mesh_ingestor import daemon  # noqa: E402 - path setup


class FakeEvent:
    """Test double for :class:`threading.Event` that can auto-set itself."""

    instances: list["FakeEvent"] = []

    def __init__(self, *, auto_set_on_wait: bool = False):
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


__all__ = ["FakeEvent", "make_state"]
