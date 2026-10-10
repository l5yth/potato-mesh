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
"""MeshCore contact uploads: one POST per contact per connect (SPEC CU1-CU3).

A connect lists the radio's contacts: the library raises ``NEXT_CONTACT`` for
each one and then ``CONTACTS`` for the whole listing (``reader.py:136-163``).
The listing posts each contact once, ``NEXT_CONTACT`` updates the roster
only, and once the listing has posted the daemon's snapshot carries the self
node only.  A listing that never ends leaves the roster to the snapshot, and
a re-fetch that never ends leaves its contacts to the next re-fetch.

The real ``_run_meshcore`` runs the real ``MeshCore`` class over a fake link
(:mod:`meshcore_frames`).  :class:`Radio` keeps a contact table and answers
``CMD_GET_CONTACTS`` as the firmware does; the library's own
``ensure_contacts`` and ``get_contacts`` fetch it through the real reader and
dispatcher, and the library's own auto-update fetches it again on an advert.
The real ingestor handlers run, and the real ``daemon._try_send_snapshot``
runs with the real ``MeshcoreProvider`` as soon as the runner signals
readiness, as the daemon's first pass does.  Only ``queue._queue_post_json``
is captured.
"""

from __future__ import annotations

import asyncio
import collections
import sys
import threading
import time
import types
from pathlib import Path

import meshcore
import pytest
from meshcore.commands.contact import ContactCommands

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import meshcore_frames as frames  # noqa: E402 - pytest puts tests/ on sys.path
from daemon_fakes import make_state  # noqa: E402 - pytest puts tests/ on sys.path

import data.mesh_ingestor.channels as _channels  # noqa: E402
import data.mesh_ingestor.config as config  # noqa: E402
import data.mesh_ingestor.daemon as daemon  # noqa: E402
import data.mesh_ingestor.handlers as handlers  # noqa: E402
import data.mesh_ingestor.ingestors as ingestors  # noqa: E402
import data.mesh_ingestor.protocols.meshcore as _mod  # noqa: E402
import data.mesh_ingestor.queue as queue  # noqa: E402
from data.mesh_ingestor.handlers import _state  # noqa: E402
from data.mesh_ingestor.protocols.meshcore import advert_replay  # noqa: E402
from data.mesh_ingestor.protocols.meshcore import runner as _runner  # noqa: E402
from data.mesh_ingestor.protocols.meshcore import (  # noqa: E402
    MeshcoreProvider,
    _MeshcoreInterface,
    _make_event_handlers,
)

ADVERTISED = frames.SENDER_TS
"""Newest advert time on the radio's clock; the roster advertised before it."""

HOST_KEY = bytes([0x5E, 0x1F]) + bytes(range(30))
"""The host radio's public key."""

HOST_ID = "!5e1f0001"
"""The host radio's node id: the first four bytes of :data:`HOST_KEY`."""

STRANGER_KEY = bytes([0xD0, 0x0D]) + bytes(range(30))
"""A key the radio hears adverts from but did not add to its roster."""

LOST_END_WAIT = 1.0
"""Seconds the library waits for a ``CONTACT_END`` that never comes: short
for a test, long enough that a stalled test machine still delivers every
contact of the answer first."""


def contact_key(index: int) -> bytes:
    """Return the public key of roster contact *index*.

    Parameters:
        index: The contact's place in :func:`roster`.

    Returns:
        A 32-byte key whose node id, its first four bytes, is unique per index.
    """
    return bytes([0xC0 + (index >> 8), index & 0xFF]) + bytes(range(30))


def node_id(key: bytes) -> str:
    """Return the canonical node id of a public key (its first four bytes).

    Parameters:
        key: A 32-byte public key.

    Returns:
        ``!`` followed by the first four bytes in hex.
    """
    return "!" + key[:4].hex()


