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
"""Regression guard: an RX-log advert is ingested only when its signature holds.

The companion radio pushes every frame it receives to the RX log before the
firmware checks it (``Dispatcher::checkRecv`` calls ``logRxRaw`` before
``tryParsePacket``), and the pinned ``meshcore`` parser reads an advert's
signature without checking it.  The firmware verifies an advert only on its
way into the contact roster (``Mesh::onRecvPacket``), and before this check
the ingestor posted every parsed RX-log advert.  It now posts one only when
its signature holds (SPEC SG1-SG3), under a key not of small order (SG4), and
when its signed timestamp is newer than the last one accepted for its key
(SG5).

Each case builds an on-air advert with :mod:`meshcore_frames` from a key
derived from a fixed seed, parses it with the pinned library's
``MeshcorePacketParser`` and hands it to the ingestor's ``RX_LOG_DATA``
handler with the real ``handlers`` module; only the HTTP queue is replaced.
The small-order cases send keys no private key stands behind, and their
blocklist is checked against :mod:`ed25519_oracle`, which derives it from the
RFC 8032 curve constants.  ``tests/conftest.py`` empties the per-process replay
memory before every test.
"""

from __future__ import annotations

import asyncio
import sys
import types
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import ed25519_oracle  # noqa: E402 - pytest puts tests/ on sys.path
import meshcore_frames as frames  # noqa: E402 - pytest puts tests/ on sys.path

import data.mesh_ingestor.activity as activity  # noqa: E402
import data.mesh_ingestor.config as config  # noqa: E402
import data.mesh_ingestor.queue as queue  # noqa: E402
from data.mesh_ingestor.protocols.meshcore import (  # noqa: E402
    _MeshcoreInterface,
    _make_event_handlers,
)

VICTIM = frames.advert_key("potato-mesh test advertiser: victim")
"""Key of the node a forged advert claims to be (derived per run, never stored)."""

VICTIM_ID = frames.advert_node_id(VICTIM)
"""Canonical node id the victim's adverts post under."""

VICTIM_KEY = frames.advert_public_key(VICTIM)
"""The victim's raw public key."""

VICTIM_KEY_HEX = VICTIM_KEY.hex()
"""The victim's full public key as the parser reports it (``adv_key``)."""

OTHER_KEY_HEX = frames.advert_public_key(
    frames.advert_key("potato-mesh test advertiser: other")
).hex()
"""A second node's full public key."""

THIRD_KEY_HEX = frames.advert_public_key(
    frames.advert_key("potato-mesh test advertiser: third")
).hex()
"""A third node's full public key."""

SENT_AT = 1_791_288_000
"""Sender-side advert time: 2026-10-06T12:00:00Z."""

BERLIN = {"lat_e6": 52_520_000, "lon_e6": 13_405_000}
"""Advertised position of every case: 52.52 N, 13.405 E."""

LONG_NAME = "Alice of the Tiergarten"
"""A 23-byte name: with the flags and the position the app data fills 32 bytes."""

DROPPED = "Unverified RX-log advert dropped"
"""Log message of a dropped RX-log advert."""


@pytest.fixture
def posts(monkeypatch):
    """Capture every queued POST, with MeshCore as the active protocol.

    Returns:
        A list that collects ``(path, payload)`` for each queued request.
    """
    sent: list = []
    monkeypatch.setattr(config, "PROTOCOL", "meshcore")
    monkeypatch.setattr(
        queue,
        "_queue_post_json",
        lambda path, payload, *_args, **_kwargs: sent.append((path, payload)),
    )
    return sent


@pytest.fixture
def logged(monkeypatch):
    """Capture the RX-log advert log lines instead of printing them.

    Returns:
        A list that collects each ``meshcore.rx_advert`` line's message,
        severity and metadata.
    """
    lines: list = []

    def record(message, *, context=None, severity="debug", **metadata):
        """Keep the RX-log advert lines and drop every other log line."""
        if context == "meshcore.rx_advert":
            lines.append({"message": message, "severity": severity, **metadata})

    monkeypatch.setattr(config, "_debug_log", record)
    return lines


@pytest.fixture
def replay():
    """Return the replay-memory module (SPEC SG5), imported when a test needs it.

    Imported here rather than at the top so that the handler-level cases
    still run, and fail on their own assertions, against code without it.

    Returns:
        :mod:`data.mesh_ingestor.protocols.meshcore.advert_replay`.
    """
    from data.mesh_ingestor.protocols.meshcore import advert_replay

    return advert_replay


