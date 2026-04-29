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

RSpec.describe PotatoMesh::App::Routes::Root::Helpers do
  let(:harness_class) do
    Class.new do
      include PotatoMesh::App::Helpers
      include PotatoMesh::App::Routes::Root::Helpers

      attr_accessor :request

      def app_constant(name)
        @constants ||= {}
        @constants[name]
      end

      def set_constant(name, value)
        @constants ||= {}
        @constants[name] = value
      end
    end
  end

  let(:helper) { harness_class.new }
  let(:request_double) { double("request", base_url: "http://upstream.example", scheme: "https") }

  before do
    helper.request = request_double
  end

  describe "#public_base_url" do
    it "returns the instance domain when configured" do
      helper.set_constant(:INSTANCE_DOMAIN, "potatomesh.net")

      expect(helper.public_base_url).to eq("https://potatomesh.net")
    end

    it "honors the request scheme when present" do
      helper.set_constant(:INSTANCE_DOMAIN, "potatomesh.net")
      allow(request_double).to receive(:scheme).and_return("http")

      expect(helper.public_base_url).to eq("http://potatomesh.net")
    end

    it "defaults to https when the scheme is missing" do
      helper.set_constant(:INSTANCE_DOMAIN, "potatomesh.net")
      allow(request_double).to receive(:scheme).and_return(nil)

      expect(helper.public_base_url).to eq("https://potatomesh.net")
    end

    it "falls back to request.base_url when no instance domain is set" do
      helper.set_constant(:INSTANCE_DOMAIN, nil)

      expect(helper.public_base_url).to eq("http://upstream.example")
    end
  end

  describe "#og_image_url" do
    before do
      helper.set_constant(:INSTANCE_DOMAIN, "potatomesh.net")
    end

    it "returns the OG_IMAGE_URL override verbatim when set" do
      allow(PotatoMesh::Config).to receive(:og_image_url).and_return("https://cdn.example.org/preview.png")

      expect(helper.og_image_url).to eq("https://cdn.example.org/preview.png")
    end

    it "returns the runtime preview URL when no override is configured" do
      allow(PotatoMesh::Config).to receive(:og_image_url).and_return(nil)

      expect(helper.og_image_url).to eq("https://potatomesh.net/og-image.png")
    end

    it "treats blank overrides as unset" do
      allow(PotatoMesh::Config).to receive(:og_image_url).and_return("   ")

      expect(helper.og_image_url).to eq("https://potatomesh.net/og-image.png")
    end
  end

  describe "#node_detail_title_label" do
    it "combines short and long names when both are present" do
      label = helper.node_detail_title_label(short_name: "ABCD", long_name: "Long Name", canonical_id: "!aabbccdd")
      expect(label).to eq("ABCD (Long Name)")
    end

    it "returns the short name alone when long is missing" do
      label = helper.node_detail_title_label(short_name: "ABCD", long_name: nil, canonical_id: "!aabbccdd")
      expect(label).to eq("ABCD")
    end

    it "returns the long name when only that is present" do
      label = helper.node_detail_title_label(short_name: nil, long_name: "Long", canonical_id: "!aabbccdd")
      expect(label).to eq("Long")
    end

    it "falls back to the canonical id when both names are blank" do
      label = helper.node_detail_title_label(short_name: nil, long_name: nil, canonical_id: "!aabbccdd")
      expect(label).to eq("Node !aabbccdd")
    end

    it "uses a generic label when no identifier is available" do
      label = helper.node_detail_title_label(short_name: nil, long_name: nil, canonical_id: nil)
      expect(label).to eq("Node detail")
    end
  end

  describe "#static_page_meta_overrides" do
    let(:page) do
      PotatoMesh::App::Pages::PageEntry.new(
        slug: "about",
        title: "About",
        description: "Custom description.",
        image: "https://e.com/p.png",
        noindex: true,
      )
    end

    before do
      allow(PotatoMesh::Sanitizer).to receive(:sanitized_site_name).and_return("Test Mesh")
    end

    it "includes only populated keys" do
      result = helper.static_page_meta_overrides(page)

      expect(result[:title]).to eq("About · Test Mesh")
      expect(result[:description]).to eq("Custom description.")
      expect(result[:image]).to eq("https://e.com/p.png")
      expect(result[:noindex]).to be(true)
    end

    it "omits description, image, and noindex when frontmatter is empty" do
      bare = PotatoMesh::App::Pages::PageEntry.new(slug: "about", title: "About")

      result = helper.static_page_meta_overrides(bare)

      expect(result.keys).to contain_exactly(:title)
      expect(result[:title]).to eq("About · Test Mesh")
    end

    it "uses the bare title when the site name is blank" do
      allow(PotatoMesh::Sanitizer).to receive(:sanitized_site_name).and_return("")
      bare = PotatoMesh::App::Pages::PageEntry.new(slug: "about", title: "About")

      result = helper.static_page_meta_overrides(bare)

      expect(result[:title]).to eq("About")
    end

    it "falls back to the site name when title is blank" do
      bare = PotatoMesh::App::Pages::PageEntry.new(slug: "about", title: "")

      result = helper.static_page_meta_overrides(bare)

      expect(result[:title]).to eq("Test Mesh")
    end
  end

  describe "#xml_escape" do
    it "escapes the five XML predefined entities" do
      expect(helper.xml_escape("a&b<c>d\"e'f")).to eq("a&amp;b&lt;c&gt;d&quot;e&apos;f")
    end

    it "coerces non-string input into a string before escaping" do
      expect(helper.xml_escape(42)).to eq("42")
    end
  end

  describe "#build_robots_txt" do
    it "returns a blanket disallow in private mode" do
      allow(PotatoMesh::Config).to receive(:private_mode_enabled?).and_return(true)

      result = helper.build_robots_txt("https://example.test/sitemap.xml")

      expect(result).to eq("User-agent: *\nDisallow: /\n")
    end

    it "advertises the sitemap and instrumentation paths in public mode" do
      allow(PotatoMesh::Config).to receive(:private_mode_enabled?).and_return(false)

      result = helper.build_robots_txt("https://example.test/sitemap.xml")

      expect(result).to include("Disallow: /metrics")
      expect(result).to include("Disallow: /api/")
      expect(result).to include("Sitemap: https://example.test/sitemap.xml")
    end
  end
end
