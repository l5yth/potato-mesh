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
"""Regression guard: the Meshtastic node-list snapshot posts ``lastHeard``
inside the web app's read windows when the radio's clock is wrong (SPEC RK4).

The snapshot posts each nodeDB entry's ``lastHeard``, stamped by the radio's
clock.  The field host's radio (meshtasticd, no RTC) ran 97 days slow, so a
node it heard 10 minutes ago was posted 97 days old: outside the 7-day
``GET /api/nodes`` window and the 28-day per-id window, and stored as the
node's ``first_heard`` for good.  The radio stamps its own entry with its
clock's reading while it sends the nodeDB at connect, so the snapshot reads
the offset there and posts every entry with the age the radio's clock gives
it, counted from the host clock.

The nodeDB is loaded through the pinned meshtastic library's
``_handleFromRadio`` the way a radio sends it, and
``daemon._try_send_snapshot`` runs with the real :class:`MeshtasticProvider`.
The host clock is frozen; only the HTTP queue is replaced.  The cases after
the regression guard pin the rule: the 1-hour tolerance in both directions,
the skip of entries from an earlier boot, the snapshot without a clock
reading, another node's entry under the host id, a ``lastHeard`` at or
shifted to 0 or below, the radio's uptime telling an earlier boot's entries
apart, one warning per snapshot, and the library's dicts left as they were.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:  # pragma: no cover - conftest adds it
    sys.path.insert(0, str(REPO_ROOT))

from meshtastic.protobuf import mesh_pb2  # noqa: E402

import data.mesh_ingestor.config as config  # noqa: E402
import data.mesh_ingestor.daemon as daemon  # noqa: E402
import data.mesh_ingestor.handlers as handlers  # noqa: E402
import data.mesh_ingestor.handlers.receive_time as receive_time  # noqa: E402
from daemon_fakes import make_state  # noqa: E402 - shared daemon doubles
from data.mesh_ingestor.protocols.meshtastic import MeshtasticProvider  # noqa: E402
from data.mesh_ingestor.serialization import _iso  # noqa: E402
from test_channel_scope_unit import (  # noqa: E402,F401 - shared fixtures
    SECONDARY,
    SENDER,
    SENDER_ID,
    _node_info_frame,
    _snapshot,
    radio,
    scope,
)

DAY = 86_400
"""Seconds in a day."""

HOST_NOW = 1_791_460_800
"""Ingestor host clock for every case: 2026-10-08T12:00:00Z."""

RADIO_OFFSET = -97 * DAY
"""The field radio's clock minus the host clock: 97 days slow (-8380800 s)."""

RADIO_NOW = HOST_NOW + RADIO_OFFSET
"""The field radio's clock reading at connect: 2026-07-03T12:00:00Z."""

TOLERANCE = 60 * 60
"""SPEC RK2's tolerance in seconds, which the snapshot reuses (RK4)."""

HOST_NUM = 0x0D15EA5E
"""Node number of the ingestor's own radio."""

HOST_ID = "!0d15ea5e"
"""Canonical id of :data:`HOST_NUM`, as ``daemon._try_connect`` registers it."""

PREV_BOOT_NUM = 0x0B007B00
"""Node last heard during the radio's previous boot."""

PREV_BOOT_ID = "!0b007b00"
"""Canonical id of :data:`PREV_BOOT_NUM`."""

IMPOSTOR_NUM = 0x0BADBEEF
"""Node whose NodeInfo names :data:`HOST_ID`, so the library files its entry
under the host id (SPEC NI1)."""

AHEAD_NUM = 0x0FA57000
"""Node a fast clock stamped 61 minutes ahead of the host clock."""

AHEAD_ID = "!0fa57000"
"""Canonical id of :data:`AHEAD_NUM`."""

FAST_OFFSET = HOST_NOW
"""A radio clock ahead of the host clock by as long as the host clock is past
1970: shifted by it, an entry stamped at the host clock would post at 0."""

FIELD_HOST_NOW = 1_791_455_465
"""The field host's clock at its snapshot with the uptime read:
2026-10-08T10:31:05Z."""

FIELD_READING = 1_783_067_010
"""The field radio's own ``lastHeard`` at that snapshot, its clock's reading."""

FIELD_OFFSET = FIELD_READING - FIELD_HOST_NOW
"""The field radio's clock minus the host clock: -8388455 s, 97.1 days slow."""