def roster(count: int) -> dict[bytes, dict]:
    """Return *count* positioned contacts as the radio stores them.

    Parameters:
        count: Number of contacts.

    Returns:
        Public key to the :func:`meshcore_frames.contact_frame` fields of each
        contact, contact 0 the most recently advertised.
    """
    return {
        contact_key(i): {
            "name": f"Contact {i}",
            "last_advert": ADVERTISED - 600 - i,
            "lat_e6": 52_500_000 + i,
            "lon_e6": 13_400_000 + i,
        }
        for i in range(count)
    }


class Radio:
    """The firmware's side of the companion link: a contact table.

    It answers ``CMD_GET_CONTACTS`` the way ``MyMesh.cpp`` does:
    ``CONTACT_START``, each contact modified after the asked ``since``, then
    ``CONTACT_END`` with the newest ``lastmod`` it listed, ``0`` for none.
    With :attr:`end_lost` set the answer loses its ``CONTACT_END`` frame, as
    a serial or BLE link can.

    Attributes:
        contacts: Public key to the contact's
            :func:`meshcore_frames.contact_frame` fields.
        end_lost: Whether answers lose their ``CONTACT_END`` frame.
        fetch_timeout: Seconds the library waits for each frame of an answer.
        fetches: The ``since`` of every ``CMD_GET_CONTACTS``, in order.
    """

    def __init__(self, contacts: dict[bytes, dict], *, end_lost: bool = False):
        """Hold the contact table.

        Parameters:
            contacts: Initial contact table, as :func:`roster` returns it.
            end_lost: Initial :attr:`end_lost`.
        """
        self.contacts = contacts
        self.end_lost = end_lost
        self.fetch_timeout = 5.0
        self.fetches: list[int] = []
        self._answers: set[asyncio.Task] = set()

    def answer(self, mc, since: int) -> None:
        """Answer one ``CMD_GET_CONTACTS`` once the command has left.

        Parameters:
            mc: The ``MeshCore`` instance whose reader the answer reaches.
            since: The ``lastmod`` the command asked with.
        """
        self.fetches.append(since)
        listed = {
            key: fields
            for key, fields in self.contacts.items()
            if fields["last_advert"] > since
        }
        answer = frames.contacts_listing(
            [frames.contact_frame(key, **fields) for key, fields in listed.items()],
            lastmod=max((f["last_advert"] for f in listed.values()), default=0),
        )
        if self.end_lost:
            answer = answer[:-1]
        task = asyncio.get_running_loop().create_task(self._send(mc, answer))
        self._answers.add(task)
        task.add_done_callback(self._answers.discard)

    @staticmethod
    async def _send(mc, answer: list[bytes]) -> None:
        """Hand the answer to the reader after the fetch subscribed to it.

        Parameters:
            mc: The ``MeshCore`` instance whose reader the answer reaches.
            answer: The frames of the answer, in order.
        """
        await asyncio.sleep(0)
        for raw in answer:
            await mc._reader.handle_rx(bytearray(raw))


class RadioCommands(frames.QuietCommands):
    """Companion commands of a link to a :class:`Radio`.

    ``get_contacts`` is the library's own fetch (``ContactCommands``): it
    sends the command, then waits for ``NEXT_CONTACT`` frames until
    ``CONTACTS`` or a timeout.  Every other command answers ``ERROR`` at once.
    """

    def __init__(self, mc, radio: Radio) -> None:
        """Wire the library's fetch to *radio*.

        Parameters:
            mc: The ``MeshCore`` instance the commands belong to.
            radio: The radio answering ``CMD_GET_CONTACTS``.
        """
        super().__init__()
        self.dispatcher = mc.dispatcher
        self._mc = mc
        self._radio = radio

    async def get_contacts(self, lastmod: int = 0, timeout: float | None = None):
        """Fetch the contacts changed since *lastmod* with the library's code.

        Parameters:
            lastmod: The ``since`` to ask with.
            timeout: Seconds to wait per frame; the radio's when ``None``.

        Returns:
            The library's result: the ``CONTACTS`` event, or ``ERROR``.
        """
        wait = self._radio.fetch_timeout if timeout is None else timeout
        return await ContactCommands.get_contacts(self, lastmod, wait)

    async def get_contacts_async(self, lastmod: int = 0) -> None:
        """Send ``CMD_GET_CONTACTS``; the radio answers on the link.

        Parameters:
            lastmod: The ``since`` to ask with.
        """
        self._radio.answer(self._mc, lastmod)


