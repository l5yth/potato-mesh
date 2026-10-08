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
"""The Reticulum host's own position, read from the RNS config (SPEC RP1-RP6).

A Reticulum announce carries no position, so no RNS peer can be placed on the
map.  The ingestor's own host is the one node it can answer for: RNS 1.5
defines per-interface ``latitude``, ``longitude`` and ``height`` keys, and this
module publishes the ones in the first ``RNodeInterface`` block of the shared
RNS config as the host's position.

**The RNS config, read-only.**  :func:`rns_config_text` and
:func:`rnode_block_entries` are also the source of the radio metadata (SPEC
RL1): both features read the same block by the same line rules.  A caller names
the keys it wants and receives only those, so nothing else in the file -- the
shared instance's ``rpc_key``, an interface ``passphrase`` -- ever leaves the
parser.  RNS itself reads the position keys only when the interface sets
``discoverable = yes``; they are read here whether or not it does, and
``location_cmd`` is never run.

**Read once per connect.**  :func:`read_host_position` runs at connect.  Keys
and values are read as RNS's own config parser reads them: a key counts only
under its exact name, after one pair of quotes is stripped from it, and one
matching pair of quotes is stripped from each value.  RL1 keeps its own,
case-insensitive key rule.  Missing coordinates mean no position and log one
debug line; an invalid latitude or longitude logs one warning and also means no
position; an invalid ``height`` logs one warning and drops only the altitude.
A line is logged only when the outcome changes, so a connection that recycles
hourly on a quiet mesh does not repeat it.

**Published as written.**  No rounding and no ``precisionBits``: the operator
typed the value into their own config.  The host's records carry it as the node
record's ``position`` (:func:`with_host_position`), and every self-node report,
the first of which runs at connect, also posts one ``POST /api/positions`` row
(:func:`report_host_position`), the way a MeshCore host does.  Peer records are
never touched.
"""

from __future__ import annotations

import hashlib
import os
import time
from collections.abc import Callable
from typing import NamedTuple

from .. import config, handlers
from .. import queue as _queue
from ..handlers.radio import _apply_radio_metadata
from ..node_identity import node_num_from_id
from ..serialization import _coerce_float, _iso, _normalize_lat_lon

POSITION_KEYS: frozenset[str] = frozenset({"latitude", "longitude", "height"})
"""The ``RNodeInterface`` keys the host position reads.

``location_cmd`` is deliberately absent: it names a command to run, and the
ingestor never runs one.
"""

LOCATION_SOURCE = "LOC_MANUAL"
"""``locationSource`` of a position typed into a config file by hand."""

_ROW_ID_MASK = (1 << 53) - 1
"""Positions-row ids fit 53 bits, so they round-trip through the frontend."""

_last_outcome: str | None = None
"""Outcome of the last read that was logged, so a repeat stays quiet."""


class HostPosition(NamedTuple):
    """The host's position as written in the RNS config."""

    latitude: float
    """Latitude in decimal degrees."""

    longitude: float
    """Longitude in decimal degrees."""

    altitude: float | None
    """Height in metres, or ``None`` when the config sets none."""


def rns_config_text(config_dir: object) -> str | None:
    """Return the contents of the RNS config file in *config_dir*.

    Parameters:
        config_dir: The RNS config directory, normally
            :data:`~data.mesh_ingestor.config.RETICULUM_CONFIG_DIR`.

    Returns:
        The text of ``<config_dir>/config``, or ``None`` when the directory is
        unset or the file cannot be read.
    """
    if not isinstance(config_dir, str) or not config_dir.strip():
        return None
    path = os.path.join(os.path.expanduser(config_dir), "config")
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except OSError:
        return None


def rnode_block_entries(
    text: str, keys: frozenset[str]
) -> list[tuple[str, str]] | None:
    """Return the *keys* lines of the first ``RNodeInterface`` block in *text*.

    Walks the RNS config's indented ``[[name]]`` interface blocks: any line
    starting with ``[`` closes the block being collected, ``#`` starts a
    comment, a line without ``=`` is skipped, and keys compare lower-cased.  A
    block is an RNode block when its ``type`` is ``RNodeInterface``.

    Parameters:
        text: Contents of the RNS config file.
        keys: Lower-case keys to return; every other line is dropped here.

    Returns:
        ``(key, value)`` pairs in file order, values stripped, or ``None`` when
        the config holds no ``RNodeInterface`` block.
    """
    entries: list[tuple[str, str]] = []
    is_rnode = False
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        if line.startswith("["):
            # A new section ends the one being collected.
            if is_rnode:
                return entries
            entries, is_rnode = [], False
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip().lower(), value.strip()
        if key == "type":
            is_rnode = value == "RNodeInterface"
        elif key in keys:
            entries.append((key, value))
    return entries if is_rnode else None