def _hear(frame: dict) -> None:
    """Hand one parsed RX-log frame to the ingestor's ``RX_LOG_DATA`` handler.

    Parameters:
        frame: RX-log payload as the reader dispatches it.
    """
    hmap = _make_event_handlers(_MeshcoreInterface(target=None), "/dev/ttyUSB0")
    asyncio.run(hmap["RX_LOG_DATA"](types.SimpleNamespace(payload=frame)))


def _app_data(name: str) -> bytes:
    """Encode the app data of a companion at :data:`BERLIN` named *name*.

    Parameters:
        name: Advertised node name.

    Returns:
        The encoded app data.
    """
    return frames.advert_app_data(frames.ADV_TYPE_CHAT, name=name, **BERLIN)


def _signature(app_data: bytes, timestamp: int = SENT_AT) -> bytes:
    """Return the victim's own signature over its advert carrying *app_data*.

    Parameters:
        app_data: Encoded app data.
        timestamp: Sender-side advert time the signature covers.

    Returns:
        The 64-byte Ed25519 signature.
    """
    return VICTIM.sign(frames.advert_signed_message(VICTIM_KEY, timestamp, app_data))


def _victim_frame(
    app_data: bytes,
    *,
    signature: bytes | None = None,
    timestamp: int = SENT_AT,
    hops: int = 2,
    snr: float = 9.0,
    rssi: int = -80,
) -> dict:
    """Return the parsed RX-log copy of an advert carrying the victim's key.

    Parameters:
        app_data: Encoded app data the frame carries.
        signature: Signature bytes the frame carries; the victim's genuine
            signature over this frame by default.
        timestamp: Sender-side advert time the frame carries.
        hops: Repeaters this copy travelled.
        snr: Reception SNR of this copy in dB.
        rssi: Reception RSSI of this copy in dBm.

    Returns:
        The parsed frame.
    """
    payload = frames.advert_payload(VICTIM, timestamp, app_data, signature=signature)
    return frames.rx_log_advert(
        payload, recv_time=SENT_AT + 5, snr=snr, rssi=rssi, hops=hops
    )


def _dropped(reason: str, node_id: str = VICTIM_ID) -> list:
    """Return the one log line a dropped advert writes.

    Parameters:
        reason: Why the signature check failed.
        node_id: Node id the advert claimed.

    Returns:
        The expected :func:`logged` entries.
    """
    return [
        {"message": DROPPED, "severity": "debug", "node_id": node_id, "reason": reason}
    ]


FORGED = {
    # An all-zero signature.
    "zeroed": lambda: _victim_frame(_app_data("Mallory"), signature=bytes(64)),
    # The victim's signature over other bytes: its own advert naming Alice.
    "other-bytes": lambda: _victim_frame(
        _app_data("Mallory"), signature=_signature(_app_data("Alice"))
    ),
    # A signature one byte short: the parser reads 64 bytes regardless, so the
    # first app-data byte ends the signature.
    "truncated": lambda: _victim_frame(
        _app_data("Alice"), signature=_signature(_app_data("Alice"))[:63]
    ),
}
"""Adverts carrying the victim's key whose signature does not hold, by case."""


@pytest.mark.parametrize("case", sorted(FORGED))
def test_rx_log_advert_with_an_invalid_signature_is_not_ingested(case, posts, logged):
    """A zeroed signature, one over other bytes or a cut one posts neither a
    node nor a position, and the drop is logged at debug level with the node
    id and the reason."""

    frame = FORGED[case]()
    assert frame["adv_key"] == VICTIM_KEY_HEX

    _hear(frame)

    assert posts == [], f"{case} advert posted {posts}"
    assert logged == _dropped("invalid signature")


def _heard_before(frame: dict) -> dict:
    """Hear *frame* once, so that hearing it again is a replay (SPEC SG5).

    Parameters:
        frame: Parsed RX-log frame of a genuine advert.

    Returns:
        The same frame.
    """
    _hear(frame)
    return frame


COUNTED = {
    # Refused by the signature check: the zeroed signature of FORGED.
    "refused": (FORGED["zeroed"], []),
    # Refused by the replay check: a genuine advert heard once already.
    "replayed": (lambda: _heard_before(_victim_frame(_app_data("Alice"))), []),
    # Let through: the victim's own advert.
    "verified": (
        lambda: _victim_frame(_app_data("Alice")),
        ["/api/nodes", "/api/positions"],
    ),
}
"""Adverts the checks refuse and one they let through, by case: frame, routes."""