FIELD_UPTIME = 343_965
"""The field radio's own ``deviceMetrics.uptimeSeconds``: up 3.98 days."""

FIELD_BOOT_START = FIELD_READING - FIELD_UPTIME
"""When the field radio's boot started, by its own clock: 1782723045."""

OLD_BOOT_NUM = 0x0B00701D
"""Node last heard during an earlier boot, before the field radio's boot."""

OLD_BOOT_ID = "!0b00701d"
"""Canonical id of :data:`OLD_BOOT_NUM`."""

OLD_BOOT_LAST_HEARD = FIELD_HOST_NOW - 120 * DAY
"""Heard 120 days ago by an earlier boot's right clock: 1781087465, more than
an hour before :data:`FIELD_BOOT_START`."""

REMOTE_LAST_HEARD = RADIO_NOW - 600
""":data:`SENDER` heard 10 minutes ago, stamped by the field radio's clock."""

PREV_BOOT_LAST_HEARD = HOST_NOW - 5 * DAY - 4_294_967
"""Heard 5 days ago during the previous boot, whose clock ran 2^32 ms behind.

That is 42.3 days after the field radio's reading: no single shift fits both
boots, and shifted by this boot's offset it would lie 42 days in the future.
"""

BULK_WINDOW = 7 * DAY
"""Floor of ``GET /api/nodes``: a node last heard earlier is not listed."""

FIELD_WARNING = {
    "message": "Radio clock is off; posting snapshot lastHeard shifted to the "
    "ingestor clock",
    "severity": "warn",
    "offset_secs": -8_380_800,
    "shifted": 2,
    "skipped": 1,
}
"""The one warning the field snapshot logs: own entry and :data:`SENDER`
shifted, the previous-boot entry skipped."""

FIELD_UPTIME_WARNING = {
    **FIELD_WARNING,
    "offset_secs": -8_388_455,
    "unshifted": 1,
}
"""The one warning of the field host's snapshot with the uptime read: own
entry and :data:`SENDER` shifted, the previous-boot entry skipped, and the
entry from before the boot posted as stamped."""


@pytest.fixture
def host_now():
    """Start the shared ``host_clock`` fixture (``tests/conftest.py``) at
    :data:`HOST_NOW`, where every case keeps it."""

    return HOST_NOW


@pytest.fixture
def snapshot_log(monkeypatch):
    """Capture the daemon's snapshot log lines instead of printing them.

    Returns:
        A list that collects each ``daemon.snapshot`` line's message,
        severity and metadata.
    """

    lines: list[dict] = []

    def record(message, *, context=None, severity="debug", **metadata):
        """Keep the snapshot lines and drop every other log line."""

        if context == "daemon.snapshot":
            lines.append({"message": message, "severity": severity, **metadata})

    monkeypatch.setattr(config, "_debug_log", record)
    return lines


def _load_node_db(
    radio,
    own_last_heard: int | None,
    entries: dict[int, int],
    *,
    register_host: bool = True,
    own_uptime: int = 0,
) -> None:
    """Send ``radio`` its nodeDB the way a radio sends it at connect.

    Parameters:
        radio: The ``radio`` fixture's namespace.
        own_last_heard: ``lastHeard`` of the radio's own entry, its clock's
            reading.  ``0`` sends the entry without one; ``None`` sends
            neither ``my_info`` nor the entry.
        entries: ``lastHeard`` of each other entry, by node number.
        register_host: Register the host id afterwards, as
            ``daemon._try_connect`` does right before the snapshot.
        own_uptime: ``deviceMetrics.uptimeSeconds`` of the own entry, the
            radio's uptime; ``0`` sends no device metrics.
    """

    iface = radio.iface
    if own_last_heard is not None:
        my_info = mesh_pb2.MyNodeInfo(my_node_num=HOST_NUM)
        iface._handleFromRadio(mesh_pb2.FromRadio(my_info=my_info).SerializeToString())
        iface._handleFromRadio(
            _node_info_frame(
                HOST_NUM, last_heard=own_last_heard, uptime_seconds=own_uptime
            )
        )
    for num, last_heard in entries.items():
        iface._handleFromRadio(_node_info_frame(num, last_heard=last_heard))
    if register_host:
        handlers.register_host_node_id(HOST_ID)


