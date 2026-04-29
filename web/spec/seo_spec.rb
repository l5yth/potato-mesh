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
require "rexml/document"

# Acceptance suite for the search-engine and social-preview surfaces:
# +/robots.txt+, +/sitemap.xml+, per-route meta tags, the JSON-LD block on
# the dashboard, the Open Graph image override path, and the +noindex+
# frontmatter behaviour.
RSpec.describe "SEO surface" do
  let(:app) { Sinatra::Application }

  before do
    PotatoMesh::App::Pages.clear_pages_cache!
    PotatoMesh::OgImage.reset_for_tests!
    PotatoMesh::OgImage.capture_strategy = ->(_) { "PNG_BYTES" }
  end

  after do
    PotatoMesh::App::Pages.clear_pages_cache!
    PotatoMesh::OgImage.reset_for_tests!
  end

  describe "GET /robots.txt" do
    it "advertises the sitemap and disallows instrumentation in public mode" do
      allow(PotatoMesh::Config).to receive(:private_mode_enabled?).and_return(false)

      get "/robots.txt"

      expect(last_response).to be_ok
      expect(last_response.headers["Content-Type"]).to include("text/plain")
      expect(last_response.body).to include("User-agent: *")
      expect(last_response.body).to include("Disallow: /metrics")
      expect(last_response.body).to include("Disallow: /api/")
      expect(last_response.body).to include("Sitemap: http://spec.mesh.test/sitemap.xml")
    end

    it "blocks every path in private mode" do
      allow(PotatoMesh::Config).to receive(:private_mode_enabled?).and_return(true)

      get "/robots.txt"

      expect(last_response).to be_ok
      expect(last_response.body).to include("User-agent: *")
      expect(last_response.body).to include("Disallow: /")
      expect(last_response.body).not_to include("Sitemap:")
    end

    it "sets a one-hour cache window" do
      get "/robots.txt"

      expect(last_response.headers["Cache-Control"]).to include("max-age=3600")
    end
  end

  describe "GET /sitemap.xml" do
    let(:pages_dir) { File.join(SPEC_TMPDIR, "pages-sitemap-#{SecureRandom.hex(4)}") }

    before do
      FileUtils.mkdir_p(pages_dir)
      File.write(
        File.join(pages_dir, "1-about.md"),
        "---\ntitle: About\n---\n\n# About\n",
      )
      File.write(
        File.join(pages_dir, "5-impressum.md"),
        "---\ntitle: Impressum\nnoindex: true\n---\n\n# Impressum\n",
      )
      allow(PotatoMesh::Config).to receive(:pages_directory).and_return(pages_dir)
      PotatoMesh::App::Pages.clear_pages_cache!
    end

    after do
      FileUtils.rm_rf(pages_dir)
      PotatoMesh::App::Pages.clear_pages_cache!
    end

    it "returns well-formed XML listing the public dashboards" do
      allow(PotatoMesh::Config).to receive(:private_mode_enabled?).and_return(false)
      allow(PotatoMesh::Config).to receive(:federation_enabled?).and_return(true)

      get "/sitemap.xml"

      expect(last_response).to be_ok
      expect(last_response.headers["Content-Type"]).to include("application/xml")

      doc = REXML::Document.new(last_response.body)
      locs = REXML::XPath.match(doc, "//xmlns:loc", "xmlns" => "http://www.sitemaps.org/schemas/sitemap/0.9")
        .map(&:text)

      expect(locs).to include("http://spec.mesh.test/")
      expect(locs).to include("http://spec.mesh.test/map")
      expect(locs).to include("http://spec.mesh.test/chat")
      expect(locs).to include("http://spec.mesh.test/charts")
      expect(locs).to include("http://spec.mesh.test/nodes")
      expect(locs).to include("http://spec.mesh.test/federation")
      expect(locs).to include("http://spec.mesh.test/pages/about")
    end

    it "omits the federation entry when federation is disabled" do
      allow(PotatoMesh::Config).to receive(:private_mode_enabled?).and_return(false)
      allow(PotatoMesh::Config).to receive(:federation_enabled?).and_return(false)

      get "/sitemap.xml"

      doc = REXML::Document.new(last_response.body)
      locs = REXML::XPath.match(doc, "//xmlns:loc", "xmlns" => "http://www.sitemaps.org/schemas/sitemap/0.9")
        .map(&:text)
      expect(locs).to include("http://spec.mesh.test/chat")
      expect(locs).not_to include("http://spec.mesh.test/federation")
    end

    it "omits pages flagged with noindex frontmatter" do
      get "/sitemap.xml"

      expect(last_response.body).to include("/pages/about")
      expect(last_response.body).not_to include("/pages/impressum")
    end

    it "omits lastmod for top-level routes but keeps it on pages" do
      get "/sitemap.xml"

      doc = REXML::Document.new(last_response.body)
      ns = { "xmlns" => "http://www.sitemaps.org/schemas/sitemap/0.9" }
      url_nodes = REXML::XPath.match(doc, "//xmlns:url", ns)

      page_entry = url_nodes.find do |node|
        REXML::XPath.first(node, "xmlns:loc", ns)&.text == "http://spec.mesh.test/pages/about"
      end
      dashboard_entry = url_nodes.find do |node|
        REXML::XPath.first(node, "xmlns:loc", ns)&.text == "http://spec.mesh.test/"
      end

      expect(REXML::XPath.first(page_entry, "xmlns:lastmod", ns)).not_to be_nil
      expect(REXML::XPath.first(dashboard_entry, "xmlns:lastmod", ns)).to be_nil
    end

    it "returns 404 in private mode" do
      allow(PotatoMesh::Config).to receive(:private_mode_enabled?).and_return(true)

      get "/sitemap.xml"

      expect(last_response.status).to eq(404)
    end
  end

  describe "per-route meta tags" do
    let(:pages_dir) { File.join(SPEC_TMPDIR, "pages-meta-#{SecureRandom.hex(4)}") }

    before do
      FileUtils.mkdir_p(pages_dir)
      File.write(
        File.join(pages_dir, "1-about.md"),
        "---\ntitle: About Us\ndescription: Custom about description for SEO.\n---\n\n# About\n",
      )
      File.write(
        File.join(pages_dir, "2-impressum.md"),
        "---\ntitle: Impressum\nnoindex: true\n---\n\n# Impressum\n",
      )
      allow(PotatoMesh::Config).to receive(:pages_directory).and_return(pages_dir)
      PotatoMesh::App::Pages.clear_pages_cache!
    end

    after do
      FileUtils.rm_rf(pages_dir)
      PotatoMesh::App::Pages.clear_pages_cache!
    end

    it "uses a Map · Site title on the map view" do
      allow(PotatoMesh::Config).to receive(:site_name).and_return("Test Mesh")
      get "/map"

      expect(last_response.body).to include("<title>Map · Test Mesh</title>")
    end

    it "uses a Charts · Site title on the charts view" do
      allow(PotatoMesh::Config).to receive(:site_name).and_return("Test Mesh")
      get "/charts"

      expect(last_response.body).to include("<title>Charts · Test Mesh</title>")
    end

    it "honours frontmatter title and description on /pages/:slug" do
      allow(PotatoMesh::Config).to receive(:site_name).and_return("Test Mesh")

      get "/pages/about"

      expect(last_response.body).to include("<title>About Us · Test Mesh</title>")
      expect(last_response.body).to include('content="Custom about description for SEO."')
    end

    it "uses the page-level image: frontmatter for og:image and twitter:image" do
      File.write(
        File.join(pages_dir, "3-press.md"),
        "---\ntitle: Press\nimage: https://cdn.example.org/press.png\n---\n\n# Press kit\n",
      )
      PotatoMesh::App::Pages.clear_pages_cache!

      get "/pages/press"

      expect(last_response.body).to include('<meta property="og:image" content="https://cdn.example.org/press.png" />')
      expect(last_response.body).to include('<meta name="twitter:image" content="https://cdn.example.org/press.png" />')
      expect(last_response.body).not_to include("og:image:width")
    end

    it "drops non-https image: frontmatter values" do
      File.write(
        File.join(pages_dir, "4-evil.md"),
        "---\ntitle: Bad\nimage: javascript:alert(1)\n---\n\n# nope\n",
      )
      PotatoMesh::App::Pages.clear_pages_cache!

      get "/pages/evil"

      expect(last_response.body).not_to include("javascript:alert(1)")
      expect(last_response.body).to include('<meta property="og:image" content="http://spec.mesh.test/og-image.png" />')
    end

    it "emits noindex meta when frontmatter requests it" do
      get "/pages/impressum"

      expect(last_response.body).to include('<meta name="robots" content="noindex,nofollow" />')
    end

    it "emits the JSON-LD WebSite schema only on the dashboard" do
      get "/"
      expect(last_response.body).to include('<script type="application/ld+json">')
      expect(last_response.body).to include('"@type":"WebSite"')

      get "/map"
      expect(last_response.body).not_to include('<script type="application/ld+json">')
    end

    it "emits og:image dimensions only when serving the runtime PNG" do
      get "/"
      expect(last_response.body).to include('<meta property="og:image:width" content="1200" />')
      expect(last_response.body).to include('<meta property="og:image:height" content="630" />')
      expect(last_response.body).to include('<meta property="og:image:type" content="image/png" />')
    end

    it "omits og:image dimensions when OG_IMAGE_URL points at an external image" do
      allow(PotatoMesh::Config).to receive(:og_image_url).and_return("https://cdn.example.org/og.svg")
      get "/"
      expect(last_response.body).to include('<meta property="og:image" content="https://cdn.example.org/og.svg" />')
      expect(last_response.body).not_to include("og:image:width")
      expect(last_response.body).not_to include("og:image:height")
      expect(last_response.body).not_to include("og:image:type")
    end
  end

  describe "GET /og-image.png" do
    it "returns the captured PNG bytes when the strategy succeeds" do
      PotatoMesh::OgImage.capture_strategy = ->(_) { "FAKE_PNG_DATA" }

      get "/og-image.png"

      expect(last_response).to be_ok
      expect(last_response.headers["Content-Type"]).to eq("image/png")
      expect(last_response.body).to eq("FAKE_PNG_DATA")
    end

    it "redirects to the configured OG_IMAGE_URL override" do
      allow(PotatoMesh::Config).to receive(:og_image_url).and_return("https://cdn.example.org/og.png")

      get "/og-image.png"

      expect(last_response.status).to eq(302)
      expect(last_response.headers["Location"]).to eq("https://cdn.example.org/og.png")
    end

    it "ignores OG_IMAGE_URL overrides that are not http(s)" do
      allow(PotatoMesh::Config).to receive(:og_image_url).and_return("javascript:alert(1)")

      get "/og-image.png"

      expect(last_response).to be_ok
      expect(last_response.headers["Content-Type"]).to eq("image/png")
    end

    it "falls back to the default PNG when capture fails and no cache exists" do
      PotatoMesh::OgImage.capture_strategy = ->(_) { raise PotatoMesh::OgImage::CaptureError, "no chromium" }

      get "/og-image.png"

      expect(last_response).to be_ok
      expect(last_response.body.bytesize).to eq(File.size(PotatoMesh::Config.og_image_default_path))
    end

    it "returns 503 when neither capture nor default are available" do
      PotatoMesh::OgImage.capture_strategy = ->(_) { raise PotatoMesh::OgImage::CaptureError, "no chromium" }
      allow(PotatoMesh::Config).to receive(:og_image_default_path).and_return("/nonexistent/og-image.png")

      get "/og-image.png"

      expect(last_response.status).to eq(503)
    end
  end
end
