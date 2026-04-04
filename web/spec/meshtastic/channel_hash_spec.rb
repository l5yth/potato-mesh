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
require "base64"

RSpec.describe PotatoMesh::App::Meshtastic::ChannelHash do
  subject(:mod) { described_class }

  # ---------------------------------------------------------------------------
  # xor_bytes
  # ---------------------------------------------------------------------------
  describe ".xor_bytes" do
    it "returns 0 for an empty string" do
      expect(mod.xor_bytes("")).to eq(0)
    end

    it "returns 0 for an empty array" do
      expect(mod.xor_bytes([])).to eq(0)
    end

    it "XORs a single byte" do
      expect(mod.xor_bytes([0x42])).to eq(0x42)
    end

    it "XORs multiple bytes" do
      # 0xAA ^ 0x55 == 0xFF
      expect(mod.xor_bytes([0xAA, 0x55])).to eq(0xFF)
    end

    it "accepts a binary string" do
      expect(mod.xor_bytes("\xAA\x55".b)).to eq(0xFF)
    end

    it "masks the result to 8 bits" do
      # 0xFF ^ 0x01 == 0xFE — still within 8 bits
      expect(mod.xor_bytes([0xFF, 0x01])).to eq(0xFE)
    end
  end

  # ---------------------------------------------------------------------------
  # default_key_for_alias
  # ---------------------------------------------------------------------------
  describe ".default_key_for_alias" do
    it "returns the 16-byte default key for alias 1" do
      key = mod.default_key_for_alias(1)
      expect(key).not_to be_nil
      expect(key.bytesize).to eq(16)
    end

    it "returns the 32-byte default key for alias 2" do
      key = mod.default_key_for_alias(2)
      expect(key).not_to be_nil
      expect(key.bytesize).to eq(32)
    end

    it "returns nil for an unknown alias" do
      expect(mod.default_key_for_alias(99)).to be_nil
    end

    it "returns nil for nil input" do
      expect(mod.default_key_for_alias(nil)).to be_nil
    end
  end

  # ---------------------------------------------------------------------------
  # expanded_key
  # ---------------------------------------------------------------------------
  describe ".expanded_key" do
    it "returns an empty binary string for empty PSK" do
      result = mod.expanded_key(Base64.strict_encode64(""))
      expect(result).to eq("".b)
    end

    it "resolves a 1-byte alias to its default key" do
      # Alias byte 1
      raw = [1].pack("C*")
      result = mod.expanded_key(Base64.strict_encode64(raw))
      expect(result.bytesize).to eq(16)
    end

    it "pads a 2–15 byte key to 16 bytes" do
      raw = "short_key".b  # 9 bytes
      result = mod.expanded_key(Base64.strict_encode64(raw))
      expect(result.bytesize).to eq(16)
    end

    it "returns a 16-byte key unchanged" do
      raw = ("a" * 16).b
      result = mod.expanded_key(Base64.strict_encode64(raw))
      expect(result.bytesize).to eq(16)
      expect(result).to eq(raw)
    end

    it "pads a 17–31 byte key to 32 bytes" do
      raw = ("b" * 20).b
      result = mod.expanded_key(Base64.strict_encode64(raw))
      expect(result.bytesize).to eq(32)
    end

    it "returns a 32-byte key unchanged" do
      raw = ("c" * 32).b
      result = mod.expanded_key(Base64.strict_encode64(raw))
      expect(result.bytesize).to eq(32)
      expect(result).to eq(raw)
    end

    it "returns nil for oversized keys (> 32 bytes)" do
      raw = ("d" * 40).b
      expect(mod.expanded_key(Base64.strict_encode64(raw))).to be_nil
    end

    it "handles nil PSK gracefully (decodes to empty string)" do
      result = mod.expanded_key(nil)
      expect(result).to eq("".b)
    end
  end

  # ---------------------------------------------------------------------------
  # channel_hash
  # ---------------------------------------------------------------------------
  describe ".channel_hash" do
    let(:default_psk_b64) do
      # Alias byte 1 — the standard Meshtastic default PSK alias
      Base64.strict_encode64([1].pack("C*"))
    end

    it "returns nil when name is nil" do
      expect(mod.channel_hash(nil, default_psk_b64)).to be_nil
    end

    it "returns an integer in the range 0..255" do
      result = mod.channel_hash("LongFast", default_psk_b64)
      expect(result).to be_a(Integer)
      expect(result).to be_between(0, 255)
    end

    it "returns different hashes for different names with the same PSK" do
      h1 = mod.channel_hash("LongFast", default_psk_b64)
      h2 = mod.channel_hash("LongSlow", default_psk_b64)
      # Different names should (very likely) yield different hashes.
      expect(h1).not_to eq(h2)
    end

    it "returns nil when expanded_key returns nil (oversized PSK)" do
      oversized_psk = Base64.strict_encode64("x" * 40)
      expect(mod.channel_hash("test", oversized_psk)).to be_nil
    end
  end
end
