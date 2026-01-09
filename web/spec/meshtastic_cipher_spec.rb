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

  describe PotatoMesh::App::Meshtastic::ChannelHash do
    it "hashes channel names with the provided PSK" do
      hash = described_class.channel_hash("BerlinMesh", psk_b64)

      expect(hash).to eq(35)
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

  it "returns nil when the cipher text is invalid" do
    text = described_class.decrypt_text(
      cipher_b64: "not-base64",
      packet_id: packet_id,
      from_id: from_id,
      psk_b64: psk_b64,
    )

    expect(text).to be_nil
  end
end
