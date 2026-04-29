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

"""Runtime monkey-patches applied to the upstream ``meshtastic`` library."""

from __future__ import annotations

from .ble_receive import _patch_meshtastic_ble_receive_loop
from .nodeinfo import (
    _build_safe_nodeinfo_callback,
    _patch_meshtastic_nodeinfo_handler,
    _patch_nodeinfo_handler_class,
    _update_nodeinfo_handler_aliases,
)


def apply_all() -> None:
    """Apply every meshtastic monkey-patch in the order required for safety."""
    _patch_meshtastic_nodeinfo_handler()
    _patch_meshtastic_ble_receive_loop()


__all__ = [
    "apply_all",
    "_build_safe_nodeinfo_callback",
    "_patch_meshtastic_ble_receive_loop",
    "_patch_meshtastic_nodeinfo_handler",
    "_patch_nodeinfo_handler_class",
    "_update_nodeinfo_handler_aliases",
]
