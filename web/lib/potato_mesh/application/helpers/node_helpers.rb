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

module PotatoMesh
  module App
    module Helpers
      # Build the canonical node detail path for the supplied identifier.
      #
      # @param identifier [String, nil] node identifier in ``!xxxx`` notation.
      # @return [String, nil] detail path including the canonical ``!`` prefix.
      def node_detail_path(identifier)
        ident = string_or_nil(identifier)
        return nil unless ident && !ident.empty?
        trimmed = ident.strip
        return nil if trimmed.empty?
        body = trimmed.start_with?("!") ? trimmed[1..-1] : trimmed
        return nil unless body && !body.empty?
        escaped = Rack::Utils.escape_path(body)
        "/nodes/!#{escaped}"
      end

      # Render a linked long name pointing to the node detail page.
      #
      # @param long_name [String] display name for the node.
      # @param identifier [String, nil] canonical node identifier.
      # @param css_class [String, nil] optional CSS class applied to the anchor.
      # @return [String] escaped HTML snippet.
      def node_long_name_link(long_name, identifier, css_class: "node-long-link")
        text = string_or_nil(long_name)
        return "" unless text
        href = node_detail_path(identifier)
        escaped_text = Rack::Utils.escape_html(text)
        return escaped_text unless href
        canonical_identifier = canonical_node_identifier(identifier)
        class_attr = css_class ? %( class="#{css_class}") : ""
        data_attrs = %( data-node-detail-link="true")
        if canonical_identifier
          escaped_identifier = Rack::Utils.escape_html(canonical_identifier)
          data_attrs = %(#{data_attrs} data-node-id="#{escaped_identifier}")
        end
        %(<a#{class_attr} href="#{href}"#{data_attrs}>#{escaped_text}</a>)
      end

      # Normalise a node identifier by ensuring the canonical ``!`` prefix.
      #
      # @param identifier [String, nil] raw identifier string.
      # @return [String, nil] canonical identifier or ``nil`` when unavailable.
      def canonical_node_identifier(identifier)
        ident = string_or_nil(identifier)
        return nil unless ident && !ident.empty?
        trimmed = ident.strip
        return nil if trimmed.empty?
        trimmed.start_with?("!") ? trimmed : "!#{trimmed}"
      end

      # Broad emoji regex covering the most common Unicode emoji blocks:
      # Supplementary Multilingual Plane emoji (U+1F000–U+1FFFF), Miscellaneous
      # Symbols and Dingbats (U+2600–U+27BF), and Miscellaneous Symbols and
      # Arrows (U+2B00–U+2BFF).
      #
      # Matching is intentionally single-codepoint: callers iterate grapheme
      # clusters first and then test each cluster against this pattern, so
      # multi-codepoint emoji (country flags like 🇩🇪 = 🇩 + 🇪, ZWJ family
      # sequences like 👨‍👩‍👧, skin-tone modifiers like 👍🏽, the rainbow flag
      # 🏳️‍🌈) come through intact instead of being shredded into their
      # component codepoints.
      #
      # @type [Regexp]
      MESHCORE_COMPANION_EMOJI_PATTERN = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u

      # Derive a display short name for a MeshCore COMPANION node from its long
      # name. The ingestor stores a raw 2-byte short name; this method produces a
      # richer, human-readable variant for the API layer without touching the DB.
      #
      # Algorithm (applied in priority order):
      # 1. If the long name contains an emoji grapheme cluster (anchored by
      #    +MESHCORE_COMPANION_EMOJI_PATTERN+), use that whole cluster in a
      #    4-column display slot: ``" E "`` (one leading space, emoji, one
      #    trailing space). Emoji are rendered double-width in monospace fonts,
      #    so one leading space keeps the badge at four visual columns.
      #    Iterating grapheme clusters (rather than raw codepoints) preserves
      #    multi-codepoint sequences such as country flags 🇩🇪, ZWJ families
      #    👨‍👩‍👧, and skin-tone-modified thumbs 👍🏽.
      # 2. If the long name contains two or more whitespace-separated words,
      #    use the capitalised first letters of the first two words: ``" XY "``.
      # 3. Return +nil+ — single-word names fall back to the raw short name
      #    stored in the database (typically the first two bytes of the node
      #    ID). A single initial looked poor and carried no more information
      #    than the raw value.
      #
      # @param long_name [String, nil] long name stored on the node.
      # @return [String, nil] derived display short name or +nil+.
      def meshcore_companion_display_short_name(long_name)
        name = string_or_nil(long_name)
        return nil unless name

        emoji_cluster = name.each_grapheme_cluster.find do |cluster|
          cluster.match?(MESHCORE_COMPANION_EMOJI_PATTERN)
        end
        # Wide emoji occupies two display columns, so use one leading space and
        # one trailing space to stay within the four-column badge width.
        return " #{emoji_cluster} " if emoji_cluster

        words = name.strip.split(/\s+/).reject(&:empty?)
        return nil if words.empty?

        if words.length >= 2
          first = words[0][0]&.upcase
          second = words[1][0]&.upcase
          return " #{first}#{second} " if first && second
        end

        nil
      end

      # Recursively coerce hash keys to strings and normalise nested arrays.
      #
      # @param value [Object] JSON compatible value.
      # @return [Object] structure with canonical string keys.
      def normalize_json_value(value)
        case value
        when Hash
          value.each_with_object({}) do |(key, val), memo|
            memo[key.to_s] = normalize_json_value(val)
          end
        when Array
          value.map { |element| normalize_json_value(element) }
        else
          value
        end
      end

      # Parse JSON payloads or hashes into normalised hashes with string keys.
      #
      # @param value [Hash, String, nil] raw JSON object or string representation.
      # @return [Hash, nil] canonicalised hash or nil when parsing fails.
      def normalize_json_object(value)
        case value
        when Hash
          normalize_json_value(value)
        when String
          trimmed = value.strip
          return nil if trimmed.empty?
          begin
            parsed = JSON.parse(trimmed)
          rescue JSON::ParserError
            return nil
          end
          parsed.is_a?(Hash) ? normalize_json_value(parsed) : nil
        else
          nil
        end
      end

      # Coerce an arbitrary value into an integer when possible.
      #
      # @param value [Object] user supplied value.
      # @return [Integer, nil] parsed integer or nil when invalid.
      def coerce_integer(value)
        case value
        when Integer
          value
        when Float
          value.finite? ? value.to_i : nil
        when Numeric
          value.to_i
        when String
          trimmed = value.strip
          return nil if trimmed.empty?
          return trimmed.to_i(16) if trimmed.match?(/\A0[xX][0-9A-Fa-f]+\z/)
          return trimmed.to_i(10) if trimmed.match?(/\A-?\d+\z/)
          begin
            float_val = Float(trimmed)
            float_val.finite? ? float_val.to_i : nil
          rescue ArgumentError
            nil
          end
        else
          nil
        end
      end

      # Coerce an arbitrary value into a floating point number when possible.
      #
      # @param value [Object] user supplied value.
      # @return [Float, nil] parsed float or nil when invalid.
      def coerce_float(value)
        case value
        when Float
          value.finite? ? value : nil
        when Integer
          value.to_f
        when Numeric
          value.to_f
        when String
          trimmed = value.strip
          return nil if trimmed.empty?
          begin
            float_val = Float(trimmed)
            float_val.finite? ? float_val : nil
          rescue ArgumentError
            nil
          end
        else
          nil
        end
      end

      # Coerce an arbitrary value into a boolean according to common truthy
      # conventions.
      #
      # @param value [Object] user supplied value.
      # @return [Boolean, nil] boolean interpretation or nil when unknown.
      def coerce_boolean(value)
        case value
        when true, false
          value
        when String
          trimmed = value.strip.downcase
          return true if %w[true 1 yes y].include?(trimmed)
          return false if %w[false 0 no n].include?(trimmed)
          nil
        when Numeric
          !value.to_i.zero?
        else
          nil
        end
      end

      # Normalise PEM encoded public key content into LF line endings.
      #
      # @param value [String, #to_s, nil] raw PEM content.
      # @return [String, nil] cleaned PEM string or nil when blank.
      def sanitize_public_key_pem(value)
        return nil if value.nil?

        pem = value.is_a?(String) ? value : value.to_s
        pem = pem.gsub(/\r\n?/, "\n")
        return nil if pem.strip.empty?

        pem
      end
    end
  end
end