@pytest.mark.parametrize("case", sorted(COUNTED))
def test_rx_log_advert_counts_as_air_traffic_once_whether_refused_or_verified(
    case, posts
):
    """Every RX-log advert counts once toward the activity total, before the
    signature and replay checks run (SPEC SG2, SG5, MA1): a refused or
    replayed frame still counts and posts nothing, and a verified one counts
    once and posts as before."""

    build, routes = COUNTED[case]
    frame = build()
    activity.take_packet_count()  # drain what earlier tests and the set-up counted
    posts.clear()

    _hear(frame)

    assert activity.take_packet_count() == 1
    assert [path for path, _payload in posts] == routes


def test_rx_log_advert_with_a_valid_signature_is_ingested(posts, logged):
    """A genuinely signed advert posts its node and its position, as before."""

    _hear(_victim_frame(_app_data("Alice")))

    assert [path for path, _payload in posts] == ["/api/nodes", "/api/positions"]
    user = posts[0][1][VICTIM_ID]["user"]
    assert (user["longName"], user["publicKey"]) == ("Alice", VICTIM_KEY_HEX)
    position = posts[1][1]
    assert (
        position["node_id"],
        position["latitude"],
        position["longitude"],
        position["position_time"],
    ) == (VICTIM_ID, 52.52, 13.405, SENT_AT)
    assert [line["message"] for line in logged] == ["MeshCore RX-log advert"]


def test_rx_log_advert_with_app_data_past_the_signed_32_bytes_is_not_ingested(
    posts, logged
):
    """App data past 32 bytes is outside the signature, so the advert is dropped.

    The firmware never sends more than 32 bytes of app data and verifies only
    the first 32 of a longer frame (``Mesh::onRecvPacket``), while the pinned
    parser reads the name to the end of the frame: the bytes past 32 would
    reach the posted name unsigned.
    """

    app_data = _app_data(LONG_NAME)
    assert len(app_data) == frames.MAX_ADVERT_DATA_SIZE
    signature = _signature(app_data)
    frame = _victim_frame(app_data + b" (not signed)", signature=signature)
    # The firmware's own check passes: it stops reading at 32 bytes.
    VICTIM.public_key().verify(
        signature, frames.advert_signed_message(VICTIM_KEY, SENT_AT, app_data)
    )
    assert frame["adv_name"] == LONG_NAME + " (not signed)"

    _hear(frame)

    assert posts == [], f"advert with unsigned app data posted {posts}"
    assert logged == _dropped("app data over 32 bytes")


def _without(frame: dict, key: str) -> dict:
    """Return a copy of *frame* without *key*.

    Parameters:
        frame: Parsed RX-log frame.
        key: Field to leave out.

    Returns:
        The reduced copy.
    """
    return {name: value for name, value in frame.items() if name != key}


def _with(frame: dict, **fields) -> dict:
    """Return a copy of *frame* with *fields* replaced.

    Parameters:
        frame: Parsed RX-log frame.
        **fields: Fields to set.

    Returns:
        The changed copy.
    """
    return {**frame, **fields}


UNVERIFIABLE = {
    # No raw bytes to check the signature against.
    "no-raw-payload": (
        lambda frame: _without(frame, "pkt_payload"),
        "no raw payload",
        VICTIM_ID,
    ),
    # Raw bytes in a form the check does not read.
    "hex-raw-payload": (
        lambda frame: _with(frame, pkt_payload=frame["pkt_payload"].hex()),
        "no raw payload",
        VICTIM_ID,
    ),
    # Raw bytes that end inside the signature.
    "cut-in-signature": (
        lambda frame: _with(frame, pkt_payload=frame["pkt_payload"][:99]),
        "truncated signature",
        VICTIM_ID,
    ),
    # A parsed key that is not the key the signed bytes carry.
    "other-key": (
        lambda frame: _with(frame, adv_key=OTHER_KEY_HEX),
        "key mismatch",
        "!" + OTHER_KEY_HEX[:8],
    ),
}
"""Parsed fields the signed bytes do not back, by case: change, reason, node id."""


