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

"""Convert MeshCore contact / self-info payloads into ``POST /api/nodes`` dicts."""

from __future__ import annotations

import time

from .identity import (
    _meshcore_adv_type_to_role,
    _meshcore_node_id,
    _meshcore_short_name,
)


def _contact_to_node_dict(contact: dict) -> dict:
    """Convert a MeshCore contact dict to a Meshtastic-ish node dict.

    Parameters:
        contact: Contact dict from the MeshCore library.  Expected keys
            include ``public_key``, ``type`` (``ADV_TYPE_*``), ``adv_name``,
            ``last_advert``, ``adv_lat``, and ``adv_lon``.

    Returns:
        Node dict compatible with the ``POST /api/nodes`` payload format.
    """
    pub_key = contact.get("public_key", "")
    node_id = _meshcore_node_id(pub_key)
    name = (contact.get("adv_name") or "").strip()
    role = _meshcore_adv_type_to_role(contact.get("type"))
    node: dict = {
        "lastHeard": contact.get("last_advert"),
        "protocol": "meshcore",
        "user": {
            "longName": name,
            "shortName": _meshcore_short_name(node_id),
            "publicKey": pub_key,
            **({"role": role} if role is not None else {}),
        },
    }
    lat = contact.get("adv_lat")
    lon = contact.get("adv_lon")
    if lat is not None and lon is not None and (lat or lon):
        pos: dict = {"latitude": lat, "longitude": lon}
        last_advert = contact.get("last_advert")
        if last_advert is not None:
            pos["time"] = last_advert
        node["position"] = pos
    return node


def _derive_modem_preset(sf: object, bw: object, cr: object) -> str | None:
    """Return a compact radio-parameter string from spreading factor, bandwidth, and coding rate.

    Parameters:
        sf: Spreading factor (int, e.g. ``12``).
        bw: Bandwidth in kHz (int or float, e.g. ``125.0``).
        cr: Coding rate denominator (int, e.g. ``5`` meaning 4/5).

    Returns:
        A string such as ``"SF12/BW125/CR5"``, or ``None`` when any parameter
        is absent or zero (meaning the radio config was not reported).
    """
    if not sf or not bw or not cr:
        return None
    return f"SF{int(sf)}/BW{int(bw)}/CR{int(cr)}"


def _self_info_to_node_dict(self_info: dict) -> dict:
    """Convert a MeshCore ``SELF_INFO`` payload to a Meshtastic-ish node dict.

    Parameters:
        self_info: Payload dict from the ``SELF_INFO`` event.  Expected keys
            include ``name``, ``public_key``, ``adv_type`` (``ADV_TYPE_*``),
            ``adv_lat``, and ``adv_lon``.

    Returns:
        Node dict compatible with the ``POST /api/nodes`` payload format.
    """
    name = (self_info.get("name") or "").strip()
    pub_key = self_info.get("public_key", "")
    node_id = _meshcore_node_id(pub_key)
    role = _meshcore_adv_type_to_role(self_info.get("adv_type"))
    node: dict = {
        "lastHeard": int(time.time()),
        "protocol": "meshcore",
        "user": {
            "longName": name,
            "shortName": _meshcore_short_name(node_id),
            "publicKey": pub_key,
            **({"role": role} if role is not None else {}),
        },
    }
    lat = self_info.get("adv_lat")
    lon = self_info.get("adv_lon")
    if lat is not None and lon is not None and (lat or lon):
        node["position"] = {"latitude": lat, "longitude": lon, "time": int(time.time())}
    return node
