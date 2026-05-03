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

"""MeshCore protocol implementation.

This package defines :class:`MeshcoreProvider`, which satisfies the
:class:`~data.mesh_ingestor.mesh_protocol.MeshProtocol` interface for MeshCore
nodes connected via serial port, BLE, or TCP/IP.

The protocol backend runs MeshCore's ``asyncio`` event loop in a background
daemon thread so that incoming events are dispatched without blocking the
synchronous daemon loop.  Received contacts, channel messages, and direct
messages are forwarded to the shared HTTP ingest queue via the same
:mod:`~data.mesh_ingestor.handlers` helpers used by the Meshtastic protocol.

Connection type is detected automatically from the target string:

* **BLE** — MAC address (``AA:BB:CC:DD:EE:FF``) or UUID (macOS format).
* **TCP** — ``host:port`` or ``[ipv6]:port`` (accepts hostnames).
* **Serial** — any other non-empty string (e.g. ``/dev/ttyUSB0``).
* **Auto** — ``None`` or empty: tries serial candidates from
  :func:`~data.mesh_ingestor.connection.default_serial_targets`.

Node identities are derived from the first four bytes (eight hex characters)
of each contact's 32-byte public key, formatted as ``!xxxxxxxx`` to match
the canonical node-ID schema used across the system.  Ingested
``user.shortName`` is the first two bytes (four hex characters) of the
node ID, not the advertised name.
"""

from __future__ import annotations

# Apply upstream-library patches before any ``MeshCore`` instance is built,
# otherwise the first malformed advertisement dies inside a detached asyncio
# task before our handler can observe it.  See
# :mod:`data.mesh_ingestor.protocols._meshcore_patches` for the specific
# upstream bugs covered.
#
# This mutates the upstream class at import time.  The blast radius is
# narrow because ``protocols/__init__.py`` exposes this package only through
# a lazy ``__getattr__`` and the daemon resolves it only when
# ``PROTOCOL=meshcore`` is active.  Any future diagnostic CLI that imports
# this package will inherit the shim.
from .. import _meshcore_patches as _meshcore_patches

_meshcore_patches.apply()

# Re-expose meshcore-library symbols so existing test imports (and callers
# that prefer a single import surface) keep working unchanged.  Submodules
# resolve these names at call time via ``sys.modules`` so monkey-patches
# applied to the package surface during tests propagate.
from meshcore import (  # noqa: E402 - patches must run before this import.
    BLEConnection,
    EventType,
    MeshCore,
    SerialConnection,
    TCPConnection,
)

# Re-expose the ``data.mesh_ingestor`` modules that tests monkeypatch through
# the meshcore namespace (``_mod.config._debug_log``, ``_mod._ingestors``,
# ``_mod._queue``).  Keeping these attributes preserves the call surface of
# the pre-split ``meshcore.py`` module.
from ... import config as config  # noqa: E402
from ... import ingestors as _ingestors  # noqa: E402
from ... import queue as _queue  # noqa: E402
from ...connection import default_serial_targets  # noqa: E402

from ._constants import (  # noqa: E402 - keep grouped with sibling re-exports.
    _CHANNEL_PROBE_FALLBACK_MAX,
    _CONNECT_TIMEOUT_SECS,
    _DEFAULT_BAUDRATE,
    _MENTION_RE,
    _MESHCORE_ADV_TYPE_ROLE,
    _MESHCORE_ID_BITS,
    _MESHCORE_ID_MASK,
)
from .channels import _ensure_channel_names  # noqa: E402
from .connection import (  # noqa: E402
    _log_unhandled_loop_exception,
    _make_connection,
)
from .debug_log import (  # noqa: E402
    _IGNORED_MESSAGE_LOCK,
    _IGNORED_MESSAGE_LOG_PATH,
    _record_meshcore_message,
    _to_json_safe,
)
from .decode import (  # noqa: E402
    _contact_to_node_dict,
    _derive_modem_preset,
    _self_info_to_node_dict,
)
from .handlers import (  # noqa: E402
    _make_event_handlers,
    _process_contact_update,
    _process_contacts,
    _process_self_info,
)
from .identity import (  # noqa: E402
    _derive_synthetic_node_id,
    _meshcore_adv_type_to_role,
    _meshcore_node_id,
    _meshcore_short_name,
    _pubkey_prefix_to_node_id,
)
from .interface import ClosedBeforeConnectedError, _MeshcoreInterface  # noqa: E402
from .messages import (  # noqa: E402
    _derive_message_id,
    _extract_mention_names,
    _parse_sender_name,
    _synthetic_node_dict,
)
from .position import _store_meshcore_position  # noqa: E402
from .provider import MeshcoreProvider  # noqa: E402
from .runner import _run_meshcore  # noqa: E402

__all__ = [
    "BLEConnection",
    "ClosedBeforeConnectedError",
    "EventType",
    "MeshCore",
    "MeshcoreProvider",
    "SerialConnection",
    "TCPConnection",
    "_CHANNEL_PROBE_FALLBACK_MAX",
    "_CONNECT_TIMEOUT_SECS",
    "_DEFAULT_BAUDRATE",
    "_IGNORED_MESSAGE_LOCK",
    "_IGNORED_MESSAGE_LOG_PATH",
    "_MENTION_RE",
    "_MESHCORE_ADV_TYPE_ROLE",
    "_MESHCORE_ID_BITS",
    "_MESHCORE_ID_MASK",
    "_MeshcoreInterface",
    "_contact_to_node_dict",
    "_derive_message_id",
    "_derive_modem_preset",
    "_derive_synthetic_node_id",
    "_ensure_channel_names",
    "_extract_mention_names",
    "_log_unhandled_loop_exception",
    "_make_connection",
    "_make_event_handlers",
    "_meshcore_adv_type_to_role",
    "_meshcore_node_id",
    "_meshcore_short_name",
    "_parse_sender_name",
    "_process_contact_update",
    "_process_contacts",
    "_process_self_info",
    "_pubkey_prefix_to_node_id",
    "_record_meshcore_message",
    "_run_meshcore",
    "_self_info_to_node_dict",
    "_store_meshcore_position",
    "_synthetic_node_dict",
    "_to_json_safe",
]