def _load_field_host(radio, host_clock, entries: dict[int, int]) -> None:
    """Set the field host's clock and send its radio's nodeDB (SPEC RK4).

    The own entry reads :data:`FIELD_READING` and carries
    :data:`FIELD_UPTIME`.

    Parameters:
        radio: The ``radio`` fixture's namespace.
        host_clock: The shared ``host_clock`` fixture, moved to
            :data:`FIELD_HOST_NOW`.
        entries: ``lastHeard`` of each other entry, by node number.
    """

    host_clock.now = FIELD_HOST_NOW
    _load_node_db(radio, FIELD_READING, entries, own_uptime=FIELD_UPTIME)


@pytest.fixture
def field(radio, host_clock):
    """The field host's radio at connect, its clock 97 days slow.

    Its nodeDB holds its own entry, stamped with the clock's reading, a node it
    heard 10 minutes ago and one heard during the previous boot.  The own
    entry's stamp is read in meshtastic/firmware master: ``PhoneAPI.cpp``
    ``STATE_SEND_MY_INFO`` calls ``refreshLocalMeshNode``, which sets its
    ``last_heard`` to the radio's clock.  On the field host it read
    :data:`FIELD_READING` against the host clock :data:`FIELD_HOST_NOW`.
    """

    _load_node_db(
        radio,
        RADIO_NOW,
        {SENDER: REMOTE_LAST_HEARD, PREV_BOOT_NUM: PREV_BOOT_LAST_HEARD},
    )
    return radio


def _warnings(lines: list[dict]) -> list[dict]:
    """Return the ``warn`` lines of a :func:`snapshot_log` capture."""

    return [line for line in lines if line["severity"] == "warn"]


def _skipped(lines: list[dict]) -> dict[str, str]:
    """Return the reason of each entry a :func:`snapshot_log` capture skipped."""

    return {
        line["node_id"]: line["reason"] for line in lines if line["severity"] == "debug"
    }


def _file_impostor_under_host_id(radio, last_heard: int) -> None:
    """Send :data:`IMPOSTOR_NUM`'s entry, which names the host id (SPEC NI1).

    The library files it under :data:`HOST_ID`, replacing the radio's own
    entry there; ``getMyNodeInfo`` still finds the own entry by number.

    Parameters:
        radio: The ``radio`` fixture's namespace.
        last_heard: The impostor's ``lastHeard``.
    """

    radio.iface._handleFromRadio(
        _node_info_frame(IMPOSTOR_NUM, last_heard=last_heard, user_id=HOST_ID)
    )


# ---------------------------------------------------------------------------
# Regression guard: the field case
# ---------------------------------------------------------------------------


def test_snapshot_last_heard_lands_inside_bulk_window(field):
    """A node the radio heard 10 minutes ago is posted inside the 7-day
    ``/api/nodes`` window, 10 minutes old by the host clock."""

    posted = _snapshot(field)[SENDER_ID]["lastHeard"]

    assert HOST_NOW - BULK_WINDOW <= posted <= HOST_NOW, (
        f"snapshot lastHeard {posted} ({_iso(posted)}) is the radio clock, "
        f"{(HOST_NOW - posted) / DAY:.0f} days behind the ingestor clock "
        f"({_iso(HOST_NOW)}); GET /api/nodes does not list it (7-day bulk and "
        "28-day per-id windows)"
    )
    assert posted == HOST_NOW - 600


def test_own_entry_is_posted_at_the_host_clock(field):
    """The radio's own entry, its clock's reading, is posted as the host clock."""

    assert _snapshot(field)[HOST_ID]["lastHeard"] == HOST_NOW


def test_entry_from_an_earlier_boot_is_skipped_as_clock_epoch(field, snapshot_log):
    """An entry stamped more than an hour after the radio's reading was stamped
    during an earlier boot: it is skipped with reason ``clock-epoch``."""

    upserts = _snapshot(field)

    assert set(upserts) == {HOST_ID, SENDER_ID}
    skipped = [line for line in snapshot_log if line["severity"] == "debug"]
    assert skipped == [
        {
            "message": "Skipped snapshot node",
            "severity": "debug",
            "node_id": PREV_BOOT_ID,
            "reason": "clock-epoch",
        }
    ]


