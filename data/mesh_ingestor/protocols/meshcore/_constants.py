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

"""Constants shared across MeshCore submodules.

Hoisted out of the original monolithic ``meshcore.py`` so that submodules can
import only what they need without picking up unrelated side-effects.
"""

from __future__ import annotations

import re

_CONNECT_TIMEOUT_SECS: float = 30.0
"""Seconds to wait for the MeshCore node to respond to the appstart handshake."""

_DEFAULT_BAUDRATE: int = 115200
"""Default baud rate for MeshCore serial connections."""

# MeshCore ``ADV_TYPE_*`` (``AdvertDataHelpers.h``) → ``user.role`` for POST /api/nodes.
_MESHCORE_ADV_TYPE_ROLE: dict[int, str] = {
    1: "COMPANION",  # ADV_TYPE_CHAT
    2: "REPEATER",  # ADV_TYPE_REPEATER
    3: "ROOM_SERVER",  # ADV_TYPE_ROOM_SERVER
    4: "SENSOR",  # ADV_TYPE_SENSOR
}

_MESHCORE_ID_BITS = 53
"""Width of the synthetic MeshCore message ID, in bits.

53 bits keeps the value within :js:data:`Number.MAX_SAFE_INTEGER`
(``2**53 - 1``) so the JSON ID round-trips through the JavaScript frontend
without precision loss, while giving roughly :math:`2^{26.5}` (~95 million)
distinct messages of birthday-collision headroom.
"""

_MESHCORE_ID_MASK = (1 << _MESHCORE_ID_BITS) - 1
"""Bitmask applied to the SHA-256 prefix to clamp the id to 53 bits."""

# Fallback upper bound for channel index probing when the device query fails
# or returns an older firmware version that omits ``max_channels``.
_CHANNEL_PROBE_FALLBACK_MAX = 32

# Matches @[Name] mention patterns in MeshCore message bodies.
_MENTION_RE = re.compile(r"@\[([^\]]+)\]")
