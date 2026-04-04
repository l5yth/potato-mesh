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
