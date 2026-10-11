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

"""Loose byte caps on the strings the ingestor posts (SPEC SL8), and list caps.

The web app holds the final caps, in UTF-8 bytes, and cuts free text on a
grapheme-cluster boundary
(``web/lib/potato_mesh/application/data_processing/field_limits.rb``).
Python's standard library has no grapheme segmentation, so the ingestor only
trims a string that runs past its web cap plus :data:`LOOSE_MARGIN_BYTES`, on a
code-point boundary.  The web's cut reads the same margin past its cap, so it
sees in a trimmed value the context it would see in the untrimmed one and
stores the same text; the trim only keeps an oversized value off the wire.  A
protobuf parses a string of any length, whatever the firmware allows, so a
node name can arrive at 60 kB.

A list is cut to the web's entry cap exactly, keeping its first entries
(SPEC IB3): a neighbour snapshot's ``neighbors`` and a trace's ``hops``, each
entry of which the web app stores as a node.  One UDP datagram carries 16,000
route entries or 4,000 neighbours.  Every entry the ingestor posts names a
node, so the web app keeps the same first entries from the cut list as from
the whole one.

:func:`bound_post_payload` runs once per payload, in
:func:`~data.mesh_ingestor.queue._queue_post_json`, the one place every POST
to the web app passes.
"""

from __future__ import annotations

from typing import Callable, Final, Mapping

LOOSE_MARGIN_BYTES: Final[int] = 64
"""Bytes kept past a web cap; the web's cut reads the same margin."""

CAPS: Final[Mapping[str, int]] = {
    "LONG_NAME": 512,
    "SHORT_NAME": 16,
    "HW_MODEL": 64,
    "ROLE": 32,
    "MACADDR": 32,
    "PUBLIC_KEY": 512,
    "HASH": 64,
    "ASPECT": 64,
    "INTERFACE": 256,
    "LABEL": 32,
    "MESSAGE_TEXT": 1024,
    "PAYLOAD": 512,
    "CHANNEL_NAME": 64,
    "EMOJI": 64,
    "PATH": 512,
    "RX_ISO": 32,
    "USER_STRING": 256,
    "WAYPOINT_NAME": 128,
    "WAYPOINT_DESCRIPTION": 512,
    "INGESTOR_VERSION": 64,
}
"""Web caps in UTF-8 bytes, named as the web's ``<NAME>_BYTES`` constants."""

ENTRY_CAPS: Final[Mapping[str, int]] = {
    "NEIGHBOR": 16,
    "TRACE_HOP": 16,
}
"""Web caps in list entries, named as the web's ``<NAME>_ENTRIES`` constants."""

_NODE_FIELDS: Final[Mapping[tuple[str, ...], int]] = {
    ("user", "longName"): CAPS["LONG_NAME"],
    ("user", "long_name"): CAPS["LONG_NAME"],
    ("user", "shortName"): CAPS["SHORT_NAME"],
    ("user", "short_name"): CAPS["SHORT_NAME"],
    ("user", "hwModel"): CAPS["HW_MODEL"],
    ("user", "hw_model"): CAPS["HW_MODEL"],
    ("hwModel",): CAPS["HW_MODEL"],
    ("hw_model",): CAPS["HW_MODEL"],
    ("user", "role"): CAPS["ROLE"],
    ("user", "macaddr"): CAPS["MACADDR"],
    ("user", "publicKey"): CAPS["PUBLIC_KEY"],
    ("user", "public_key"): CAPS["PUBLIC_KEY"],
    ("identityHash",): CAPS["HASH"],
    ("identity_hash",): CAPS["HASH"],
    ("destination", "id"): CAPS["HASH"],
    ("destination", "aspect"): CAPS["ASPECT"],
    ("destination", "role"): CAPS["ROLE"],
    ("interface",): CAPS["INTERFACE"],
    ("modem_preset",): CAPS["LABEL"],
    ("modemPreset",): CAPS["LABEL"],
    ("position", "locationSource"): CAPS["LABEL"],
    ("position", "location_source"): CAPS["LABEL"],
}

