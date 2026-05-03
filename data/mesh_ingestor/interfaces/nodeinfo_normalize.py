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

"""Inject a canonical ``id`` into Meshtastic nodeinfo packets when missing."""

from __future__ import annotations

from .identity import _candidate_node_id, _ensure_mapping


def _normalise_nodeinfo_packet(packet) -> dict | None:
    """Return a dictionary view of ``packet`` with a guaranteed ``id`` when known."""

    mapping = _ensure_mapping(packet)
    if mapping is None:
        return None

    try:
        normalised: dict = dict(mapping)
    except Exception:
        try:
            normalised = {key: mapping[key] for key in mapping}
        except Exception:  # pragma: no cover - both copy strategies failed
            return None

    node_id = _candidate_node_id(normalised)
    if node_id and normalised.get("id") != node_id:
        normalised["id"] = node_id

    return normalised
