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
"""Unit tests for :mod:`data.mesh_ingestor.protocols.reticulum_position`.

Covers the RNS config reader shared with the radio metadata (SPEC RL1), the
position keys' validation and logging (SPEC RP1-RP3), and the record and row
builders (SPEC RP4-RP6).  The provider and daemon wiring is covered in
``tests/test_reticulum_host_position.py``.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest
from RNS.vendor.configobj import ConfigObj

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:  # pragma: no cover - conftest adds it
    sys.path.insert(0, str(REPO_ROOT))

import data.mesh_ingestor.protocols.reticulum as reticulum  # noqa: E402
import data.mesh_ingestor.protocols.reticulum_position as rp  # noqa: E402
from data.mesh_ingestor import config, handlers, queue  # noqa: E402
from data.mesh_ingestor.handlers import _state as handler_state  # noqa: E402

_HOST = "!27716218"
"""The field host's node id (SPEC RE8)."""

_SECRET = "deadbeefdeadbeefdeadbeefdeadbeef"
"""A shared-instance ``rpc_key`` that must never leave the parser."""

_PASSPHRASE = "correct horse battery staple"
"""An interface ``passphrase`` (IFAC secret) that must never leave it either."""

_MARKER = "potato-location-cmd-ran"
"""File a ``location_cmd`` would create if anything ran it."""

_CONFIG = f"""
[reticulum]
  enable_transport = No
  share_instance = Yes
  rpc_key = {_SECRET}

[interfaces]
  [[Default Interface]]
    type = AutoInterface
    enabled = yes
    latitude = 1.0
    longitude = 2.0

  [[RNode LoRa Interface]]
    type = RNodeInterface
    enabled = yes
    port = /dev/ttyUSB0
    passphrase = {_PASSPHRASE}
    frequency = 867200000
    bandwidth = 125000
    spreadingfactor = 8
    codingrate = 5
    latitude = 52.5029   # Berlin
    longitude = 13.4042
    height = 34
    location_cmd = touch {_MARKER}
    potatomesh_latitude = 1.5
    reachable_on = 127.0.0.1

  [[Second RNode]]
    type = RNodeInterface
    latitude = 48.1
    longitude = 11.5
"""
"""An RNS config with the position keys in the first RNode block and decoys
elsewhere: an ``AutoInterface`` before it and a second RNode after it."""


@pytest.fixture(autouse=True)
def fresh_log_state(monkeypatch):
    """Start every test with no logged outcome and a recording ``_debug_log``.

    Returns:
        The list of ``(message, fields)`` pairs logged.
    """
    logged: list[tuple[str, dict]] = []
    monkeypatch.setattr(rp, "_last_outcome", None)
    monkeypatch.setattr(
        config, "_debug_log", lambda msg, **kw: logged.append((msg, kw))
    )
    return logged


def _block(lines: str) -> str:
    """Wrap *lines* in one ``RNodeInterface`` block.

    Parameters:
        lines: Key lines for the block.

    Returns:
        RNS config text.
    """
    return "[interfaces]\n  [[RNode]]\n    type = RNodeInterface\n" + lines


def _parse(text: str):
    """Parse the position keys of *text*'s first RNode block.

    Parameters:
        text: RNS config text.

    Returns:
        ``(position, problem)`` from :func:`rp.parse_host_position`.
    """
    return rp.parse_host_position(rp.rnode_block_entries(text, rp.POSITION_KEYS))


# ---------------------------------------------------------------------------
# The shared block reader (SPEC RL1/RP1)
# ---------------------------------------------------------------------------


def test_block_reader_returns_only_the_requested_keys_of_the_first_rnode():
    """The first RNode block, in file order, and nothing a caller did not ask for.

    The ``AutoInterface`` block before it and the second RNode after it are
    both decoys; the ``passphrase``, ``location_cmd`` and the ``[reticulum]``
    section's ``rpc_key`` never leave the reader.
    """
    entries = rp.rnode_block_entries(_CONFIG, rp.POSITION_KEYS)
    assert entries == [
        ("latitude", "52.5029"),
        ("longitude", "13.4042"),
        ("height", "34"),
    ]
    flat = repr(rp.rnode_block_entries(_CONFIG, frozenset({"latitude"})))
    assert _SECRET not in flat and _PASSPHRASE not in flat