@pytest.mark.parametrize("case", sorted(UNVERIFIABLE))
def test_rx_log_advert_whose_fields_the_signature_does_not_cover_is_not_ingested(
    case, posts, logged
):
    """An advert is posted only when its signature covers the fields posted:
    a frame missing its raw bytes, or whose key differs from theirs, is
    dropped, logged, and raises nothing."""

    change, reason, node_id = UNVERIFIABLE[case]

    _hear(change(_victim_frame(_app_data("Alice"))))

    assert posts == [], f"{case} advert posted {posts}"
    assert logged == _dropped(reason, node_id)


LIMITS = {
    # The most app data the firmware signs: 32 bytes, as parsed.
    "app-data-at-32-bytes": lambda frame: frame,
    # The same raw bytes handed over as a bytearray rather than bytes.
    "bytearray-payload": lambda frame: _with(
        frame, pkt_payload=bytearray(frame["pkt_payload"])
    ),
}
"""Genuine adverts at the edges of what the check reads, by case: change."""


@pytest.mark.parametrize("case", sorted(LIMITS))
def test_rx_log_advert_at_the_limits_of_the_check_is_ingested(case, posts, logged):
    """A genuine advert with 32 bytes of app data verifies and posts, whether
    its raw bytes arrive as bytes or as a bytearray."""

    _hear(LIMITS[case](_victim_frame(_app_data(LONG_NAME))))

    assert [path for path, _payload in posts] == ["/api/nodes", "/api/positions"]
    assert posts[0][1][VICTIM_ID]["user"]["longName"] == LONG_NAME
    assert [line["message"] for line in logged] == ["MeshCore RX-log advert"]


CUT_SHORT = {
    "cut-in-key": 20,
    "cut-in-signature": 70,
    "no-app-data": 100,
}
"""Length a raw advert payload is cut to, by case: inside the 32-byte key,
inside the 64-byte signature, and right after it with no flags byte."""


@pytest.mark.parametrize("case", sorted(CUT_SHORT))
def test_rx_log_advert_cut_short_is_skipped_without_raising(case, posts):
    """An advert cut short parses without a key and is skipped without
    raising, as before the check (RF3)."""

    payload = frames.advert_payload(VICTIM, SENT_AT, _app_data("Alice"))
    frame = frames.rx_log_advert(payload[: CUT_SHORT[case]], recv_time=SENT_AT)
    assert "adv_key" not in frame

    _hear(frame)

    assert posts == []


# ---------------------------------------------------------------------------
# SPEC SG4: no key of small order
# ---------------------------------------------------------------------------

SMALL_ORDER = {
    "zero": "00" * 32,
    "one": "01" + "00" * 31,
    "order-8-26e8": "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
    "order-8-c717": "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
    "p-minus-1": "ec" + "ff" * 30 + "7f",
    "p": "ed" + "ff" * 30 + "7f",
    "p-plus-1": "ee" + "ff" * 30 + "7f",
}
"""libsodium's small-order blocklist (``ge25519_has_small_order``), by case."""


def _sign_bit_set(key: bytes) -> bytes:
    """Return *key* with the top bit of byte 31, the sign of x, set.

    Parameters:
        key: A 32-byte public-key encoding.

    Returns:
        The sign-bit variant.
    """
    return key[:31] + bytes([key[31] | 0x80])


SMALL_ORDER_KEYS = {
    **{name: bytes.fromhex(key) for name, key in SMALL_ORDER.items()},
    **{
        f"{name}-sign-bit": _sign_bit_set(bytes.fromhex(key))
        for name, key in SMALL_ORDER.items()
    },
}
"""Every listed encoding and its sign-bit variant, by case: 14 keys."""

IDENTITY_SIGNATURE = b"\x01" + bytes(31) + bytes(32)
"""The signature ``R = identity, S = 0``, which small-order keys can verify."""


def _small_order_frame(key: bytes) -> dict:
    """Return the parsed RX-log copy of an advert naming Mallory under *key*.

    Parameters:
        key: The 32 bytes the frame carries as its public key.

    Returns:
        The parsed frame, signed with :data:`IDENTITY_SIGNATURE`.
    """
    payload = frames.advert_payload_bytes(
        key, SENT_AT, IDENTITY_SIGNATURE, _app_data("Mallory")
    )
    return frames.rx_log_advert(
        payload, recv_time=SENT_AT + 5, snr=9.0, rssi=-80, hops=2
    )