def test_one_warning_per_snapshot(field, snapshot_log):
    """Each snapshot logs one warning with the offset and both counts; the
    counts start again with the next connection's snapshot, which reuses the
    provider."""

    state = make_state(provider=MeshtasticProvider(), iface=field.iface)

    assert daemon._try_send_snapshot(state) is True
    assert daemon._try_send_snapshot(state) is True

    assert _warnings(snapshot_log) == [FIELD_WARNING, FIELD_WARNING]


def test_library_dicts_keep_the_radio_clock(field):
    """The shift is made on copies: the library's nodeDB keeps the radio's times."""

    nodes = field.iface.nodes
    library_entry = nodes[SENDER_ID]

    upserts = _snapshot(field)

    assert upserts[SENDER_ID]["lastHeard"] == HOST_NOW - 600
    assert nodes[SENDER_ID] is library_entry
    assert library_entry["lastHeard"] == REMOTE_LAST_HEARD
    assert nodes[HOST_ID]["lastHeard"] == RADIO_NOW
    assert nodes[PREV_BOOT_ID]["lastHeard"] == PREV_BOOT_LAST_HEARD
    assert field.iface.getMyNodeInfo() is nodes[HOST_ID]


# ---------------------------------------------------------------------------
# The rule: tolerance, earlier boots, no reading
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("minutes", "shifted"),
    [(-61, True), (-60, False), (-59, False), (59, False), (60, False), (61, True)],
)
def test_radio_clock_offset_boundaries(
    radio, host_clock, snapshot_log, minutes, shifted
):
    """A radio clock 59 or exactly 60 minutes off the host clock, behind or
    ahead, leaves the entries as stamped; 61 minutes off shifts them by the
    offset, with one warning."""

    reading = HOST_NOW + minutes * 60
    _load_node_db(radio, reading, {SENDER: reading - 600})

    posted = _snapshot(radio)[SENDER_ID]["lastHeard"]

    assert posted == (HOST_NOW - 600 if shifted else reading - 600)
    expected = [{**FIELD_WARNING, "offset_secs": minutes * 60, "skipped": 0}]
    assert _warnings(snapshot_log) == (expected if shifted else [])


@pytest.mark.parametrize(("minutes", "posted"), [(59, True), (60, True), (61, False)])
def test_entry_ahead_of_the_radio_reading_boundaries(
    radio, host_clock, minutes, posted
):
    """An entry stamped up to 60 minutes after the radio's reading is posted,
    shifted; one 61 minutes after is skipped."""

    stamp = RADIO_NOW + minutes * 60
    _load_node_db(radio, RADIO_NOW, {SENDER: stamp})

    upserts = _snapshot(radio)

    if posted:
        assert upserts[SENDER_ID]["lastHeard"] == stamp - RADIO_OFFSET
    else:
        assert SENDER_ID not in upserts


@pytest.mark.parametrize(("shifted", "posted"), [(1, True), (0, False), (-1, False)])
def test_entry_shifted_to_zero_or_below_is_skipped(
    radio, host_clock, snapshot_log, shifted, posted
):
    """An entry the shift would post at 0 or below, 1970 or before by the host
    clock, was stamped by another clock than this boot's: it is skipped as
    ``clock-epoch`` and counted in the warning.  One the shift posts at 1 is
    posted."""

    _load_node_db(radio, HOST_NOW + FAST_OFFSET, {SENDER: FAST_OFFSET + shifted})

    upserts = _snapshot(radio)

    if posted:
        assert upserts[SENDER_ID]["lastHeard"] == shifted
    else:
        assert _skipped(snapshot_log) == {SENDER_ID: "clock-epoch"}
    expected = {
        **FIELD_WARNING,
        "offset_secs": FAST_OFFSET,
        "shifted": 2 if posted else 1,
        "skipped": 0 if posted else 1,
    }
    assert _warnings(snapshot_log) == [expected]


@pytest.mark.parametrize(
    "own_last_heard", [0, None], ids=["own entry without lastHeard", "no own entry"]
)
def test_without_a_reading_entries_post_as_stamped(
    radio, host_clock, snapshot_log, own_last_heard
):
    """Without a clock reading from the own entry, entries are posted as
    stamped, a radio clock 97 days slow included, and nothing is logged."""

    _load_node_db(radio, own_last_heard, {SENDER: REMOTE_LAST_HEARD})

    upserts = _snapshot(radio)

    assert upserts[SENDER_ID]["lastHeard"] == REMOTE_LAST_HEARD
    assert snapshot_log == []