def test_block_reader_is_none_without_an_rnode_block():
    """No ``RNodeInterface`` anywhere: nothing to read."""
    only_auto = "[interfaces]\n  [[Default]]\n    type = AutoInterface\n"
    assert rp.rnode_block_entries(only_auto, rp.POSITION_KEYS) is None
    assert rp.rnode_block_entries("", rp.POSITION_KEYS) is None


def test_block_reader_keeps_an_rnode_block_with_none_of_the_keys():
    """An RNode block without the keys is an empty block, not a missing one."""
    assert rp.rnode_block_entries(_block("    port = /dev/x\n"), rp.POSITION_KEYS) == []


def test_block_reader_keeps_values_as_written():
    """Quotes survive the reader: unquoting is the position parser's job alone."""
    text = _block("    latitude = \"52.5\"\n    longitude = '13.4'\n")
    assert rp.rnode_block_entries(text, rp.POSITION_KEYS) == [
        ("latitude", '"52.5"'),
        ("longitude", "'13.4'"),
    ]


def _legacy_parse_rnode_radio_config(text: str) -> dict | None:
    """The radio parser exactly as it read before the block reader was shared.

    Kept verbatim as a test oracle: the refactor must not change what SPEC RL1
    reports for any config.

    Parameters:
        text: RNS config text.

    Returns:
        What the pre-refactor ``_parse_rnode_radio_config`` returned.
    """
    current: dict = {}
    best: dict | None = None
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        if line.startswith("["):
            if current.get("_is_rnode") and best is None:
                best = current
            current = {}
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip().lower(), value.strip()
        if key == "type":
            current["_is_rnode"] = value == "RNodeInterface"
        elif key in ("frequency", "bandwidth", "spreadingfactor", "codingrate"):
            try:
                current[key] = int(value)
            except ValueError:
                continue
    if current.get("_is_rnode") and best is None:
        best = current
    if not best:
        return None
    frequency = best.get("frequency")
    bandwidth = best.get("bandwidth")
    return {
        "frequency_mhz": int(frequency // 1_000_000) if frequency else None,
        "bandwidth_khz": int(bandwidth / 1000) if bandwidth else None,
        "sf": best.get("spreadingfactor"),
        "cr": best.get("codingrate"),
    }


@pytest.mark.parametrize(
    "text",
    [
        _CONFIG,
        "",
        "frequency = 867200000\ntype = RNodeInterface\n",
        _block("    frequency = 867200000\n    frequency = bogus\n"),
        _block("    frequency = bogus\n    frequency = 868000000\n"),
        _block("    FREQUENCY = 869525000\n    BandWidth = 250000\n"),
        _block("    frequency = 867200000\n    type = AutoInterface\n"),
        "[[A]]\n type = AutoInterface\n frequency = 1\n[[B]]\n"
        " type = RNodeInterface\n codingrate = 6\n",
        _block("    spreadingfactor = 12 # comment\n    bare-token\n    = 5\n"),
        _block("    frequency = 0\n    bandwidth = 0\n"),
        "[[A]]\n type = RNodeInterface\n[[B]]\n type = RNodeInterface\n sf = 7\n",
        _block(
            "    frequency = \"867200000\"\n    bandwidth = '125000'\n    codingrate = 5\n"
        ),
    ],
    ids=[
        "full-config",
        "empty",
        "before-any-section",
        "valid-then-invalid",
        "invalid-then-valid",
        "upper-case-keys",
        "type-changes-away",
        "rnode-second",
        "comment-bare-token-blank-key",
        "zero-values",
        "first-rnode-empty",
        "quoted-values",
    ],
)
def test_radio_parser_reads_exactly_what_it_read_before_the_refactor(text):
    """SPEC RL1 is unchanged: the shared reader yields the same radio values."""
    assert reticulum._parse_rnode_radio_config(
        text
    ) == _legacy_parse_rnode_radio_config(text)


def test_config_text_is_none_for_an_unset_dir_or_a_missing_file(tmp_path):
    """No directory or no readable file: no text, and no exception."""
    assert rp.rns_config_text(None) is None
    assert rp.rns_config_text("   ") is None
    assert rp.rns_config_text(str(tmp_path)) is None
    (tmp_path / "config").write_text("[reticulum]\n", encoding="utf-8")
    assert rp.rns_config_text(str(tmp_path)) == "[reticulum]\n"


# ---------------------------------------------------------------------------
# Validation (SPEC RP2/RP3)
# ---------------------------------------------------------------------------


def test_a_valid_position_is_published_as_written():
    """No rounding: the values are the floats the operator typed (SPEC RP3)."""
    position, problem = _parse(_CONFIG)
    assert problem is None
    assert position == rp.HostPosition(52.5029, 13.4042, 34.0)


def test_height_is_optional():
    """Latitude and longitude alone are a position without altitude."""
    position, problem = _parse(
        _block("    latitude = -33.8688\n    longitude = 151.2093\n")
    )
    assert (position, problem) == (rp.HostPosition(-33.8688, 151.2093, None), None)


@pytest.mark.parametrize(
    "lines",
    [
        "",
        "    port = /dev/ttyUSB0\n",
        "    height = 34\n",
        f"    location_cmd = touch {_MARKER}\n",
    ],
    ids=["empty-block", "port-only", "height-only", "command-only"],
)
def test_no_coordinates_mean_no_position_and_no_problem(lines):
    """Missing keys, or height or location_cmd alone, are not an error."""
    assert _parse(_block(lines)) == (None, None)


def test_keys_outside_the_first_rnode_block_are_not_read():
    """An ``AutoInterface`` position is not this host's radio position."""
    text = "[interfaces]\n  [[Auto]]\n    type = AutoInterface\n    latitude = 1\n"
    assert _parse(text + "    longitude = 2\n") == (None, None)


def test_discoverable_does_not_matter():
    """RNS reads the keys only for a discoverable interface; this reads them always."""
    for flag in ("", "    discoverable = no\n", "    discoverable = yes\n"):
        position, _ = _parse(_block(flag + "    latitude = 10\n    longitude = 20\n"))
        assert position == rp.HostPosition(10.0, 20.0, None)


@pytest.mark.parametrize(
    ("lines", "problem"),
    [
        ("    latitude = 52.5\n", "only one of latitude and longitude is set"),
        ("    longitude = 13.4\n", "only one of latitude and longitude is set"),
        ("    latitude = north\n    longitude = 13.4\n", "must be numbers"),
        ("    latitude = 52.5\n    longitude = 13,4\n", "must be numbers"),
        ("    latitude =\n    longitude = 13.4\n", "must be numbers"),
        ("    latitude = nan\n    longitude = 13.4\n", "must be numbers"),
        ("    latitude = 52.5\n    longitude = inf\n", "must be numbers"),
        ("    latitude = \"52.5'\n    longitude = 13.4\n", "must be numbers"),
        ('    latitude = "52.5\n    longitude = 13.4\n', "must be numbers"),
        ('    latitude = ""52.5""\n    longitude = 13.4\n', "must be numbers"),
        ('    latitude = ""\n    longitude = 13.4\n', "must be numbers"),
        ('    latitude = "north"\n    longitude = 13.4\n', "must be numbers"),
        ("    latitude = 90.0001\n    longitude = 13.4\n", "latitude is outside"),
        ("    latitude = -91\n    longitude = 13.4\n", "latitude is outside"),
        ("    latitude = 52.5\n    longitude = 180.5\n", "longitude is outside"),
        ("    latitude = 52.5\n    longitude = -181\n", "longitude is outside"),
        ("    latitude = 0\n    longitude = 0\n", "0, 0 is not a position"),
        ("    latitude = 0.0\n    longitude = -0.0\n", "0, 0 is not a position"),
        (
            "    latitude = 95\n    longitude = 2\n    height = high\n",
            "latitude is outside",
        ),
    ],
    ids=[
        "latitude-alone",
        "longitude-alone",
        "word",
        "decimal-comma",
        "empty-value",
        "nan",
        "inf",
        "mismatched-quotes",
        "unbalanced-quote",
        "two-pairs-of-quotes",
        "empty-quotes",
        "quoted-word",
        "latitude-above-90",
        "latitude-below-minus-90",
        "longitude-above-180",
        "longitude-below-minus-180",
        "null-island",
        "null-island-signed",
        "bad-latitude-wins-over-bad-height",
    ],
)
def test_an_invalid_value_means_no_position(lines, problem):
    """Each invalid shape is rejected with a reason (SPEC RP2)."""
    position, reason = _parse(_block(lines))
    assert position is None
    assert problem in reason


@pytest.mark.parametrize(
    "value",
    ['"52.5029"', "'52.5029'", '" 52.5029 "'],
    ids=["double-quotes", "single-quotes", "quoted-with-spaces"],
)
def test_one_pair_of_quotes_is_stripped_as_rns_does(value):
    """A quoted value reads as RNS's own ConfigObj reads it (SPEC RP2)."""
    text = _block(
        f"    latitude = {value}\n    longitude = '13.4042'\n    height = \"34\"\n"
    )
    section = ConfigObj(text.splitlines())["interfaces"]["RNode"]
    rns = tuple(section.as_float(key) for key in ("latitude", "longitude", "height"))
    assert _parse(text) == (rp.HostPosition(*rns), None)


@pytest.mark.parametrize(
    "height",
    ["high", "", "nan", "inf", '"tall"'],
    ids=["word", "empty", "nan", "inf", "quoted-word"],
)
def test_an_invalid_height_drops_only_the_altitude(height):
    """The coordinates still publish; only the altitude is left out (SPEC RP2)."""
    text = _block(f"    latitude = 52.5\n    longitude = 13.4\n    height = {height}\n")
    assert _parse(text) == (
        rp.HostPosition(52.5, 13.4, None),
        "height must be a number",
    )


@pytest.mark.parametrize(
    "lines",
    [
        "    Latitude = 52.5029\n    Longitude = 13.4042\n",
        "    LATITUDE = 52.5029\n    longitude = 13.4042\n",
        "    latitude = 52.5029\n    longitude = 13.4042\n    Latitude = 1\n    HEIGHT = 34\n",
        '    "latitude" = 52.5029\n    \'longitude\' = 13.4042\n    "height" = 34\n',
        '    "Latitude" = 52.5029\n    longitude = 13.4042\n',
        "    latitude = 52.5029\n    longitude = 13.4042\n    Height = sky-high\n",
    ],
    ids=[
        "capitalised",
        "upper-case-latitude",
        "case-variant-after-the-key",
        "quoted-keys",
        "quoted-capitalised-key",
        "case-variant-of-a-bad-height",
    ],
)
def test_keys_match_as_rns_matches_them(tmp_path, fresh_log_state, lines):
    """A key counts only under the exact name RNS reads (SPEC RP2).

    RNS's ConfigObj matches a key exactly after stripping one pair of quotes:
    ``Latitude`` is a different key, ``"latitude"`` is ``latitude``.  RNS's own
    parser is the oracle: the ingestor publishes what RNS would read, and warns
    exactly when RNS's view of the keys is invalid, never about a key RNS ignores.
    """
    text = _block(lines)
    section = ConfigObj(text.splitlines())["interfaces"]["RNode"]
    rns_view = [
        (k, section[k]) for k in ("latitude", "longitude", "height") if k in section
    ]
    (tmp_path / "config").write_text(text, encoding="utf-8")
    expected, problem = rp.parse_host_position(rns_view)
    assert rp.read_host_position(str(tmp_path)) == expected
    warnings = [kw.get("severity") for _msg, kw in fresh_log_state].count("warn")
    assert warnings == (0 if problem is None else 1)


def test_the_boundaries_and_one_zero_axis_are_valid():
    """The poles, the antimeridian, the equator and the prime meridian are real."""
    for lat, lon in (("90", "180"), ("-90", "-180"), ("0", "13.4"), ("52.5", "0")):
        position, problem = _parse(
            _block(f"    latitude = {lat}\n    longitude = {lon}\n")
        )
        assert problem is None
        assert position == rp.HostPosition(float(lat), float(lon), None)


def test_a_negative_height_is_valid():
    """Below sea level is a height, not an error."""
    position, _ = _parse(
        _block("    latitude = 31.5\n    longitude = 35.5\n    height = -430\n")
    )
    assert position.altitude == -430.0


def test_the_last_occurrence_of_a_key_wins():
    """RNS rejects duplicates; if one slips through, the later line wins."""
    text = _block("    latitude = 1\n    longitude = 2\n    latitude = 3\n")
    assert _parse(text)[0] == rp.HostPosition(3.0, 2.0, None)


# ---------------------------------------------------------------------------
# read_host_position: once per connect, logged once per outcome (SPEC RP2)
# ---------------------------------------------------------------------------


def test_read_logs_a_valid_position_once_and_never_its_coordinates(
    tmp_path, fresh_log_state
):
    """One info line, then silence while the outcome holds."""
    (tmp_path / "config").write_text(_CONFIG, encoding="utf-8")
    assert rp.read_host_position(str(tmp_path)) == rp.HostPosition(
        52.5029, 13.4042, 34.0
    )
    assert rp.read_host_position(str(tmp_path)) == rp.HostPosition(
        52.5029, 13.4042, 34.0
    )
    assert [(msg, kw["severity"]) for msg, kw in fresh_log_state] == [
        ("Publishing the host position from the RNS config", "info")
    ]
    flat = repr(fresh_log_state)
    for leak in ("52.5029", "13.4042", _SECRET, _PASSPHRASE):
        assert leak not in flat


def test_read_logs_missing_keys_once_at_debug(tmp_path, fresh_log_state):
    """No keys, no file or no directory: one debug line, no warning spam."""
    assert rp.read_host_position(str(tmp_path)) is None
    (tmp_path / "config").write_text(_block(""), encoding="utf-8")
    assert rp.read_host_position(str(tmp_path)) is None
    assert rp.read_host_position(None) is None
    assert len(fresh_log_state) == 1
    message, fields = fresh_log_state[0]
    assert "No host position" in message
    assert fields.get("severity", "debug") == "debug"


def test_read_warns_once_per_problem(tmp_path, fresh_log_state):
    """An invalid value warns once; a different problem warns again."""
    config_file = tmp_path / "config"
    config_file.write_text(
        _block("    latitude = 95\n    longitude = 13\n"), encoding="utf-8"
    )
    assert rp.read_host_position(str(tmp_path)) is None
    assert rp.read_host_position(str(tmp_path)) is None
    config_file.write_text(_block("    latitude = 52\n"), encoding="utf-8")
    assert rp.read_host_position(str(tmp_path)) is None
    warnings = [msg for msg, kw in fresh_log_state if kw.get("severity") == "warn"]
    assert len(warnings) == 2
    assert "latitude is outside -90..90" in warnings[0]
    assert "only one of latitude and longitude" in warnings[1]
    assert "95" not in repr(fresh_log_state)


def test_read_warns_once_about_an_invalid_height_and_never_its_value(
    tmp_path, fresh_log_state
):
    """One warning names ``height``; the value and the coordinates stay out."""
    text = _block(
        "    latitude = 52.5029\n    longitude = 13.4042\n    height = sky-high\n"
    )
    (tmp_path / "config").write_text(text, encoding="utf-8")
    expected = rp.HostPosition(52.5029, 13.4042, None)
    assert rp.read_host_position(str(tmp_path)) == expected
    assert rp.read_host_position(str(tmp_path)) == expected
    assert [kw.get("severity") for _msg, kw in fresh_log_state] == ["warn"]
    message = fresh_log_state[0][0]
    assert "height" in message and "without altitude" in message
    flat = repr(fresh_log_state)
    for leak in ("sky-high", "52.5029", "13.4042"):
        assert leak not in flat


def test_read_never_runs_location_cmd(tmp_path, monkeypatch):
    """``location_cmd`` names a command; the reader never runs it (SPEC RP1)."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "config").write_text(_CONFIG, encoding="utf-8")
    rp.read_host_position(str(tmp_path))
    assert not (tmp_path / _MARKER).exists()


# ---------------------------------------------------------------------------
# Builders (SPEC RP3-RP6)
# ---------------------------------------------------------------------------

_POSITION = rp.HostPosition(52.5029, 13.4042, 34.0)
_FLAT = rp.HostPosition(52.5029, 13.4042, None)


def test_node_position_is_the_record_mapping():
    """``{latitude, longitude, altitude?, time, locationSource}`` (SPEC RP4)."""
    assert rp.node_position(_POSITION, 1_791_000_000) == {
        "latitude": 52.5029,
        "longitude": 13.4042,
        "altitude": 34.0,
        "time": 1_791_000_000,
        "locationSource": "LOC_MANUAL",
    }
    assert "altitude" not in rp.node_position(_FLAT, 1)
    assert "precisionBits" not in rp.node_position(_POSITION, 1)


def test_position_row_carries_the_host_and_its_radio(monkeypatch):
    """One row per report: a stable 53-bit id, the reticulum stamp (SPEC RP5)."""
    monkeypatch.setattr(config, "LORA_FREQ", 867)
    monkeypatch.setattr(config, "MODEM_PRESET", "SF8/BW125/CR5")
    row = rp.position_row(_HOST, _POSITION, 1_791_000_000)
    assert row == {
        "id": row["id"],
        "rx_time": 1_791_000_000,
        "rx_iso": "2026-10-03T04:00:00Z",
        "node_id": _HOST,
        "node_num": 0x27716218,
        "from_id": _HOST,
        "latitude": 52.5029,
        "longitude": 13.4042,
        "altitude": 34.0,
        "position_time": 1_791_000_000,
        "location_source": "LOC_MANUAL",
        "ingestor": _HOST,
        "protocol": "reticulum",
        "lora_freq": 867,
        "modem_preset": "SF8/BW125/CR5",
    }
    assert 0 <= row["id"] < 1 << 53
    assert rp.position_row(_HOST, _POSITION, 1_791_000_000)["id"] == row["id"]
    assert rp.position_row(_HOST, _POSITION, 1_791_000_001)["id"] != row["id"]
    assert "altitude" not in rp.position_row(_HOST, _FLAT, 1)


@pytest.fixture
def host(monkeypatch):
    """Register :data:`_HOST` and record every queued POST.

    Returns:
        Namespace with ``posts`` (``(path, payload)`` pairs) and ``iface``
        (an interface holding :data:`_POSITION`).
    """
    for name in (
        "_host_node_id",
        "_host_telemetry_last_rx",
        "_host_nodeinfo_last_seen",
    ):
        monkeypatch.setattr(handler_state, name, None)
    handlers.register_host_node_id(_HOST)
    posts: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        queue,
        "_queue_post_json",
        lambda path, payload, **_k: posts.append((path, payload)),
    )
    monkeypatch.setattr(rp.time, "time", lambda: 1_791_000_000.4)
    return types.SimpleNamespace(
        posts=posts, iface=types.SimpleNamespace(host_position=_POSITION)
    )


def _bare(node_id: str, report_time: int) -> dict:
    """Stand-in for the provider's bare host record.

    Parameters:
        node_id: Host node id.
        report_time: Unix seconds.

    Returns:
        A minimal node dict.
    """
    return {"nodeId": node_id, "lastHeard": report_time, "user": {"longName": "bare"}}


def test_only_the_host_records_are_positioned(host):
    """Peers pass through untouched, and nothing is mutated (SPEC RP4)."""
    peer = {"nodeId": "!aabbccdd", "user": {"longName": "Peer"}}
    own = {"nodeId": _HOST, "destination": {"aspect": "lxmf.delivery"}}
    items = [("!aabbccdd", peer), (_HOST, own)]
    out = rp.with_host_position(items, host.iface, _bare)
    assert out[0] == ("!aabbccdd", peer) and out[0][1] is peer
    assert out[1][1]["position"] == rp.node_position(_POSITION, 1_791_000_000)
    assert out[1][1]["destination"] == {"aspect": "lxmf.delivery"}
    assert "position" not in own and len(items) == 2
    assert host.posts == []  # the snapshot posts no row


def test_a_bare_record_carries_the_position_when_no_record_is_the_host(host):
    """Docker: nothing announces, so the host rides on a bare record (SPEC RP6)."""
    out = rp.with_host_position(
        [("!aabbccdd", {"nodeId": "!aabbccdd"})], host.iface, _bare
    )
    assert [node_id for node_id, _node in out] == ["!aabbccdd", _HOST]
    bare = out[1][1]
    assert bare["user"] == {"longName": "bare"}
    assert bare["lastHeard"] == 1_791_000_000
    assert bare["position"]["time"] == 1_791_000_000


@pytest.mark.parametrize("missing", ["position", "host"])
def test_nothing_changes_without_a_position_or_a_host_id(host, missing):
    """No position, or a host id not yet resolved: the records pass as they are."""
    items = [(_HOST, {"nodeId": _HOST})]
    iface = host.iface
    if missing == "position":
        iface = types.SimpleNamespace(host_position=None)
    else:
        handlers.register_host_node_id(None)
    assert rp.with_host_position(items, iface, _bare) is items
    assert rp.report_host_position(items, iface, _bare) is items
    assert rp.with_host_position(items, None, _bare) is items
    assert host.posts == []


def test_a_report_positions_its_records_and_posts_one_row(host):
    """The report is what posts the row, at connect and hourly (SPEC RP5)."""
    out = rp.report_host_position([], host.iface, _bare)
    assert [node_id for node_id, _node in out] == [_HOST]
    assert out[0][1]["position"]["latitude"] == 52.5029
    assert [path for path, _payload in host.posts] == ["/api/positions"]
    assert host.posts[0][1]["node_id"] == _HOST
    assert host.posts[0][1]["position_time"] == 1_791_000_000