def test_small_order_blocklist_is_every_encoding_of_the_eight_torsion():
    """The blocklist holds libsodium's seven values, and they are exactly the
    encodings of the eight points of order dividing 8 that the RFC 8032
    curve constants give, sign bit cleared (SPEC SG4)."""
    from data.mesh_ingestor.protocols.meshcore.advert_signature import (
        _SMALL_ORDER_KEYS,
    )

    listed = {bytes.fromhex(key) for key in SMALL_ORDER.values()}
    assert _SMALL_ORDER_KEYS == listed == ed25519_oracle.small_order_encodings()


@pytest.mark.parametrize("case", sorted(SMALL_ORDER_KEYS))
def test_rx_log_advert_with_a_small_order_key_is_not_ingested(case, posts, logged):
    """A key of small order posts nothing, whichever listed encoding and sign
    bit it carries, and logs reason ``small-order key`` (SPEC SG4)."""

    key = SMALL_ORDER_KEYS[case]

    _hear(_small_order_frame(key))

    assert posts == [], f"{case} advert posted {posts}"
    assert logged == _dropped("small-order key", "!" + key[:4].hex())


@pytest.mark.parametrize("case", ["one", "one-sign-bit"])
def test_rx_log_advert_small_order_key_is_refused_though_openssl_accepts_it(
    case, posts, logged
):
    """OpenSSL verifies the identity key's trivial signature over any message,
    also as ``01 00..00 80``, which the firmware's decoder refuses: without
    SG4 both adverts would post."""

    key = SMALL_ORDER_KEYS[case]
    message = frames.advert_signed_message(key, SENT_AT, _app_data("Mallory"))
    Ed25519PublicKey.from_public_bytes(key).verify(IDENTITY_SIGNATURE, message)

    _hear(_small_order_frame(key))

    assert posts == []
    assert logged == _dropped("small-order key", "!01000000")


def test_rx_log_advert_with_an_ordinary_key_passes_the_small_order_check(posts, logged):
    """An ordinary key passes, even with its sign bit set, as the victim's is:
    the masked comparison matches only the seven listed values (SPEC SG4)."""

    assert VICTIM_KEY[31] & 0x80

    _hear(_victim_frame(_app_data("Alice")))

    assert [path for path, _payload in posts] == ["/api/nodes", "/api/positions"]
    assert [line["message"] for line in logged] == ["MeshCore RX-log advert"]


# ---------------------------------------------------------------------------
# SPEC SG5: newer than the last advert accepted for the key
# ---------------------------------------------------------------------------

REPLAYS = {
    # The same advert again, over four repeaters instead of two.
    "same-advert-other-path": (SENT_AT, 4, []),
    # An older advert of the same node.
    "older-advert": (SENT_AT - 60, 2, []),
    # A newer advert of the same node.
    "newer-advert": (SENT_AT + 60, 2, ["/api/nodes", "/api/positions"]),
}
"""A second advert after one accepted at SENT_AT, by case: time, hops, routes."""


@pytest.mark.parametrize("case", sorted(REPLAYS))
def test_replay_check_needs_a_timestamp_newer_than_the_last_accepted(
    case, posts, logged
):
    """After one advert is accepted, a copy of it over another path or an
    older advert posts nothing and logs reason ``replayed advert``; a newer
    advert posts as usual (SPEC SG5)."""

    timestamp, hops, routes = REPLAYS[case]
    _hear(_victim_frame(_app_data("Alice")))
    posts.clear()
    logged.clear()

    _hear(_victim_frame(_app_data("Alice"), timestamp=timestamp, hops=hops))

    assert [path for path, _payload in posts] == routes
    if routes:
        assert [line["message"] for line in logged] == ["MeshCore RX-log advert"]
    else:
        assert logged == _dropped("replayed advert")


def test_replay_check_keeps_the_first_receptions_signal(posts, logged):
    """Of two copies of one advert only the first reaches the web, so the
    node keeps that copy's SNR, RSSI and hop count (SPEC SG5)."""

    _hear(_victim_frame(_app_data("Alice"), hops=1, snr=9.0, rssi=-80))
    _hear(_victim_frame(_app_data("Alice"), hops=5, snr=-3.5, rssi=-118))

    nodes = [payload[VICTIM_ID] for path, payload in posts if path == "/api/nodes"]
    assert [(n["snr"], n["rssi"], n["hopsAway"]) for n in nodes] == [(9.0, -80, 1)]
    assert logged[-1] == _dropped("replayed advert")[0]


