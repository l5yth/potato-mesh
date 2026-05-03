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

"""Backward-compat aliases for renames hidden behind the package barrel."""

from __future__ import annotations

from ..connection import (
    BLE_ADDRESS_RE,
    DEFAULT_SERIAL_PATTERNS,
    DEFAULT_TCP_PORT,
    default_serial_targets,
    parse_ble_target,
)

# Private aliases so that existing internal callers and monkeypatching in
# tests keep working without modification.
_BLE_ADDRESS_RE = BLE_ADDRESS_RE
_DEFAULT_TCP_PORT = DEFAULT_TCP_PORT
_DEFAULT_SERIAL_PATTERNS = DEFAULT_SERIAL_PATTERNS
_parse_ble_target = parse_ble_target
_default_serial_targets = default_serial_targets
