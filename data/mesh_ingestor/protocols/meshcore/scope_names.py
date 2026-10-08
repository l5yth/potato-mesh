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

"""Built-in public hashtag region names that can name a MeshCore flood scope.

SPEC SC3 (amended 2026-10-08).  A scoped flood carries
``transport_codes[0]``, a 16-bit HMAC keyed by its region, and the companion
firmware has no command that lists regions, so the ingestor can name a region
only by recomputing that code for a candidate name
(:func:`.route.resolve_scope`).  The radio's own default flood scope is tried
first and wins whenever it reproduces the code.  Otherwise the names below
are tried, and one is stored only when it is the only name that reproduces
the code; no match, or several, stores ``?``.

Every entry is a public hashtag region as :func:`.route.scope_label`
publishes it: lowercase, without its ``#``.  Its key is
``SHA256("#" + name)[:16]`` (``RegionMap::getTransportKeysFor``), derived
once, at import, into :data:`.route.SCOPE_TABLE`.  The groups:

* :data:`ISO_3166_1_ALPHA_2`: every officially assigned ISO 3166-1 alpha-2
  country code (249);
* :data:`EU`: ``eu``, exceptionally reserved in ISO 3166-1 for the European
  Union and therefore not in the group above;
* :data:`ISO_3166_2_DE`, :data:`ISO_3166_2_AT` and :data:`ISO_3166_2_CH`: the
  ISO 3166-2 codes of the German Länder (16), the Austrian states (9) and the
  Swiss cantons (26).

The codes are those of Debian ``iso-codes`` 4.20.1 (``iso_3166-1.json`` and
``iso_3166-2.json``); its alpha-2 list equals tzdata's ``iso3166.tab``,
current as of ISO/TC 46 N1127 (2024-02-29).

**Extending the table.**

1. Add the name to the lines of its group, or add a group tuple and join it
   into :data:`SCOPE_NAMES`.  A name is lowercase ASCII letters and digits,
   in parts joined by single ``-``, without the ``#``, at most 30 bytes,
   never ``*`` or a private ``$`` name, and listed once.
   ``tests/test_meshcore_scope_names_unit.py`` checks these rules and the
   group sizes; update its counts.
2. Each name costs one HMAC per scoped channel message, and each raises the
   chance that a flood scoped to a region the table does not list reads a
   wrong name: with N names, about N in 65,536 such messages.  Restate N
   wherever it is quoted when it changes: SPEC SC3 and SC6, ACCEPTANCE SC-A3
   and SC-A8, and the ``scope`` field of ``CONTRACTS.md``.
"""

from __future__ import annotations

ISO_3166_1_ALPHA_2: tuple[str, ...] = tuple("""
    ad ae af ag ai al am ao aq ar as at au aw ax az
    ba bb bd be bf bg bh bi bj bl bm bn bo bq br bs bt bv bw by bz
    ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz
    de dj dk dm do dz
    ec ee eg eh er es et
    fi fj fk fm fo fr
    ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy
    hk hm hn hr ht hu
    id ie il im in io iq ir is it
    je jm jo jp
    ke kg kh ki km kn kp kr kw ky kz
    la lb lc li lk lr ls lt lu lv ly
    ma mc md me mf mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz
    na nc ne nf ng ni nl no np nr nu nz
    om
    pa pe pf pg ph pk pl pm pn pr ps pt pw py
    qa
    re ro rs ru rw
    sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st sv sx sy sz
    tc td tf tg th tj tk tl tm tn to tr tt tv tw tz
    ua ug um us uy uz
    va vc ve vg vi vn vu
    wf ws
    ye yt
    za zm zw
    """.split())
"""Every officially assigned ISO 3166-1 alpha-2 country code, lowercase (249)."""

EU: tuple[str, ...] = ("eu",)
"""The European Union, ``EU`` being exceptionally reserved in ISO 3166-1."""

ISO_3166_2_DE: tuple[str, ...] = tuple("""
    de-bb de-be de-bw de-by de-hb de-he de-hh de-mv
    de-ni de-nw de-rp de-sh de-sl de-sn de-st de-th
    """.split())
"""ISO 3166-2:DE, the 16 Länder (``de-be`` Berlin, ``de-by`` Bayern, ...)."""

ISO_3166_2_AT: tuple[str, ...] = tuple(
    "at-1 at-2 at-3 at-4 at-5 at-6 at-7 at-8 at-9".split()
)
"""ISO 3166-2:AT, the 9 states (``at-1`` Burgenland to ``at-9`` Wien)."""

ISO_3166_2_CH: tuple[str, ...] = tuple("""
    ch-ag ch-ai ch-ar ch-be ch-bl ch-bs ch-fr ch-ge ch-gl
    ch-gr ch-ju ch-lu ch-ne ch-nw ch-ow ch-sg ch-sh ch-so
    ch-sz ch-tg ch-ti ch-ur ch-vd ch-vs ch-zg ch-zh
    """.split())
"""ISO 3166-2:CH, the 26 cantons (``ch-zh`` Zürich, ``ch-ge`` Genève, ...)."""

SCOPE_NAMES: tuple[str, ...] = (
    ISO_3166_1_ALPHA_2 + EU + ISO_3166_2_DE + ISO_3166_2_AT + ISO_3166_2_CH
)
"""Every built-in name, in the order :data:`.route.SCOPE_TABLE` keeps (301)."""

__all__ = [
    "EU",
    "ISO_3166_1_ALPHA_2",
    "ISO_3166_2_AT",
    "ISO_3166_2_CH",
    "ISO_3166_2_DE",
    "SCOPE_NAMES",
]
