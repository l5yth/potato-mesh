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

"""Radio metadata helpers for enriching API payloads.

LoRa radio parameters (frequency and modem preset) are captured once at
connection time by :mod:`data.mesh_ingestor.interfaces` and stored on the
:mod:`data.mesh_ingestor.config` module.  The helpers here read those cached
values and attach them to outgoing payloads so the web dashboard can display
radio configuration alongside mesh data.
"""

from __future__ import annotations

from .. import config


def _radio_metadata_fields() -> dict[str, object]:
    """Return the shared radio metadata fields for payload enrichment.

    Reads ``LORA_FREQ`` and ``MODEM_PRESET`` from :mod:`config` and returns
    only the keys that have been populated (i.e. skips ``None`` values).

    Returns:
        A dictionary containing zero, one, or both of ``lora_freq`` and
        ``modem_preset`` depending on what is available.
    """

    metadata: dict[str, object] = {}
    freq = getattr(config, "LORA_FREQ", None)
    if freq is not None:
        metadata["lora_freq"] = freq
    preset = getattr(config, "MODEM_PRESET", None)
    if preset is not None:
        metadata["modem_preset"] = preset
    return metadata


def _apply_radio_metadata(payload: dict) -> dict:
    """Augment a flat payload dict with radio metadata when available.

    Parameters:
        payload: Mutable dictionary that will receive radio metadata keys.

    Returns:
        The same ``payload`` dict with radio metadata keys merged in-place.
    """

    metadata = _radio_metadata_fields()
    if metadata:
        payload.update(metadata)
    return payload


def _apply_radio_metadata_to_nodes(payload: dict) -> dict:
    """Attach radio metadata to each node entry stored in ``payload``.

    Node upsert payloads are keyed by node ID; each value is a dict of node
    attributes.  This function enriches every node-value dict with radio
    metadata so the dashboard can show the radio configuration that was active
    when the node was last heard.

    Parameters:
        payload: Mapping of ``node_id → node_dict`` to enrich in-place.

    Returns:
        The same ``payload`` dict after in-place mutation of its node entries.
    """

    metadata = _radio_metadata_fields()
    if not metadata:
        return payload
    for value in payload.values():
        if isinstance(value, dict):
            value.update(metadata)
    return payload


__all__ = [
    "_apply_radio_metadata",
    "_apply_radio_metadata_to_nodes",
    "_radio_metadata_fields",
]