def test_refused_rx_log_advert_leaves_the_replay_memory_alone(posts, logged):
    """Only a verified advert is remembered: a forged one with a far-future
    timestamp cannot refuse the genuine advert that follows (SPEC SG5)."""

    _hear(
        _victim_frame(
            _app_data("Mallory"), timestamp=SENT_AT + 10**8, signature=bytes(64)
        )
    )
    _hear(_victim_frame(_app_data("Alice")))

    assert [path for path, _payload in posts] == ["/api/nodes", "/api/positions"]
    assert [line.get("reason") for line in logged] == ["invalid signature", None]


def test_replay_memory_is_empty_after_a_restart(posts, logged, replay):
    """The memory lives in the process: after a restart the first advert of a
    key heard only in the RX log passes again, and a repeat of it is refused
    again (SPEC SG5).  A roster contact's key is reloaded by the startup
    roster fetch instead (:func:`test_replay_memory_takes_a_listed_contacts_last_advert`).
    """

    frame = _victim_frame(_app_data("Alice"))
    _hear(frame)
    replay._reset_replay_memory()  # what a restart does
    _hear(frame)
    _hear(frame)

    assert [path for path, _payload in posts] == ["/api/nodes", "/api/positions"] * 2
    assert [line.get("reason") for line in logged] == [None, None, "replayed advert"]


def test_replay_memory_holds_4096_keys(replay):
    """The RX-log cap is pinned: more than ten times the largest companion
    roster."""

    assert replay._REPLAY_MEMORY_CAP == 4096


def test_replay_memory_holds_1024_roster_keys(replay):
    """The roster cap is pinned: about three times the largest companion
    roster."""

    assert replay._ROSTER_MEMORY_CAP == 1024


def test_replay_memory_forgets_the_least_recently_accepted_key_past_its_cap(
    monkeypatch, replay
):
    """Past its cap the RX-log pool forgets the least recently accepted key,
    whose next advert passes as after a restart (SPEC SG5)."""

    monkeypatch.setattr(replay, "_REPLAY_MEMORY_CAP", 2)
    accept = replay._accept_advert_timestamp

    assert accept("aa", 10) and accept("bb", 10)
    assert accept("aa", 11)  # aa is now the most recently accepted
    assert accept("cc", 10)  # over the cap: bb, the least recent, is forgotten
    assert accept("bb", 10)  # bb passes again, and aa is forgotten in turn
    assert not accept("cc", 10)
    assert accept("aa", 5)


def test_replay_memory_backstop_evicts_only_keys_the_full_listing_lacks(
    monkeypatch, replay
):
    """Past its backstop cap the roster pool hands the least recently
    refreshed key that the latest full listing lacks to the RX-log pool, and
    never a key of that listing, even when the listing alone exceeds the cap;
    a key that leaves keeps its timestamp (SPEC SG5)."""

    monkeypatch.setattr(replay, "_ROSTER_MEMORY_CAP", 2)
    listing = replay._take_roster_listing

    listing({"aa": 10}, full=True)
    listing({"bb": 10}, full=False)
    listing({"cc": 10}, full=False)  # over the cap: bb leaves, listed aa stays
    assert list(replay._roster) == ["aa", "cc"]
    assert dict(replay._heard) == {"bb": 10}
    listing({"dd": 10, "ee": 10, "ff": 10}, full=True)  # larger than the cap
    assert list(replay._roster) == ["dd", "ee", "ff"]
    assert not replay._accept_advert_timestamp("aa", 10)  # left, time kept
    assert not replay._accept_advert_timestamp("dd", 10)


def _connect() -> dict:
    """Return the event-handler map of a new connection, as the runner builds it.

    Returns:
        The handler map; its first ``CONTACTS`` listing counts as the full roster.
    """
    return _make_event_handlers(_MeshcoreInterface(target=None), "/dev/ttyUSB0")


def _contact(
    last_advert: object, key_hex: str = VICTIM_KEY_HEX, name: str = "Alice"
) -> dict:
    """Return a roster contact as the meshcore library reports it.

    Parameters:
        last_advert: The contact's ``last_advert`` field.
        key_hex: The contact's public key as hex.
        name: The contact's advertised name.

    Returns:
        The contact dict.
    """
    return {
        "public_key": key_hex,
        "type": frames.ADV_TYPE_CHAT,
        "adv_name": name,
        "last_advert": last_advert,
    }


