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
require "digest"
require "timeout"

# Content-Security-Policy and Referrer-Policy (SPEC HD1-HD3): the policy every
# HTML view carries, the inline scripts it allows by hash, the responses that
# carry no policy, and the middleware itself.
RSpec.describe "Security headers" do
  let(:app) { Sinatra::Application }
  let(:referrer_policy) { "strict-origin-when-cross-origin" }

  # The Leaflet release the layout loads, the one unpkg source the policy
  # admits (SPEC HD1).
  let(:leaflet_source) { "https://unpkg.com/leaflet@1.9.4/" }

  # The policy of SPEC HD1 with the given +'sha256-...'+ script sources.
  #
  # @param hashes [Array<String>] quoted hash sources, in policy order.
  # @return [String] the expected header value.
  def expected_policy(hashes)
    [
      "default-src 'self'",
      (["script-src 'self' #{leaflet_source}"] + hashes).join(" "),
      "style-src 'self' #{leaflet_source} 'unsafe-inline'",
      "style-src-elem 'self' #{leaflet_source}",
      "style-src-attr 'unsafe-inline'",
      "img-src 'self' data: https:",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join("; ")
  end

  # The CSP source for a script body, as a browser computes it.
  #
  # @param body [String] the script element's text, byte for byte.
  # @return [String] the quoted +'sha256-<base64>'+ source.
  def hash_source(body)
    "'sha256-#{Digest::SHA256.base64digest(body)}'"
  end

  # Every inline script the policy governs, exactly as served: a +<script>+
  # without +src+ whose type is not the JSON-LD data block. Tag and
  # attribute names match in any letter case and an end tag in any form
  # (+</script >+, +</SCRIPT x>+), as HTML parses them (SPEC CQ4).
  #
  # @param html [String] the served page.
  # @return [Array<Array(String, String)>] attributes and body of each script.
  def inline_scripts(html)
    html.scan(%r{<script\b([^>]*)>(.*?)</script[^>]*>}im).reject do |attrs, _body|
      attrs.match?(/\bsrc\s*=/i) || attrs.match?(%r{application/ld\+json}i)
    end
  end

  describe "the inline script finder" do
    it "finds a script tag in any letter case, with any end-tag form (SPEC CQ4)" do
      html = <<~HTML
        <SCRIPT>upper()</SCRIPT>
        <script type="module">a()</script >
        <Script>mixed()</script	data-x="1">
        <script src="/x.js"></script>
        <script type="application/ld+json">{}</script>
      HTML

      expect(inline_scripts(html).map(&:last)).to eq(["upper()", "a()", "mixed()"])
    end
  end

  describe "HTML views" do
    let(:node_id) { "!c5f0a001" }

    # Open the test database read-write.
    #
    # @yieldparam db [SQLite3::Database] the handle.
    # @return [void]
    def with_db
      db = SQLite3::Database.new(PotatoMesh::Config.db_path)
      db.busy_timeout = PotatoMesh::Config.db_busy_timeout_ms
      yield db
    ensure
      db&.close
    end

    before do
      allow(PotatoMesh::Config).to receive(:federation_enabled?).and_return(true)
      PotatoMesh::App::Pages.clear_pages_cache!
      now = Time.now.to_i
      with_db do |db|
        db.execute(
          "INSERT OR REPLACE INTO nodes(node_id, num, short_name, long_name, last_heard, first_heard) VALUES (?,?,?,?,?,?)",
          [node_id, 0xc5f0a001, "CSP", "Policy Probe", now, now],
        )
      end
    end

    after do
      with_db { |db| db.execute("DELETE FROM nodes WHERE node_id = ?", [node_id]) }
      PotatoMesh::App::Pages.clear_pages_cache!
    end

    %w[/ /map /chat /nodes /charts /federation /pages/about /nodes/!c5f0a001].each do |path|
      it "sends the policy and the referrer policy on #{path}, its one inline script allowed by hash" do
        get path

        expect(last_response).to be_ok
        scripts = inline_scripts(last_response.body)
        expect(scripts.map(&:first)).to eq([' type="importmap"'])
        expect(last_response.headers["Content-Security-Policy"]).to eq(expected_policy([hash_source(scripts.first.last)]))
        expect(last_response.headers["Referrer-Policy"]).to eq(referrer_policy)
      end
    end

    it "boots the charts, node and federation views from modules the policy allows by origin" do
      { "/charts" => "charts-page-boot.js", "/nodes/!c5f0a001" => "node-page-boot.js",
        "/federation" => "federation-page-boot.js" }.each do |path, boot|
        get path

        expect(last_response.body).to match(%r{<script type="module" src="/assets/js/app/#{Regexp.escape(boot)}\?v=[^"]+"></script>})
      end
    end

    it "builds the policy at boot: a request hashes nothing" do
      allow(PotatoMesh::App::SecurityHeaders).to receive(:content_security_policy).and_call_original
      allow(PotatoMesh::App::SecurityHeaders).to receive(:script_hash_source).and_call_original

      get "/"

      expect(last_response.headers["Content-Security-Policy"]).to include("'sha256-")
      expect(PotatoMesh::App::SecurityHeaders).not_to have_received(:content_security_policy)
      expect(PotatoMesh::App::SecurityHeaders).not_to have_received(:script_hash_source)
    end

    it "sends the policy on an HTML error page too" do
      get "/no-such-page"

      expect(last_response.status).to eq(404)
      expect(last_response.headers["Content-Security-Policy"]).to start_with("default-src 'self'; script-src ")
      expect(last_response.headers["Referrer-Policy"]).to eq(referrer_policy)
    end
  end

  describe "responses that are not HTML" do
    before do
      PotatoMesh::OgImage.reset_for_tests!
      PotatoMesh::OgImage.capture_strategy = ->(_) { "PNG_BYTES" }
      allow(PotatoMesh::Config).to receive(:private_mode_enabled?).and_return(false)
    end

    after { PotatoMesh::OgImage.reset_for_tests! }

    {
      "/api/nodes" => "application/json",
      "/version" => "application/json",
      "/robots.txt" => "text/plain",
      "/sitemap.xml" => "application/xml",
      "/metrics" => "text/plain",
      "/og-image.png" => "image/png",
      "/assets/js/app/main.js" => "javascript",
      "/assets/styles/base.css" => "text/css",
      "/potatomesh-logo.svg" => "image/svg+xml",
    }.each do |path, type|
      it "sends the referrer policy and no CSP on #{path}" do
        get path

        expect(last_response.status).to eq(200)
        expect(last_response.content_type).to include(type)
        expect(last_response.headers["Content-Security-Policy"]).to be_nil
        expect(last_response.headers["Referrer-Policy"]).to eq(referrer_policy)
      end
    end

    it "sends the referrer policy and no CSP on the live-update stream" do
      allow(PotatoMesh::App::Routes::Events).to receive(:pump)

      Timeout.timeout(5) { get "/api/events" }

      expect(last_response.content_type).to include("text/event-stream")
      expect(last_response.headers["Content-Security-Policy"]).to be_nil
      expect(last_response.headers["Referrer-Policy"]).to eq(referrer_policy)
    ensure
      PotatoMesh::App::PubSub.reset!
    end
  end

  describe "the middleware" do
    let(:policy) { "default-src 'self'" }

    # Run the middleware over a downstream response with the given headers.
    #
    # @param headers [Hash] the downstream response headers.
    # @return [Hash] the headers the middleware returns.
    def headers_after(headers)
      downstream = ->(_env) { [200, headers, ["body"]] }
      PotatoMesh::App::SecurityHeaders.new(downstream, content_security_policy: policy).call({})[1]
    end

    it "adds the policy to text/html whatever the key's case and the parameters" do
      expect(headers_after("Content-Type" => "TEXT/HTML; charset=utf-8")["content-security-policy"]).to eq(policy)
      expect(headers_after("content-type" => "text/html")["content-security-policy"]).to eq(policy)
    end

    it "adds no policy to other types, or without a type" do
      expect(headers_after("content-type" => "text/htmlx")).not_to have_key("content-security-policy")
      expect(headers_after("content-type" => "application/xhtml+xml")).not_to have_key("content-security-policy")
      expect(headers_after({})).not_to have_key("content-security-policy")
    end

    it "adds the referrer policy to every response" do
      expect(headers_after({})["referrer-policy"]).to eq(referrer_policy)
      expect(headers_after("content-type" => "application/json")["referrer-policy"]).to eq(referrer_policy)
    end

    it "keeps a policy or referrer policy set further in" do
      headers = headers_after(
        "content-type" => "text/html",
        "Content-Security-Policy" => "default-src 'none'",
        "Referrer-Policy" => "no-referrer",
      )

      expect(headers).not_to have_key("content-security-policy")
      expect(headers).not_to have_key("referrer-policy")
      expect(headers["Content-Security-Policy"]).to eq("default-src 'none'")
      expect(headers["Referrer-Policy"]).to eq("no-referrer")
    end
  end

  describe "the Leaflet source" do
    # The sources of one directive of +policy+.
    #
    # @param policy [String] a Content-Security-Policy value.
    # @param directive [String] the directive name.
    # @return [Array<String>] its sources.
    def sources_of(policy, directive)
      policy.split("; ").find { |entry| entry.start_with?("#{directive} ") }.split(" ").drop(1)
    end

    it "is the package release of the pinned asset URLs, never the whole host" do
      policy = PotatoMesh::App::SecurityHeaders.content_security_policy([])

      expect(PotatoMesh::App::LeafletAssets.sources).to eq([leaflet_source])
      %w[script-src style-src style-src-elem].each do |directive|
        expect(sources_of(policy, directive)).to include(leaflet_source)
        expect(sources_of(policy, directive)).not_to include("https://unpkg.com", "https://unpkg.com/")
      end
    end

    it "covers exactly the stylesheet and script the layout loads" do
      get "/"

      css = last_response.body[%r{<link\s+rel="stylesheet"\s+href="(https://[^"]+)"}m, 1]
      js = last_response.body[%r{<script\s+src="(https://[^"]+)"}m, 1]
      expect([css, js]).to eq([PotatoMesh::App::LeafletAssets::CSS_URL, PotatoMesh::App::LeafletAssets::JS_URL])
      expect([css, js]).to all(start_with(leaflet_source))
    end

    it "takes the origin and the package segment of an asset URL" do
      source = ->(url) { PotatoMesh::App::LeafletAssets.package_source(url) }

      expect(source.call("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js")).to eq(leaflet_source)
      expect(source.call("https://cdn.example.test/pkg@2.0.0/a/b.css")).to eq("https://cdn.example.test/pkg@2.0.0/")
    end
  end

  describe ".content_security_policy" do
    it "lists the two script origins, then each inline script's hash once" do
      policy = PotatoMesh::App::SecurityHeaders.content_security_policy(["a", "b", "a"])

      expect(policy).to eq(expected_policy([hash_source("a"), hash_source("b")]))
    end

    it "hashes a script body byte for byte" do
      expect(PotatoMesh::App::SecurityHeaders.script_hash_source(%({"imports":{}}))).to eq(hash_source(%({"imports":{}})))
    end
  end
end
