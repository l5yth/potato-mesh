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

"""Mesh interface discovery helpers for interacting with Meshtastic hardware."""

from __future__ import annotations

# The patches subpackage applies meshtastic monkey-patches at import time so
# subsequent calls (and any direct ``import meshtastic`` from elsewhere)
# inherit the safe wrappers.  Apply BEFORE pulling in factory.py because
# factory.py imports ``meshtastic.serial_interface`` / ``meshtastic.tcp_interface``
# and those modules transitively load NodeInfoHandler.
from .patches import (
    _build_safe_nodeinfo_callback,
    _patch_meshtastic_ble_receive_loop,
    _patch_meshtastic_nodeinfo_handler,
    _patch_nodeinfo_handler_class,
    _update_nodeinfo_handler_aliases,
    apply_all as _apply_all_patches,
)

_apply_all_patches()

from ._aliases import (  # noqa: E402 - keep grouped with sibling re-exports.
    _BLE_ADDRESS_RE,
    _DEFAULT_SERIAL_PATTERNS,
    _DEFAULT_TCP_PORT,
    _default_serial_targets,
    _parse_ble_target,
)
from .channels_meta import _ensure_channel_metadata  # noqa: E402
from .factory import (  # noqa: E402
    BLEInterface,
    NoAvailableMeshInterface,
    SerialInterface,
    TCPInterface,
    _DummySerialInterface,
    _create_default_interface,
    _create_serial_interface,
    _load_ble_interface,
)
from .identity import (  # noqa: E402
    _candidate_node_id,
    _ensure_mapping,
    _extract_host_node_id,
    _is_nodeish_identifier,
)
from .nodeinfo_normalize import _normalise_nodeinfo_packet  # noqa: E402
from .radio import (  # noqa: E402
    _REGION_CHANNEL_PARAMS,
    _camelcase_enum_name,
    _computed_channel_frequency,
    _ensure_radio_metadata,
    _enum_name_from_field,
    _has_field,
    _modem_preset,
    _region_frequency,
    _resolve_lora_message,
)
from .targets import _DEFAULT_TCP_TARGET, _parse_network_target  # noqa: E402

__all__ = [
    "BLEInterface",
    "NoAvailableMeshInterface",
    "_ensure_channel_metadata",
    "_ensure_radio_metadata",
    "_extract_host_node_id",
    "_DummySerialInterface",
    "_DEFAULT_TCP_PORT",
    "_DEFAULT_TCP_TARGET",
    "_create_default_interface",
    "_create_serial_interface",
    "_default_serial_targets",
    "_load_ble_interface",
    "_parse_ble_target",
    "_parse_network_target",
    "SerialInterface",
    "TCPInterface",
]
