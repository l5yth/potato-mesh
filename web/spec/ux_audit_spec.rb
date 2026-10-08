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

  # Opening tag of the phone menu's Pages group (SPEC SH2).
  #
  # @return [String] the nav's start tag as the layout renders it.
  def pages_nav_open
    '<nav class="mobile-nav mobile-nav--pages" aria-label="Pages">'
  end

  # The phone menu's Pages group in a rendered page (SPEC SH2).
  #
  # @param html [String] response body.
  # @return [String, nil] the nav element, or nil when absent.
  def pages_nav(html)
    start = html.index(pages_nav_open)
    start && html[start..][%r{\A.*?</nav>}m]
  end

  # The footer element in a rendered page.
  #
  # @param html [String] response body.
  # @return [String, nil] the footer element, or nil when absent.
  def footer_of(html)
    html[%r{<footer.*?</footer>}m]
  end

  # Rendered protocol label of one footer join line. Matching it, rather than
  # the bare protocol name the toggles and the legend also carry, is what lets
  # an absence assertion fail when the line renders.
  #
  # @param label [String] protocol label as the footer spells it.
  # @return [String] the line's protocol span.
  def join_proto(label)
    %(<span class="join-line__proto">#{label}</span>)
  end

  # Stub the Reticulum join pair the footer reads (SPEC UX12, RL8).
  #
  # @param preset [String, nil] value for +Config.reticulum_preset+.
  # @param freq [String, nil] value for +Config.reticulum_freq+.
  # @return [void]
  def stub_reticulum_join(preset, freq)
    allow(PotatoMesh::Config).to receive(:reticulum_preset).and_return(preset)
    allow(PotatoMesh::Config).to receive(:reticulum_freq).and_return(freq)
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

    it "names the unit of every numeric column in its header (DV1)" do
      html = body_of("/nodes")
      {
        "Frequency" => "MHz", "Battery" => "%", "Voltage" => "V",
        "Channel Util" => "%", "Air Util Tx" => "%", "Temperature" => "°C",
        "Humidity" => "%", "Pressure" => "hPa", "Altitude" => "m",
      }.each do |label, unit|
        expect(html).to include(%(<span>#{label} <span class="nodes-col__unit">#{unit}</span></span>))
      end
      expect(html.scan('class="nodes-col__unit"').size).to eq(9)
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
    it "renders static pages in the footer and the menu's Pages group, not the product navs" do
      html = body_of("/")
      # Every nav on the page, so a nav added later is checked too.
      pages_navs, product_navs = html.scan(%r{<nav\b[^>]*>.*?</nav>}m)
                                     .partition { |nav| nav.start_with?(pages_nav_open) }
      expect(product_navs.size).to eq(2)
      product_navs.each { |nav| expect(nav).not_to include("/pages/") }
      expect(pages_navs.size).to eq(1)
      expect(pages_navs.first).to include("/pages/about")
      expect(footer_of(html)).to include("/pages/about")
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

  describe "phone menu Pages group (SH2)" do
    let(:pages_dir) { File.join(SPEC_TMPDIR, "pages-menu-#{SecureRandom.hex(4)}") }

    before do
      FileUtils.mkdir_p(pages_dir)
      File.write(File.join(pages_dir, "1-about.md"), "# About\n")
      File.write(File.join(pages_dir, "5-rules.md"), %(---\ntitle: "Rules & <Etiquette>"\n---\n\n# Rules\n))
      allow(PotatoMesh::Config).to receive(:pages_directory).and_return(pages_dir)
      PotatoMesh::App::Pages.clear_pages_cache!
    end

    after do
      FileUtils.rm_rf(pages_dir)
      PotatoMesh::App::Pages.clear_pages_cache!
    end

    it "lists every static page, GitHub and the contact link in the phone menu on every view" do
      allow(PotatoMesh::Config).to receive(:contact_link).and_return("#mesh:example.org")
      %w[/ /map /chat /nodes /charts].each do |path|
        nav = pages_nav(body_of(path))
        expect(nav).to include('<a href="/pages/about" class="mobile-nav__link">About</a>')
        expect(nav).to include('<a href="/pages/rules" class="mobile-nav__link">Rules &amp; &lt;Etiquette&gt;</a>')
        expect(nav).to include('<a href="https://github.com/l5yth/potato-mesh" class="mobile-nav__link" target="_blank" rel="noopener noreferrer">GitHub: l5yth/potato-mesh</a>')
        expect(nav).to include('<a href="https://matrix.to/#/#mesh:example.org" class="mobile-nav__link" target="_blank" rel="noopener noreferrer">chat: #mesh:example.org</a>')
      end
    end

    it "marks the active page in the phone menu" do
      nav = pages_nav(body_of("/pages/rules"))
      expect(nav).to include('<a href="/pages/rules" class="mobile-nav__link is-active" aria-current="page">')
      expect(nav).to include('<a href="/pages/about" class="mobile-nav__link">About</a>')
    end

    it "escapes the page titles and the contact link in the phone menu and the footer" do
      link = %(https://chat.example.org/?a=1&b="><script>x</script>)
      escaped = "https://chat.example.org/?a=1&amp;b=&quot;&gt;&lt;script&gt;x&lt;/script&gt;"
      allow(PotatoMesh::Config).to receive(:contact_link).and_return(link)
      html = body_of("/")
      [pages_nav(html), footer_of(html)].each do |links|
        expect(links).to include("Rules &amp; &lt;Etiquette&gt;")
        expect(links).to include(%(href="#{escaped}"))
        expect(links).to include("#{escaped}</a>")
        expect(links).not_to include("<script>")
        expect(links).not_to include("<Etiquette>")
      end
    end

    it "shows a contact link without a URL as escaped text" do
      allow(PotatoMesh::Config).to receive(:contact_link).and_return("ask at the <info> tent")
      html = body_of("/")
      expect(pages_nav(html)).to include('<span class="mobile-nav__link">chat: ask at the &lt;info&gt; tent</span>')
      expect(footer_of(html)).to include("ask at the &lt;info&gt; tent")
      expect(footer_of(html)).not_to include("<info>")
    end

    it "leaves the contact entry out when no contact link is set" do
      allow(PotatoMesh::Config).to receive(:contact_link).and_return(" ")
      html = body_of("/")
      expect(pages_nav(html)).not_to include("chat:")
      expect(footer_of(html)).not_to include("footer-contact")
    end
  end

  describe "header glyphs (SH5)" do
    it "draws the region, menu and close glyphs as inline SVG in the text colour" do
      allow(PotatoMesh::Config).to receive(:federation_enabled?).and_return(true)
      allow_any_instance_of(Sinatra::Application).to receive(:federation_enabled?).and_return(true)
      html = body_of("/")
      buttons = {
        region: html[%r{<button\s+id="instanceSelectToggle".*?</button>}m],
        menu: html[%r{<button\s+id="mobileMenuToggle".*?</button>}m],
        close: html[%r{<button class="icon-button mobile-menu__close".*?</button>}m],
      }
      buttons.each do |name, button|
        expect(button).to include('<svg viewBox="0 0 24 24"'), name.to_s
        expect(button).to include('aria-hidden="true" focusable="false"'), name.to_s
        expect(button).to include('stroke="currentColor"'), name.to_s
        expect(button).to include('stroke-width="1.8"'), name.to_s
      end
      expect(html).not_to include("🌍")
      expect(html).not_to include("☰")
      expect(buttons[:close]).not_to include("×")
    end
  end

  describe "join strip & preset config (UX12)" do
    it "renders the join-line strip from the resolved Meshtastic preset config" do
      html = body_of("/")
      expect(html).to include("join-line")
      expect(html).to include("Meshtastic")
      expect(html).to include("#LongFast")
      expect(html).to include("915MHz")
      expect(html).not_to include(join_proto("Meshcore"))
      expect(html).not_to include(join_proto("Reticulum"))
    end

    it "adds the MeshCore join line only when both preset config values are set" do
      allow(PotatoMesh::Config).to receive(:meshcore_preset).and_return("EU/UK Narrow")
      allow(PotatoMesh::Config).to receive(:meshcore_freq).and_return("869MHz")
      html = body_of("/")
      expect(html).to include("Meshcore")
      expect(html).to include("EU/UK Narrow")
      expect(html).to include("869MHz")
    end

    it "adds the Reticulum join line only when both preset config values are set" do
      [["SF8/BW125/CR5", nil], [nil, "868MHz"]].each do |preset, freq|
        stub_reticulum_join(preset, freq)
        expect(body_of("/")).not_to include(join_proto("Reticulum"))
      end
      stub_reticulum_join("SF8/BW125/CR5", "868MHz")
      expect(body_of("/")).to include("#{join_proto("Reticulum")} · SF8/BW125/CR5 · 868MHz")
    end
  end

  describe "join strip moved to the footer (audit follow-up 04)" do
    it "renders the join strip in the footer and drops the redundant details link" do
      html = body_of("/")
      # The strip now carries its footer-placement class and still names the
      # resolved preset — it lives in the footer, next to the About link.
      expect(html).to include("footer-join")
      expect(html).to include("join-line")
      expect(html).to include("#LongFast")
      # The `details` link (its About-page shortcut) is gone: the footer's own
      # About link sits right beside the strip.
      expect(html).not_to include("join-line__more")
    end

    it "labels the protocol toggles with per-protocol count elements" do
      html = body_of("/")
      expect(html).to include('id="protocolToggleMeshcoreCount"')
      expect(html).to include('id="protocolToggleMeshtasticCount"')
      expect(html).to include('id="protocolToggleReticulumCount"')
      expect(html).to include("protocol-toggle-count")
    end

    it "renders the reticulum toggle chip mirroring the other protocols (#888)" do
      html = body_of("/")
      expect(html).to include('id="protocolToggleReticulum"')
      expect(html).to include('aria-label="Hide Reticulum nodes"')
      expect(html).to include("/assets/img/reticulum.svg")
    end
  end

  describe "footer dot separators (Post-Deploy 02·03)" do
    it "renders footer-separator elements as dots, not em dashes" do
      html = body_of("/")
      # The links row separators become dots; the dangling em-dash that the
      # wrapping .footer-links box stranded on line one is gone.
      expect(html).to match(%r{<span class="footer-separator"[^>]*>·</span>})
      expect(html).not_to match(%r{<span class="footer-separator"[^>]*>—</span>})
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

    it "reads the Reticulum pair from the ingestor's own settings (preset config)" do
      within_env("RETICULUM_PRESET" => nil, "RETICULUM_FREQ" => " ") do
        expect(PotatoMesh::Config.reticulum_preset).to be_nil
        expect(PotatoMesh::Config.reticulum_freq).to be_nil
      end
      within_env("RETICULUM_PRESET" => "SF8/BW125/CR5", "RETICULUM_FREQ" => "868MHz") do
        expect(PotatoMesh::Config.reticulum_preset).to eq("SF8/BW125/CR5")
        expect(PotatoMesh::Config.reticulum_freq).to eq("868MHz")
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