def radio_meshcore(radio: Radio) -> type:
    """Return the real ``MeshCore`` class linked to *radio*.

    Parameters:
        radio: The radio at the other end of the link.

    Returns:
        A ``meshcore.MeshCore`` subclass taking the runner's ``cx`` argument.
    """

    class RadioMeshCore(frames.offline_meshcore()):
        """The real ``MeshCore``, its contact fetch answered by *radio*."""

        # The library's own fetch, not the offline stand-in that skips it.
        ensure_contacts = meshcore.MeshCore.ensure_contacts

        def __init__(self, cx) -> None:
            """Build the instance over the fake link.

            Parameters:
                cx: The runner's connection; replaced by a fake.
            """
            super().__init__(cx)
            self.commands = RadioCommands(self, radio)

        async def connect(self):
            """Answer the handshake with the host radio's ``SELF_INFO``.

            Returns:
                A non-``None`` result.
            """
            await self.dispatcher.start()
            await self._reader.handle_rx(
                bytearray(frames.self_info_frame(HOST_KEY, "Host"))
            )
            await frames.settle(self)
            return "ok"

        async def disconnect(self):
            """Stop the dispatcher."""
            await self.dispatcher.stop()

    return RadioMeshCore


async def _idle_poll(_mc, _iface) -> None:
    """Stand in for the telemetry poll loop, which needs a radio."""


