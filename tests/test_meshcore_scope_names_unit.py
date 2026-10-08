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
"""Unit tests for the MeshCore scope-name table (SPEC SC3, amended 2026-10-08; SN1).

Covers :mod:`data.mesh_ingestor.protocols.meshcore.scope_names`, the built-in
public hashtag region names a scoped flood is named by when the radio's
default flood scope does not reproduce its transport code, and the region
keys :mod:`data.mesh_ingestor.protocols.meshcore.route` derives from it once,
at import.  The resolution itself is tested in
``tests/test_meshcore_route_unit.py``.
"""

from __future__ import annotations

import re
import sys
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import meshcore_frames as frames  # noqa: E402 - pytest puts tests/ on sys.path

from data.mesh_ingestor.protocols.meshcore import route, scope_names  # noqa: E402

_NAME = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
"""Shape of a table name: lowercase ASCII letters and digits, in parts joined
by single ``-``."""

_GROUP_SHAPES = {
    "ISO_3166_1_ALPHA_2": r"[a-z]{2}",
    "ISO_3166_2_DE": r"de-[a-z]{2}",
    "ISO_3166_2_AT": r"at-[1-9]",
    "ISO_3166_2_CH": r"ch-[a-z]{2}",
}
"""ISO form of each group's codes, lowercased."""


def _firmware_name_char(byte: int) -> bool:
    """Return whether the firmware accepts *byte* in a region name.

    An independent copy of ``RegionMap::is_name_char``: ``-``, ``$``, ``#``,
    the digits, and every byte from ``A`` up.

    Parameters:
        byte: One byte of a UTF-8 region name.

    Returns:
        ``True`` when ``RegionMap::putRegion`` would accept the byte.
    """
    return byte in b"-$#" or 0x30 <= byte <= 0x39 or byte >= 0x41


def test_table_holds_its_groups():
    """306 names: 249 ISO 3166-1 alpha-2 codes, ``eu``, 16 + 9 + 26
    subdivisions, then 5 German community regions."""
    assert len(scope_names.ISO_3166_1_ALPHA_2) == 249
    assert len(scope_names.ISO_3166_2_DE) == 16
    assert len(scope_names.ISO_3166_2_AT) == 9
    assert len(scope_names.ISO_3166_2_CH) == 26
    assert len(scope_names.DE_COMMUNITY_REGIONS) == 5
    assert scope_names.SCOPE_NAMES == (
        scope_names.ISO_3166_1_ALPHA_2
        + ("eu",)
        + scope_names.ISO_3166_2_DE
        + scope_names.ISO_3166_2_AT
        + scope_names.ISO_3166_2_CH
        + scope_names.DE_COMMUNITY_REGIONS
    )
    assert len(scope_names.SCOPE_NAMES) == 306


def test_table_entries_are_unique():
    """No name is listed twice, so a code never counts one region twice."""
    counts = Counter(scope_names.SCOPE_NAMES)
    assert [name for name, count in counts.items() if count > 1] == []


def test_table_entries_are_lowercase_and_well_formed():
    """Each name is stored as listed: lowercase, no ``#``, 1-30 bytes, only
    firmware name characters, never ``*`` or a private ``$`` region."""
    bad = [
        name
        for name in scope_names.SCOPE_NAMES
        if not isinstance(name, str)
        or not _NAME.fullmatch(name)
        or route.scope_label(name) != name
        or route.region_key(name) is None
        or not 1 <= len(name.encode("utf-8")) <= 30
        or not all(_firmware_name_char(byte) for byte in name.encode("utf-8"))
    ]
    assert bad == []


def test_each_group_keeps_its_iso_form():
    """Alpha-2 codes are two letters; subdivisions read ``de-xx``, ``at-N``
    and ``ch-xx``; spot checks against ISO 3166 (iso-codes 4.20.1)."""
    for group, shape in _GROUP_SHAPES.items():
        names = getattr(scope_names, group)
        assert [name for name in names if not re.fullmatch(shape, name)] == [], group
    for name in ("de", "at", "ch", "gb", "us", "ss", "eu"):
        assert name in scope_names.SCOPE_NAMES, name
    for name in ("de-be", "de-by", "de-nw", "at-1", "at-9", "ch-ai", "ch-zh"):
        assert name in scope_names.SCOPE_NAMES, name


def test_table_lists_the_german_community_regions():
    """SN1: ``de-bebb`` (Berlin and Brandenburg), ``de-nord``, ``de-ost``,
    ``de-sued`` and ``de-west`` are listed; none is ISO 3166-2."""
    names = ("de-bebb", "de-nord", "de-ost", "de-sued", "de-west")
    assert [name for name in names if name not in scope_names.SCOPE_NAMES] == []
    assert scope_names.DE_COMMUNITY_REGIONS == names
    assert set(names).isdisjoint(scope_names.ISO_3166_2_DE)


def test_route_precomputes_each_region_key_at_import(monkeypatch):
    """``route.SCOPE_TABLE`` pairs each name, in table order, with
    ``SHA256("#" + name)[:16]``; a lookup derives no key of its own."""
    assert tuple(name for name, _key in route.SCOPE_TABLE) == scope_names.SCOPE_NAMES
    assert [n for n, key in route.SCOPE_TABLE if key != frames.region_key(n)] == []
    derived: list = []
    real_region_key = route.region_key
    monkeypatch.setattr(
        route,
        "region_key",
        lambda name: derived.append(name) or real_region_key(name),
    )
    # ``0000`` is a reserved code no key produces, so every name is tried.
    copy = route.RxCopy(
        msg_hash=1,
        hops=1,
        route_type=0,
        path=None,
        rssi=None,
        code0=b"\x00\x00",
        payload=b"pp",
        seen_at=0.0,
    )
    assert route.resolve_scope(copy, None) == "?"
    assert derived == [None]
