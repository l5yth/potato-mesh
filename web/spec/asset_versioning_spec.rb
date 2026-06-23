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

# Acceptance-aligned rendering suite for asset cache-busting (SPEC AV1-AV5,
# ACCEPTANCE AV-A1..AV-A4). Confirms the dashboard emits version-stamped
# JS/CSS URLs (so a deploy busts the browser cache) while leaving images on
# their existing revalidation.
RSpec.describe "Asset cache-busting" do
  let(:app) { Sinatra::Application }

  # The live, git-derived cache key; assertions interpolate it so the suite is
  # independent of the actual tag/commit the specs run against.
  let(:version) { PotatoMesh::Application::APP_VERSION }

  describe "template-written asset URLs (AV2)" do
    before { get "/" }

    it "serves the landing page" do
      expect(last_response).to be_ok
    end

    it "version-stamps the base stylesheet" do
      expect(last_response.body).to include("/assets/styles/base.css?v=#{version}")
    end

    it "version-stamps the classic entry scripts" do
      expect(last_response.body).to include("/assets/js/theme.js?v=#{version}")
      expect(last_response.body).to include("/assets/js/background.js?v=#{version}")
    end

    it "version-stamps the module entry point" do
      expect(last_response.body).to include("/assets/js/app/index.js?v=#{version}")
    end

    it "never emits those assets unversioned (anchored to the tag attribute)" do
      expect(last_response.body).not_to include('href="/assets/styles/base.css"')
      expect(last_response.body).not_to include('src="/assets/js/theme.js"')
      expect(last_response.body).not_to include('src="/assets/js/background.js"')
      expect(last_response.body).not_to include('src="/assets/js/app/index.js"')
    end
  end

  describe "scope boundary: images are NOT versioned (AV4)" do
    before { get "/" }

    it "leaves the logo and favicons on existing revalidation" do
      expect(last_response.body).to include('src="/potatomesh-logo.svg"')
      expect(last_response.body).not_to match(%r{/potatomesh-logo\.svg\?v=})
      expect(last_response.body).not_to match(%r{/favicon\.[a-z]+\?v=})
    end
  end

  describe "inline ES-module imports (AV2)" do
    it "version-stamps the charts page import specifier" do
      get "/charts"

      expect(last_response).to be_ok
      expect(last_response.body).to include("/assets/js/app/charts-page.js?v=#{version}")
    end
  end

  describe "import map for the deep module graph (AV3)" do
    before { get "/" }

    it "emits exactly one import map" do
      expect(last_response.body.scan('<script type="importmap">').size).to eq(1)
    end

    it "version-stamps a transitively-imported module (main.js)" do
      # main.js is imported only via a relative specifier inside index.js and is
      # never written in a template, so its versioned map entry proves the whole
      # graph is busted — not just the entry points.
      expect(last_response.body).to include(
        %("/assets/js/app/main.js":"/assets/js/app/main.js?v=#{version}"),
      )
    end

    it "does not leak test files into the map" do
      expect(last_response.body).not_to include("__tests__")
    end

    it "places the import map before the module entry point" do
      body = last_response.body
      map_at = body.index('<script type="importmap">')
      entry_at = body.index('<script type="module" src="/assets/js/app/index.js')

      expect(map_at).to be < entry_at
    end
  end
end
