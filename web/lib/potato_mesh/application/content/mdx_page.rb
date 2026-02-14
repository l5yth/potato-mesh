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

require "yaml"
require "rack/utils"

module PotatoMesh
  module App
    module Content
      # Parse MDX/Markdown content files with optional frontmatter and produce
      # a sanitised HTML payload for static pages.
      module MdxPage
        module_function

        DEFAULT_METADATA = {
          "title" => "Imprint",
        }.freeze

        # Resolve the absolute source path for a page slug under web/content.
        #
        # @param slug [String] page identifier without extension.
        # @return [String] absolute path to the corresponding .mdx file.
        def source_path_for(slug)
          File.expand_path("#{slug}.mdx", content_root)
        end

        # Load and render an MDX page by slug. Missing or unreadable files are
        # mapped to a friendly fallback payload instead of raising.
        #
        # @param slug [String] page identifier without extension.
        # @return [Hash] metadata/body payload ready for view rendering.
        def load(slug)
          path = source_path_for(slug)
          return fallback_payload unless File.file?(path) && File.readable?(path)

          raw_content = File.read(path)
          metadata, body_markdown = extract_frontmatter(raw_content)
          rendered_html = markdown_to_html(body_markdown)

          {
            "found" => true,
            "title" => metadata["title"] || DEFAULT_METADATA["title"],
            "metadata" => metadata,
            "body_html" => PotatoMesh::Sanitizer.sanitize_rendered_html(rendered_html),
          }
        rescue Errno::EACCES, Errno::ENOENT
          fallback_payload
        end

        # Extract optional YAML frontmatter from a markdown file.
        #
        # @param content [String] full source file content.
        # @return [Array<Hash, String>] parsed metadata and markdown body.
        def extract_frontmatter(content)
          return [{}, content.to_s] unless content.is_a?(String)

          normalized = content.dup
          normalized.sub!(/\A\uFEFF/, "")

          while (match = normalized.match(/\A\s*<!--.*?-->\s*/m))
            normalized = normalized[match[0].length..]
          end

          frontmatter_match = normalized.match(/\A---\s*\n(?<meta>.*?)\n---\s*\n?/m)
          return [{}, normalized] unless frontmatter_match

          metadata = parse_metadata(frontmatter_match[:meta])
          remaining = normalized[frontmatter_match[0].length..].to_s
          [metadata, remaining]
        end

        # Convert YAML metadata into a flat string hash used by templates.
        #
        # @param raw_frontmatter [String] YAML frontmatter body.
        # @return [Hash] parsed key/value metadata.
        def parse_metadata(raw_frontmatter)
          parsed = YAML.safe_load(raw_frontmatter, permitted_classes: [], aliases: false)
          return {} unless parsed.is_a?(Hash)

          parsed.each_with_object({}) do |(key, value), metadata|
            next if key.nil?
            next if value.nil?

            metadata[key.to_s] = value.to_s
          end
        rescue Psych::Exception
          {}
        end

        # Render markdown to HTML while disabling embedded raw HTML parsing in
        # the markdown stage; output is sanitised by the caller.
        #
        # @param markdown [String] markdown source content.
        # @return [String] rendered HTML output.
        def markdown_to_html(markdown)
          lines = markdown.to_s.gsub("\r\n", "\n").split("\n")
          rendered = []
          in_list = false

          lines.each do |line|
            content = line.strip
            if content.empty?
              if in_list
                rendered << "</ul>"
                in_list = false
              end
              next
            end

            heading_match = content.match(/\A(#{Regexp.union("###", "##", "#")})\s+(.+)\z/)
            if heading_match
              if in_list
                rendered << "</ul>"
                in_list = false
              end
              level = heading_match[1].length
              rendered << "<h#{level}>#{render_inline_markdown(heading_match[2])}</h#{level}>"
              next
            end

            list_match = content.match(/\A[-*]\s+(.+)\z/)
            if list_match
              unless in_list
                rendered << "<ul>"
                in_list = true
              end
              rendered << "<li>#{render_inline_markdown(list_match[1])}</li>"
              next
            end

            if in_list
              rendered << "</ul>"
              in_list = false
            end
            rendered << "<p>#{render_inline_markdown(content)}</p>"
          end

          rendered << "</ul>" if in_list
          rendered.join("\n")
        end

        # Render inline markdown links while escaping plain text segments.
        #
        # @param text [String] source markdown text for a single block.
        # @return [String] escaped inline HTML fragment.
        def render_inline_markdown(text)
          source = text.to_s
          index = 0
          output = +""
          link_pattern = /\[([^\]]+)\]\(([^)]+)\)/

          while (match = link_pattern.match(source, index))
            output << Rack::Utils.escape_html(source[index...match.begin(0)])

            label = Rack::Utils.escape_html(match[1].to_s)
            href = match[2].to_s.strip
            if href.match?(/\Ahttps?:\/\/[^\s]+\z/i)
              output << "<a href=\"#{Rack::Utils.escape_html(href)}\" target=\"_blank\" rel=\"noreferrer noopener\">#{label}</a>"
            else
              output << Rack::Utils.escape_html(match[0].to_s)
            end
            index = match.end(0)
          end

          output << Rack::Utils.escape_html(source[index..].to_s)
          output
        end

        # Return the absolute content directory path relative to the web app
        # root, so loading works in local runs and container builds.
        #
        # @return [String] absolute content directory path.
        def content_root
          app_root = File.expand_path("../../../../", __dir__)
          File.expand_path("content", app_root)
        end

        # Build a stable fallback payload used when content is unavailable.
        #
        # @return [Hash] fallback response consumed by the imprint view.
        def fallback_payload
          {
            "found" => false,
            "title" => DEFAULT_METADATA["title"],
            "metadata" => {},
            "body_html" => PotatoMesh::Sanitizer.sanitize_rendered_html(
              "<p>The imprint content is currently unavailable. Please try again later.</p>",
            ),
          }
        end
      end
    end
  end
end