def _unquote(value: str) -> str:
    """Strip one matching pair of single or double quotes, as RNS does.

    RNS's own config parser reads ``latitude = "52.5"`` as ``52.5``, and the
    host position must read what RNS reads.  Only the position unquotes:
    :func:`rnode_block_entries` and the radio metadata (SPEC RL1) keep every
    value as written.

    Parameters:
        value: A stripped value from :func:`rnode_block_entries`.

    Returns:
        *value* without one surrounding pair of matching quotes, if it has one.
    """
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def parse_host_position(
    entries: list[tuple[str, str]] | None,
) -> tuple[HostPosition | None, str | None]:
    """Validate the position keys of the first ``RNodeInterface`` block.

    Each value loses one matching pair of quotes first (:func:`_unquote`).

    Parameters:
        entries: Output of :func:`rnode_block_entries` for
            :data:`POSITION_KEYS`; the last occurrence of a key wins.

    Returns:
        ``(position, None)`` for a valid position, ``(None, None)`` when the
        block sets neither coordinate, and ``(None, problem)`` when a
        coordinate is invalid: one coordinate alone, a value that is not a
        finite number, a latitude beyond 90 or a longitude beyond 180 degrees,
        or ``0, 0``.  A ``height`` that is not a finite number drops only the
        altitude: ``(position, problem)``, the position without altitude.
    """
    values = {key: _unquote(value) for key, value in entries or ()}
    lat_text, lon_text = values.get("latitude"), values.get("longitude")
    if lat_text is None and lon_text is None:
        return None, None
    if lat_text is None or lon_text is None:
        return None, "only one of latitude and longitude is set"
    latitude, longitude = _coerce_float(lat_text), _coerce_float(lon_text)
    if latitude is None or longitude is None:
        return None, "latitude and longitude must be numbers"
    if abs(latitude) > 90:
        return None, "latitude is outside -90..90"
    if abs(longitude) > 180:
        return None, "longitude is outside -180..180"
    if _normalize_lat_lon(latitude, longitude) == (None, None):
        # The shared sentinel rule (CONTRACTS, issue #782): 0, 0 is no fix.
        return None, "0, 0 is not a position"
    if "height" not in values:
        return HostPosition(latitude, longitude, None), None
    altitude = _coerce_float(values["height"])
    if altitude is None:
        # The coordinates are what the map needs; only the altitude goes.
        return HostPosition(latitude, longitude, None), "height must be a number"
    return HostPosition(latitude, longitude, altitude), None


def _log_outcome(position: HostPosition | None, problem: str | None) -> None:
    """Log the outcome of a read, once per change of outcome.

    The coordinates themselves are never logged.

    Parameters:
        position: The position read, or ``None``.
        problem: Why the keys were rejected, or ``None``.
    """
    global _last_outcome
    if position is not None and problem is not None:
        outcome = "valid without altitude: " + problem
    elif position is not None:
        outcome = "valid"
    elif problem is not None:
        outcome = "invalid: " + problem
    else:
        outcome = "missing"
    if outcome == _last_outcome:
        return
    _last_outcome = outcome
    if position is not None and problem is not None:
        # Names the key only: neither the bad value nor the coordinates.
        config._debug_log(
            "Publishing the host position from the RNS config without altitude: "
            f"{problem}; fix or remove height in its first RNodeInterface block",
            context="reticulum.position",
            severity="warn",
        )
    elif position is not None:
        config._debug_log(
            "Publishing the host position from the RNS config",
            context="reticulum.position",
            severity="info",
            altitude=position.altitude is not None,
        )
    elif problem is not None:
        config._debug_log(
            "Ignoring the host position in the RNS config: "
            f"{problem}; fix or remove latitude, longitude and height in its "
            "first RNodeInterface block",
            context="reticulum.position",
            severity="warn",
        )
    else:
        config._debug_log(
            "No host position in the first RNodeInterface block of the RNS config",
            context="reticulum.position",
        )


def _rns_spelled_keys(text: str) -> str:
    """Spell the position keys in *text* the way RNS's config parser matches them.

    RNS's ``ConfigObj`` matches a key exactly once one pair of quotes is
    stripped from it: it reads ``latitude`` and ``"latitude"``, and ignores
    ``Latitude``.  The shared reader lower-cases keys and keeps their quotes,
    which is RL1's rule and stays unchanged, so the position path rewrites a
    quoted position key to its bare name and drops every other spelling of one
    before the shared reader sees the text.

    Parameters:
        text: Contents of the RNS config file.

    Returns:
        *text* with each position key as RNS reads it, and no other spelling.
    """
    lines = []
    for raw in text.splitlines():
        content = raw.split("#", 1)[0]
        if "=" in content and not content.strip().startswith("["):
            key, _, rest = raw.partition("=")
            name = _unquote(key.strip())
            if name in POSITION_KEYS:
                raw = f"{name} ={rest}"
            elif name.lower() in POSITION_KEYS:
                continue
        lines.append(raw)
    return "\n".join(lines)


def read_host_position(config_dir: object) -> HostPosition | None:
    """Read the host position from the RNS config (SPEC RP1/RP2).

    Keys count only under the name RNS reads (:func:`_rns_spelled_keys`).

    Parameters:
        config_dir: The RNS config directory, as passed to RNS.

    Returns:
        The position, or ``None`` when the config sets none or an invalid one.
    """
    text = rns_config_text(config_dir)
    entries = (
        None
        if text is None
        else rnode_block_entries(_rns_spelled_keys(text), POSITION_KEYS)
    )
    position, problem = parse_host_position(entries)
    _log_outcome(position, problem)
    return position