@pytest.mark.parametrize(("minutes", "posted"), [(59, True), (60, True), (61, False)])
def test_without_a_reading_an_entry_ahead_of_the_host_clock(
    radio, host_clock, snapshot_log, minutes, posted
):
    """Without a clock reading, an entry stamped up to 60 minutes ahead of the
    host clock is posted as stamped; one 61 minutes ahead is skipped as
    ``clock-epoch``, without a warning."""

    stamp = HOST_NOW + minutes * 60
    _load_node_db(radio, 0, {SENDER: stamp})

    upserts = _snapshot(radio)

    if posted:
        assert upserts[SENDER_ID]["lastHeard"] == stamp
    else:
        assert SENDER_ID not in upserts
        assert snapshot_log[0]["reason"] == "clock-epoch"
    assert _warnings(snapshot_log) == []


def test_within_the_tolerance_every_entry_posts_as_stamped(radio, host_clock):
    """A radio clock within the tolerance changes nothing: an entry two hours
    ahead of its reading is posted as stamped, as before RK4."""

    reading = HOST_NOW + 30 * 60
    _load_node_db(radio, reading, {SENDER: reading + 2 * TOLERANCE})

    assert _snapshot(radio)[SENDER_ID]["lastHeard"] == reading + 2 * TOLERANCE


def test_reading_falls_back_to_get_my_node_info(radio, host_clock):
    """Before the host id is registered, the library's ``getMyNodeInfo`` finds
    the own entry by the radio's node number."""

    _load_node_db(radio, RADIO_NOW, {SENDER: REMOTE_LAST_HEARD}, register_host=False)

    assert _snapshot(radio)[SENDER_ID]["lastHeard"] == HOST_NOW - 600


def test_mismatched_own_entry_falls_back_to_get_my_node_info(
    radio, host_clock, snapshot_log
):
    """Another node's entry filed under the host id (SPEC NI1) carries that
    node's time, not the radio's clock: the reading comes from
    ``getMyNodeInfo``.  With the radio's clock right, a node heard 10 minutes
    ago and one 61 minutes ahead of the host clock post as stamped, and
    nothing is shifted."""

    _load_node_db(
        radio, HOST_NOW, {SENDER: HOST_NOW - 600, AHEAD_NUM: HOST_NOW + 61 * 60}
    )
    _file_impostor_under_host_id(radio, HOST_NOW - 3 * DAY)

    upserts = _snapshot(radio)

    assert _skipped(snapshot_log) == {HOST_ID: "num-mismatch"}
    assert upserts[SENDER_ID]["lastHeard"] == HOST_NOW - 600
    assert upserts[AHEAD_ID]["lastHeard"] == HOST_NOW + 61 * 60
    assert _warnings(snapshot_log) == []


def test_mismatched_own_entry_without_a_fallback_gives_no_reading(
    radio, host_clock, snapshot_log
):
    """Another node's entry under the host id, and no own entry for
    ``getMyNodeInfo`` to find, give no clock reading: a node heard 10 minutes
    ago posts as stamped, one 61 minutes ahead of the host clock is skipped
    as ``clock-epoch``, and no warning is logged."""

    _load_node_db(radio, None, {SENDER: HOST_NOW - 600, AHEAD_NUM: HOST_NOW + 61 * 60})
    _file_impostor_under_host_id(radio, HOST_NOW - 3 * DAY)

    upserts = _snapshot(radio)

    assert _skipped(snapshot_log) == {
        HOST_ID: "num-mismatch",
        AHEAD_ID: "clock-epoch",
    }
    assert upserts[SENDER_ID]["lastHeard"] == HOST_NOW - 600
    assert _warnings(snapshot_log) == []


def test_mismatched_own_entry_without_get_my_node_info_gives_no_reading(
    scope, host_clock
):
    """An interface without ``getMyNodeInfo`` leaves another node's entry
    under the host id unread: there is no reading, so a node heard 10 minutes
    ago is neither skipped by the impostor's time nor shifted."""

    handlers.register_host_node_id(HOST_ID)
    impostor = {"num": IMPOSTOR_NUM, "lastHeard": HOST_NOW - 3 * DAY}
    recent = {"num": SENDER, "lastHeard": HOST_NOW - 600}
    provider = MeshtasticProvider()

    provider.node_snapshot_items(
        SimpleNamespace(nodes={HOST_ID: impostor, SENDER_ID: recent})
    )

    assert provider.snapshot_filter_reason(HOST_ID, impostor) == "num-mismatch"
    assert provider.snapshot_filter_reason(SENDER_ID, recent) is None
    assert provider.snapshot_entry(SENDER_ID, recent) is recent
    assert provider.snapshot_clock_warning is None


