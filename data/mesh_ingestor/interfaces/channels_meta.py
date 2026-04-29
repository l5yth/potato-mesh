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

"""One-shot channel metadata capture from a live Meshtastic interface."""

from __future__ import annotations

from typing import Any

from .. import channels, config


def _ensure_channel_metadata(iface: Any) -> None:
    """Capture channel metadata by inspecting ``iface`` once per runtime."""

    if iface is None:
        return

    try:
        channels.capture_from_interface(iface)
    except Exception as exc:  # pragma: no cover - defensive instrumentation
        config._debug_log(
            "Failed to capture channel metadata",
            context="interfaces.ensure_channel_metadata",
            severity="warn",
            error_class=exc.__class__.__name__,
            error_message=str(exc),
        )