def node_position(position: HostPosition, report_time: int) -> dict:
    """Return the node record's ``position`` mapping (SPEC RP3/RP4).

    Parameters:
        position: The host position.
        report_time: Unix seconds of the report; becomes ``time``.

    Returns:
        ``{latitude, longitude, altitude?, time, locationSource}``.
    """
    mapping: dict = {
        "latitude": position.latitude,
        "longitude": position.longitude,
        "time": report_time,
        "locationSource": LOCATION_SOURCE,
    }
    if position.altitude is not None:
        mapping["altitude"] = position.altitude
    return mapping


def position_row(node_id: str, position: HostPosition, report_time: int) -> dict:
    """Build the host's ``POST /api/positions`` payload (SPEC RP5).

    The id is a stable 53-bit hash of the node and the report time, so a row
    posted twice within one second is stored once.

    Parameters:
        node_id: The registered host node id.
        position: The host position.
        report_time: Unix seconds of the report.

    Returns:
        Positions payload, enriched with the configured radio metadata.
    """
    digest = hashlib.sha256(f"reticulum:{node_id}:{report_time}".encode()).digest()
    row = {
        "id": int.from_bytes(digest[:7], "big") & _ROW_ID_MASK,
        "rx_time": report_time,
        "rx_iso": _iso(report_time),
        "node_id": node_id,
        "node_num": node_num_from_id(node_id),
        "from_id": node_id,
        "latitude": position.latitude,
        "longitude": position.longitude,
        "position_time": report_time,
        "location_source": LOCATION_SOURCE,
        "ingestor": node_id,
        "protocol": "reticulum",
    }
    if position.altitude is not None:
        row["altitude"] = position.altitude
    return _apply_radio_metadata(row)


def _host_and_position(iface: object) -> tuple[str | None, HostPosition | None]:
    """Return the registered host id and the position read at connect.

    Parameters:
        iface: The active Reticulum interface, which holds ``host_position``.

    Returns:
        ``(host_id, position)``, either of which may be ``None``.
    """
    return handlers.host_node_id(), getattr(iface, "host_position", None)


def with_host_position(
    items: list[tuple[str, dict]],
    iface: object,
    bare_record: Callable[[str, int], dict],
    *,
    report_time: int | None = None,
) -> list[tuple[str, dict]]:
    """Put the host position on every record of the host (SPEC RP4/RP6).

    Only a record keyed on the registered host id gains ``position``; peer
    records pass through untouched.  When no record carries the host id --
    Docker's default volume announces nothing, so the host has no destination
    -- one bare host record is appended to carry the position.

    Parameters:
        items: ``(node_id, node)`` pairs about to be upserted.
        iface: The active Reticulum interface, which holds the position read
            at connect; ``None`` or no position leaves *items* as they are.
        bare_record: Builds the host's record when no item carries it, from the
            host id and the report time.
        report_time: Unix seconds of the report; defaults to now.

    Returns:
        A new list when the host is positioned; *items* and its node dicts are
        never modified.
    """
    host_id, position = _host_and_position(iface)
    if position is None or not host_id:
        return items
    now = int(time.time()) if report_time is None else int(report_time)
    if not any(node_id == host_id for node_id, _node in items):
        items = [*items, (host_id, bare_record(host_id, now))]
    mapping = node_position(position, now)
    return [
        (node_id, {**node, "position": mapping} if node_id == host_id else node)
        for node_id, node in items
    ]


def report_host_position(
    items: list[tuple[str, dict]],
    iface: object,
    bare_record: Callable[[str, int], dict],
) -> list[tuple[str, dict]]:
    """Position the host's records for a report and post its row (SPEC RP5).

    The row is queued before the daemon upserts the returned records.  Should
    it reach the web app first on the host's very first report, the web app
    creates the node row from it, and the record that follows completes it.

    Parameters:
        items: The report's ``(node_id, node)`` pairs.
        iface: As for :func:`with_host_position`.
        bare_record: As for :func:`with_host_position`.

    Returns:
        The records, positioned as :func:`with_host_position` does.
    """
    host_id, position = _host_and_position(iface)
    if position is None or not host_id:
        return items
    now = int(time.time())
    positioned = with_host_position(items, iface, bare_record, report_time=now)
    # The position class of every protocol (SPEC UR2, invariant IV).
    _queue._queue_post_json(
        "/api/positions",
        position_row(host_id, position, now),
        priority=_queue._POSITION_POST_PRIORITY,
    )
    return positioned


__all__ = [
    "HostPosition",
    "LOCATION_SOURCE",
    "POSITION_KEYS",
    "node_position",
    "parse_host_position",
    "position_row",
    "read_host_position",
    "report_host_position",
    "rnode_block_entries",
    "rns_config_text",
    "with_host_position",
]
