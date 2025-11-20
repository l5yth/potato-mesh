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

"""Configuration helpers for the potato-mesh ingestor."""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from types import ModuleType
from typing import Any

DEFAULT_SNAPSHOT_SECS = 60
"""Default interval, in seconds, between state snapshot uploads."""

DEFAULT_CHANNEL_INDEX = 0
"""Default LoRa channel index used when none is specified."""

DEFAULT_RECONNECT_INITIAL_DELAY_SECS = 5.0
"""Initial reconnection delay applied after connection loss."""

DEFAULT_RECONNECT_MAX_DELAY_SECS = 60.0
"""Maximum reconnection backoff delay applied by the ingestor."""

DEFAULT_CLOSE_TIMEOUT_SECS = 5.0
"""Grace period for interface shutdown routines to complete."""

DEFAULT_INACTIVITY_RECONNECT_SECS = float(60 * 60)
"""Interval before forcing a reconnect when no packets are observed."""

DEFAULT_ENERGY_ONLINE_DURATION_SECS = 300.0
"""Duration to stay online before entering a low-power sleep cycle."""

DEFAULT_ENERGY_SLEEP_SECS = float(6 * 60 * 60)
"""Sleep duration used when energy saving mode is active."""

CONNECTION = os.environ.get("CONNECTION") or os.environ.get("MESH_SERIAL")
"""Optional connection target for the mesh interface.

When unset, platform-specific defaults will be inferred by the interface
implementations. The legacy :envvar:`MESH_SERIAL` environment variable is still
accepted for backwards compatibility.
"""

SNAPSHOT_SECS = DEFAULT_SNAPSHOT_SECS
"""Interval, in seconds, between state snapshot uploads."""

CHANNEL_INDEX = int(os.environ.get("CHANNEL_INDEX", str(DEFAULT_CHANNEL_INDEX)))
"""Index of the LoRa channel to select when connecting."""

DEBUG = os.environ.get("DEBUG") == "1"
INSTANCE = os.environ.get("POTATOMESH_INSTANCE", "").rstrip("/")
API_TOKEN = os.environ.get("API_TOKEN", "")
ENERGY_SAVING = os.environ.get("ENERGY_SAVING") == "1"
"""When ``True``, enables the ingestor's energy saving mode."""

LORA_FREQ: float | int | str | None = None
"""Frequency of the local node's configured LoRa region in MHz or raw region label."""

MODEM_PRESET: str | None = None
"""CamelCase modem preset name reported by the local node."""

_RECONNECT_INITIAL_DELAY_SECS = DEFAULT_RECONNECT_INITIAL_DELAY_SECS
_RECONNECT_MAX_DELAY_SECS = DEFAULT_RECONNECT_MAX_DELAY_SECS
_CLOSE_TIMEOUT_SECS = DEFAULT_CLOSE_TIMEOUT_SECS
_INACTIVITY_RECONNECT_SECS = DEFAULT_INACTIVITY_RECONNECT_SECS
_ENERGY_ONLINE_DURATION_SECS = DEFAULT_ENERGY_ONLINE_DURATION_SECS
_ENERGY_SLEEP_SECS = DEFAULT_ENERGY_SLEEP_SECS

# Backwards compatibility shim for legacy imports.
PORT = CONNECTION


def _debug_log(
    message: str,
    *,
    context: str | None = None,
    severity: str = "debug",
    always: bool = False,
    **metadata: Any,
) -> None:
    """Print ``message`` with a UTC timestamp when ``DEBUG`` is enabled.

    Parameters:
        message: Text to display when debug logging is active.
        context: Optional logical component emitting the message.
        severity: Log level label to embed in the formatted output.
        always: When ``True``, bypasses the :data:`DEBUG` guard.
        **metadata: Additional structured log metadata.
    """

    normalized_severity = severity.lower()

    if not DEBUG and not always and normalized_severity == "debug":
        return

    timestamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    timestamp = timestamp.replace("+00:00", "Z")
    parts = [f"[{timestamp}]", "[potato-mesh]", f"[{normalized_severity}]"]
    if context:
        parts.append(f"context={context}")
    for key, value in sorted(metadata.items()):
        parts.append(f"{key}={value!r}")
    parts.append(message)
    print(" ".join(parts))


__all__ = [
    "CONNECTION",
    "SNAPSHOT_SECS",
    "CHANNEL_INDEX",
    "DEBUG",
    "INSTANCE",
    "API_TOKEN",
    "ENERGY_SAVING",
    "LORA_FREQ",
    "MODEM_PRESET",
    "_RECONNECT_INITIAL_DELAY_SECS",
    "_RECONNECT_MAX_DELAY_SECS",
    "_CLOSE_TIMEOUT_SECS",
    "_INACTIVITY_RECONNECT_SECS",
    "_ENERGY_ONLINE_DURATION_SECS",
    "_ENERGY_SLEEP_SECS",
    "_debug_log",
]


class _ConfigModule(ModuleType):
    """Module proxy that keeps connection aliases synchronised."""

    def __setattr__(self, name: str, value: Any) -> None:  # type: ignore[override]
        """Propagate CONNECTION/PORT assignments to both attributes."""

        if name in {"CONNECTION", "PORT"}:
            super().__setattr__("CONNECTION", value)
            super().__setattr__("PORT", value)
            return
        super().__setattr__(name, value)


sys.modules[__name__].__class__ = _ConfigModule