def _list_contacts(hmap: dict, *contacts: dict) -> None:
    """Deliver one ``CONTACTS`` listing of *contacts* to a connection's handlers.

    Parameters:
        hmap: The connection's handler map from :func:`_connect`.
        *contacts: The listed contacts.
    """
    payload = {contact["public_key"]: contact for contact in contacts}
    asyncio.run(hmap["CONTACTS"](types.SimpleNamespace(payload=payload)))


def _push(hmap: dict, event: str, contact: dict) -> None:
    """Deliver one ``NEW_CONTACT`` or ``NEXT_CONTACT`` event to a connection.

    Parameters:
        hmap: The connection's handler map from :func:`_connect`.
        event: ``"NEW_CONTACT"`` or ``"NEXT_CONTACT"``.
        contact: The contact the event carries.
    """
    asyncio.run(hmap[event](types.SimpleNamespace(payload=contact)))


LISTED = {
    # The connection's first listing: the radio's whole roster.
    "first-listing": lambda hmap: _list_contacts(hmap, _contact(SENT_AT)),
    # A later listing, the auto-update re-fetch of changed contacts.
    "later-listing": lambda hmap: (
        _list_contacts(hmap, _contact(SENT_AT, OTHER_KEY_HEX, "Bob")),
        _list_contacts(hmap, _contact(SENT_AT)),
    ),
}
"""Ways the radio lists the victim as a roster contact, by case."""


@pytest.mark.parametrize("case", sorted(LISTED))
def test_replay_memory_takes_a_listed_contacts_last_advert(case, posts, logged):
    """A contact the radio lists, in a connection's first listing or a later
    one, refuses an RX-log copy of its last advert, also right after a
    restart, and lets a newer advert through (SPEC SG5)."""

    LISTED[case](_connect())
    posts.clear()

    _hear(_victim_frame(_app_data("Alice")))
    _hear(_victim_frame(_app_data("Alice"), timestamp=SENT_AT + 60))

    assert [path for path, _payload in posts] == ["/api/nodes", "/api/positions"]
    assert [line.get("reason") for line in logged] == ["replayed advert", None]


def test_replay_memory_takes_no_key_from_a_new_contact_push(posts, replay):
    """The radio pushes ``NEW_CONTACT`` for an advert from a key it did not
    add to its roster, so the push adds nothing to the roster pool, and that
    key's RX-log advert, new to the memory, posts (SPEC SG5)."""

    hmap = _connect()
    _list_contacts(hmap)  # the connection's first listing: an empty roster
    _push(hmap, "NEW_CONTACT", _contact(SENT_AT))
    posts.clear()

    _hear(_victim_frame(_app_data("Alice")))

    assert VICTIM_KEY_HEX not in replay._roster
    assert [path for path, _payload in posts] == ["/api/nodes", "/api/positions"]


def test_replay_memory_keeps_a_roster_key_through_a_new_contact_flood(
    posts, logged, replay
):
    """1025 new keys, each delivered as the radio delivers an advert it does
    not add (``RX_LOG_DATA``, then ``NEW_CONTACT``), leave a listed contact's
    key in the roster pool, so a replay of its advert is refused (SPEC SG5)."""

    hmap = _connect()
    _list_contacts(hmap, _contact(SENT_AT))
    for n in range(replay._ROSTER_MEMORY_CAP + 1):
        key = frames.advert_key(f"potato-mesh test advertiser: flood {n}")
        payload = frames.advert_payload(key, SENT_AT, _app_data(f"Flood {n}"))
        _hear(frames.rx_log_advert(payload, recv_time=SENT_AT + 5))
        key_hex = frames.advert_public_key(key).hex()
        _push(hmap, "NEW_CONTACT", _contact(SENT_AT, key_hex, f"Flood {n}"))
    posts.clear()
    logged.clear()

    _hear(_victim_frame(_app_data("Alice")))

    assert posts == [], f"replay posted {posts}"
    assert logged == _dropped("replayed advert")
    # The flood keys stayed in the RX-log pool; the roster pool holds the victim.
    assert list(replay._roster) == [VICTIM_KEY_HEX]
    assert len(replay._heard) == replay._ROSTER_MEMORY_CAP + 1


