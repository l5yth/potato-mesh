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

# frozen_string_literal: true

require "spec_helper"

RSpec.describe PotatoMesh::App::Meshtastic::Cipher do
  let(:psk_b64) { "Nmh7EooP2Tsc+7pvPwXLcEDDuYhk+fBo2GLnbA1Y1sg=" }
  let(:cipher_b64) { "Q1R7tgI5yXzMXu/3" }
  let(:packet_id) { 3_915_687_257 }
  let(:from_id) { "!9e95cf60" }

  def encode_varint(value)
    bytes = []
    remaining = value

    loop do
      byte = remaining & 0x7f
      remaining >>= 7
      if remaining.zero?
        bytes << byte
        break
      end
      bytes << (byte | 0x80)
    end

    bytes.pack("C*")
  end

  def build_data_message(portnum, payload)
    tag_portnum = (1 << 3) | 0
    tag_payload = (2 << 3) | 2

    [
      tag_portnum,
    ].pack("C") + encode_varint(portnum) +
      [tag_payload].pack("C") + encode_varint(payload.bytesize) + payload
  end

  def encrypt_message(plaintext, psk_b64:, packet_id:, from_id:)
    key = PotatoMesh::App::Meshtastic::ChannelHash.expanded_key(psk_b64)
    from_num = described_class.normalize_node_num(from_id, nil)
    nonce = described_class.build_nonce(packet_id, from_num)

    cipher_name = key.bytesize == 16 ? "aes-128-ctr" : "aes-256-ctr"
    cipher = OpenSSL::Cipher.new(cipher_name)
    cipher.encrypt
    cipher.key = key
    cipher.iv = nonce

    Base64.strict_encode64(cipher.update(plaintext) + cipher.final)
  end

  describe PotatoMesh::App::Meshtastic::ChannelHash do
    it "hashes channel names with the provided PSK" do
      hash = described_class.channel_hash("BerlinMesh", psk_b64)

      expect(hash).to eq(35)
    end

    it "resolves the default PSK alias when hashing channel names" do
      hash = described_class.channel_hash("PUBLIC", "AQ==")

      expect(hash).to eq(3)
    end

    it "expands short PSKs to AES-128 length" do
      key = described_class.expanded_key(Base64.strict_encode64("abc"))

      expect(key.bytesize).to eq(16)
      expect(key.bytes.first(3).pack("C*")).to eq("abc")
    end

    it "returns nil for unsupported PSK sizes" do
      key = described_class.expanded_key(Base64.strict_encode64("x" * 33))

      expect(key).to be_nil
    end

    it "resolves the event PSK alias" do
      key = described_class.expanded_key(Base64.strict_encode64([2].pack("C")))

      expect(key.bytesize).to eq(32)
    end

    it "returns nil for unknown aliases" do
      expect(described_class.default_key_for_alias(99)).to be_nil
    end

    it "xors byte arrays deterministically" do
      value = described_class.xor_bytes([0x01, 0x02, 0x03])

      expect(value).to eq(0x00)
    end

    it "xors byte strings deterministically" do
      value = described_class.xor_bytes("ABC")

      expect(value).to eq(0x40)
    end

    it "returns empty key material for empty PSK" do
      key = described_class.expanded_key("")

      expect(key).to eq("")
    end

    it "pads 17 byte PSKs up to 32 bytes" do
      key = described_class.expanded_key(Base64.strict_encode64("x" * 17))

      expect(key.bytesize).to eq(32)
    end
  end

  describe PotatoMesh::App::Meshtastic::RainbowTable do
    it "returns candidate names for a channel hash" do
      candidates = described_class.channel_names_for(35, psk_b64: psk_b64)

      expect(candidates).to include("BerlinMesh")
    end
  end

  it "decrypts the BerlinMesh example payload" do
    text = described_class.decrypt_text(
      cipher_b64: cipher_b64,
      packet_id: packet_id,
      from_id: from_id,
      psk_b64: psk_b64,
    )

    expect(text).to eq("Nabend")
  end

  it "decrypts the public PSK alias sample payload" do
    text = described_class.decrypt_text(
      cipher_b64: "otu3OyMrTIUlcaisLVDyAnLW",
      packet_id: 3_189_171_433,
      from_id: "!7c5b0920",
      psk_b64: "AQ==",
    )

    expect(text).to eq("FF-TB Beacon")
  end

  it "decrypts another public PSK alias payload sample" do
    text = described_class.decrypt_text(
      cipher_b64: "Xso0VQhndJ5RJ3pfHRVRLKSA",
      packet_id: 4_126_217_817,
      from_id: "!1d60dd3c",
      psk_b64: "AQ==",
    )

    expect(text).to eq("FF-ZW Beacon")
  end

  it "returns nil when the cipher text is invalid" do
    text = described_class.decrypt_text(
      cipher_b64: "not-base64",
      packet_id: packet_id,
      from_id: from_id,
      psk_b64: psk_b64,
    )

    expect(text).to be_nil
  end

  it "ignores non-text portnums even when payload is UTF-8" do
    payload = "OK".b
    plaintext = build_data_message(3, payload)
    encrypted = encrypt_message(plaintext, psk_b64: psk_b64, packet_id: packet_id, from_id: from_id)

    text = described_class.decrypt_text(
      cipher_b64: encrypted,
      packet_id: packet_id,
      from_id: from_id,
      psk_b64: psk_b64,
    )

    data = described_class.decrypt_data(
      cipher_b64: encrypted,
      packet_id: packet_id,
      from_id: from_id,
      psk_b64: psk_b64,
    )

    expect(text).to be_nil
    expect(data).to eq({ portnum: 3, payload: payload, text: nil })
  end

  it "normalizes packet ids from numeric strings" do
    value = described_class.normalize_packet_id("12345")

    expect(value).to eq(12_345)
  end

  it "returns nil for negative packet ids" do
    value = described_class.normalize_packet_id(-1)

    expect(value).to be_nil
  end

  it "normalizes node numbers from hex identifiers" do
    value = described_class.normalize_node_num("0x433da83c", nil)

    expect(value).to eq(0x433da83c)
  end

  it "uses the provided numeric node number when present" do
    value = described_class.normalize_node_num("!deadbeef", 123)

    expect(value).to eq(123)
  end

  it "decrypts payload bytes when requested" do
    payload = "OK".b
    plaintext = build_data_message(1, payload)
    encrypted = encrypt_message(plaintext, psk_b64: psk_b64, packet_id: packet_id, from_id: from_id)

    bytes = described_class.decrypt_payload_bytes(
      cipher_b64: encrypted,
      packet_id: packet_id,
      from_id: from_id,
      psk_b64: psk_b64,
    )

    expect(bytes).to eq(payload)
  end

  it "returns nil for non-numeric packet ids" do
    value = described_class.normalize_packet_id("abc")

    expect(value).to be_nil
  end

  it "returns nil for invalid node identifiers" do
    value = described_class.normalize_node_num("not-hex", nil)

    expect(value).to be_nil
  end

  it "normalizes floating node numbers" do
    value = described_class.normalize_node_num(nil, 12.5)

    expect(value).to eq(12)
  end

  it "returns nil when the PSK is an unsupported size" do
    data = described_class.decrypt_data(
      cipher_b64: "AA==",
      packet_id: 1,
      from_id: "!9e95cf60",
      psk_b64: Base64.strict_encode64("x" * 33),
    )

    expect(data).to be_nil
  end

  it "returns nil when the PSK expands to an empty key" do
    data = described_class.decrypt_data(
      cipher_b64: "AA==",
      packet_id: 1,
      from_id: "!9e95cf60",
      psk_b64: "",
    )

    expect(data).to be_nil
  end
end
