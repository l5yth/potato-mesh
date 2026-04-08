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

require "kramdown"
require "kramdown-parser-gfm"
require "sanitize"

module PotatoMesh
  module App
    # Discovers, parses, and renders operator-managed Markdown pages from the
    # configured pages directory. Files are named with an optional numeric
    # prefix for ordering (e.g. +1-about.md+, +9-contact.md+) and exposed as
    # navigable routes under +/pages/:slug+.
    module Pages
      module_function

      # Lightweight value object describing a single static page discovered on
      # disk. Fields are populated by {parse_page_filename} and consumed by
      # route handlers and layout templates.
      #
      # @!attribute [r] sort_key
      #   @return [String] filename stem used for alphabetical ordering.
      # @!attribute [r] slug
      #   @return [String] URL-safe identifier derived from the filename.
      # @!attribute [r] title
      #   @return [String] human-readable nav label.
      # @!attribute [r] path
      #   @return [String] absolute filesystem path to the Markdown source.
      PageEntry = Struct.new(:sort_key, :slug, :title, :path, keyword_init: true)

      # Pattern matching a safe slug segment: lowercase alphanumeric words
      # separated by single hyphens. Used to validate both parsed slugs and
      # incoming route parameters.
      SLUG_PATTERN = /\A[a-z0-9]+(-[a-z0-9]+)*\z/

      # Pattern used to split a page filename into an optional numeric sort
      # prefix and the slug portion.
      FILENAME_PATTERN = /\A(\d+)-(.+)\z/

      # Maximum number of pages loaded from disk. Prevents accidental
      # directory-bomb scenarios from consuming unbounded memory.
      MAX_PAGES = 50

      # Kramdown options shared across all page renders.
      KRAMDOWN_OPTIONS = {
        input: "GFM",
        hard_wrap: false,
      }.freeze

      # HTML tags allowed in rendered markdown output. Tags not in this list
      # are stripped after rendering to prevent XSS from operator content.
      ALLOWED_TAGS = Set.new(%w[
        h1 h2 h3 h4 h5 h6 p a em strong b i u s del code pre br hr
        ul ol li dl dt dd blockquote table thead tbody tfoot tr th td
        img span div sup sub abbr mark small details summary
      ]).freeze

      @pages_cache = nil
      @pages_cache_mutex = Mutex.new

      # Parse a Markdown filename into a {PageEntry} without the filesystem
      # path populated.
      #
      # Filenames are expected to follow the pattern +<digits>-<slug>.md+ where
      # the numeric prefix controls navigation order. Files without a prefix
      # are accepted, using the full stem as both sort key and slug.
      #
      # @param basename [String] bare filename (e.g. +"9-contact.md"+).
      # @return [PageEntry, nil] parsed entry or +nil+ when the filename is
      #   invalid or contains an unsafe slug.
      def parse_page_filename(basename)
        stem = basename.sub(/\.md\z/i, "")
        return nil if stem.empty?

        match = stem.match(FILENAME_PATTERN)
        if match
          slug = match[2].downcase
          sort_key = stem
        else
          slug = stem.downcase
          sort_key = stem
        end

        return nil unless slug.match?(SLUG_PATTERN)

        title = slug.split("-").map(&:capitalize).join(" ")
        PageEntry.new(sort_key: sort_key, slug: slug, title: title, path: nil)
      end

      # Scan the pages directory and return a sorted list of page entries.
      #
      # The directory is read once per call; results are not cached here (see
      # {static_pages} for the cached interface). Non-+.md+ files and entries
      # with invalid filenames are silently skipped.
      #
      # @param directory [String] absolute path to the pages directory.
      # @return [Array<PageEntry>] frozen, sort-key-ordered list of pages.
      def load_static_pages(directory = PotatoMesh::Config.pages_directory)
        return [].freeze unless directory && File.directory?(directory)

        entries = Dir.glob(File.join(directory, "*.md")).filter_map do |path|
          basename = File.basename(path)
          entry = parse_page_filename(basename)
          next unless entry

          PageEntry.new(
            sort_key: entry.sort_key,
            slug: entry.slug,
            title: entry.title,
            path: path,
          )
        end

        entries.sort_by!(&:sort_key)
        entries.uniq!(&:slug)
        entries.take(MAX_PAGES).freeze
      end

      # Return the current set of static pages, reloading from disk when the
      # cache has expired.
      #
      # The TTL is short in non-production environments (1 second) so that
      # newly added files appear almost immediately during development.
      #
      # @return [Array<PageEntry>] cached page entries.
      def static_pages
        @pages_cache_mutex.synchronize do
          if @pages_cache.nil? || Time.now > @pages_cache[:expires_at]
            ttl = production_environment? ? 60 : 1
            @pages_cache = {
              entries: load_static_pages,
              expires_at: Time.now + ttl,
            }
          end
          @pages_cache[:entries]
        end
      end

      # Look up a page entry by its URL slug.
      #
      # @param slug [String] URL slug to search for.
      # @return [PageEntry, nil] matching entry or +nil+.
      def find_page_by_slug(slug)
        static_pages.find { |entry| entry.slug == slug }
      end

      # Read and render a page's Markdown source to HTML.
      #
      # Files exceeding {Config.max_page_file_bytes} are rejected to guard
      # against accidental out-of-memory conditions. Raw HTML blocks are
      # disabled at the parser level to prevent XSS.
      #
      # @param page_entry [PageEntry] entry whose +path+ points to the source.
      # @return [String, nil] sanitised HTML string, or +nil+ when the file
      #   cannot be read.
      def render_page_content(page_entry)
        return nil unless page_entry&.path
        return nil unless File.file?(page_entry.path) && File.readable?(page_entry.path)

        size = File.size(page_entry.path)
        return nil if size > PotatoMesh::Config.max_page_file_bytes

        content = File.read(page_entry.path, encoding: "utf-8")
        raw_html = Kramdown::Document.new(content, **KRAMDOWN_OPTIONS).to_html
        strip_unsafe_html(raw_html)
      rescue SystemCallError
        nil
      end

      # Remove HTML tags not present in {ALLOWED_TAGS} and strip dangerous
      # attributes (event handlers, javascript: URIs) from the rendered output.
      # This provides a safety net against XSS when operators include raw HTML
      # in their Markdown source.
      #
      # @param html [String] raw HTML produced by kramdown.
      # @return [String] HTML with disallowed tags and attributes stripped.
      def strip_unsafe_html(html)
        # Delegate to the sanitize gem for robust HTML and attribute
        # sanitization instead of relying on ad-hoc regular expressions.
        Sanitize.fragment(
          html,
          elements: ALLOWED_TAGS,
          attributes: {
            :all => %w[id class title alt],
            "a" => %w[href],
            "img" => %w[src width height loading decoding],
          },
          protocols: {
            "a" => { "href" => ["http", "https", "mailto"] },
            "img" => { "src" => ["http", "https"] },
          },
        )
      end

      # Invalidate the in-memory page cache so the next call to
      # {static_pages} re-scans the directory. Intended for test teardown.
      #
      # @return [void]
      def clear_pages_cache!
        @pages_cache_mutex.synchronize { @pages_cache = nil }
      end

      # Determine whether the application is running in a production-like
      # environment.
      #
      # @return [Boolean] true when +RACK_ENV+ or +APP_ENV+ is +"production"+.
      def production_environment?
        %w[production].include?(ENV.fetch("RACK_ENV", nil)) ||
          %w[production].include?(ENV.fetch("APP_ENV", nil))
      end
    end
  end
end