def test_replay_memory_drops_a_key_the_next_full_listing_lacks(posts, logged, replay):
    """A connection's first listing replaces the membership: a key it lacks
    leaves the roster pool and becomes an ordinary RX-log-pool entry that
    keeps its timestamp.  A later listing that omits a member keeps it, as
    such a listing names only the contacts changed since (SPEC SG5)."""

    first = _connect()
    _list_contacts(first, _contact(SENT_AT), _contact(SENT_AT, OTHER_KEY_HEX, "Bob"))
    _list_contacts(first, _contact(SENT_AT, THIRD_KEY_HEX, "Carol"))
    assert set(replay._roster) == {VICTIM_KEY_HEX, OTHER_KEY_HEX, THIRD_KEY_HEX}

    second = _connect()  # a reconnect: its first listing is the whole roster
    _list_contacts(second, _contact(SENT_AT, OTHER_KEY_HEX, "Bob"))
    assert set(replay._roster) == {OTHER_KEY_HEX}
    assert replay._heard[VICTIM_KEY_HEX] == SENT_AT
    posts.clear()

    _hear(_victim_frame(_app_data("Alice")))

    assert posts == []
    assert logged == _dropped("replayed advert")


def test_replay_memory_timestamps_only_rise(posts, logged, replay):
    """Listings, ``NEW_CONTACT``, ``NEXT_CONTACT`` and accepted RX-log adverts
    only ever raise a key's remembered timestamp (SPEC SG5)."""

    hmap = _connect()
    _list_contacts(hmap, _contact(SENT_AT + 60))
    _push(hmap, "NEXT_CONTACT", _contact(SENT_AT))  # older: no change
    _list_contacts(hmap, _contact(SENT_AT))  # an older later listing: no change
    assert replay._roster[VICTIM_KEY_HEX] == SENT_AT + 60
    _push(hmap, "NEW_CONTACT", _contact(SENT_AT + 120))  # newer: raised
    assert replay._roster[VICTIM_KEY_HEX] == SENT_AT + 120

    _hear(_victim_frame(_app_data("Alice"), timestamp=SENT_AT + 90))
    _hear(_victim_frame(_app_data("Alice"), timestamp=SENT_AT + 180))
    _list_contacts(_connect(), _contact(SENT_AT + 120))  # the next connection

    assert replay._roster[VICTIM_KEY_HEX] == SENT_AT + 180
    assert [line.get("reason") for line in logged] == ["replayed advert", None]


@pytest.mark.parametrize("last_advert", [None, "1891288000"], ids=["none", "string"])
def test_replay_memory_ignores_a_listed_contact_without_an_integer_time(
    last_advert, posts, replay
):
    """A listed contact without an integer ``last_advert`` joins nothing and
    a contact event carrying one raises nothing, so the next RX-log advert
    passes and nothing raises (SPEC SG5)."""

    hmap = _connect()
    _list_contacts(hmap, _contact(last_advert))
    _push(hmap, "NEXT_CONTACT", _contact(last_advert))
    posts.clear()

    _hear(_victim_frame(_app_data("Alice")))

    assert VICTIM_KEY_HEX not in replay._roster
    assert [path for path, _payload in posts] == ["/api/nodes", "/api/positions"]


FLOODED = {
    # Listed by the radio: the flood cannot push the key out, so a replay of
    # the advert is refused.
    "roster-contact": (lambda: _list_contacts(_connect(), _contact(SENT_AT)), []),
    # Heard only in the RX log: the flood pushes the key out, so a replay of
    # the advert posts once (the limit SPEC SG5 states).
    "rx-log-only": (
        lambda: _hear(_victim_frame(_app_data("Alice"))),
        ["/api/nodes", "/api/positions"],
    ),
}
"""How the victim's advert at SENT_AT was remembered, by case: how, and the
routes a replay of it posts after the flood."""


@pytest.mark.parametrize("case", sorted(FLOODED))
def test_replay_memory_through_a_flood_of_adverts_from_new_keys(
    case, posts, logged, replay
):
    """4097 verified adverts from new keys overflow the RX-log pool: a key the
    radio listed stays, so a replay of its advert is refused, while a silent
    node known only from the RX log is forgotten and a replay of its advert
    posts (SPEC SG5).  The flood goes straight to the memory, as the handler
    hands it each verified advert."""

    remember, routes = FLOODED[case]
    remember()
    for n in range(replay._REPLAY_MEMORY_CAP + 1):
        assert replay._accept_advert_timestamp(f"{n:064x}", SENT_AT)
    posts.clear()
    logged.clear()

    _hear(_victim_frame(_app_data("Alice")))

    assert [path for path, _payload in posts] == routes
    if routes:
        assert [line["message"] for line in logged] == ["MeshCore RX-log advert"]
    else:
        assert logged == _dropped("replayed advert")
