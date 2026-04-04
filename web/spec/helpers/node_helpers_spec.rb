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
end