ROUTE_FIELDS: Final[Mapping[str, Mapping[tuple[str, ...], int]]] = {
    "/api/nodes": _NODE_FIELDS,
    "/api/messages": {
        ("text",): CAPS["MESSAGE_TEXT"],
        ("encrypted",): CAPS["PAYLOAD"],
        ("channel_name",): CAPS["CHANNEL_NAME"],
        ("emoji",): CAPS["EMOJI"],
        ("path",): CAPS["PATH"],
        ("rx_iso",): CAPS["RX_ISO"],
        ("portnum",): CAPS["LABEL"],
        ("modem_preset",): CAPS["LABEL"],
    },
    "/api/positions": {
        ("rx_iso",): CAPS["RX_ISO"],
        ("location_source",): CAPS["LABEL"],
        ("position", "location_source"): CAPS["LABEL"],
        ("position", "locationSource"): CAPS["LABEL"],
        ("position", "raw", "location_source"): CAPS["LABEL"],
        ("payload_b64",): CAPS["PAYLOAD"],
        ("modem_preset",): CAPS["LABEL"],
    },
    "/api/telemetry": {
        ("rx_iso",): CAPS["RX_ISO"],
        ("portnum",): CAPS["LABEL"],
        ("payload_b64",): CAPS["PAYLOAD"],
        ("modem_preset",): CAPS["LABEL"],
        ("telemetry_type",): CAPS["LABEL"],
        ("user_string",): CAPS["USER_STRING"],
        ("host_metrics", "user_string"): CAPS["USER_STRING"],
        ("host_metrics", "userString"): CAPS["USER_STRING"],
    },
    "/api/traces": {("rx_iso",): CAPS["RX_ISO"]},
    "/api/waypoints": {
        ("rx_iso",): CAPS["RX_ISO"],
        ("name",): CAPS["WAYPOINT_NAME"],
        ("description",): CAPS["WAYPOINT_DESCRIPTION"],
        ("payload_b64",): CAPS["PAYLOAD"],
    },
    "/api/ingestors": {
        ("version",): CAPS["INGESTOR_VERSION"],
        ("modem_preset",): CAPS["LABEL"],
    },
}
"""Capped string fields of each POST route, as nested key paths."""

ROUTE_LISTS: Final[Mapping[str, Mapping[tuple[str, ...], int]]] = {
    "/api/neighbors": {("neighbors",): ENTRY_CAPS["NEIGHBOR"]},
    "/api/traces": {("hops",): ENTRY_CAPS["TRACE_HOP"]},
}
"""Capped list fields of each POST route, as key paths (SPEC IB3)."""

_KEYED_ROUTES: Final[frozenset[str]] = frozenset({"/api/nodes"})
"""Routes whose payload maps a node id to each record."""


def loose_cut(text: str, cap: int) -> str:
    """Trim ``text`` to its web cap plus :data:`LOOSE_MARGIN_BYTES`.

    The cut lands on a code-point boundary and may split a grapheme cluster;
    the web app makes the final cut on a cluster boundary.  A lone surrogate
    in a trimmed value is dropped, so the result always encodes as UTF-8.

    Parameters:
        text: String value of a capped field.
        cap: Web cap of the field in UTF-8 bytes.

    Returns:
        ``text`` itself when it fits ``cap + LOOSE_MARGIN_BYTES`` bytes,
        otherwise its longest prefix of whole code points that does.
    """

    limit = cap + LOOSE_MARGIN_BYTES
    # A code point takes at most four UTF-8 bytes: a string this short fits
    # without encoding it.
    if len(text) * 4 <= limit:
        return text
    encoded = text.encode("utf-8", "surrogatepass")
    if len(encoded) <= limit:
        return text
    return encoded[:limit].decode("utf-8", "ignore")


