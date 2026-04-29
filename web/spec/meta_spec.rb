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

RSpec.describe PotatoMesh::Meta do
  before do
    allow(PotatoMesh::Sanitizer).to receive(:sanitized_site_name).and_return("Test Mesh")
    allow(PotatoMesh::Sanitizer).to receive(:sanitized_channel).and_return("#TestCh")
    allow(PotatoMesh::Sanitizer).to receive(:sanitized_frequency).and_return("868MHz")
    allow(PotatoMesh::Sanitizer).to receive(:sanitized_contact_link).and_return("#chat:example.org")
    allow(PotatoMesh::Sanitizer).to receive(:sanitized_max_distance_km).and_return(10.0)
  end

  describe ".formatted_distance_km" do
    it "drops trailing .0" do
      expect(described_class.formatted_distance_km(42.0)).to eq("42")
    end

    it "preserves single-decimal precision" do
      expect(described_class.formatted_distance_km(42.5)).to eq("42.5")
    end
  end

  describe ".description" do
    it "renders the standard description in public mode" do
      result = described_class.description(private_mode: false)
      expect(result).to include("Live Meshtastic mesh map for Test Mesh on #TestCh (868MHz).")
      expect(result).to include("Track nodes, messages, and coverage in real time.")
      expect(result).to include("within roughly 10 km")
      expect(result).to include("Join the community in #chat:example.org via chat.")
    end

    it "omits message coverage in private mode" do
      result = described_class.description(private_mode: true)
      expect(result).to include("Track nodes and coverage in real time.")
      expect(result).not_to include("messages,")
    end

    it "handles missing channel and frequency" do
      allow(PotatoMesh::Sanitizer).to receive(:sanitized_channel).and_return("")
      allow(PotatoMesh::Sanitizer).to receive(:sanitized_frequency).and_return("")
      result = described_class.description(private_mode: false)
      expect(result).to start_with("Live Meshtastic mesh map for Test Mesh.")
    end

    it "tunes the description when only frequency is configured" do
      allow(PotatoMesh::Sanitizer).to receive(:sanitized_channel).and_return("")
      result = described_class.description(private_mode: false)
      expect(result).to include("tuned to 868MHz")
    end

    it "describes the channel when only the channel is configured" do
      allow(PotatoMesh::Sanitizer).to receive(:sanitized_frequency).and_return("")
      result = described_class.description(private_mode: false)
      expect(result).to include("on #TestCh")
    end

    it "skips the radius sentence when no max distance is configured" do
      allow(PotatoMesh::Sanitizer).to receive(:sanitized_max_distance_km).and_return(nil)
      result = described_class.description(private_mode: false)
      expect(result).not_to include("within roughly")
    end

    it "skips the contact sentence when no contact is configured" do
      allow(PotatoMesh::Sanitizer).to receive(:sanitized_contact_link).and_return(nil)
      result = described_class.description(private_mode: false)
      expect(result).not_to include("Join the community")
    end
  end

  describe ".view_label" do
    it "returns labels for known views" do
      expect(described_class.view_label(:map)).to eq("Map")
      expect(described_class.view_label(:chat)).to eq("Chat")
      expect(described_class.view_label(:charts)).to eq("Charts")
      expect(described_class.view_label(:nodes)).to eq("Nodes")
      expect(described_class.view_label(:federation)).to eq("Federation")
    end

    it "accepts string view identifiers" do
      expect(described_class.view_label("map")).to eq("Map")
    end

    it "returns nil for unknown views" do
      expect(described_class.view_label(:dashboard)).to be_nil
      expect(described_class.view_label(nil)).to be_nil
    end
  end

  describe ".view_title" do
    it "composes Label · Site for known views" do
      expect(described_class.view_title(:map, "Test Mesh")).to eq("Map · Test Mesh")
    end

    it "returns nil when no label exists for the view" do
      expect(described_class.view_title(:dashboard, "Test Mesh")).to be_nil
    end

    it "returns the bare label when site is blank" do
      expect(described_class.view_title(:map, "")).to eq("Map")
    end
  end

  describe ".view_description" do
    it "renders the map description with channel and frequency" do
      result = described_class.view_description(:map, private_mode: false)
      expect(result).to include("Live coverage map of Test Mesh on #TestCh (868MHz)")
    end

    it "renders the map description with only channel" do
      allow(PotatoMesh::Sanitizer).to receive(:sanitized_frequency).and_return("")
      result = described_class.view_description(:map, private_mode: false)
      expect(result).to include("on #TestCh")
    end

    it "renders the map description with only frequency" do
      allow(PotatoMesh::Sanitizer).to receive(:sanitized_channel).and_return("")
      result = described_class.view_description(:map, private_mode: false)
      expect(result).to include("tuned to 868MHz")
    end

    it "renders the bare map description without channel or frequency" do
      allow(PotatoMesh::Sanitizer).to receive(:sanitized_channel).and_return("")
      allow(PotatoMesh::Sanitizer).to receive(:sanitized_frequency).and_return("")
      result = described_class.view_description(:map, private_mode: false)
      expect(result).to start_with("Live coverage map of Test Mesh —")
    end

    it "returns nil for the chat view in private mode" do
      expect(described_class.view_description(:chat, private_mode: true)).to be_nil
    end

    it "returns chat description with channel" do
      expect(described_class.view_description(:chat, private_mode: false)).to include("on #TestCh")
    end

    it "returns chat description without channel" do
      allow(PotatoMesh::Sanitizer).to receive(:sanitized_channel).and_return("")
      expect(described_class.view_description(:chat, private_mode: false)).to include("on Test Mesh")
    end

    it "returns descriptions for charts, nodes, and federation" do
      expect(described_class.view_description(:charts, private_mode: false)).to include("Network activity charts for Test Mesh")
      expect(described_class.view_description(:nodes, private_mode: false)).to include("All Meshtastic and MeshCore nodes seen on Test Mesh")
      expect(described_class.view_description(:federation, private_mode: false)).to include("Federated PotatoMesh instances")
    end

    it "returns nil for unknown views" do
      expect(described_class.view_description(:dashboard, private_mode: false)).to be_nil
      expect(described_class.view_description(nil, private_mode: false)).to be_nil
    end
  end

  describe ".configuration" do
    it "returns the dashboard defaults when no view is supplied" do
      result = described_class.configuration(private_mode: false)
      expect(result[:title]).to eq("Test Mesh")
      expect(result[:name]).to eq("Test Mesh")
      expect(result[:description]).to include("Live Meshtastic mesh map for Test Mesh")
      expect(result[:image]).to be_nil
      expect(result[:noindex]).to be(false)
    end

    it "returns view-specific titles for known views" do
      result = described_class.configuration(private_mode: false, view: :charts)
      expect(result[:title]).to eq("Charts · Test Mesh")
      expect(result[:description]).to include("Network activity charts")
    end

    it "honours overrides over view defaults" do
      result = described_class.configuration(
        private_mode: false,
        view: :charts,
        overrides: {
          title: "Custom Title",
          description: "Custom description",
          image: "https://x/p.png",
          noindex: true,
        },
      )
      expect(result[:title]).to eq("Custom Title")
      expect(result[:description]).to eq("Custom description")
      expect(result[:image]).to eq("https://x/p.png")
      expect(result[:noindex]).to be(true)
    end

    it "ignores blank overrides" do
      result = described_class.configuration(
        private_mode: false,
        view: :charts,
        overrides: { title: "", description: " " },
      )
      expect(result[:title]).to eq("Charts · Test Mesh")
      expect(result[:description]).to include("Network activity charts")
    end

    it "treats a non-Hash overrides argument as nothing" do
      result = described_class.configuration(private_mode: false, overrides: :not_a_hash)
      expect(result[:title]).to eq("Test Mesh")
    end

    it "freezes the returned hash" do
      result = described_class.configuration(private_mode: false)
      expect(result).to be_frozen
    end
  end

  describe ".string_or_nil" do
    it "returns nil for nil" do
      expect(described_class.string_or_nil(nil)).to be_nil
    end

    it "returns nil for blank strings" do
      expect(described_class.string_or_nil("  ")).to be_nil
    end

    it "trims and returns non-blank strings" do
      expect(described_class.string_or_nil(" hello ")).to eq("hello")
    end

    it "stringifies non-string input" do
      expect(described_class.string_or_nil(42)).to eq("42")
    end
  end
end
