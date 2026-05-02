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

"""``DEBUG=1`` capture of unhandled MeshCore frames to ``ignored-meshcore.txt``."""

from __future__ import annotations

import base64
import json
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

from ... import config

# This file lives one level deeper than the pre-split ``meshcore.py``
# (``data/mesh_ingestor/protocols/meshcore/debug_log.py`` vs.
# ``data/mesh_ingestor/protocols/meshcore.py``), so ``parents[4]`` here
# (meshcore/ → protocols/ → mesh_ingestor/ → data/ → repo root) lands at
# the same repo-root destination as ``parents[3]`` did in the original
# module.  The on-disk log path is therefore unchanged after the split.
_IGNORED_MESSAGE_LOG_PATH = Path(__file__).resolve().parents[4] / "ignored-meshcore.txt"
"""Filesystem path that stores raw MeshCore messages when ``DEBUG=1``."""

_IGNORED_MESSAGE_LOCK = threading.Lock()
"""Lock guarding writes to :data:`_IGNORED_MESSAGE_LOG_PATH`."""


def _to_json_safe(value: object) -> object:
    """Recursively convert *value* to a JSON-serialisable form.

    Handles the common types present in mesh protocol messages: dicts, lists,
    bytes (base64-encoded), and primitives.  Anything else is coerced via
    ``str()``.
    """
    if isinstance(value, dict):
        return {str(k): _to_json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_to_json_safe(v) for v in value]
    if isinstance(value, bytes):
        return base64.b64encode(value).decode("ascii")
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _record_meshcore_message(message: object, *, source: str) -> None:
    """Persist a MeshCore message to :data:`ignored-meshcore.txt` when ``DEBUG=1``.

    When ``DEBUG`` is not set the function returns immediately without any
    I/O so that production deployments are not burdened by file writes.

    Parameters:
        message: The raw message object received from the MeshCore node.
        source: A short label describing where the message originated (e.g.
            a serial port path or BLE address).
    """
    if not config.DEBUG:
        return

    # Resolve path/lock via the parent package so test monkey-patches at
    # ``meshcore._IGNORED_MESSAGE_LOG_PATH`` (and ``_IGNORED_MESSAGE_LOCK``)
    # take effect at call time.
    pkg = sys.modules.get("data.mesh_ingestor.protocols.meshcore")
    log_path = getattr(pkg, "_IGNORED_MESSAGE_LOG_PATH", _IGNORED_MESSAGE_LOG_PATH)
    log_lock = getattr(pkg, "_IGNORED_MESSAGE_LOCK", _IGNORED_MESSAGE_LOCK)

    timestamp = datetime.now(timezone.utc).isoformat()
    entry = {
        "message": _to_json_safe(message),
        "source": source,
        "timestamp": timestamp,
    }
    payload = json.dumps(entry, ensure_ascii=False, sort_keys=True)
    with log_lock:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as fh:
            fh.write(f"{payload}\n")