def _cut_text(value: object, cap: int) -> object:
    """Trim a string field loosely; leave any other value alone.

    Parameters:
        value: Value of a capped string field.
        cap: Web cap of the field in UTF-8 bytes.

    Returns:
        :func:`loose_cut` of a string, or ``value`` itself.
    """

    return loose_cut(value, cap) if isinstance(value, str) else value


def _cut_list(value: object, cap: int) -> object:
    """Keep the first ``cap`` entries of a list field (SPEC IB3).

    Parameters:
        value: Value of a capped list field.
        cap: Web cap of the field in entries.

    Returns:
        ``value`` itself when it is no list or fits, otherwise a new list of
        its first ``cap`` entries.
    """

    if isinstance(value, list) and len(value) > cap:
        return value[:cap]
    return value


_Rule = tuple[tuple[str, ...], int, Callable[[object, int], object]]
"""A capped field: its key path, its cap, and the cut that applies it."""

_ROUTE_RULES: Final[Mapping[str, tuple[_Rule, ...]]] = {
    route: tuple(
        [(path, cap, _cut_text) for path, cap in ROUTE_FIELDS.get(route, {}).items()]
        + [(path, cap, _cut_list) for path, cap in ROUTE_LISTS.get(route, {}).items()]
    )
    for route in ROUTE_FIELDS.keys() | ROUTE_LISTS.keys()
}
"""Every cut of each POST route: its string fields, then its list fields."""


def _bound_path(
    value: object,
    path: tuple[str, ...],
    cap: int,
    cut: Callable[[object, int], object],
) -> object:
    """Cut the field at ``path`` inside ``value``, copying what changes.

    Parameters:
        value: Mapping at the current level, or any other value.
        path: Remaining keys, outermost first.
        cap: Web cap of the field, in bytes or entries.
        cut: :func:`_cut_text` or :func:`_cut_list`.

    Returns:
        ``value`` itself when nothing at ``path`` needs a cut, otherwise a
        shallow copy of each level down to the cut value.
    """

    if not isinstance(value, dict) or path[0] not in value:
        return value
    current = value[path[0]]
    if len(path) > 1:
        bounded = _bound_path(current, path[1:], cap, cut)
    else:
        bounded = cut(current, cap)
    if bounded is current:
        return value
    copy = dict(value)
    copy[path[0]] = bounded
    return copy


def _bound_record(record: object, rules: tuple[_Rule, ...]) -> object:
    """Cut every capped field of one record.

    Parameters:
        record: One record of a payload.
        rules: Capped fields of the route, with their caps and cuts.

    Returns:
        ``record`` itself when every field fits, otherwise a cut copy.
    """

    bounded = record
    for path, cap, cut in rules:
        bounded = _bound_path(bounded, path, cap, cut)
    return bounded


def bound_post_payload(path: str, payload: object) -> object:
    """Trim the oversized strings and lists of a payload bound for ``path``.

    The payload is never modified: a payload whose fields all fit comes back
    as the same object, and one with an oversized field comes back as a copy
    sharing everything the trim did not touch.

    Parameters:
        path: Web API route the payload is posted to.
        payload: JSON-serialisable body: one record, a list of records, or,
            for ``/api/nodes``, a mapping of node ids to records.

    Returns:
        The payload, trimmed.
    """

    rules = _ROUTE_RULES.get(path)
    if rules is None:
        return payload
    if isinstance(payload, list):
        records = [_bound_record(record, rules) for record in payload]
        if all(new is old for new, old in zip(records, payload)):
            return payload
        return records
    if path in _KEYED_ROUTES and isinstance(payload, dict):
        bounded = payload
        for key, record in payload.items():
            trimmed = _bound_record(record, rules)
            if trimmed is not record:
                if bounded is payload:
                    bounded = dict(payload)
                bounded[key] = trimmed
        return bounded
    return _bound_record(payload, rules)


__all__ = [
    "CAPS",
    "ENTRY_CAPS",
    "LOOSE_MARGIN_BYTES",
    "ROUTE_FIELDS",
    "ROUTE_LISTS",
    "bound_post_payload",
    "loose_cut",
]
