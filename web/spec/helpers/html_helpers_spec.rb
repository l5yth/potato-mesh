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

RSpec.describe PotatoMesh::App::Helpers do
  let(:harness_class) do
    Class.new do
      include PotatoMesh::App::Helpers
    end
  end

  subject(:helper) { harness_class.new }

  # ---------------------------------------------------------------------------
  # announcement_html
  # ---------------------------------------------------------------------------
  describe "#announcement_html" do
    context "when the announcement is nil" do
      before do
        allow(PotatoMesh::Sanitizer).to receive(:sanitized_announcement).and_return(nil)
      end

      it "returns nil" do
        expect(helper.announcement_html).to be_nil
      end
    end

    context "when the announcement contains no URLs" do
      before do
        allow(PotatoMesh::Sanitizer).to receive(:sanitized_announcement).and_return("Come join us!")
      end

      it "returns escaped plain text" do
        result = helper.announcement_html
        expect(result).to eq("Come join us!")
      end
    end

    context "when the announcement contains HTML-sensitive characters but no URL" do
      before do
        allow(PotatoMesh::Sanitizer).to receive(:sanitized_announcement)
                                          .and_return("Use <strong> tags!")
      end

      it "escapes the HTML entities" do
        result = helper.announcement_html
        expect(result).to include("&lt;strong&gt;")
        expect(result).not_to include("<strong>")
      end
    end

    context "when the announcement is a plain URL" do
      before do
        allow(PotatoMesh::Sanitizer).to receive(:sanitized_announcement)
                                          .and_return("https://example.org")
      end

      it "wraps the URL in an anchor tag" do
        result = helper.announcement_html
        expect(result).to include('<a href="https://example.org"')
        expect(result).to include('target="_blank"')
        expect(result).to include('rel="noopener noreferrer"')
      end
    end

    context "when the announcement mixes text and a URL" do
      before do
        allow(PotatoMesh::Sanitizer).to receive(:sanitized_announcement)
                                          .and_return("Visit https://example.org for details")
      end

      it "links the URL and escapes surrounding text" do
        result = helper.announcement_html
        expect(result).to include('<a href="https://example.org"')
        expect(result).to include("Visit ")
        expect(result).to include(" for details")
      end
    end

    context "when the announcement text ends immediately after the URL" do
      before do
        allow(PotatoMesh::Sanitizer).to receive(:sanitized_announcement)
                                          .and_return("See http://mesh.local")
      end

      it "produces valid output without trailing text fragment" do
        result = helper.announcement_html
        expect(result).to include("See ")
        expect(result).to include('<a href="http://mesh.local"')
      end
    end
  end

  # ---------------------------------------------------------------------------
  # display_version
  # ---------------------------------------------------------------------------
  describe "#display_version" do
    it "adds a 'v' prefix to a bare version number" do
      expect(helper.display_version("1.2.3")).to eq("v1.2.3")
    end

    it "leaves an existing 'v' prefix intact" do
      expect(helper.display_version("v1.2.3")).to eq("v1.2.3")
    end

    it "returns nil for nil input" do
      expect(helper.display_version(nil)).to be_nil
    end

    it "returns nil for an empty string" do
      expect(helper.display_version("")).to be_nil
    end

    it "returns nil for a whitespace-only string" do
      expect(helper.display_version("   ")).to be_nil
    end

    it "trims surrounding whitespace before processing" do
      expect(helper.display_version("  2.0.0  ")).to eq("v2.0.0")
    end
  end
end
