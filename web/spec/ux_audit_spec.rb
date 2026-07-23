# frozen_string_literal: true

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

require "spec_helper"

# Server-rendered guards for the frontend design & UX audit remediation
# (SPEC UX1–UX15, ACCEPTANCE UX-A1…UX-A11). Every example was written before
# the fix and demonstrated failing against the unfixed tree (Phase 2 of the
# bugfix protocol).
RSpec.describe "UX audit remediation markup" do
  let(:app) { Sinatra::Application }

  # Fetch a page body via rack-test.
  #
  # @param path [String] request path.
  # @return [String] response body.
  def body_of(path)
    get path
    expect(last_response).to be_ok
    last_response.body
  end

  describe "degenerate-state voice (UX4)" do
    it "ships a noscript notice naming the raw API" do
      html = body_of("/")
      expect(html).to include("<noscript>")
      expect(html).to include("/api/nodes")
    end

    it "server-renders the nodes-table waiting row" do
      html = body_of("/")
      expect(html).to include("nodes-empty-row")
      expect(html).to include("No nodes heard yet")
    end
  end

  describe "legend defaults (UX8)" do
    it "expands the legend on the dedicated map view" do
      expect(body_of("/map")).to include('data-legend-collapsed="false"')
    end

    it "keeps the legend collapsed on the dashboard composite" do
      expect(body_of("/")).to include('data-legend-collapsed="true"')
    end
  end

  describe "nodes table IA (UX9)" do
    it "carries a caption, column scopes, and the grouped header row" do
      html = body_of("/nodes")
      expect(html).to include("<caption")
      expect(html).to include('scope="col"')
      expect(html).to include("nodes-group-header")
      expect(html).to include(">Identity<")
      expect(html).to include(">Health<")
      expect(html).to include(">Position<")
    end

    it "moves units into the battery and voltage headers" do
      html = body_of("/nodes")
      expect(html).to include("Battery %")
      expect(html).to include("Voltage V")
    end

    it "adds the mobile disclosure column header" do
      expect(body_of("/nodes")).to include("nodes-col--more")
    end

    it "exposes visually hidden section headings on the dashboard (table IA landmarks)" do
      html = body_of("/")
      expect(html).to match(%r{<h2[^>]*class="[^"]*visually-hidden[^"]*"[^>]*>Chat</h2>})
      expect(html).to match(%r{<h2[^>]*class="[^"]*visually-hidden[^"]*"[^>]*>Map</h2>})
      expect(html).to match(%r{<h2[^>]*class="[^"]*visually-hidden[^"]*"[^>]*>Nodes</h2>})
    end
  end

  describe "federation table IA (UX9, UX12)" do
    before do
      allow(PotatoMesh::Config).to receive(:federation_enabled?).and_return(true)
      allow_any_instance_of(Sinatra::Application).to receive(:federation_enabled?).and_return(true)
    end

    it "leads with the traveler columns and says Preset (table IA)" do
      html = body_of("/federation")
      expect(html).to include("<caption")
      expect(html).to include('scope="col"')
      name = html.index("instances-col--name")
      domain = html.index("instances-col--domain")
      preset = html.index(">Preset ")
      frequency = html.index("instances-col--frequency")
      nodes = html.index("instances-col--nodes")
      latitude = html.index("instances-col--latitude")
      expect([name, domain, preset, frequency, nodes, latitude]).to all(be_a(Integer))
      expect(name).to be < domain
      expect(domain).to be < preset
      expect(preset).to be < frequency
      expect(frequency).to be < nodes
      expect(nodes).to be < latitude
    end
  end

  describe "shell economics (UX11)" do
    it "renders static pages in the footer, not the navs" do
      html = body_of("/")
      nav = html[%r{<nav class="site-nav".*?</nav>}m]
      mobile_nav = html[%r{<nav class="mobile-nav".*?</nav>}m]
      footer = html[%r{<footer.*?</footer>}m]
      expect(nav).not_to include("/pages/")
      expect(mobile_nav).not_to include("/pages/")
      expect(footer).to include("/pages/about")
    end

    it "drops the protocol icon from the Charts nav links" do
      html = body_of("/")
      expect(html).not_to match(%r{meshtastic\.svg[^>]*>\s*Charts})
    end

    it "collapses the region selector behind a compact toggle with an honest option" do
      allow(PotatoMesh::Config).to receive(:federation_enabled?).and_return(true)
      allow_any_instance_of(Sinatra::Application).to receive(:federation_enabled?).and_return(true)
      html = body_of("/")
      expect(html).to include("instance-selector-toggle")
      expect(html).to include("Other regions…")
      expect(html).not_to include("Select region ...")
    end
  end

  describe "join strip & preset config (UX12)" do
    it "renders the join-line strip from the resolved Meshtastic preset config" do
      html = body_of("/")
      expect(html).to include("join-line")
      expect(html).to include("Meshtastic")
      expect(html).to include("#LongFast")
      expect(html).to include("915MHz")
      expect(html).not_to include("MeshCore ·")
    end

    it "adds the MeshCore join line only when both preset config values are set" do
      allow(PotatoMesh::Config).to receive(:meshcore_preset).and_return("EU/UK Narrow")
      allow(PotatoMesh::Config).to receive(:meshcore_freq).and_return("869MHz")
      html = body_of("/")
      expect(html).to include("MeshCore")
      expect(html).to include("EU/UK Narrow")
      expect(html).to include("869MHz")
    end
  end

  describe "preset config resolution (UX12)" do
    it "prefers MESHTASTIC_PRESET/MESHTASTIC_FREQ over the deprecated pair (preset config)" do
      within_env(
        "MESHTASTIC_PRESET" => "MediumFast",
        "MESHTASTIC_FREQ" => "869MHz",
        "CHANNEL" => "#Legacy",
        "FREQUENCY" => "433MHz",
      ) do
        expect(PotatoMesh::Config.meshtastic_preset).to eq("MediumFast")
        expect(PotatoMesh::Config.meshtastic_freq).to eq("869MHz")
      end
    end

    it "falls back to the deprecated CHANNEL/FREQUENCY pair (preset config)" do
      within_env(
        "MESHTASTIC_PRESET" => nil,
        "MESHTASTIC_FREQ" => nil,
        "CHANNEL" => "#Legacy",
        "FREQUENCY" => "433MHz",
      ) do
        expect(PotatoMesh::Config.meshtastic_preset).to eq("#Legacy")
        expect(PotatoMesh::Config.meshtastic_freq).to eq("433MHz")
      end
    end

    it "defaults to #LongFast/915MHz when nothing is configured (preset config)" do
      within_env(
        "MESHTASTIC_PRESET" => nil,
        "MESHTASTIC_FREQ" => nil,
        "CHANNEL" => nil,
        "FREQUENCY" => nil,
      ) do
        expect(PotatoMesh::Config.meshtastic_preset).to eq("#LongFast")
        expect(PotatoMesh::Config.meshtastic_freq).to eq("915MHz")
      end
    end

    it "hides MeshCore until both values are configured (preset config)" do
      within_env("MESHCORE_PRESET" => "EU/UK Narrow", "MESHCORE_FREQ" => nil) do
        expect(PotatoMesh::Config.meshcore_preset).to eq("EU/UK Narrow")
        expect(PotatoMesh::Config.meshcore_freq).to be_nil
        expect(PotatoMesh::Config.meshcore_join_configured?).to be(false)
      end
      within_env("MESHCORE_PRESET" => "EU/UK Narrow", "MESHCORE_FREQ" => "869MHz") do
        expect(PotatoMesh::Config.meshcore_join_configured?).to be(true)
      end
    end
  end

  describe "keyboard map equivalence (UX14)" do
    it "describes every map region with the accessible-equivalent note" do
      %w[/ /map].each do |path|
        html = body_of(path)
        expect(html).to include('aria-describedby="mapAccessNote"')
        expect(html).to include("nodes table")
      end
    end
  end

  # Temporarily override environment variables for one example.
  #
  # @param values [Hash{String => String, nil}] variables to set (nil deletes).
  # @yield the block executed under the modified environment.
  # @return [void]
  def within_env(values)
    original = {}
    values.each do |key, value|
      original[key] = ENV.key?(key) ? ENV[key] : :__unset__
      if value.nil?
        ENV.delete(key)
      else
        ENV[key] = value
      end
    end
    yield
  ensure
    original.each do |key, value|
      if value == :__unset__
        ENV.delete(key)
      else
        ENV[key] = value
      end
    end
  end
end
