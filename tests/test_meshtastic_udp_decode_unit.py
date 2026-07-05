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
"""Unit tests for :mod:`data.mesh_ingestor.protocols.meshtastic_udp_decode`.

Two layers of coverage:

1. **Real-fixture tests** replay 32 genuine Meshtastic multicast datagrams
   captured from a live Station G2 (``tests/fixtures/mesh_udp``) and assert
   the decrypt heuristic accepts exactly the 21 primary-channel packets and
   drops exactly the 11 private-channel packets, with the mapping producing
   sane, round-trippable output for every accepted packet.
2. **Synthetic tests** build encrypted packets in-process to exercise every
   line and branch of the module (key expansion edge cases, decrypt failure
   paths, and every optional field in the packet-dict mapping).
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import sys
import time
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from meshtastic.protobuf import mesh_pb2, portnums_pb2

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from data.mesh_ingestor.protocols import meshtastic_udp_decode as udp

DEFAULT_KEY = "AQ=="
"""Base64 form of the Meshtastic default 1-byte primary-channel PSK."""

FIXTURE_PATH = os.path.join(
    os.path.dirname(__file__),
    "fixtures",
    "mesh_udp",
    "primary_and_private_capture.jsonl",
)
"""Path to the real captured-datagram fixture, resolved relative to this file."""

EXPECTED_PORTNUMS = {
    "POSITION_APP",
    "TELEMETRY_APP",
    "TEXT_MESSAGE_APP",
    "TRACEROUTE_APP",
    "NODEINFO_APP",
    "ROUTING_APP",
}
"""Portnums documented in the fixture README as present on the primary channel."""


def _encrypt(data: "mesh_pb2.Data", mp: "mesh_pb2.MeshPacket", key_b64: str) -> bytes:
    """Encrypt *data* the same way a Meshtastic node would for *mp*.

    Mirrors the production nonce construction (``id`` then ``from``, both
    little-endian 8-byte) so tests can build round-trippable fixtures without
    importing any private module internals.
    """
    key = udp.expand_default_key(key_b64)
    nonce = mp.id.to_bytes(8, "little") + getattr(mp, "from").to_bytes(8, "little")
    enc = Cipher(algorithms.AES(key), modes.CTR(nonce)).encryptor()
    return enc.update(data.SerializeToString()) + enc.finalize()


def _load_fixture_packets() -> list["mesh_pb2.MeshPacket"]:
    """Parse every line of the real-capture fixture into a ``MeshPacket``."""
    packets = []
    with open(FIXTURE_PATH, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            raw = base64.b64decode(record["raw_b64"])
            mp = mesh_pb2.MeshPacket()
            mp.ParseFromString(raw)
            packets.append(mp)
    return packets


# ---------------------------------------------------------------------------
# Real-fixture tests
# ---------------------------------------------------------------------------


class TestRealCaptureFixture:
    """Replays genuine captured datagrams through the decode pipeline."""

    def test_all_datagrams_parse_as_meshpacket(self):
        """All 32 captured datagrams parse cleanly as ``MeshPacket``."""
        packets = _load_fixture_packets()
        assert len(packets) == 32

    def test_decrypt_accepts_primary_and_drops_private(self):
        """Decrypt accepts exactly the 21 channel-31 packets, drops the rest."""
        packets = _load_fixture_packets()
        accepted = 0
        dropped = 0
        for mp in packets:
            data = udp.decrypt_meshpacket(mp, DEFAULT_KEY)
            if mp.channel == 31:
                assert data is not None
                accepted += 1
            else:
                assert data is None
                dropped += 1
        assert accepted == 21
        assert dropped == 11

    def test_accepted_packets_map_to_known_portnums_and_roundtrip_payload(self):
        """Every accepted packet maps to a known portnum with a round-trippable payload."""
        packets = _load_fixture_packets()
        seen_portnums = set()
        accepted_count = 0
        for mp in packets:
            data = udp.decrypt_meshpacket(mp, DEFAULT_KEY)
            if data is None:
                continue
            accepted_count += 1
            mp.decoded.CopyFrom(data)
            packet_dict = udp.meshpacket_to_packet_dict(mp)
            portnum_name = packet_dict["decoded"]["portnum"]
            assert isinstance(portnum_name, str) and portnum_name
            assert base64.b64decode(packet_dict["decoded"]["payload"]) == data.payload
            seen_portnums.add(portnum_name)
        assert accepted_count == 21
        assert seen_portnums <= EXPECTED_PORTNUMS


# ---------------------------------------------------------------------------
# expand_default_key
# ---------------------------------------------------------------------------


class TestExpandDefaultKey:
    """Tests for :func:`expand_default_key`."""

    def test_one_byte_psk_expands_to_16_bytes(self):
        """A 1-byte PSK in range 0x01..0x07 is prefixed to a 16-byte AES key."""
        key = udp.expand_default_key(DEFAULT_KEY)
        assert len(key) == 16
        assert key.hex().endswith("01")
        assert key == bytes.fromhex("d4f1bb3a20290759f0bcffabcf4e69") + b"\x01"

    def test_multi_byte_key_passthrough(self):
        """A key that already decodes to more than 1 byte is returned as-is."""
        raw = b"\x00" * 16
        key_b64 = base64.b64encode(raw).decode()
        assert udp.expand_default_key(key_b64) == raw

    def test_one_byte_out_of_range_passthrough(self):
        """A 1-byte value outside 0x01..0x07 is NOT treated as a default PSK."""
        raw = b"\x08"
        key_b64 = base64.b64encode(raw).decode()
        assert udp.expand_default_key(key_b64) == raw
        assert len(udp.expand_default_key(key_b64)) == 1

    def test_bad_base64_raises(self):
        """Malformed base64 propagates a decode error to the caller."""
        with pytest.raises(binascii.Error):
            udp.expand_default_key("not-valid-base64!!!")


# ---------------------------------------------------------------------------
# decrypt_meshpacket
# ---------------------------------------------------------------------------


class TestDecryptMeshpacket:
    """Tests for :func:`decrypt_meshpacket`."""

    def test_round_trip_text(self):
        """A packet encrypted with the default key decrypts back to its payload."""
        mp = mesh_pb2.MeshPacket()
        mp.id = 0x1234
        setattr(mp, "from", 0x849B7154)
        data = mesh_pb2.Data(
            portnum=portnums_pb2.PortNum.TEXT_MESSAGE_APP, payload=b"hi"
        )
        mp.encrypted = _encrypt(data, mp, DEFAULT_KEY)

        out = udp.decrypt_meshpacket(mp, DEFAULT_KEY)

        assert out is not None
        assert out.payload == b"hi"
        assert out.portnum == portnums_pb2.PortNum.TEXT_MESSAGE_APP

    def test_wrong_key_returns_none_deterministically(self):
        """Decrypting with an incorrect (but well-formed) key returns ``None``.

        Both the plaintext and the wrong key are fixed constants, so AES-CTR
        (a deterministic stream cipher) always produces the same garbage
        bytes on every run/platform -- this test carries no random or
        time-based inputs and is fully reproducible.
        """
        mp = mesh_pb2.MeshPacket()
        mp.id = 1
        setattr(mp, "from", 2)
        data = mesh_pb2.Data(
            portnum=portnums_pb2.PortNum.NODEINFO_APP, payload=b"\x08\x01"
        )
        mp.encrypted = _encrypt(data, mp, DEFAULT_KEY)

        other_key = base64.b64encode(b"\x00" * 16).decode()

        # Re-run to demonstrate the result is stable, not flaky.
        for _ in range(3):
            assert udp.decrypt_meshpacket(mp, other_key) is None

    def test_decrypt_failure_path_returns_none_on_bad_key(self):
        """An invalid key string is caught internally and yields ``None``."""
        mp = mesh_pb2.MeshPacket()
        mp.id = 7
        setattr(mp, "from", 8)
        data = mesh_pb2.Data(
            portnum=portnums_pb2.PortNum.TEXT_MESSAGE_APP, payload=b"hi"
        )
        mp.encrypted = _encrypt(data, mp, DEFAULT_KEY)

        assert udp.decrypt_meshpacket(mp, "not-valid-base64!!!") is None

    def test_empty_decoded_data_is_treated_as_private_channel(self):
        """A cleanly-parsed but empty ``Data`` (portnum 0, no payload) is dropped."""
        mp = mesh_pb2.MeshPacket()
        mp.id = 55
        setattr(mp, "from", 66)
        data = mesh_pb2.Data()  # all defaults: portnum == 0, payload == b""
        mp.encrypted = _encrypt(data, mp, DEFAULT_KEY)

        assert udp.decrypt_meshpacket(mp, DEFAULT_KEY) is None

    def test_zero_portnum_with_payload_is_not_dropped(self):
        """Portnum 0 with a non-empty payload is NOT treated as private-channel noise."""
        mp = mesh_pb2.MeshPacket()
        mp.id = 42
        setattr(mp, "from", 99)
        data = mesh_pb2.Data(portnum=0, payload=b"x")
        mp.encrypted = _encrypt(data, mp, DEFAULT_KEY)

        out = udp.decrypt_meshpacket(mp, DEFAULT_KEY)

        assert out is not None
        assert out.payload == b"x"


# ---------------------------------------------------------------------------
# _node_id
# ---------------------------------------------------------------------------


class TestNodeId:
    """Tests for the private :func:`_node_id` helper."""

    def test_broadcast_num_maps_to_all(self):
        """The reserved broadcast address maps to ``^all``."""
        assert udp._node_id(0xFFFFFFFF) == "^all"

    def test_unicast_num_maps_to_bang_hex(self):
        """A regular node number maps to canonical ``!xxxxxxxx`` form."""
        assert udp._node_id(0x849B7154) == "!849b7154"

    def test_masks_to_32_bits(self):
        """Values outside the 32-bit range are masked before formatting."""
        assert udp._node_id(0x1_849B7154) == "!849b7154"


# ---------------------------------------------------------------------------
# meshpacket_to_packet_dict
# ---------------------------------------------------------------------------


class TestMeshpacketToPacketDict:
    """Tests for :func:`meshpacket_to_packet_dict`."""

    def test_text_sets_decoded_text_and_broadcast_to(self):
        """A text packet gets a decoded ``text`` field and broadcast ``toId``."""
        mp = mesh_pb2.MeshPacket()
        mp.id = 9
        setattr(mp, "from", 0x849B7154)
        mp.to = 0xFFFFFFFF
        mp.decoded.portnum = portnums_pb2.PortNum.TEXT_MESSAGE_APP
        mp.decoded.payload = "Guten Morgen!".encode("utf-8")

        d = udp.meshpacket_to_packet_dict(mp)

        assert d["from"] == 0x849B7154
        assert d["fromId"] == "!849b7154"
        assert d["to"] == 0xFFFFFFFF
        assert d["toId"] == "^all"
        assert d["id"] == 9
        assert d["channel"] == 0
        assert d["decoded"]["portnum"] == "TEXT_MESSAGE_APP"
        assert d["decoded"]["text"] == "Guten Morgen!"
        assert base64.b64decode(d["decoded"]["payload"]) == "Guten Morgen!".encode(
            "utf-8"
        )

    def test_text_payload_invalid_utf8_is_replaced_not_raised(self):
        """Non-UTF-8 bytes in a text payload are decoded with replacement, not raised."""
        mp = mesh_pb2.MeshPacket()
        mp.id = 10
        setattr(mp, "from", 1)
        mp.to = 2
        mp.decoded.portnum = portnums_pb2.PortNum.TEXT_MESSAGE_APP
        mp.decoded.payload = b"\xff\xfe"

        d = udp.meshpacket_to_packet_dict(mp)

        assert "�" in d["decoded"]["text"]

    def test_non_text_sets_base64_payload_and_unicast_to(self):
        """A non-text portnum does not get a ``text`` field; ``toId`` is unicast."""
        mp = mesh_pb2.MeshPacket()
        mp.id = 5
        setattr(mp, "from", 0x111)
        mp.to = 0x222
        mp.decoded.portnum = portnums_pb2.PortNum.NODEINFO_APP
        mp.decoded.payload = b"\x08\x01"

        d = udp.meshpacket_to_packet_dict(mp)

        assert base64.b64decode(d["decoded"]["payload"]) == b"\x08\x01"
        assert d["toId"] == "!00000222"
        assert "text" not in d["decoded"]

    def test_optional_fields_absent_when_falsy(self):
        """``rxSnr``/``rxRssi``/``hopLimit`` are omitted when the source field is falsy."""
        mp = mesh_pb2.MeshPacket()
        mp.id = 1
        setattr(mp, "from", 1)
        mp.to = 2
        mp.decoded.portnum = portnums_pb2.PortNum.ROUTING_APP
        mp.decoded.payload = b""

        d = udp.meshpacket_to_packet_dict(mp)

        assert "rxSnr" not in d
        assert "rxRssi" not in d
        assert "hopLimit" not in d

    def test_optional_fields_present_when_truthy(self):
        """``rxSnr``/``rxRssi``/``hopLimit`` are included when the source field is set."""
        mp = mesh_pb2.MeshPacket()
        mp.id = 1
        setattr(mp, "from", 1)
        mp.to = 2
        mp.decoded.portnum = portnums_pb2.PortNum.ROUTING_APP
        mp.decoded.payload = b""
        mp.rx_snr = 7.5
        mp.rx_rssi = -42
        mp.hop_limit = 3

        d = udp.meshpacket_to_packet_dict(mp)

        assert d["rxSnr"] == pytest.approx(7.5)
        assert d["rxRssi"] == -42
        assert d["hopLimit"] == 3

    def test_rx_time_present_uses_packet_value(self):
        """A non-zero ``rx_time`` on the packet is used verbatim."""
        mp = mesh_pb2.MeshPacket()
        mp.id = 1
        setattr(mp, "from", 1)
        mp.to = 2
        mp.decoded.portnum = portnums_pb2.PortNum.ROUTING_APP
        mp.decoded.payload = b""
        mp.rx_time = 1717000000

        d = udp.meshpacket_to_packet_dict(mp)

        assert d["rxTime"] == 1717000000

    def test_rx_time_absent_falls_back_to_now(self, monkeypatch):
        """A zero (unset) ``rx_time`` falls back to the current wall-clock time."""
        mp = mesh_pb2.MeshPacket()
        mp.id = 1
        setattr(mp, "from", 1)
        mp.to = 2
        mp.decoded.portnum = portnums_pb2.PortNum.ROUTING_APP
        mp.decoded.payload = b""
        assert mp.rx_time == 0

        monkeypatch.setattr(udp.time, "time", lambda: 1234567890.0)

        d = udp.meshpacket_to_packet_dict(mp)

        assert d["rxTime"] == 1234567890


class TestXorHash:
    """Tests for the private :func:`_xor_hash` byte-fold helper."""

    def test_empty_is_zero(self):
        """The XOR-fold of no bytes is 0."""
        assert udp._xor_hash(b"") == 0

    def test_single_byte_is_itself(self):
        """The XOR-fold of one byte is that byte."""
        assert udp._xor_hash(b"\x2a") == 0x2A

    def test_multiple_bytes_fold(self):
        """0x01 ^ 0x02 ^ 0x04 == 0x07."""
        assert udp._xor_hash(b"\x01\x02\x04") == 0x07

    def test_repeated_byte_cancels(self):
        """A byte XOR-ed with itself cancels to 0."""
        assert udp._xor_hash(b"\xab\xab") == 0


class TestChannelHash:
    """Tests for :func:`channel_hash`, the Meshtastic ``generateHash`` mirror."""

    def test_mediumfast_default_key_is_31(self):
        """The real RGW1 primary (MediumFast + AQ==) hashes to 31 (0x1F).

        This value is cross-checked against the 21 primary-channel datagrams in
        the real-capture fixture, every one of which carries channel hash 31.
        """
        assert udp.channel_hash("MediumFast", "AQ==") == 31

    def test_longfast_default_key_is_8(self):
        """The Meshtastic global default (LongFast + AQ==) hashes to 8."""
        assert udp.channel_hash("LongFast", "AQ==") == 8

    def test_empty_name_is_key_hash_only(self):
        """A blank name contributes 0, so the hash is the key's XOR-fold alone."""
        key_hash = udp._xor_hash(udp.expand_default_key("AQ=="))
        assert udp.channel_hash("", "AQ==") == key_hash

    def test_same_key_different_names_differ(self):
        """Two channels sharing the default key still hash differently by name.

        This is the property that lets the UDP transport separate a PRIMARY
        channel from a SECONDARY channel that was created with the same default
        ``AQ==`` key: decryptability is identical, but the hashes differ.
        """
        assert udp.channel_hash("MediumFast", "AQ==") != udp.channel_hash(
            "Private", "AQ=="
        )

    def test_matches_manual_xor_formula(self):
        """channel_hash == xorHash(name) ^ xorHash(expanded_key)."""
        name, key = "ShortFast", "AQ=="
        expected = udp._xor_hash(name.encode("utf-8")) ^ udp._xor_hash(
            udp.expand_default_key(key)
        )
        assert udp.channel_hash(name, key) == expected