def _no_node_info():
    """A ``getMyNodeInfo`` that fails the way a nodeDB mutated mid-read does."""

    raise RuntimeError("dictionary changed size during iteration")


class _ItemsOnly:
    """A nodes object that is no mapping: it offers ``items()`` only."""

    def items(self):
        """Return the one entry, stamped 61 minutes ahead of the host clock."""

        return [(SENDER_ID, {"num": SENDER, "lastHeard": HOST_NOW + 61 * 60})]


@pytest.mark.parametrize(
    "make_iface",
    [
        lambda: SimpleNamespace(
            nodes=dict(_ItemsOnly().items()), getMyNodeInfo=_no_node_info
        ),
        lambda: SimpleNamespace(nodes=_ItemsOnly()),
    ],
    ids=["getMyNodeInfo raises", "nodes without get"],
)
def test_unreadable_own_entry_counts_as_no_reading(scope, host_clock, make_iface):
    """A failing ``getMyNodeInfo``, or a nodes object without ``get`` and an
    interface without ``getMyNodeInfo``, gives no clock reading: the snapshot
    still runs, with the host-clock guard."""

    handlers.register_host_node_id(HOST_ID)
    provider = MeshtasticProvider()

    ((node_id, node),) = provider.node_snapshot_items(make_iface())

    assert provider.snapshot_filter_reason(node_id, node) == "clock-epoch"
    assert provider.snapshot_entry(node_id, node) is node
    assert provider.snapshot_clock_warning is None


def test_channel_filter_reason_wins_over_clock_epoch(field, snapshot_log):
    """An entry from an earlier boot heard on a hidden channel is skipped as
    ``hidden-channel``; the warning counts only the ``clock-epoch`` skips."""

    field.apply("hidden")
    field.iface._handleFromRadio(
        _node_info_frame(0x0E0E0E0E, channel=SECONDARY, last_heard=PREV_BOOT_LAST_HEARD)
    )

    _snapshot(field)

    assert _skipped(snapshot_log) == {
        "!0e0e0e0e": "hidden-channel",
        PREV_BOOT_ID: "clock-epoch",
    }
    assert _warnings(snapshot_log) == [FIELD_WARNING]


# ---------------------------------------------------------------------------
# The radio's uptime: entries from before this boot
# ---------------------------------------------------------------------------


def test_field_host_posts_an_entry_older_than_the_boot_as_stamped(
    radio, host_clock, snapshot_log
):
    """The field host: its radio 8388455 s slow and up 343965 s.  A node
    heard 10 minutes ago this boot is shifted, one stamped after the reading
    is skipped, and one heard 120 days ago, before the boot started, is
    posted as stamped; one warning counts it as ``unshifted``, and the
    library's dicts keep their values."""

    _load_field_host(
        radio,
        host_clock,
        {
            SENDER: FIELD_READING - 600,
            PREV_BOOT_NUM: PREV_BOOT_LAST_HEARD,
            OLD_BOOT_NUM: OLD_BOOT_LAST_HEARD,
        },
    )
    nodes = radio.iface.nodes
    old_entry = nodes[OLD_BOOT_ID]

    upserts = _snapshot(radio)

    assert upserts[HOST_ID]["lastHeard"] == FIELD_HOST_NOW
    assert upserts[SENDER_ID]["lastHeard"] == FIELD_HOST_NOW - 600
    assert upserts[OLD_BOOT_ID]["lastHeard"] == OLD_BOOT_LAST_HEARD
    assert _skipped(snapshot_log) == {PREV_BOOT_ID: "clock-epoch"}
    assert _warnings(snapshot_log) == [FIELD_UPTIME_WARNING]
    assert nodes[OLD_BOOT_ID] is old_entry
    assert old_entry["lastHeard"] == OLD_BOOT_LAST_HEARD
    assert nodes[SENDER_ID]["lastHeard"] == FIELD_READING - 600
    assert nodes[HOST_ID]["lastHeard"] == FIELD_READING
    assert nodes[HOST_ID]["deviceMetrics"] == {"uptimeSeconds": FIELD_UPTIME}