@pytest.fixture
def posts(monkeypatch):
    """Capture every queued POST; quiet logs; an offline link and no polls.

    The host radio's ``SELF_INFO`` sets process-wide state (the host node id,
    the radio settings, the heartbeat), which is put back afterwards.

    Returns:
        A list that collects ``(path, payload)`` for each queued POST.
    """
    sent: list = []
    monkeypatch.setattr(
        queue,
        "_queue_post_json",
        lambda path, payload, **_kwargs: sent.append((path, payload)),
    )
    monkeypatch.setattr(config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(config, "PROTOCOL", "meshcore")
    monkeypatch.setattr(config, "LORA_FREQ", None)
    monkeypatch.setattr(config, "MODEM_PRESET", None)
    for name in (
        "_host_node_id",
        "_host_telemetry_last_rx",
        "_host_nodeinfo_last_seen",
        "_last_packet_monotonic",
    ):
        monkeypatch.setattr(_state, name, getattr(_state, name))
    for name in ("node_id", "last_heartbeat"):
        monkeypatch.setattr(ingestors.STATE, name, getattr(ingestors.STATE, name))
    monkeypatch.setattr(
        _runner, "_make_connection", lambda *_a, **_k: frames.FakeConnection()
    )
    monkeypatch.setattr(_runner, "_telemetry_poll_loop", _idle_poll)
    monkeypatch.setattr(_channels, "_CHANNEL_LOOKUP", {})
    return sent


def connect(monkeypatch, radio: Radio, posts: list, after=None):
    """Run one connection: the runner until ready, the snapshot, then *after*.

    The snapshot is taken the moment the runner signals readiness, which is
    when ``MeshcoreProvider.connect`` returns to the daemon.

    Parameters:
        monkeypatch: pytest fixture.
        radio: The radio the connection links to.
        posts: The list the ``posts`` fixture returned.
        after: Optional coroutine function taking the ``MeshCore`` instance,
            run once the snapshot is taken; the dispatcher settles after it.

    Returns:
        A namespace: ``iface``; ``ready``, ``snapshot`` and ``after``, the
        number of POSTs queued by the end of each stage; and ``latched``,
        whether the snapshot latched ``initial_snapshot_sent``.
    """
    monkeypatch.setattr(_mod, "MeshCore", radio_meshcore(radio))
    iface = _MeshcoreInterface(target=None)
    marks: dict = {"iface": iface}

    async def run() -> None:
        """Drive the runner, take the snapshot, run *after*, then stop."""
        connected = threading.Event()
        holder: list = [None]
        task = asyncio.create_task(
            _mod._run_meshcore(iface, "/dev/ttyUSB0", connected, holder)
        )
        deadline = time.monotonic() + 30
        while not connected.is_set():
            assert time.monotonic() < deadline, "the runner never signalled readiness"
            await asyncio.sleep(0)
        marks["ready"] = len(posts)
        state = make_state(provider=MeshcoreProvider(), iface=iface)
        daemon._try_send_snapshot(state)
        marks["snapshot"] = len(posts)
        marks["latched"] = state.initial_snapshot_sent
        if after is not None:
            await after(iface._mc)
            await frames.settle(iface._mc)
        marks["after"] = len(posts)
        iface._stop_event.set()
        await task
        assert holder[0] is None

    asyncio.run(run())
    return types.SimpleNamespace(**marks)


def node_posts(entries) -> collections.Counter:
    """Count the ``/api/nodes`` POSTs per node id.

    Parameters:
        entries: Captured ``(path, payload)`` pairs.

    Returns:
        Node id to the number of node POSTs carrying it.
    """
    return collections.Counter(
        key
        for path, payload in entries
        if path == "/api/nodes"
        for key in payload
        if key.startswith("!")
    )


def position_posts(entries) -> collections.Counter:
    """Count the ``/api/positions`` POSTs per node id.

    Parameters:
        entries: Captured ``(path, payload)`` pairs.

    Returns:
        Node id to the number of position POSTs for it.
    """
    return collections.Counter(
        payload["node_id"] for path, payload in entries if path == "/api/positions"
    )


def per_contact(counter: collections.Counter, contacts) -> collections.Counter:
    """Tally how many contacts posted how often.

    Parameters:
        counter: :func:`node_posts` or :func:`position_posts` of some POSTs.
        contacts: The contacts' node ids.

    Returns:
        POSTs per contact to the number of contacts that posted that often:
        ``{1: n}`` when each of *n* contacts posted once.
    """
    return collections.Counter(counter[contact] for contact in contacts)


def contact_ids(radio: Radio) -> set[str]:
    """Return the node ids of every contact in the radio's table.

    Parameters:
        radio: The radio.

    Returns:
        The contacts' node ids.
    """
    return {node_id(key) for key in radio.contacts}


@pytest.mark.parametrize("count", [1, 50, 300])
def test_a_connect_posts_each_contact_once(monkeypatch, posts, count):
    """One connect lists the roster: each contact posts one node and one
    position before the runner signals readiness, ``NEXT_CONTACT`` adds
    nothing, and the daemon's snapshot that follows carries the self node
    only (SPEC CU1, CU2)."""
    radio = Radio(roster(count))
    session = connect(monkeypatch, radio, posts)
    contacts = contact_ids(radio)

    connected = posts[: session.snapshot]
    assert (
        per_contact(node_posts(connected), contacts),
        per_contact(position_posts(connected), contacts),
    ) == ({1: count}, {1: count})
    ready = posts[: session.ready]
    assert per_contact(node_posts(ready), contacts) == {1: count}
    assert node_posts(posts[session.ready : session.snapshot]) == {HOST_ID: 1}
    assert session.latched
    assert radio.fetches == [0]


CONTACT_0_KEY = "c000000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d"
"""Roster contact 0's public key in hex."""

EXPECTED_NODE = {
    "!c0000001": {
        "lastHeard": ADVERTISED - 600,
        "protocol": "meshcore",
        "user": {
            "longName": "Contact 0",
            "shortName": "c000",
            "publicKey": CONTACT_0_KEY,
            "role": "COMPANION",
        },
        "position": {"latitude": 52.5, "longitude": 13.4, "time": ADVERTISED - 600},
        "lora_freq": 869.525,
        "modem_preset": "SF11/BW250/CR5",
    },
    "ingestor": HOST_ID,
    "protocol": "meshcore",
}
"""The node POST of roster contact 0, as the roster sync posted it before CU1."""

EXPECTED_POSITION = {
    "id": 2304137395364417870,
    "rx_time": ADVERTISED - 600,
    "rx_iso": "2026-10-06T09:36:40Z",
    "node_id": "!c0000001",
    "node_num": 0xC0000001,
    "from_id": "!c0000001",
    "latitude": 52.5,
    "longitude": 13.4,
    "position_time": ADVERTISED - 600,
    "ingestor": HOST_ID,
    "protocol": "meshcore",
    "public_key": CONTACT_0_KEY,
    "lora_freq": 869.525,
    "modem_preset": "SF11/BW250/CR5",
}
"""The position POST of roster contact 0, as the roster sync posted it before CU1."""


def test_a_listed_contact_posts_its_record_once(monkeypatch, posts):
    """A listed contact's node and position POSTs carry the fields, stamps,
    position and name the roster sync posted before, each in one POST
    (SPEC CU1, RS1)."""
    radio = Radio(roster(1))
    connect(monkeypatch, radio, posts)
    contact = node_id(contact_key(0))

    nodes = [p for path, p in posts if path == "/api/nodes" and contact in p]
    positions = [
        p for path, p in posts if path == "/api/positions" and p["node_id"] == contact
    ]
    assert nodes == [EXPECTED_NODE]
    assert positions == [EXPECTED_POSITION]


def test_the_snapshot_posts_the_roster_when_the_listing_never_ends(monkeypatch, posts):
    """A listing that loses its ``CONTACT_END`` raises ``NEXT_CONTACT`` for
    each contact but no ``CONTACTS``: no contact posts before readiness, and
    the daemon's snapshot posts each contact once, its position inline.  The
    library asks for the whole roster again on the next advert, and that
    listing posts each contact once more with its position (SPEC CU2)."""
    radio = Radio(roster(3), end_lost=True)
    radio.fetch_timeout = LOST_END_WAIT
    contacts = contact_ids(radio)

    async def advert_after_the_link_recovered(mc) -> None:
        """Hear an advert once the link delivers whole answers again."""
        radio.end_lost = False
        await mc._reader.handle_rx(bytearray(frames.advert_push(contact_key(0))))

    session = connect(monkeypatch, radio, posts, after=advert_after_the_link_recovered)

    ready = posts[: session.ready]
    assert per_contact(node_posts(ready), contacts) == {0: 3}
    assert per_contact(position_posts(ready), contacts) == {0: 3}
    snapshot = posts[session.ready : session.snapshot]
    assert node_posts(snapshot) == dict.fromkeys(contacts | {HOST_ID}, 1)
    assert position_posts(snapshot) == {}
    inline = {
        key: payload[key]["position"]["latitude"]
        for path, payload in snapshot
        for key in payload
        if key in contacts
    }
    assert inline == {node_id(contact_key(i)): (52_500_000 + i) / 1e6 for i in range(3)}
    later = posts[session.snapshot : session.after]
    assert per_contact(node_posts(later), contacts) == {1: 3}
    assert per_contact(position_posts(later), contacts) == {1: 3}
    assert radio.fetches == [0, 0]


def test_a_re_fetch_that_never_ends_posts_with_the_next_one(monkeypatch, posts):
    """An auto-update re-fetch that loses its ``CONTACT_END`` posts nothing:
    its ``NEXT_CONTACT`` updates the roster only, and the snapshot has run.
    The library advances its ``lastmod`` only on a whole listing, so the
    next advert's re-fetch asks with the same ``since`` and posts the
    contact once, with its new advert time (SPEC CU2)."""
    radio = Radio(roster(5))
    radio.fetch_timeout = LOST_END_WAIT
    contact = node_id(contact_key(0))
    marks: list = []

    async def re_advert_over_a_lossy_link(mc) -> None:
        """Let contact 0 advert anew twice, the first answer losing its end."""
        radio.contacts[contact_key(0)].update(
            last_advert=ADVERTISED, lat_e6=52_500_100, lon_e6=13_400_100
        )
        radio.end_lost = True
        await mc._reader.handle_rx(bytearray(frames.advert_push(contact_key(0))))
        await frames.settle(mc)
        marks.append(len(posts))
        radio.end_lost = False
        await mc._reader.handle_rx(bytearray(frames.advert_push(contact_key(0))))

    session = connect(monkeypatch, radio, posts, after=re_advert_over_a_lossy_link)

    assert posts[session.snapshot : marks[0]] == []
    later = posts[marks[0] : session.after]
    assert node_posts(later) == {contact: 1}
    assert position_posts(later) == {contact: 1}
    ((_path, node),) = [entry for entry in later if entry[0] == "/api/nodes"]
    assert node[contact]["lastHeard"] == ADVERTISED
    assert radio.fetches == [0, ADVERTISED - 600, ADVERTISED - 600]


def test_a_reconnect_posts_the_roster_again(monkeypatch, posts):
    """Contacts are present after every connect (issue #788, #789): a
    reconnect builds a new interface whose first listing is the whole roster
    again, which posts each contact once before readiness and fills the
    roster that resolves chat senders; the snapshot carries the self node
    only (SPEC CU2)."""
    radio = Radio(roster(5))
    contacts = contact_ids(radio)
    first = connect(monkeypatch, radio, posts)
    first_posts = list(posts)
    posts.clear()
    second = connect(monkeypatch, radio, posts)

    assert second.iface is not first.iface
    for session, entries in ((first, first_posts), (second, posts)):
        ready = entries[: session.ready]
        assert per_contact(node_posts(ready), contacts) == {1: 5}
        assert per_contact(position_posts(ready), contacts) == {1: 5}
        assert node_posts(entries[session.ready : session.snapshot]) == {HOST_ID: 1}
    assert {nid for nid, _node in second.iface.contacts_snapshot()} == contacts
    assert second.iface.lookup_node_id_by_name("Contact 3") == node_id(contact_key(3))
    assert radio.fetches == [0, 0]


def test_a_known_contacts_re_advert_posts_once(monkeypatch, posts):
    """A roster contact re-adverts: the radio updates it and pushes
    ``ADVERTISEMENT``, the library fetches the contacts changed since its
    last listing, and that listing posts the contact once, with its new
    advert time and position (SPEC CU3)."""
    radio = Radio(roster(5))
    contact = node_id(contact_key(0))

    async def re_advert(mc) -> None:
        """Let contact 0 advert anew, as the radio reports it."""
        radio.contacts[contact_key(0)].update(
            last_advert=ADVERTISED, lat_e6=52_500_100, lon_e6=13_400_100
        )
        await mc._reader.handle_rx(bytearray(frames.advert_push(contact_key(0))))

    session = connect(monkeypatch, radio, posts, after=re_advert)

    later = posts[session.snapshot : session.after]
    assert node_posts(later) == {contact: 1}
    assert position_posts(later) == {contact: 1}
    ((_path, node),) = [entry for entry in later if entry[0] == "/api/nodes"]
    ((_path, position),) = [entry for entry in later if entry[0] == "/api/positions"]
    assert node[contact]["lastHeard"] == ADVERTISED
    assert (position["latitude"], position["position_time"]) == (52.5001, ADVERTISED)
    assert radio.fetches == [0, ADVERTISED - 600]


def test_a_new_contact_push_posts_once_per_advert(monkeypatch, posts):
    """The radio pushes ``NEW_CONTACT`` for an advert from a key it did not
    add.  Each such advert posts the node and its position once, also when
    an earlier push put the key in the ingestor's roster (SPEC CU3)."""
    radio = Radio(roster(2))
    stranger = node_id(STRANGER_KEY)
    marks: list = []

    async def two_adverts(mc) -> None:
        """Push two ``NEW_CONTACT`` adverts from the stranger, a minute apart."""
        for advert, lat_e6 in ((ADVERTISED - 60, 48_100_000), (ADVERTISED, 48_100_100)):
            push = frames.contact_frame(
                STRANGER_KEY,
                "Stranger",
                last_advert=advert,
                lat_e6=lat_e6,
                lon_e6=11_500_000,
                code=frames.PUSH_CODE_NEW_ADVERT,
            )
            await mc._reader.handle_rx(bytearray(push))
            await frames.settle(mc)
            marks.append(len(posts))

    session = connect(monkeypatch, radio, posts, after=two_adverts)

    first = posts[session.snapshot : marks[0]]
    second = posts[marks[0] : marks[1]]
    for advert in (first, second):
        assert node_posts(advert) == {stranger: 1}
        assert position_posts(advert) == {stranger: 1}
    assert [p["position_time"] for _path, p in second if "position_time" in p] == [
        ADVERTISED
    ]
    assert radio.fetches == [0]


def test_next_contact_updates_the_roster_and_posts_nothing(monkeypatch, posts):
    """``NEXT_CONTACT`` puts the contact in the roster that resolves chat
    senders, raises its replay-memory timestamp (SPEC SG5) and advances the
    reconnect clock, and posts nothing (SPEC CU1)."""
    key = contact_key(0).hex()
    advert_replay._take_roster_listing({key: ADVERTISED - 600}, full=True)
    activity: list = []
    monkeypatch.setattr(handlers, "_mark_packet_activity", lambda: activity.append(1))
    iface = _MeshcoreInterface(target=None)
    hmap = _make_event_handlers(iface, "/dev/ttyUSB0")
    contact = {"public_key": key, "adv_name": "Contact 0", "last_advert": ADVERTISED}

    asyncio.run(hmap["NEXT_CONTACT"](types.SimpleNamespace(payload=contact)))

    assert posts == []
    assert iface.lookup_node_id_by_name("Contact 0") == node_id(contact_key(0))
    assert advert_replay._roster[key] == ADVERTISED
    assert activity == [1]


def test_a_listing_that_fails_to_post_leaves_the_roster_to_the_snapshot(
    monkeypatch, posts
):
    """The roster counts as posted only once the first listing has posted:
    if posting it raises, the snapshot still carries the contacts and the
    next listing is still taken as the whole roster (SPEC CU2, SG5)."""
    iface = _MeshcoreInterface(target=None)
    iface._self_info_payload = {"public_key": HOST_KEY.hex(), "name": "Host"}
    hmap = _make_event_handlers(iface, "/dev/ttyUSB0")
    key = contact_key(0).hex()
    listing = types.SimpleNamespace(
        payload={key: {"public_key": key, "adv_name": "Contact 0", "last_advert": 1}}
    )

    def refuse(*_args, **_kwargs):
        """Fail the POST, as a broken queue would."""
        raise RuntimeError("queue unavailable")

    monkeypatch.setattr(queue, "_queue_post_json", refuse)
    with pytest.raises(RuntimeError):
        asyncio.run(hmap["CONTACTS"](listing))
    snapshot = MeshcoreProvider().node_snapshot_items(iface)
    assert {nid for nid, _node in snapshot} == {node_id(contact_key(0)), HOST_ID}

    monkeypatch.setattr(queue, "_queue_post_json", lambda *_a, **_k: None)
    advert_replay._take_roster_listing({contact_key(1).hex(): 1}, full=True)
    asyncio.run(hmap["CONTACTS"](listing))
    assert set(advert_replay._roster) == {key}
    snapshot = MeshcoreProvider().node_snapshot_items(iface)
    assert [nid for nid, _node in snapshot] == [HOST_ID]
