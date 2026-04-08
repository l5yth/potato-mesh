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

RSpec.describe PotatoMesh::App::Pages do
  let(:pages_dir) { File.join(SPEC_TMPDIR, "pages-#{SecureRandom.hex(4)}") }

  before do
    FileUtils.mkdir_p(pages_dir)
    PotatoMesh::App::Pages.clear_pages_cache!
  end

  after do
    FileUtils.rm_rf(pages_dir)
    PotatoMesh::App::Pages.clear_pages_cache!
  end

  # ── parse_page_filename ──────────────────────────────────────

  describe ".parse_page_filename" do
    it "parses a numeric-prefixed filename" do
      entry = described_class.parse_page_filename("9-contact.md")
      expect(entry).not_to be_nil
      expect(entry.sort_key).to eq("9-contact")
      expect(entry.slug).to eq("contact")
      expect(entry.title).to eq("Contact")
    end

    it "parses a multi-word slug" do
      entry = described_class.parse_page_filename("10-privacy-policy.md")
      expect(entry.slug).to eq("privacy-policy")
      expect(entry.title).to eq("Privacy Policy")
    end

    it "parses a filename without numeric prefix" do
      entry = described_class.parse_page_filename("readme.md")
      expect(entry).not_to be_nil
      expect(entry.sort_key).to eq("readme")
      expect(entry.slug).to eq("readme")
      expect(entry.title).to eq("Readme")
    end

    it "parses a multi-digit prefix" do
      entry = described_class.parse_page_filename("100-faq.md")
      expect(entry.sort_key).to eq("100-faq")
      expect(entry.slug).to eq("faq")
      expect(entry.title).to eq("Faq")
    end

    it "rejects empty basename" do
      expect(described_class.parse_page_filename(".md")).to be_nil
    end

    it "downcases uppercase slugs" do
      entry = described_class.parse_page_filename("1-About.md")
      expect(entry).not_to be_nil
      expect(entry.slug).to eq("about")
    end

    it "rejects slugs with underscores" do
      expect(described_class.parse_page_filename("1-my_page.md")).to be_nil
    end

    it "rejects slugs with path traversal" do
      expect(described_class.parse_page_filename("../../etc.md")).to be_nil
    end

    it "rejects slugs starting with a hyphen" do
      expect(described_class.parse_page_filename("1--bad.md")).to be_nil
    end

    it "rejects slugs ending with a hyphen" do
      expect(described_class.parse_page_filename("bad-.md")).to be_nil
    end

    it "sets path to nil" do
      entry = described_class.parse_page_filename("1-about.md")
      expect(entry.path).to be_nil
    end
  end

  # ── load_static_pages ────────────────────────────────────────

  describe ".load_static_pages" do
    it "returns an empty array when the directory does not exist" do
      result = described_class.load_static_pages("/nonexistent/dir")
      expect(result).to eq([])
      expect(result).to be_frozen
    end

    it "returns an empty array when the directory argument is nil" do
      result = described_class.load_static_pages(nil)
      expect(result).to eq([])
      expect(result).to be_frozen
    end

    it "returns an empty array when the directory is empty" do
      result = described_class.load_static_pages(pages_dir)
      expect(result).to eq([])
    end

    it "discovers and sorts markdown files" do
      File.write(File.join(pages_dir, "5-beta.md"), "# Beta")
      File.write(File.join(pages_dir, "1-alpha.md"), "# Alpha")
      File.write(File.join(pages_dir, "9-gamma.md"), "# Gamma")

      result = described_class.load_static_pages(pages_dir)
      expect(result.map(&:slug)).to eq(%w[alpha beta gamma])
      expect(result.map(&:sort_key)).to eq(%w[1-alpha 5-beta 9-gamma])
    end

    it "populates the path field" do
      File.write(File.join(pages_dir, "1-test.md"), "# Test")
      result = described_class.load_static_pages(pages_dir)
      expect(result.first.path).to eq(File.join(pages_dir, "1-test.md"))
    end

    it "ignores non-md files" do
      File.write(File.join(pages_dir, "1-about.md"), "# About")
      File.write(File.join(pages_dir, "notes.txt"), "text")
      File.write(File.join(pages_dir, "image.png"), "binary")

      result = described_class.load_static_pages(pages_dir)
      expect(result.length).to eq(1)
      expect(result.first.slug).to eq("about")
    end

    it "skips files with invalid filenames" do
      File.write(File.join(pages_dir, "1-good.md"), "# Good")
      File.write(File.join(pages_dir, "1-bad_name.md"), "# Bad")

      result = described_class.load_static_pages(pages_dir)
      expect(result.length).to eq(1)
      expect(result.first.slug).to eq("good")
    end

    it "deduplicates entries with the same slug keeping the first" do
      File.write(File.join(pages_dir, "1-about.md"), "# First")
      File.write(File.join(pages_dir, "2-about.md"), "# Second")

      result = described_class.load_static_pages(pages_dir)
      expect(result.length).to eq(1)
      expect(result.first.sort_key).to eq("1-about")
    end

    it "limits entries to MAX_PAGES" do
      (1..55).each do |i|
        File.write(File.join(pages_dir, "#{i}-page#{i}.md"), "# Page #{i}")
      end

      result = described_class.load_static_pages(pages_dir)
      expect(result.length).to eq(PotatoMesh::App::Pages::MAX_PAGES)
    end

    it "returns a frozen array" do
      File.write(File.join(pages_dir, "1-test.md"), "# Test")
      result = described_class.load_static_pages(pages_dir)
      expect(result).to be_frozen
    end
  end

  # ── render_page_content ──────────────────────────────────────

  describe ".render_page_content" do
    it "renders markdown headings to HTML" do
      path = File.join(pages_dir, "1-test.md")
      File.write(path, "# Hello World\n\nSome text.")
      entry = PotatoMesh::App::Pages::PageEntry.new(
        sort_key: "1-test", slug: "test", title: "Test", path: path,
      )

      html = described_class.render_page_content(entry)
      expect(html).to include("<h1")
      expect(html).to include("Hello World")
      expect(html).to include("<p>Some text.</p>")
    end

    it "renders links" do
      path = File.join(pages_dir, "1-test.md")
      File.write(path, "[example](https://example.com)")
      entry = PotatoMesh::App::Pages::PageEntry.new(
        sort_key: "1-test", slug: "test", title: "Test", path: path,
      )

      html = described_class.render_page_content(entry)
      expect(html).to include('href="https://example.com"')
      expect(html).to include("example")
    end

    it "renders fenced code blocks" do
      path = File.join(pages_dir, "1-test.md")
      File.write(path, "```\ncode here\n```")
      entry = PotatoMesh::App::Pages::PageEntry.new(
        sort_key: "1-test", slug: "test", title: "Test", path: path,
      )

      html = described_class.render_page_content(entry)
      expect(html).to include("<code")
      expect(html).to include("code here")
    end

    it "renders tables" do
      path = File.join(pages_dir, "1-test.md")
      File.write(path, "| A | B |\n| - | - |\n| 1 | 2 |")
      entry = PotatoMesh::App::Pages::PageEntry.new(
        sort_key: "1-test", slug: "test", title: "Test", path: path,
      )

      html = described_class.render_page_content(entry)
      expect(html).to include("<table")
      expect(html).to include("<td>")
    end

    it "does not pass through raw HTML script tags" do
      path = File.join(pages_dir, "1-test.md")
      File.write(path, "<script>alert('xss')</script>\n\nSafe text.")
      entry = PotatoMesh::App::Pages::PageEntry.new(
        sort_key: "1-test", slug: "test", title: "Test", path: path,
      )

      html = described_class.render_page_content(entry)
      expect(html).not_to include("<script>")
    end

    it "does not pass through raw HTML iframe tags" do
      path = File.join(pages_dir, "1-test.md")
      File.write(path, '<iframe src="https://evil.com"></iframe>')
      entry = PotatoMesh::App::Pages::PageEntry.new(
        sort_key: "1-test", slug: "test", title: "Test", path: path,
      )

      html = described_class.render_page_content(entry)
      expect(html).not_to include("<iframe")
    end

    it "returns nil for a nil entry" do
      expect(described_class.render_page_content(nil)).to be_nil
    end

    it "returns nil for a missing file" do
      entry = PotatoMesh::App::Pages::PageEntry.new(
        sort_key: "1-gone", slug: "gone", title: "Gone",
        path: File.join(pages_dir, "missing.md"),
      )
      expect(described_class.render_page_content(entry)).to be_nil
    end

    it "returns nil when the file exceeds the size limit" do
      path = File.join(pages_dir, "1-big.md")
      File.write(path, "x" * (PotatoMesh::Config.max_page_file_bytes + 1))
      entry = PotatoMesh::App::Pages::PageEntry.new(
        sort_key: "1-big", slug: "big", title: "Big", path: path,
      )

      expect(described_class.render_page_content(entry)).to be_nil
    end

    it "returns nil when path is nil" do
      entry = PotatoMesh::App::Pages::PageEntry.new(
        sort_key: "1-test", slug: "test", title: "Test", path: nil,
      )
      expect(described_class.render_page_content(entry)).to be_nil
    end

    it "returns nil on a filesystem error" do
      path = File.join(pages_dir, "1-err.md")
      File.write(path, "# Error")
      entry = PotatoMesh::App::Pages::PageEntry.new(
        sort_key: "1-err", slug: "err", title: "Err", path: path,
      )

      allow(File).to receive(:read).with(path, encoding: "utf-8").and_raise(Errno::EIO)

      expect(described_class.render_page_content(entry)).to be_nil
    end

    it "strips event-handler attributes from allowed tags" do
      path = File.join(pages_dir, "1-test.md")
      File.write(path, '<a href="https://example.com" onclick="alert(1)">link</a>')
      entry = PotatoMesh::App::Pages::PageEntry.new(
        sort_key: "1-test", slug: "test", title: "Test", path: path,
      )

      html = described_class.render_page_content(entry)
      expect(html).to include('href="https://example.com"')
      expect(html).not_to include("onclick")
    end

    it "strips nested event-handler bypass attempts" do
      path = File.join(pages_dir, "1-test.md")
      File.write(path, '<a href="#" oonnclick="alert(1)">link</a>')
      entry = PotatoMesh::App::Pages::PageEntry.new(
        sort_key: "1-test", slug: "test", title: "Test", path: path,
      )

      html = described_class.render_page_content(entry)
      expect(html).not_to include("onclick")
    end

    it "strips javascript: URIs from href attributes" do
      path = File.join(pages_dir, "1-test.md")
      File.write(path, '<a href="javascript:alert(1)">link</a>')
      entry = PotatoMesh::App::Pages::PageEntry.new(
        sort_key: "1-test", slug: "test", title: "Test", path: path,
      )

      html = described_class.render_page_content(entry)
      expect(html).not_to include("javascript:")
    end

    it "preserves allowed HTML tags while stripping disallowed ones" do
      path = File.join(pages_dir, "1-mixed.md")
      File.write(path, "<strong>bold</strong> <script>bad</script>")
      entry = PotatoMesh::App::Pages::PageEntry.new(
        sort_key: "1-mixed", slug: "mixed", title: "Mixed", path: path,
      )

      html = described_class.render_page_content(entry)
      expect(html).to include("<strong>")
      expect(html).not_to include("<script")
    end
  end

  # ── find_page_by_slug ───────────────────────────────────────

  describe ".find_page_by_slug" do
    it "finds a page by slug" do
      File.write(File.join(pages_dir, "1-alpha.md"), "# Alpha")
      File.write(File.join(pages_dir, "2-beta.md"), "# Beta")

      allow(PotatoMesh::Config).to receive(:pages_directory).and_return(pages_dir)

      page = described_class.find_page_by_slug("beta")
      expect(page).not_to be_nil
      expect(page.slug).to eq("beta")
    end

    it "returns nil for an unknown slug" do
      allow(PotatoMesh::Config).to receive(:pages_directory).and_return(pages_dir)
      expect(described_class.find_page_by_slug("nonexistent")).to be_nil
    end
  end

  # ── static_pages (caching) ──────────────────────────────────

  describe ".static_pages" do
    it "returns cached entries from the configured directory" do
      File.write(File.join(pages_dir, "1-cached.md"), "# Cached")
      allow(PotatoMesh::Config).to receive(:pages_directory).and_return(pages_dir)

      result = described_class.static_pages
      expect(result.length).to eq(1)
      expect(result.first.slug).to eq("cached")
    end

    it "clears the cache when clear_pages_cache! is called" do
      File.write(File.join(pages_dir, "1-first.md"), "# First")
      allow(PotatoMesh::Config).to receive(:pages_directory).and_return(pages_dir)

      first = described_class.static_pages
      expect(first.length).to eq(1)

      File.write(File.join(pages_dir, "2-second.md"), "# Second")
      described_class.clear_pages_cache!

      second = described_class.static_pages
      expect(second.length).to eq(2)
    end
  end

  # ── production_environment? ─────────────────────────────────

  describe ".production_environment?" do
    it "returns false in the test environment" do
      expect(described_class.production_environment?).to be false
    end

    it "returns true when RACK_ENV is production" do
      original = ENV["RACK_ENV"]
      begin
        ENV["RACK_ENV"] = "production"
        expect(described_class.production_environment?).to be true
      ensure
        ENV["RACK_ENV"] = original
      end
    end

    it "returns true when APP_ENV is production" do
      original_rack = ENV["RACK_ENV"]
      original_app = ENV["APP_ENV"]
      begin
        ENV["RACK_ENV"] = "test"
        ENV["APP_ENV"] = "production"
        expect(described_class.production_environment?).to be true
      ensure
        ENV["RACK_ENV"] = original_rack
        ENV["APP_ENV"] = original_app
      end
    end
  end

  # ── Route integration ───────────────────────────────────────

  let(:app) { Sinatra::Application }

  describe "GET /pages/:slug" do
    before do
      FileUtils.mkdir_p(pages_dir)
      File.write(File.join(pages_dir, "1-about.md"), "# About\n\nWelcome.")
      allow(PotatoMesh::Config).to receive(:pages_directory).and_return(pages_dir)
      PotatoMesh::App::Pages.clear_pages_cache!
    end

    it "renders a valid page with 200" do
      get "/pages/about"
      expect(last_response).to be_ok
      expect(last_response.body).to include("About")
      expect(last_response.body).to include("Welcome.")
      expect(last_response.body).to include("static-page")
    end

    it "renders the page within the site layout" do
      get "/pages/about"
      expect(last_response.body).to include("site-header")
      expect(last_response.body).to include("site-nav")
    end

    it "marks the page as active in nav" do
      get "/pages/about"
      expect(last_response.body).to include('aria-current="page"')
    end

    it "returns 404 for an unknown slug" do
      get "/pages/nonexistent"
      expect(last_response.status).to eq(404)
    end

    it "rejects path traversal attempts" do
      get "/pages/..%2F..%2Fetc"
      expect(last_response.status).to be >= 400
    end

    it "returns 400 for an uppercase slug" do
      get "/pages/ABOUT"
      expect(last_response.status).to eq(400)
    end

    it "returns 400 for a slug with encoded special characters" do
      get "/pages/a%3Cb"
      expect(last_response.status).to eq(400)
    end

    it "returns 500 when page content cannot be rendered" do
      File.write(File.join(pages_dir, "1-about.md"), "# About")
      PotatoMesh::App::Pages.clear_pages_cache!

      allow(PotatoMesh::App::Pages).to receive(:render_page_content).and_return(nil)

      get "/pages/about"
      expect(last_response.status).to eq(500)
    end

    it "includes nav links for static pages" do
      File.write(File.join(pages_dir, "2-contact.md"), "# Contact")
      PotatoMesh::App::Pages.clear_pages_cache!

      get "/pages/about"
      expect(last_response.body).to include('href="/pages/about"')
      expect(last_response.body).to include('href="/pages/contact"')
    end
  end

  describe "static page nav links on other pages" do
    before do
      FileUtils.mkdir_p(pages_dir)
      File.write(File.join(pages_dir, "1-info.md"), "# Info")
      allow(PotatoMesh::Config).to receive(:pages_directory).and_return(pages_dir)
      PotatoMesh::App::Pages.clear_pages_cache!
    end

    it "shows page links in the dashboard nav" do
      get "/"
      expect(last_response.body).to include('href="/pages/info"')
      expect(last_response.body).to include("Info")
    end
  end
end