@pytest.mark.parametrize(
    ("before_boot", "shifted"), [(TOLERANCE, True), (TOLERANCE + 1, False)]
)
def test_entry_before_the_boot_start_boundaries(
    radio, host_clock, snapshot_log, before_boot, shifted
):
    """An entry stamped exactly 1 hour before the boot started is shifted; one
    a second earlier is an earlier boot's, posted as stamped and counted as
    ``unshifted``."""

    stamp = FIELD_BOOT_START - before_boot
    _load_field_host(radio, host_clock, {SENDER: stamp})

    posted = _snapshot(radio)[SENDER_ID]["lastHeard"]

    assert posted == (stamp - FIELD_OFFSET if shifted else stamp)
    expected = {
        **FIELD_UPTIME_WARNING,
        "shifted": 2 if shifted else 1,
        "skipped": 0,
        "unshifted": 0 if shifted else 1,
    }
    assert _warnings(snapshot_log) == [expected]


@pytest.mark.parametrize(("minutes", "posted"), [(60, True), (61, False)])
def test_earlier_boot_entry_ahead_of_the_host_clock(
    radio, host_clock, snapshot_log, minutes, posted
):
    """With a radio clock 30 days fast and up 1 day, an entry from before its
    boot up to 60 minutes ahead of the host clock is posted as stamped; one
    61 minutes ahead is skipped as ``clock-epoch``, as without a reading."""

    stamp = HOST_NOW + minutes * 60
    _load_node_db(radio, HOST_NOW + 30 * DAY, {SENDER: stamp}, own_uptime=DAY)

    upserts = _snapshot(radio)

    if posted:
        assert upserts[SENDER_ID]["lastHeard"] == stamp
    else:
        assert _skipped(snapshot_log) == {SENDER_ID: "clock-epoch"}
    expected = {
        **FIELD_WARNING,
        "offset_secs": 30 * DAY,
        "shifted": 1,
        "skipped": 0 if posted else 1,
        "unshifted": 1 if posted else 0,
    }
    assert _warnings(snapshot_log) == [expected]


@pytest.mark.parametrize(
    "uptime",
    [None, 0, -5, "junk", True, float(FIELD_UPTIME)],
    ids=["absent", "zero", "negative", "junk", "bool", "float"],
)
def test_without_an_uptime_every_entry_is_shifted(
    radio, host_clock, snapshot_log, uptime
):
    """An uptime that is absent or no positive int counts as none: the entry
    from before the boot is shifted, as without the uptime, and the warning
    has no ``unshifted``."""

    _load_field_host(radio, host_clock, {OLD_BOOT_NUM: OLD_BOOT_LAST_HEARD})
    own = radio.iface.nodes[HOST_ID]
    if uptime is None:
        del own["deviceMetrics"]
    else:
        own["deviceMetrics"] = {"uptimeSeconds": uptime}

    posted = _snapshot(radio)[OLD_BOOT_ID]["lastHeard"]

    assert posted == OLD_BOOT_LAST_HEARD - FIELD_OFFSET
    expected = {**FIELD_WARNING, "offset_secs": FIELD_OFFSET, "skipped": 0}
    assert _warnings(snapshot_log) == [expected]


# ---------------------------------------------------------------------------
# Mechanics: the hooks, the daemon's per-node handling
# ---------------------------------------------------------------------------


class _MutatingEntry(dict):
    """A nodeDB entry the library's thread mutates while it is copied."""

    def keys(self):
        """Fail the way iterating a dict that changes size does."""

        raise RuntimeError("dictionary changed size during iteration")

    __iter__ = keys


