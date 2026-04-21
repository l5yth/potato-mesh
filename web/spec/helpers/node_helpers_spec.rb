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
require "rack/utils"
require "json"

RSpec.describe PotatoMesh::App::Helpers do
  # Build a lightweight host class that includes the module under test.
  let(:harness_class) do
    Class.new do
      include PotatoMesh::App::Helpers
    end
  end

  subject(:helper) { harness_class.new }

  # ---------------------------------------------------------------------------
  # node_long_name_link
  # ---------------------------------------------------------------------------
  describe "#node_long_name_link" do
    it "returns an HTML anchor when both long_name and identifier are present" do
      html = helper.node_long_name_link("Alpha Node", "!aabbccdd")
      expect(html).to include("<a")
      expect(html).to include("Alpha Node")
      expect(html).to include("!aabbccdd")
    end

    it "escapes HTML in the long name" do
      html = helper.node_long_name_link("<script>", "!aabbccdd")
      expect(html).not_to include("<script>")
      expect(html).to include("&lt;script&gt;")
    end

    it "returns just the escaped text when identifier is nil" do
      html = helper.node_long_name_link("Plain Name", nil)
      expect(html).to eq("Plain Name")
      expect(html).not_to include("<a")
    end

    it "returns an empty string when long_name is nil" do
      expect(helper.node_long_name_link(nil, "!aabbccdd")).to eq("")
    end

    it "returns an empty string when long_name is blank" do
      expect(helper.node_long_name_link("   ", "!aabbccdd")).to eq("")
    end

    it "includes the data-node-id attribute when identifier is present" do
      html = helper.node_long_name_link("Alpha", "!aabbccdd")
      expect(html).to include("data-node-id=")
    end

    it "applies custom css_class when provided" do
      html = helper.node_long_name_link("Alpha", "!aabbccdd", css_class: "my-class")
      expect(html).to include('class="my-class"')
    end

    it "omits class attribute when css_class is nil" do
      html = helper.node_long_name_link("Alpha", "!aabbccdd", css_class: nil)
      expect(html).not_to include("class=")
    end
  end

  # ---------------------------------------------------------------------------
  # normalize_json_value
  # ---------------------------------------------------------------------------
  describe "#normalize_json_value" do
    it "converts hash symbol keys to strings recursively" do
      result = helper.normalize_json_value({ foo: { bar: 1 } })
      expect(result).to eq({ "foo" => { "bar" => 1 } })
    end

    it "normalises elements inside arrays" do
      result = helper.normalize_json_value([{ key: "val" }])
      expect(result).to eq([{ "key" => "val" }])
    end

    it "passes nil through unchanged" do
      expect(helper.normalize_json_value(nil)).to be_nil
    end

    it "passes a plain string through unchanged" do
      expect(helper.normalize_json_value("hello")).to eq("hello")
    end

    it "passes integers through unchanged" do
      expect(helper.normalize_json_value(42)).to eq(42)
    end

    it "handles nested hashes with mixed key types" do
      result = helper.normalize_json_value({ "a" => { b: 2 } })
      expect(result).to eq({ "a" => { "b" => 2 } })
    end
  end

  # ---------------------------------------------------------------------------
  # normalize_json_object
  # ---------------------------------------------------------------------------
  describe "#normalize_json_object" do
    it "converts a Hash with symbol keys to string keys" do
      result = helper.normalize_json_object({ foo: "bar" })
      expect(result).to eq({ "foo" => "bar" })
    end

    it "parses a valid JSON string into a normalised hash" do
      result = helper.normalize_json_object('{"key": "value"}')
      expect(result).to eq({ "key" => "value" })
    end

    it "returns nil for invalid JSON string" do
      expect(helper.normalize_json_object("{bad json}")).to be_nil
    end

    it "returns nil for a blank string" do
      expect(helper.normalize_json_object("   ")).to be_nil
    end

    it "returns nil for nil input" do
      expect(helper.normalize_json_object(nil)).to be_nil
    end

    it "returns nil when parsed JSON is an array (not a hash)" do
      expect(helper.normalize_json_object("[1,2,3]")).to be_nil
    end

    it "returns nil for non-hash, non-string input" do
      expect(helper.normalize_json_object(42)).to be_nil
    end
  end

  # ---------------------------------------------------------------------------
  # meshcore_companion_display_short_name
  # ---------------------------------------------------------------------------
  describe "#meshcore_companion_display_short_name" do
    it "returns nil for nil input" do
      expect(helper.meshcore_companion_display_short_name(nil)).to be_nil
    end

    it "returns nil for an empty string" do
      expect(helper.meshcore_companion_display_short_name("")).to be_nil
    end

    it "returns nil for a whitespace-only string" do
      expect(helper.meshcore_companion_display_short_name("   ")).to be_nil
    end

    it "returns nil for a single-word name (falls back to raw DB short name)" do
      expect(helper.meshcore_companion_display_short_name("Alice")).to be_nil
    end

    it "returns ' AB ' for a two-word name" do
      expect(helper.meshcore_companion_display_short_name("Alice Bob")).to eq(" AB ")
    end

    it "uses only the first two words for longer names" do
      expect(helper.meshcore_companion_display_short_name("Alice Bob Carol")).to eq(" AB ")
    end

    it "uppercases the initials regardless of original case" do
      expect(helper.meshcore_companion_display_short_name("alice bob")).to eq(" AB ")
    end

    it "strips leading and trailing whitespace before splitting" do
      expect(helper.meshcore_companion_display_short_name("  alice  bob  ")).to eq(" AB ")
    end

    it "returns the first emoji from the SMP range (U+1F000–U+1FFFF)" do
      name = "Node \u{1F600}"
      expect(helper.meshcore_companion_display_short_name(name)).to eq(" \u{1F600} ")
    end

    it "returns the first emoji from the misc symbols range (U+2600–U+27BF)" do
      name = "\u{2600} Sun"
      expect(helper.meshcore_companion_display_short_name(name)).to eq(" \u{2600} ")
    end

    it "returns the first emoji from the arrows range (U+2B00–U+2BFF)" do
      name = "\u{2B50} Star"
      expect(helper.meshcore_companion_display_short_name(name)).to eq(" \u{2B50} ")
    end

    it "uses the FIRST emoji when multiple are present" do
      name = "\u{1F600}\u{1F601} Two"
      expect(helper.meshcore_companion_display_short_name(name)).to eq(" \u{1F600} ")
    end

    it "prefers emoji over initials when both are present" do
      name = "Alice \u{1F600} Bob"
      expect(helper.meshcore_companion_display_short_name(name)).to eq(" \u{1F600} ")
    end

    it "returns nil for a single-word name with no emoji (falls back to raw DB short name)" do
      expect(helper.meshcore_companion_display_short_name("Zigzag")).to be_nil
    end

    # Multi-codepoint emoji coverage — see the in-file comment on
    # +MESHCORE_COMPANION_EMOJI_PATTERN+ for the grapheme-cluster rationale.
    # Each of these cases shredded into its component codepoints before the
    # fix and would otherwise render as a stray regional-indicator letter, a
    # lone family member, or an unadorned thumbs-up.

    it "preserves a country-flag grapheme cluster (🇩🇪) instead of emitting just the first regional indicator" do
      name = "sidux.user \u{1F1E9}\u{1F1EA}"
      expect(
        helper.meshcore_companion_display_short_name(name),
      ).to eq(" \u{1F1E9}\u{1F1EA} ")
    end

    it "preserves a ZWJ family sequence (👨‍👩‍👧) as one cluster" do
      family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}"
      name = "Home #{family}"
      expect(
        helper.meshcore_companion_display_short_name(name),
      ).to eq(" #{family} ")
    end

    it "preserves a skin-tone-modified emoji (👍🏽) as one cluster" do
      thumb = "\u{1F44D}\u{1F3FD}"
      name = "Ack #{thumb}"
      expect(
        helper.meshcore_companion_display_short_name(name),
      ).to eq(" #{thumb} ")
    end

    it "preserves the rainbow-flag ZWJ sequence (🏳️‍🌈) as one cluster" do
      rainbow = "\u{1F3F3}\u{FE0F}\u{200D}\u{1F308}"
      name = "Pride #{rainbow}"
      expect(
        helper.meshcore_companion_display_short_name(name),
      ).to eq(" #{rainbow} ")
    end

    it "picks the first emoji cluster when a flag is followed back-to-back by a plain emoji" do
      # No separator between clusters — proves ``find`` stops at the flag's
      # grapheme cluster rather than splitting on a subsequent codepoint that
      # also falls in the pattern range.
      name = "\u{1F1E9}\u{1F1EA}\u{1F600}"
      expect(
        helper.meshcore_companion_display_short_name(name),
      ).to eq(" \u{1F1E9}\u{1F1EA} ")
    end

    it "returns the cluster when the long name is only an emoji and nothing else" do
      # Exercises the branch where the first cluster at index 0 matches and
      # there is no surrounding ASCII to drive the initials fallback.
      name = "\u{1F1E9}\u{1F1EA}"
      expect(
        helper.meshcore_companion_display_short_name(name),
      ).to eq(" \u{1F1E9}\u{1F1EA} ")
    end
  end
end
