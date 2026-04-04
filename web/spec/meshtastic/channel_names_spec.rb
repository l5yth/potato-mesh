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

RSpec.describe PotatoMesh::App::Meshtastic::ChannelNames do
  describe "CHANNEL_NAME_CANDIDATES" do
    subject(:candidates) { described_class::CHANNEL_NAME_CANDIDATES }

    it "is a frozen Array" do
      expect(candidates).to be_a(Array)
      expect(candidates).to be_frozen
    end

    it "contains only non-empty strings" do
      expect(candidates.all? { |n| n.is_a?(String) && !n.empty? }).to be true
    end

    it "includes canonical Meshtastic channel names" do
      expect(candidates).to include("LongFast")
      expect(candidates).to include("LongSlow")
      expect(candidates).to include("MediumFast")
      expect(candidates).to include("MediumSlow")
      expect(candidates).to include("ShortFast")
    end

    it "contains unique entries" do
      expect(candidates.uniq.length).to eq(candidates.length)
    end

    it "is non-empty" do
      expect(candidates).not_to be_empty
    end
  end
end