class TestEnrichDecoded:
    """Tests that :func:`meshpacket_to_packet_dict` reproduces the library's
    decoded sub-dicts so downstream handlers behave identically to the API path.
    """

    def test_position_payload_enriched_with_coordinates(self):
        """A POSITION packet gains a ``decoded['position']`` with scaled coords."""
        from meshtastic.protobuf import mesh_pb2 as m

        pos = m.Position(latitude_i=449052672, longitude_i=-932446208, altitude=265)
        mp = mesh_pb2.MeshPacket()
        mp.id = 1
        setattr(mp, "from", 0xABCCBB6C)
        mp.to = 0xFFFFFFFF
        mp.decoded.portnum = portnums_pb2.PortNum.POSITION_APP
        mp.decoded.payload = pos.SerializeToString()

        d = udp.meshpacket_to_packet_dict(mp)

        assert "position" in d["decoded"]
        assert d["decoded"]["position"]["latitudeI"] == 449052672
        assert d["decoded"]["position"]["longitudeI"] == -932446208

    def test_telemetry_payload_enriched(self):
        """A TELEMETRY packet gains a ``decoded['telemetry']`` section."""
        from meshtastic.protobuf import telemetry_pb2

        tel = telemetry_pb2.Telemetry(
            device_metrics=telemetry_pb2.DeviceMetrics(battery_level=87, voltage=4.1)
        )
        mp = mesh_pb2.MeshPacket()
        mp.id = 2
        setattr(mp, "from", 1)
        mp.to = 0xFFFFFFFF
        mp.decoded.portnum = portnums_pb2.PortNum.TELEMETRY_APP
        mp.decoded.payload = tel.SerializeToString()

        d = udp.meshpacket_to_packet_dict(mp)

        assert "telemetry" in d["decoded"]
        assert d["decoded"]["telemetry"]["deviceMetrics"]["batteryLevel"] == 87

    def test_text_packet_not_enriched_with_factory_section(self):
        """TEXT_MESSAGE_APP has no protobuf factory: only ``text`` is added."""
        mp = mesh_pb2.MeshPacket()
        mp.id = 3
        setattr(mp, "from", 1)
        mp.to = 0xFFFFFFFF
        mp.decoded.portnum = portnums_pb2.PortNum.TEXT_MESSAGE_APP
        mp.decoded.payload = b"hello"

        d = udp.meshpacket_to_packet_dict(mp)

        assert d["decoded"]["text"] == "hello"
        # No factory-derived section keys beyond portnum/payload/text.
        assert set(d["decoded"]) == {"portnum", "payload", "text"}

    def test_malformed_subpayload_is_swallowed(self):
        """A POSITION portnum with a non-Position payload must not raise.

        The packet still flows with its ``portnum``/``payload``; the ``position``
        section is simply absent, matching how a library packet behaves when the
        firmware could not decode the sub-message.
        """
        mp = mesh_pb2.MeshPacket()
        mp.id = 4
        setattr(mp, "from", 1)
        mp.to = 0xFFFFFFFF
        mp.decoded.portnum = portnums_pb2.PortNum.POSITION_APP
        # A single 0xFF byte is not a valid Position wire message.
        mp.decoded.payload = b"\xff"

        d = udp.meshpacket_to_packet_dict(mp)

        assert d["decoded"]["portnum"] == "POSITION_APP"
        assert "position" not in d["decoded"]

    def test_unknown_portnum_without_factory_is_left_alone(self):
        """An UNKNOWN_APP (portnum 0) payload adds no factory section."""
        mp = mesh_pb2.MeshPacket()
        mp.id = 5
        setattr(mp, "from", 1)
        mp.to = 0xFFFFFFFF
        mp.decoded.portnum = portnums_pb2.PortNum.UNKNOWN_APP
        mp.decoded.payload = b"\x01\x02"

        d = udp.meshpacket_to_packet_dict(mp)

        assert set(d["decoded"]) == {"portnum", "payload"}

    def test_out_of_enum_portnum_maps_to_sentinel_without_raising(self):
        """A portnum with no enum name yields ``UNKNOWN_APP`` instead of raising.

        Guards the DoS where ``PortNum.Name()`` raised ``ValueError`` on an
        out-of-range portnum (newer firmware, or attacker garbage) and killed
        the receive thread.
        """
        mp = mesh_pb2.MeshPacket()
        mp.id = 6
        setattr(mp, "from", 1)
        mp.to = 0xFFFFFFFF
        # proto3 open enums accept arbitrary int32 values on the wire.
        mp.decoded.portnum = 99999
        mp.decoded.payload = b"\x01"

        d = udp.meshpacket_to_packet_dict(mp)  # must not raise

        assert d["decoded"]["portnum"] == "UNKNOWN_APP"
