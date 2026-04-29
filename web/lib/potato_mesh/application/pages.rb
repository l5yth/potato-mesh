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
require "yaml"

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
      #   @return [String] human-readable nav label, optionally overridden
      #     via YAML frontmatter.
      # @!attribute [r] path
      #   @return [String] absolute filesystem path to the Markdown source.
      # @!attribute [r] description
      #   @return [String, nil] meta-description override sourced from
      #     frontmatter, or +nil+ when the global default should be used.
      # @!attribute [r] image
      #   @return [String, nil] absolute URL for the per-page social preview
      #     image, or +nil+ when the default OG image should be used.
      # @!attribute [r] noindex
      #   @return [Boolean] +true+ when the operator marked the page with
      #     +noindex: true+ in frontmatter; instructs crawlers to skip it.
      PageEntry = Struct.new(
        :sort_key,
        :slug,
        :title,
        :path,
        :description,
        :image,
        :noindex,
        keyword_init: true,
      )

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

      # Maximum number of bytes inspected when extracting frontmatter from a
      # candidate file during directory scans. Keeps {load_static_pages}
      # cheap for large markdown files.
      FRONTMATTER_PROBE_BYTES = 4096

      # Set of frontmatter keys that operators may use to influence how a
      # page is presented to crawlers and social platforms. Any other key in
      # the document is silently ignored to keep the surface area small and
      # the parser predictable.
      ALLOWED_FRONTMATTER_KEYS = %w[title description image noindex].freeze

      # Pattern used to recognise a leading YAML frontmatter block.
      FRONTMATTER_PATTERN = /\A---\s*\n(.*?)\n---\s*(?:\n|\z)/m

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

      # Extract the frontmatter block (if any) from raw markdown source.
      #
      # The first +---+ delimited block is parsed via {YAML.safe_load}; only
      # keys listed in {ALLOWED_FRONTMATTER_KEYS} are kept and string values
      # are stripped. Malformed YAML, unsupported types, and missing
      # delimiters all result in an empty hash so the caller can fall back to
      # filename-derived metadata without raising.
      #
      # @param content [String] raw file contents (UTF-8).
      # @return [Hash{String=>Object}] permitted, normalised frontmatter
      #   values.
      def parse_frontmatter(content)
        return {} unless content.is_a?(String)

        match = content.match(FRONTMATTER_PATTERN)
        return {} unless match

        begin
          parsed = YAML.safe_load(match[1], permitted_classes: [], aliases: false) || {}
        rescue Psych::Exception
          return {}
        end
        return {} unless parsed.is_a?(Hash)

        parsed.each_with_object({}) do |(key, value), result|
          string_key = key.to_s
          next unless ALLOWED_FRONTMATTER_KEYS.include?(string_key)

          result[string_key] = normalise_frontmatter_value(string_key, value)
        end
      end

      # Strip a leading frontmatter block from the raw markdown body.
      #
      # @param content [String] file contents.
      # @return [String] markdown body without frontmatter.
      def strip_frontmatter(content)
        return content unless content.is_a?(String)

        content.sub(FRONTMATTER_PATTERN, "")
      end

      # Coerce frontmatter values into the canonical type expected for each
      # supported key. String fields are trimmed; +noindex+ is forced into a
      # strict boolean; +image+ additionally enforces an +http(s)+ scheme
      # so an operator who pastes a +data:+, +javascript:+, or relative
      # URI does not silently leak it into the +og:image+ tag. Unrecognised
      # values fall through to +nil+/+false+ so the rest of the pipeline
      # can rely on simple checks.
      #
      # @param key [String] supported frontmatter key.
      # @param value [Object] raw parsed value from {YAML.safe_load}.
      # @return [String, Boolean, nil] normalised value.
      def normalise_frontmatter_value(key, value)
        case key
        when "noindex"
          truthy_frontmatter?(value)
        when "image"
          normalise_image_url(value)
        else
          string = value.is_a?(String) ? value : value.to_s
          stripped = string.strip
          stripped.empty? ? nil : stripped
        end
      end

      # Validate an operator-supplied image URL. Only +http(s)+ schemes are
      # accepted — +data:+, +javascript:+, relative paths, and other
      # exotic forms are dropped silently because they would either fail
      # to render in social-media link previews or open a content-security
      # foot-gun.
      #
      # @param value [Object] raw frontmatter value.
      # @return [String, nil] absolute URL or +nil+ when invalid/blank.
      def normalise_image_url(value)
        string = value.is_a?(String) ? value : value.to_s
        stripped = string.strip
        return nil if stripped.empty?
        return nil unless stripped.match?(%r{\Ahttps?://}i)

        stripped
      end

      # Decide whether a frontmatter scalar should be treated as truthy.
      #
      # Accepts native booleans as well as the common string aliases
      # +"true"+, +"yes"+, +"1"+, +"on"+ (case-insensitive) so operators do
      # not have to remember YAML's exact boolean coercion rules.
      #
      # @param value [Object] candidate value.
      # @return [Boolean] +true+ when the value should map to truth.
      def truthy_frontmatter?(value)
        return value if value == true || value == false

        normalised = value.to_s.strip.downcase
        %w[true yes 1 on].include?(normalised)
      end

      # Read up to {FRONTMATTER_PROBE_BYTES} of the file at +path+ for
      # frontmatter inspection during directory scans. Returns an empty
      # string for unreadable or oversized inputs so the caller can treat
      # them as having no frontmatter.
      #
      # The result is force-encoded to UTF-8 because YAML parsers refuse
      # input declared as binary; for files that are already UTF-8 this
      # is a no-op, and for files in another encoding it surfaces a
      # decoding error to the YAML parser instead of silently producing
      # gibberish that happens to match the frontmatter delimiters.
      #
      # @param path [String] absolute path to the markdown source.
      # @return [String] candidate frontmatter prefix.
      def read_frontmatter_probe(path)
        return "" unless File.file?(path) && File.readable?(path)

        raw = File.open(path, "r:UTF-8") { |file| file.read(FRONTMATTER_PROBE_BYTES) || "" }
        raw.force_encoding(Encoding::UTF_8)
      rescue SystemCallError
        ""
      end

      # Apply parsed frontmatter values to a {PageEntry}, returning a new
      # struct that preserves filename-derived defaults whenever a key is
      # absent or blank.
      #
      # {parse_frontmatter} has already dropped blank string values for
      # +title+/+description+/+image+, so this method can rely on truthy
      # checks rather than re-validating each key.
      #
      # @param entry [PageEntry] base entry parsed from the filename.
      # @param frontmatter [Hash] permitted frontmatter values.
      # @return [PageEntry] enriched entry.
      def apply_frontmatter(entry, frontmatter)
        return entry unless entry

        PageEntry.new(
          sort_key: entry.sort_key,
          slug: entry.slug,
          title: frontmatter["title"] || entry.title,
          path: entry.path,
          description: frontmatter["description"],
          image: frontmatter["image"],
          noindex: frontmatter["noindex"] == true,
        )
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

          base_entry = PageEntry.new(
            sort_key: entry.sort_key,
            slug: entry.slug,
            title: entry.title,
            path: path,
          )
          frontmatter = parse_frontmatter(read_frontmatter_probe(path))
          apply_frontmatter(base_entry, frontmatter)
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
        body = strip_frontmatter(content)
        raw_html = Kramdown::Document.new(body, **KRAMDOWN_OPTIONS).to_html
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
