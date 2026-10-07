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

"""Refuse a MeshCore RX-log advert that is not newer than the last one accepted.

The firmware's roster refuses an advert whose signed timestamp is not newer
than the last one it accepted from that contact (``BaseChatMesh::onAdvertRecv``,
``src/helpers/BaseChatMesh.cpp:124``).  The RX log carries every received
copy of every advert, replays included, so the ingestor applies the same rule
to it (SPEC SG5): per process and per public key it remembers the newest
signed timestamp it accepted, or that the radio's roster reported as a
contact's ``last_advert``, and posts an RX-log advert only when the advert's
own signed timestamp is strictly newer.  A replay, and the same advert heard
again over another path, post nothing.

The memory has two pools.  The roster pool mirrors the radio's roster, and
only the radio's ``CONTACTS`` listings change who is in it
(:func:`_take_roster_listing`): the first listing of a connection is the whole
roster and replaces the membership, and a later listing (the library's
auto-update re-fetch, which asks only for contacts changed since the newest
``lastmod`` it saw) adds the contacts it names.  ``NEW_CONTACT`` and
``NEXT_CONTACT`` only raise a member's timestamp (:func:`_raise_roster_advert`):
the radio pushes ``NEW_CONTACT`` for an advert from a key it did not add, so a
flood of new keys never enters the roster pool through it; a key the radio
auto-adds enters through the next listing, as a spare the cap evicts first.
Every other key sits in the
RX-log pool of :data:`_REPLAY_MEMORY_CAP` keys, which forgets the least
recently accepted first.

Limits: a key the radio adds between listings is protected once the next
listing names it, and if auto-add lets the radio's own roster be flooded, the
protection is the radio's: a key stays protected while it is in the radio's
roster.  A restart empties both pools until the connection's first listing
refills the roster pool; after that only a key known solely from the RX log
passes its first advert again.
"""

from __future__ import annotations

import threading
from collections import OrderedDict

_REPLAY_MEMORY_CAP = 4096
"""Most keys the RX-log pool remembers, least recently accepted forgotten
first.

More than ten times the largest companion roster (``MAX_CONTACTS=350`` in the
firmware's variants), at about 860 KiB when full."""

_ROSTER_MEMORY_CAP = 1024
"""Backstop cap on the roster pool, which the radio's own table bounds.

About three times the largest companion roster.  Past it the pool hands the
least recently refreshed key that the latest full listing lacks to the RX-log
pool; it never evicts a key of the latest full listing."""

_heard: OrderedDict[str, int] = OrderedDict()
"""Newest accepted signed timestamp per lowercase hex key outside the radio's
roster, least recently accepted first."""

_roster: OrderedDict[str, int] = OrderedDict()
"""Newest signed timestamp per lowercase hex key of the radio's roster, least
recently refreshed first."""

_listed: set[str] = set()
"""Keys of the latest full listing: the ones :data:`_ROSTER_MEMORY_CAP` never
evicts."""

_lock = threading.Lock()
"""Serialises the memory: a reconnect starts a new MeshCore event-loop thread
while the old one may still be finishing its last events."""


def _store(
    pool: OrderedDict[str, int], cap: int, pub_key_hex: str, timestamp: int
) -> None:
    """Store *timestamp* as the newest for *pub_key_hex* in *pool*, cap it.

    The caller holds :data:`_lock`.

    Parameters:
        pool: :data:`_heard` or :data:`_roster`.
        cap: Most keys *pool* keeps; the least recent beyond it are forgotten.
        pub_key_hex: Lowercase hex public key, made the most recent.
        timestamp: Signed advert timestamp to remember.
    """
    pool[pub_key_hex] = timestamp
    pool.move_to_end(pub_key_hex)
    while len(pool) > cap:
        pool.popitem(last=False)


def _leave_roster(pub_key_hex: str) -> None:
    """Move a key out of the roster pool into the RX-log pool, timestamp kept.

    It becomes an ordinary RX-log-pool entry, as if just accepted, so a
    replay of its last advert is still refused until that pool forgets it.
    The caller holds :data:`_lock`.

    Parameters:
        pub_key_hex: A key of :data:`_roster`.
    """
    _store(_heard, _REPLAY_MEMORY_CAP, pub_key_hex, _roster.pop(pub_key_hex))


