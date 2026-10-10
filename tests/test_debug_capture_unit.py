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
"""Unit tests for the ``DEBUG=1`` ignored-packet capture (SPEC DC1-DC3).

With ``DEBUG=1`` the ingestor appends one line per dropped packet to
``ignored-meshtastic.txt`` (:mod:`data.mesh_ingestor.handlers.ignored`).  A
line holds the drop reason and the packet's metadata only: port, channel,
sender and recipient ids, packet id, receive time and payload size.  It
never holds the text, the payload, the meshtastic library's ``raw``
``MeshPacket``, other decoded content or a position's coordinates; the
review found every one of them there (M12), for hidden and filtered
channels, via_mqtt traffic and direct messages, MeshCore's included.  The
file rotates at 10 MB and keeps one previous file.

The Meshtastic cases hand real ``MeshPacket`` protobufs to the pinned
library through the ``radio`` fixture of ``tests/test_channel_scope_unit.py``
(SPEC CF8); the MeshCore cases run the real companion reader and event
handlers (``tests/meshcore_frames.py``).  Only the HTTP queue is replaced.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:  # pragma: no cover - conftest adds it
    sys.path.insert(0, str(REPO_ROOT))

import meshcore_frames as frames  # noqa: E402 - pytest puts tests/ on sys.path

import data.mesh_ingestor.channels as channels  # noqa: E402
import data.mesh_ingestor.config as config  # noqa: E402
import data.mesh_ingestor.handlers.ignored as ignored_mod  # noqa: E402
import data.mesh_ingestor.protocols.meshcore as meshcore_mod  # noqa: E402
from data.mesh_ingestor.protocols.meshcore import (  # noqa: E402
    _MeshcoreInterface,
    _make_event_handlers,
)
from test_channel_scope_unit import (  # noqa: E402,F401 - shared fixtures
    PRIMARY,
    SECONDARY,
    SENDER,
    SENDER_ID,
    _mesh_packet,
    _payload,
    radio,
    scope,
)

CAP = 10_000_000
"""The documented size, in bytes, at which the capture file rotates (DC2)."""

TEXT = _payload("TEXT_MESSAGE_APP").decode()
"""The text every Meshtastic probe message carries (CF8's ``_payload``)."""

DM_TEXT = "the door code is 4711"
"""Text of the MeshCore direct message."""

HOST_NUM = 0x0D15EA5E
"""Node number of the ingestor's own radio, the direct messages' recipient."""

HOST_ID = "!0d15ea5e"
"""Canonical id of :data:`HOST_NUM`."""

MESHCORE_KEY = "aabbccddee11" + "00" * 26
"""Public key of the MeshCore contact that sends the direct message."""

GATE_CASES = {
    "hidden-channel": ({"HIDDEN_CHANNELS": ("Secret",)}, SECONDARY, False),
    "disallowed-channel": ({"ALLOWED_CHANNELS": ("LongFast",)}, SECONDARY, False),
    "non-primary-channel": ({"PRIMARY_CHANNEL_ONLY": True}, SECONDARY, False),
    "via_mqtt": ({"DROP_VIA_MQTT": True}, PRIMARY, True),
}
"""Each CF2 gate reason, with the configuration and the reception it drops:
``(config overrides, channel index, via_mqtt)``."""

LISTED_PACKET = {
    "from": SENDER,
    "fromId": SENDER_ID,
    "to": 0xFFFFFFFF,
    "toId": "^all",
    "id": 77,
    "channel": SECONDARY,
    "rxTime": 1_791_000_000,
    "decoded": {"portnum": "TEXT_MESSAGE_APP", "payload": b"hello", "text": "hello"},
}
"""A library-shaped packet carrying a source for every listed field."""

LISTED_ENTRY = {
    "reason": "hidden-channel",
    "id": 77,
    "rx_time": 1_791_000_000,
    "from_id": SENDER_ID,
    "to_id": "^all",
    "channel": SECONDARY,
    "portnum": "TEXT_MESSAGE_APP",
    "payload_size": 5,
}
"""The line :data:`LISTED_PACKET` leaves, without its ``timestamp``."""

_RECORD = ignored_mod._record_ignored_packet
"""The production recorder, which the CF8 ``scope`` fixture replaces."""


@pytest.fixture
def capture(scope, monkeypatch, tmp_path):
    """Run the real recorder under ``DEBUG=1``, writing into ``tmp_path``.

    ``scope`` (neutral filters, POSTs recorded) replaces the recorder with a
    list of reasons; this puts the real one back.  The MeshCore capture is
    sent to ``tmp_path`` too, so no case writes beside the checkout.

    Returns:
        A namespace whose ``path`` is the capture file.
    """

    path = tmp_path / "ignored-meshtastic.txt"
    monkeypatch.setattr(ignored_mod, "_record_ignored_packet", _RECORD)
    monkeypatch.setattr(ignored_mod, "_IGNORED_PACKET_LOG_PATH", path)
    monkeypatch.setattr(
        meshcore_mod, "_IGNORED_MESSAGE_LOG_PATH", tmp_path / "ignored-meshcore.txt"
    )
    monkeypatch.setattr(config, "DEBUG", True)
    return SimpleNamespace(path=path)


def _hear(radio, packet) -> None:
    """Deliver ``packet`` from the known :data:`SENDER`, as ``radio.hear`` does."""

    radio.iface._getOrCreateByNum(SENDER)
    radio.iface._handlePacketFromRadio(packet)


def _meshcore_hidden_channel_message(scope) -> None:
    """Hear the real reader's ``#test`` channel message, ``#test`` hidden."""

    # A MeshCore radio names its own channels, as the real reader does.
    channels._reset_channel_cache()
    scope.apply(HIDDEN_CHANNELS=(frames.CHANNEL_NAME,))
    hmap = _make_event_handlers(_MeshcoreInterface(target=None), "/dev/ttyUSB0")
    raw_frames = [frames.channel_info_frame(), frames.channel_msg_v3_frame(path_len=3)]
    asyncio.run(frames.feed_reader(raw_frames, hmap))


def _meshcore_direct_message(*, rostered: bool) -> None:
    """Hear :data:`DM_TEXT` sent to the host, its sender in the roster or not."""

    iface = _MeshcoreInterface(target=None)
    iface.host_node_id = HOST_ID
    if rostered:
        iface._update_contact({"public_key": MESHCORE_KEY, "adv_name": "Alice"})
    hmap = _make_event_handlers(iface, "/dev/ttyUSB0")
    event = SimpleNamespace(
        payload={
            "sender_timestamp": frames.SENDER_TS,
            "text": DM_TEXT,
            "pubkey_prefix": MESHCORE_KEY[:12],
        }
    )
    asyncio.run(hmap["CONTACT_MSG_RECV"](event))


def _b64(data: bytes) -> str:
    """Return ``data`` as the old capture wrote bytes: Base64 text."""

    return base64.b64encode(data).decode("ascii")


def _leaks(capture, **forms) -> list[str]:
    """Name each content form of a dropped packet the capture file holds.

    Parameters:
        capture: The :func:`capture` fixture's namespace.
        **forms: A name for each form and the string, or tuple of strings,
            any one of which in the file betrays it: the text, the payload as
            Base64, a coordinate.

    Returns:
        The names found, in argument order, then ``raw`` when a line carries
        the library's ``raw`` ``MeshPacket``.
    """

    content = capture.path.read_text(encoding="utf-8")
    found = []
    for name, needles in forms.items():
        needles = (needles,) if isinstance(needles, str) else needles
        if any(needle in content for needle in needles):
            found.append(name)
    if '"raw"' in content:
        found.append("raw")
    return found


def _only_entry(capture) -> dict:
    """Return the file's single line, parsed, its ISO ``timestamp`` removed."""

    lines = capture.path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1, lines
    entry = json.loads(lines[0])
    assert datetime.fromisoformat(entry.pop("timestamp")).tzinfo is not None
    return entry


# ---------------------------------------------------------------------------
# Every drop reason the review found keeps metadata only (SPEC DC1)
# ---------------------------------------------------------------------------


class TestDroppedPacketsKeepNoContent:
    """A dropped packet's line holds its metadata, never its content."""

    @pytest.mark.parametrize("reason", list(GATE_CASES))
    def test_text_dropped_at_the_filter_gate(self, radio, capture, reason):
        """A text the CF2 gate drops leaves no text, payload or ``raw``."""
        overrides, channel, via_mqtt = GATE_CASES[reason]
        radio.apply(**overrides)
        packet = _mesh_packet("TEXT_MESSAGE_APP", channel=channel, via_mqtt=via_mqtt)
        _hear(radio, packet)
        assert radio.posts == []
        assert _leaks(capture, text=TEXT, payload=_b64(packet.decoded.payload)) == []
        expected = {
            "reason": reason,
            "id": packet.id,
            "rx_time": packet.rx_time,
            "from_id": SENDER_ID,
            "to_id": "^all",
            "portnum": "TEXT_MESSAGE_APP",
            "payload_size": len(TEXT.encode()),
        }
        if channel:
            # proto3 omits the channel field at index 0 (SPEC CF2).
            expected["channel"] = channel
        assert _only_entry(capture) == expected

    def test_hidden_channel_position(self, radio, capture):
        """A hidden channel's position leaves no coordinates or payload."""
        radio.apply("hidden")
        packet = _mesh_packet("POSITION_APP", channel=SECONDARY)
        _hear(radio, packet)
        assert radio.posts == []
        assert (
            _leaks(
                capture,
                coordinates=("525200000", "52.52", "134050000", "13.405"),
                payload=_b64(packet.decoded.payload),
            )
            == []
        )
        entry = _only_entry(capture)
        assert (entry["reason"], entry["portnum"], entry["channel"]) == (
            "hidden-channel",
            "POSITION_APP",
            SECONDARY,
        )
        assert entry["payload_size"] == len(packet.decoded.payload)

    def test_meshtastic_direct_message(self, radio, capture):
        """A direct message the ingestor skips leaves no text, payload or ``raw``."""
        packet = _mesh_packet("TEXT_MESSAGE_APP", channel=PRIMARY)
        packet.to = HOST_NUM
        _hear(radio, packet)
        assert radio.posts == []
        assert _leaks(capture, text=TEXT, payload=_b64(packet.decoded.payload)) == []
        entry = _only_entry(capture)
        assert entry["reason"] == "skipped-direct-message"
        assert (entry["from_id"], entry["to_id"]) == (SENDER_ID, HOST_ID)

    def test_meshcore_hidden_channel_message(self, scope, capture):
        """A MeshCore message on a hidden channel leaves no text (SC8)."""
        _meshcore_hidden_channel_message(scope)
        assert scope.posts == []
        assert _leaks(capture, text=("hello path", frames.TEXT)) == []
        entry = _only_entry(capture)
        assert (entry["reason"], entry["channel"], entry["portnum"]) == (
            "hidden-channel",
            0,
            "TEXT_MESSAGE_APP",
        )
        assert entry["payload_size"] == len(frames.TEXT.encode())

    def test_meshcore_direct_message(self, scope, capture):
        """A MeshCore direct message the ingestor skips leaves no text."""
        _meshcore_direct_message(rostered=True)
        assert scope.posts == []
        assert _leaks(capture, text=DM_TEXT) == []
        entry = _only_entry(capture)
        assert entry["reason"] == "skipped-direct-message"
        assert (entry["from_id"], entry["to_id"]) == ("!aabbccdd", HOST_ID)
        assert entry["payload_size"] == len(DM_TEXT.encode())


# ---------------------------------------------------------------------------
# DEBUG log lines keep metadata only (SPEC DC7)
# ---------------------------------------------------------------------------


def _log_line(out: str, message: str) -> str:
    """Return the one line of ``out`` that ``config._debug_log`` printed for
    ``message``, which it writes after the fields."""

    [line] = [line for line in out.splitlines() if line.endswith(message)]
    return line


class TestDebugLogLinesKeepNoContent:
    """A log line that describes a dropped packet prints no content."""

    def test_packet_missing_from_id_prints_metadata(self, scope, capture, capsys):
        """A MeshCore direct message from outside the roster has no sender id;
        its ``Packet missing from_id`` line names the packet, not its text."""
        _meshcore_direct_message(rostered=False)
        out = capsys.readouterr().out
        assert DM_TEXT not in out
        line = _log_line(out, "Packet missing from_id")
        assert f"to_id='{HOST_ID}'" in line
        assert f"payload_size={len(DM_TEXT.encode())}" in line
        assert "from_id" not in line.removesuffix("Packet missing from_id")
        assert scope.posts == []
        assert _only_entry(capture)["reason"] == "skipped-direct-message"

    def test_meshcore_channel_message_names_no_sender(self, scope, capture, capsys):
        """The ``MeshCore channel message`` line keeps the channel and the
        sender id; the name parsed from a hidden channel's text stays out."""
        _meshcore_hidden_channel_message(scope)
        out = capsys.readouterr().out
        assert "Alice" not in out
        assert "hello path" not in out
        line = _log_line(out, "MeshCore channel message")
        assert "channel=0" in line
        assert "from_id='!" in line


# ---------------------------------------------------------------------------
# The allowlist (SPEC DC1)
# ---------------------------------------------------------------------------


class TestCaptureAllowlist:
    """Only the listed fields are written; a new field is excluded by default."""

    def test_unknown_field_is_left_out(self, capture):
        """A field the allowlist does not name never reaches the file, at the
        top level or inside ``decoded``; the listed fields still do."""
        packet = {
            **LISTED_PACKET,
            "futureField": "zz-unlisted-zz",
            "decoded": {
                **LISTED_PACKET["decoded"],
                "futureSection": {"note": "zz-unlisted-zz"},
            },
        }
        ignored_mod._record_ignored_packet(packet, reason="hidden-channel")
        assert "zz-unlisted-zz" not in capture.path.read_text(encoding="utf-8")
        assert _only_entry(capture) == LISTED_ENTRY

    def test_allowlist_is_the_documented_metadata(self):
        """The allowlist names the metadata DC1 lists, in DC1's order."""
        assert list(ignored_mod._CAPTURE_FIELDS) == [
            "id",
            "rx_time",
            "from_id",
            "to_id",
            "channel",
            "portnum",
            "payload_size",
        ]

    def test_non_scalar_values_are_left_out(self, capture):
        """A listed field whose value is not a string or number is left out."""
        nested = {"text": "zz-nested-zz"}
        packet = {
            "id": nested,
            "rxTime": ["zz-nested-zz"],
            "fromId": nested,
            "toId": b"zz-nested-zz",
            "channel": nested,
            "decoded": {"portnum": nested, "payload": nested},
        }
        ignored_mod._record_ignored_packet(packet, reason="unsupported-port")
        assert "zz-nested-zz" not in capture.path.read_text(encoding="utf-8")
        assert _only_entry(capture) == {"reason": "unsupported-port"}

    def test_packet_that_is_no_mapping_leaves_its_reason(self, capture):
        """A packet that is not a mapping leaves the reason and nothing else."""
        ignored_mod._record_ignored_packet("zz-opaque-zz", reason="unsupported-port")
        assert "zz-opaque-zz" not in capture.path.read_text(encoding="utf-8")
        assert _only_entry(capture) == {"reason": "unsupported-port"}

    @pytest.mark.parametrize(
        "packet, size",
        [
            ({"decoded": {"payload": b"\x00\x01\x02", "text": "zz"}}, 3),
            ({"decoded": {"payload": _b64(b"abcd")}}, 4),
            ({"decoded": {"payload": {"__bytes_b64__": _b64(b"abcde")}}}, 5),
            ({"decoded": {"text": "grüße"}}, 7),
            ({"encrypted": _b64(b"\x07" * 9)}, 9),
            ({"encrypted": True, "decoded": {"portnum": "TEXT_MESSAGE_APP"}}, None),
            ({"decoded": {"payload": "not base64!"}}, None),
            ({}, None),
        ],
        ids=[
            "library-bytes",
            "udp-base64",
            "bytes-mapping",
            "handler-text",
            "ciphertext",
            "encrypted-flag",
            "unreadable",
            "none",
        ],
    )
    def test_payload_size(self, capture, packet, size):
        """The size counts the payload bytes, then the ciphertext, then the
        text in UTF-8; a packet with none of them has no size."""
        ignored_mod._record_ignored_packet(packet, reason="no-message-payload")
        assert _only_entry(capture).get("payload_size") == size

    def test_numeric_sender_and_recipient_are_canonical(self, capture):
        """A numeric ``from``/``to`` is written as a ``!xxxxxxxx`` id."""
        packet = {"from": SENDER, "fromId": "!0badbeef", "to": HOST_NUM}
        ignored_mod._record_ignored_packet(packet, reason="skipped-direct-message")
        entry = _only_entry(capture)
        assert (entry["from_id"], entry["to_id"]) == (SENDER_ID, HOST_ID)


# ---------------------------------------------------------------------------
# Rotation (SPEC DC2)
# ---------------------------------------------------------------------------


def _fill(path: Path, size: int) -> None:
    """Make ``path`` ``size`` bytes long without writing them (a sparse file)."""

    with path.open("wb") as handle:
        handle.truncate(size)


_WRITER = """
import json, os, sys, time
from pathlib import Path

repo, path, cap, count, ready, go = sys.argv[1:]
sys.path.insert(0, repo)
import data.mesh_ingestor.config as config
import data.mesh_ingestor.handlers.ignored as ignored

config.DEBUG = True
ignored._IGNORED_PACKET_LOG_PATH = Path(path)
ignored._IGNORED_PACKET_LOG_MAX_BYTES = int(cap)
moved, discarded = [], []
replace = os.replace


def spy(src, dst):
    if os.path.exists(dst):
        data = Path(dst).read_bytes()
        discarded.append(data.rstrip(b"\\n").rfind(b"\\n") + 1)
    replace(src, dst)
    moved.append(os.stat(dst).st_size)


os.replace = spy
errors = []
Path(ready).touch()
while not os.path.exists(go):
    time.sleep(0.001)
for number in range(int(count)):
    try:
        ignored._record_ignored_packet({"id": number}, reason="hidden-channel")
    except OSError as exc:
        errors.append(type(exc).__name__)
print(json.dumps({"errors": errors, "moved": moved, "discarded": discarded}))
"""
"""A capture writer run as its own process: after the shared start it writes
``count`` lines to ``path`` at a cap of ``cap`` bytes and prints the errors it
caught, the size of each file it rotated into ``.1``, and for each ``.1`` it
replaced the offset of that file's last line."""


def _open_files() -> set[str]:
    """Return the path of every file this process holds open (Linux)."""

    names = set()
    for fd in os.listdir("/proc/self/fd"):
        with contextlib.suppress(OSError):
            names.add(os.readlink(f"/proc/self/fd/{fd}"))
    return names


class TestCaptureRotation:
    """The file rotates at 10 MB and keeps exactly one previous file; it is
    created, with its directory, on the first write."""

    def test_write_that_reaches_the_cap_rotates(self, capture):
        """The write that takes the file to 10 MB moves it to ``.1``; the next
        write starts a new file."""
        previous = capture.path.with_name("ignored-meshtastic.txt.1")
        _fill(capture.path, CAP - 1)
        ignored_mod._record_ignored_packet({"id": 1}, reason="hidden-channel")
        assert previous.exists()
        assert previous.stat().st_size >= CAP
        assert not capture.path.exists()
        ignored_mod._record_ignored_packet({"id": 2}, reason="hidden-channel")
        assert _only_entry(capture) == {"reason": "hidden-channel", "id": 2}

    def test_write_below_the_cap_appends(self, capture):
        """A write that leaves the file under 10 MB appends to it."""
        _fill(capture.path, CAP - 1000)
        ignored_mod._record_ignored_packet({"id": 3}, reason="hidden-channel")
        assert not capture.path.with_name("ignored-meshtastic.txt.1").exists()
        size = capture.path.stat().st_size
        assert CAP - 1000 < size < CAP
        with capture.path.open("rb") as handle:
            handle.seek(CAP - 1000)
            assert json.loads(handle.read())["id"] == 3

    def test_only_one_previous_file_is_kept(self, capture, tmp_path):
        """A second rotation replaces the previous file; nothing else is kept."""
        previous = capture.path.with_name("ignored-meshtastic.txt.1")
        previous.write_text("older capture\n", encoding="utf-8")
        _fill(capture.path, CAP - 1)
        ignored_mod._record_ignored_packet({"id": 4}, reason="hidden-channel")
        # The 14-byte older file is gone: ``.1`` is now the rotated 10 MB one.
        assert previous.stat().st_size >= CAP
        assert sorted(p.name for p in tmp_path.iterdir()) == [
            "ignored-meshtastic.txt.1"
        ]

    def test_write_creates_a_missing_directory(self, capture, monkeypatch, tmp_path):
        """A capture path whose directory is missing is created on the write."""
        path = tmp_path / "gone" / "ignored-meshtastic.txt"
        monkeypatch.setattr(ignored_mod, "_IGNORED_PACKET_LOG_PATH", path)
        ignored_mod._record_ignored_packet({"id": 5}, reason="hidden-channel")
        assert json.loads(path.read_text(encoding="utf-8"))["id"] == 5

    def test_two_processes_share_one_rotation(self, tmp_path):
        """Two ingestors writing one checkout's capture never fail on a
        rotation, and every rotation moves a full file to ``.1``: never a
        fresh one over it (SPEC DC2)."""
        path = tmp_path / "ignored-meshtastic.txt"
        cap, count, go = 20_000, 10_000, tmp_path / "go"
        ready = [tmp_path / f"ready-{index}" for index in range(2)]
        writers = [
            subprocess.Popen(
                [sys.executable, "-c", _WRITER, str(REPO_ROOT), str(path)]
                + [str(cap), str(count), str(flag), str(go)],
                cwd=tmp_path,
                stdout=subprocess.PIPE,
                text=True,
            )
            for flag in ready
        ]
        deadline = time.monotonic() + 60
        while not all(flag.exists() for flag in ready):
            assert time.monotonic() < deadline, "the writers never started"
            time.sleep(0.01)
        go.touch()
        reports = [json.loads(writer.communicate(timeout=120)[0]) for writer in writers]
        assert [writer.returncode for writer in writers] == [0, 0]
        assert [report["errors"] for report in reports] == [[], []]
        moved = [size for report in reports for size in report["moved"]]
        assert moved, "no rotation happened"
        assert min(moved) >= cap
        assert path.with_name("ignored-meshtastic.txt.1").stat().st_size >= cap
        # A file is rotated by the write that filled it, so every line but its
        # last went in below the cap: no line was appended after a rotation.
        discarded = [offset for report in reports for offset in report["discarded"]]
        assert discarded, "no previous file was replaced"
        assert max(discarded) < cap

    @pytest.mark.parametrize("fresh", [True, False], ids=["new-file", "no-file"])
    def test_writer_that_waited_appends_to_the_current_file(
        self, capture, monkeypatch, fresh
    ):
        """A writer that waited for the lock while another process rotated the
        full file appends to the file now at the path, never to the rotated
        one, which the next rotation would discard."""
        fcntl = pytest.importorskip("fcntl")
        previous = capture.path.with_name("ignored-meshtastic.txt.1")
        _fill(capture.path, CAP)
        waits = []

        def rotated_while_waiting(fd, operation):
            """On the first wait let another process rotate the full file."""
            if not waits:
                waits.append(fd)
                os.replace(capture.path, previous)
                if fresh:
                    capture.path.write_text("fresh\n", encoding="utf-8")
            fcntl.flock(fd, operation)

        monkeypatch.setattr(
            ignored_mod,
            "fcntl",
            SimpleNamespace(LOCK_EX=fcntl.LOCK_EX, flock=rotated_while_waiting),
        )
        ignored_mod._record_ignored_packet({"id": 6}, reason="hidden-channel")
        assert previous.stat().st_size == CAP
        lines = capture.path.read_text(encoding="utf-8").splitlines()
        assert lines[:-1] == (["fresh"] if fresh else [])
        assert json.loads(lines[-1])["id"] == 6

    def test_without_fcntl_no_handle_is_open_at_the_rename(self, capture, monkeypatch):
        """Without ``fcntl`` (Windows) the file is closed before it is renamed,
        as Windows refuses to rename an open file."""
        if not os.path.isdir("/proc/self/fd"):
            pytest.skip("needs /proc to list the open files")
        monkeypatch.setattr(ignored_mod, "fcntl", None)
        replace, seen = os.replace, []

        def checked_replace(src, dst):
            """Record whether either file is open in this process, then rename."""
            files = _open_files()
            seen.append(
                (os.path.realpath(src) in files, os.path.realpath(dst) in files)
            )
            replace(src, dst)

        monkeypatch.setattr(os, "replace", checked_replace)
        _fill(capture.path, CAP - 1)
        ignored_mod._record_ignored_packet({"id": 8}, reason="hidden-channel")
        assert seen == [(False, False)]
        assert capture.path.with_name("ignored-meshtastic.txt.1").stat().st_size >= CAP

    def test_with_fcntl_the_rename_runs_under_the_lock(self, capture, monkeypatch):
        """With ``fcntl`` the file is renamed while this process holds its lock,
        so no other process appends to it or rotates it meanwhile."""
        fcntl = pytest.importorskip("fcntl")
        replace, held = os.replace, []

        def checked_replace(src, dst):
            """Try to take the lock from another handle, then rename."""
            with open(src, "ab") as probe:
                try:
                    fcntl.flock(probe.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    held.append(False)
                except BlockingIOError:
                    held.append(True)
            replace(src, dst)

        monkeypatch.setattr(os, "replace", checked_replace)
        _fill(capture.path, CAP - 1)
        ignored_mod._record_ignored_packet({"id": 11}, reason="hidden-channel")
        assert held == [True]
        assert capture.path.with_name("ignored-meshtastic.txt.1").stat().st_size >= CAP

    @pytest.mark.parametrize("locks", [True, False], ids=["fcntl", "no-fcntl"])
    def test_refused_rename_is_retried_at_the_next_write(
        self, capture, monkeypatch, locks
    ):
        """A rename the system refuses, as Windows does while another process
        holds the file open, is no error; the next write rotates the file."""
        if not locks:
            monkeypatch.setattr(ignored_mod, "fcntl", None)
        previous = capture.path.with_name("ignored-meshtastic.txt.1")
        replace, refusals = os.replace, [PermissionError(13, "in use")]

        def refusing_once(src, dst):
            """Refuse the first rename, then rename."""
            if refusals:
                raise refusals.pop()
            replace(src, dst)

        monkeypatch.setattr(os, "replace", refusing_once)
        _fill(capture.path, CAP - 1)
        ignored_mod._record_ignored_packet({"id": 9}, reason="hidden-channel")
        assert not previous.exists()
        assert capture.path.stat().st_size >= CAP
        ignored_mod._record_ignored_packet({"id": 10}, reason="hidden-channel")
        assert previous.stat().st_size >= CAP
        assert not capture.path.exists()

    def test_rotating_a_file_already_gone_is_no_error(self, capture):
        """A capture file removed before its rotation leaves nothing to move."""
        ignored_mod._rotate(capture.path)
        assert not capture.path.with_name("ignored-meshtastic.txt.1").exists()

    def test_without_file_locks_one_process_still_rotates(self, capture, monkeypatch):
        """Where ``fcntl`` is missing (not POSIX), rotation works per process:
        the write that fills the file rotates it, the next one appends."""
        monkeypatch.setattr(ignored_mod, "fcntl", None)
        _fill(capture.path, CAP - 1)
        ignored_mod._record_ignored_packet({"id": 7}, reason="hidden-channel")
        assert capture.path.with_name("ignored-meshtastic.txt.1").stat().st_size >= CAP
        assert not capture.path.exists()
        ignored_mod._record_ignored_packet({"id": 12}, reason="hidden-channel")
        assert _only_entry(capture) == {"reason": "hidden-channel", "id": 12}

    def test_meshcore_capture_rotates_the_same_way(self, capture, tmp_path):
        """``ignored-meshcore.txt`` rotates at 10 MB too and keeps one previous
        file; its lines keep the content SC8 gives them."""
        path = tmp_path / "ignored-meshcore.txt"
        previous = path.with_name("ignored-meshcore.txt.1")
        _fill(path, CAP - 1)
        frame = {"payload_typename": "GRP_TXT", "msg_hash": 7}
        meshcore_mod._record_meshcore_message(frame, source="auto:RX_LOG_DATA")
        assert previous.exists()
        assert previous.stat().st_size >= CAP
        assert not path.exists()
        meshcore_mod._record_meshcore_message(frame, source="auto:RX_LOG_DATA")
        [line] = path.read_text(encoding="utf-8").splitlines()
        assert json.loads(line)["message"] == frame
