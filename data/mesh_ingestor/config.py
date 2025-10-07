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
import time

PORT = os.environ.get("MESH_SERIAL")
SNAPSHOT_SECS = int(os.environ.get("MESH_SNAPSHOT_SECS", "60"))
CHANNEL_INDEX = int(os.environ.get("MESH_CHANNEL_INDEX", "0"))
DEBUG = os.environ.get("DEBUG") == "1"
INSTANCE = os.environ.get("POTATOMESH_INSTANCE", "").rstrip("/")
API_TOKEN = os.environ.get("API_TOKEN", "")

_RECONNECT_INITIAL_DELAY_SECS = float(os.environ.get("MESH_RECONNECT_INITIAL", "5"))
_RECONNECT_MAX_DELAY_SECS = float(os.environ.get("MESH_RECONNECT_MAX", "60"))
_CLOSE_TIMEOUT_SECS = float(os.environ.get("MESH_CLOSE_TIMEOUT", "5"))


def _debug_log(message: str) -> None:
    """Print ``message`` with a UTC timestamp when ``DEBUG`` is enabled.

    Parameters:
        message: Text to display when debug logging is active.
    """

    if not DEBUG:
        return

    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    print(f"[{timestamp}] [debug] {message}")


__all__ = [
    "PORT",
    "SNAPSHOT_SECS",
    "CHANNEL_INDEX",
    "DEBUG",
    "INSTANCE",
    "API_TOKEN",
    "_RECONNECT_INITIAL_DELAY_SECS",
    "_RECONNECT_MAX_DELAY_SECS",
    "_CLOSE_TIMEOUT_SECS",
    "_debug_log",
]
