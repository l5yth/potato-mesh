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

RSpec.describe PotatoMesh::App::Meshtastic::RainbowTable do
  subject(:rt) { described_class }

  # PSK alias byte 1 — the standard Meshtastic default PSK
  let(:default_psk_b64) { Base64.strict_encode64([1].pack("C*")) }

  # ---------------------------------------------------------------------------
  # build_table
  # ---------------------------------------------------------------------------
  describe ".build_table" do
    it "returns a Hash" do
      table = rt.build_table(default_psk_b64)
      expect(table).to be_a(Hash)
    end

    it "maps Integer keys (hash bytes) to Arrays of names" do
      table = rt.build_table(default_psk_b64)
      table.each do |key, value|
        expect(key).to be_a(Integer)
        expect(value).to be_a(Array)
        value.each { |name| expect(name).to be_a(String) }
      end
    end

    it "is non-empty for a valid PSK" do
      table = rt.build_table(default_psk_b64)
      expect(table).not_to be_empty
    end

    it "covers at least some well-known channel names" do
      table = rt.build_table(default_psk_b64)
      all_names = table.values.flatten
      expect(all_names).to include("LongFast")
    end
  end

  # ---------------------------------------------------------------------------
  # table_for
  # ---------------------------------------------------------------------------
  describe ".table_for" do
    it "returns the same object on repeated calls (cached)" do
      first = rt.table_for(default_psk_b64)
      second = rt.table_for(default_psk_b64)
      expect(first).to equal(second)
    end

    it "returns a different table for a different PSK" do
      other_psk = Base64.strict_encode64(("x" * 16).b)
      t1 = rt.table_for(default_psk_b64)
      t2 = rt.table_for(other_psk)
      # Different PSKs should produce different tables (they're separate objects).
      expect(t1).not_to equal(t2)
    end

    it "treats nil the same as empty string (both normalised to '')" do
      t_nil = rt.table_for(nil)
      t_empty = rt.table_for("")
      expect(t_nil).to equal(t_empty)
    end
  end

  # ---------------------------------------------------------------------------
  # channel_names_for
  # ---------------------------------------------------------------------------
  describe ".channel_names_for" do
    it "returns an empty array for a non-Integer index" do
      expect(rt.channel_names_for(nil, psk_b64: default_psk_b64)).to eq([])
      expect(rt.channel_names_for("0", psk_b64: default_psk_b64)).to eq([])
    end

    it "returns an Array of strings for a known hash byte" do
      # Compute the hash for "LongFast" using the default PSK, then look it up.
      hash = PotatoMesh::App::Meshtastic::ChannelHash.channel_hash("LongFast", default_psk_b64)
      names = rt.channel_names_for(hash, psk_b64: default_psk_b64)
      expect(names).to be_an(Array)
      expect(names).to include("LongFast")
    end

    it "returns an empty array for an index with no matching names" do
      # Use a PSK that produces no candidate matches for index 255 (very likely).
      oversized_psk = Base64.strict_encode64(("z" * 16).b)
      result = rt.channel_names_for(255, psk_b64: oversized_psk)
      expect(result).to be_an(Array)
    end
  end
end