def test_an_entry_failing_its_copy_costs_only_that_entry(
    scope, host_clock, snapshot_log
):
    """``snapshot_entry`` runs inside the per-node error handling: an entry
    that fails while it is copied is logged and skipped, the others are
    posted, the latch is set and the interface stays open."""

    iface = SimpleNamespace(
        nodes={
            HOST_ID: {"num": HOST_NUM, "lastHeard": RADIO_NOW},
            "!0000000a": _MutatingEntry(num=10, lastHeard=RADIO_NOW - 60),
            "!0000000b": {"num": 11, "lastHeard": RADIO_NOW - 120},
        }
    )
    handlers.register_host_node_id(HOST_ID)
    state = make_state(provider=MeshtasticProvider(), iface=iface)

    assert daemon._try_send_snapshot(state) is True

    assert state.iface is iface and state.initial_snapshot_sent is True
    posted = {
        node_id: entry["lastHeard"]
        for _path, body in scope.posts
        for node_id, entry in body.items()
        if node_id.startswith("!")
    }
    assert posted == {HOST_ID: HOST_NOW, "!0000000b": HOST_NOW - 120}
    failed = [line for line in _warnings(snapshot_log) if "node_id" in line]
    assert [line["node_id"] for line in failed] == ["!0000000a"]
    assert _warnings(snapshot_log)[-1] == {**FIELD_WARNING, "skipped": 0}


def test_hooks_leave_entries_alone_before_a_snapshot(scope):
    """A provider that has not read a snapshot's clock changes no entry."""

    provider = MeshtasticProvider()
    entry = {"num": SENDER, "lastHeard": HOST_NOW + 10 * DAY}

    assert provider.snapshot_entry(SENDER_ID, entry) is entry
    assert provider.snapshot_filter_reason(SENDER_ID, entry) is None
    assert provider.snapshot_clock_warning is None


def test_snapshot_entry_passes_entries_without_a_time(field):
    """With an offset kept, an entry without ``lastHeard`` and one that is not
    a mapping are returned as they are."""

    provider = MeshtasticProvider()
    provider.node_snapshot_items(field.iface)
    untimed = {"num": 5}
    opaque = SimpleNamespace(lastHeard=RADIO_NOW)

    assert provider.snapshot_filter_reason("!00000005", untimed) is None
    assert provider.snapshot_entry("!00000005", untimed) is untimed
    assert provider.snapshot_entry("!00000006", opaque) is opaque
    assert provider.snapshot_clock_warning == {
        "offset_secs": RADIO_OFFSET,
        "shifted": 0,
        "skipped": 0,
    }


@pytest.mark.parametrize("last_heard", [0, -5])
def test_last_heard_of_zero_or_below_posts_as_it_is(field, last_heard):
    """With an offset kept, a ``lastHeard`` of 0 or below counts as none: the
    entry is not skipped, and it is posted as it is, not shifted to
    ``lastHeard - offset`` (8380800 for 0)."""

    provider = MeshtasticProvider()
    provider.node_snapshot_items(field.iface)
    entry = {"num": 5, "lastHeard": last_heard}

    assert provider.snapshot_filter_reason("!00000005", entry) is None
    posted = provider.snapshot_entry("!00000005", entry)
    assert posted["lastHeard"] == last_heard
    assert posted is entry
    assert provider.snapshot_clock_warning == {
        "offset_secs": RADIO_OFFSET,
        "shifted": 0,
        "skipped": 0,
    }


def test_failed_node_list_read_reports_no_warning(field):
    """A snapshot whose node list cannot be read keeps no offset from the
    snapshot before it."""

    class _AlwaysMutating:
        """A nodes object whose iteration never settles."""

        def items(self):
            """Fail every attempt."""

            raise RuntimeError("dictionary changed size during iteration")

    provider = MeshtasticProvider()
    provider.node_snapshot_items(field.iface)
    assert provider.snapshot_clock_warning is not None

    assert provider.node_snapshot_items(SimpleNamespace(nodes=_AlwaysMutating())) == []
    assert provider.snapshot_clock_warning is None


# ---------------------------------------------------------------------------
# The pure offset helper
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("reading", "expected"),
    [
        (None, None),
        ("", None),
        ("junk", None),
        (0, None),
        (-5, None),
        (HOST_NOW - TOLERANCE, 0),
        (HOST_NOW + TOLERANCE, 0),
        (HOST_NOW - TOLERANCE - 1, -TOLERANCE - 1),
        (HOST_NOW + TOLERANCE + 1, TOLERANCE + 1),
        (str(RADIO_NOW), RADIO_OFFSET),
    ],
)
def test_radio_clock_offset(reading, expected):
    """``None`` for no clock reading, ``0`` within the tolerance (the bound
    included), else the reading minus the host clock."""

    assert receive_time.radio_clock_offset(reading, HOST_NOW) == expected
