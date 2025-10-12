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

"""Configuration helpers for the potato-mesh ingestor."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

PORT = os.environ.get("MESH_SERIAL")
SNAPSHOT_SECS = int(os.environ.get("MESH_SNAPSHOT_SECS", "60"))
CHANNEL_INDEX = int(os.environ.get("MESH_CHANNEL_INDEX", "0"))
DEBUG = os.environ.get("DEBUG") == "1"
INSTANCE = os.environ.get("POTATOMESH_INSTANCE", "").rstrip("/")
API_TOKEN = os.environ.get("API_TOKEN", "")
ENERGY_SAVING = os.environ.get("ENERGY_SAVING") == "1"

_RECONNECT_INITIAL_DELAY_SECS = float(os.environ.get("MESH_RECONNECT_INITIAL", "5"))
_RECONNECT_MAX_DELAY_SECS = float(os.environ.get("MESH_RECONNECT_MAX", "60"))
_CLOSE_TIMEOUT_SECS = float(os.environ.get("MESH_CLOSE_TIMEOUT", "5"))
_INACTIVITY_RECONNECT_SECS = float(
    os.environ.get("MESH_INACTIVITY_RECONNECT_SECS", str(60 * 60))
)
_ENERGY_ONLINE_DURATION_SECS = float(
    os.environ.get("ENERGY_ONLINE_DURATION_SECS", "300")
)
_ENERGY_SLEEP_SECS = float(os.environ.get("ENERGY_SLEEP_SECS", str(6 * 60 * 60)))


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
    "PORT",
    "SNAPSHOT_SECS",
    "CHANNEL_INDEX",
    "DEBUG",
    "INSTANCE",
    "API_TOKEN",
    "ENERGY_SAVING",
    "_RECONNECT_INITIAL_DELAY_SECS",
    "_RECONNECT_MAX_DELAY_SECS",
    "_CLOSE_TIMEOUT_SECS",
    "_INACTIVITY_RECONNECT_SECS",
    "_ENERGY_ONLINE_DURATION_SECS",
    "_ENERGY_SLEEP_SECS",
    "_debug_log",
]