def _accept_advert_timestamp(pub_key_hex: str, timestamp: int) -> bool:
    """Accept a verified RX-log advert's timestamp when it is strictly newer.

    Call it only for an advert whose signature holds, so that no forged
    timestamp is ever remembered: a forged far-future one would otherwise
    lock the genuine node out.  The key stays in the pool it is in.

    Parameters:
        pub_key_hex: The advert's public key as lowercase hex (``adv_key``).
        timestamp: The advert's signed sender-side timestamp.

    Returns:
        ``True`` when the timestamp is newer than any remembered for the key,
        which then becomes the newest; ``False`` for a replay or a repeat.
    """
    with _lock:
        if pub_key_hex in _roster:
            pool, cap = _roster, _ROSTER_MEMORY_CAP
        else:
            pool, cap = _heard, _REPLAY_MEMORY_CAP
        newest = pool.get(pub_key_hex)
        if newest is not None and timestamp <= newest:
            return False
        _store(pool, cap, pub_key_hex, timestamp)
        return True


def _take_roster_listing(last_adverts: dict[str, object], *, full: bool) -> None:
    """Make the roster pool follow one ``CONTACTS`` listing from the radio.

    The firmware verified the advert each listed contact carries, and its
    ``last_advert`` is that advert's signed sender-side timestamp
    (``ContactInfo::last_advert_timestamp``), the clock RX-log adverts carry.
    Each listed key joins or stays in the roster pool with the newest of its
    ``last_advert`` and what was remembered for it, never lowered.

    A full listing (*full*: the first of a connection, asked with ``since = 0``)
    is the whole roster: its keys replace the membership, and a member it
    lacks leaves for the RX-log pool (:func:`_leave_roster`).  A later listing
    (the auto-update re-fetch) names only contacts changed since the newest
    ``lastmod`` the library saw, so a member it lacks is unchanged and stays.

    Parameters:
        last_adverts: Each listed contact's hex public key and ``last_advert``;
            a contact whose ``last_advert`` is not an ``int`` is skipped.
        full: Whether the listing is the radio's whole roster.
    """
    listed = {
        key.lower(): stamp
        for key, stamp in last_adverts.items()
        if isinstance(stamp, int)
    }
    with _lock:
        if full:
            for key in [key for key in _roster if key not in listed]:
                _leave_roster(key)
            _listed.clear()
            _listed.update(listed)
        for key, stamp in listed.items():
            newest = max(stamp, _roster.get(key, stamp), _heard.pop(key, stamp))
            _roster[key] = newest
            _roster.move_to_end(key)
        # The radio's table bounds the pool; the cap only backs it up, and it
        # never evicts a key of the latest full listing.
        spare = [key for key in _roster if key not in _listed]
        while len(_roster) > _ROSTER_MEMORY_CAP and spare:
            _leave_roster(spare.pop(0))


def _raise_roster_advert(pub_key_hex: str, last_advert: object) -> None:
    """Raise a roster member's timestamp to a contact event's ``last_advert``.

    ``NEW_CONTACT`` and ``NEXT_CONTACT`` call this.  It never adds a key: the
    radio pushes ``NEW_CONTACT`` for an advert from a key it did not add to
    its roster (``BaseChatMesh::onAdvertRecv``, ``MyMesh::onDiscoveredContact``),
    so only a ``CONTACTS`` listing makes a key a member.

    Parameters:
        pub_key_hex: The contact's public key as hex.
        last_advert: The contact's ``last_advert``; anything but an ``int`` is
            ignored, as is a value not newer than the remembered one.
    """
    if not isinstance(last_advert, int):
        return
    key = pub_key_hex.lower()
    with _lock:
        if key in _roster and last_advert > _roster[key]:
            _roster[key] = last_advert
            _roster.move_to_end(key)


def _reset_replay_memory() -> None:
    """Forget every remembered timestamp and the roster, as a restart does.

    Provided for test isolation.
    """
    with _lock:
        _heard.clear()
        _roster.clear()
        _listed.clear()
