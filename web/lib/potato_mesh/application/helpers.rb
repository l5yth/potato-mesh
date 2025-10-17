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
    # Shared view and controller helper methods. Each helper is documented with
    # its intended consumers to ensure consistent behaviour across the Sinatra
    # application.
    module Helpers
      # Fetch an application level constant exposed by {PotatoMesh::Application}.
      #
      # @param name [Symbol] constant identifier to retrieve.
      # @return [Object] constant value stored on the application class.
      def app_constant(name)
        PotatoMesh::Application.const_get(name)
      end

      # Retrieve the configured Prometheus report identifiers as an array.
      #
      # @return [Array<String>] list of report IDs used on the metrics page.
      def prom_report_ids
        PotatoMesh::Config.prom_report_id_list
      end

      # Read a text configuration value with a fallback.
      #
      # @param key [String] environment variable key.
      # @param default [String] fallback value when unset.
      # @return [String] sanitised configuration string.
      def fetch_config_string(key, default)
        PotatoMesh::Config.fetch_string(key, default)
      end

      # Proxy for {PotatoMesh::Sanitizer.string_or_nil}.
      #
      # @param value [Object] value to sanitise.
      # @return [String, nil] cleaned string or nil.
      def string_or_nil(value)
        PotatoMesh::Sanitizer.string_or_nil(value)
      end

      # Proxy for {PotatoMesh::Sanitizer.sanitize_instance_domain}.
      #
      # @param value [Object] candidate domain string.
      # @param downcase [Boolean] whether to force lowercase normalisation.
      # @return [String, nil] canonical domain or nil.
      def sanitize_instance_domain(value, downcase: true)
        PotatoMesh::Sanitizer.sanitize_instance_domain(value, downcase: downcase)
      end

      # Proxy for {PotatoMesh::Sanitizer.instance_domain_host}.
      #
      # @param domain [String] domain literal.
      # @return [String, nil] host portion of the domain.
      def instance_domain_host(domain)
        PotatoMesh::Sanitizer.instance_domain_host(domain)
      end

      # Proxy for {PotatoMesh::Sanitizer.ip_from_domain}.
      #
      # @param domain [String] domain literal.
      # @return [IPAddr, nil] parsed address object.
      def ip_from_domain(domain)
        PotatoMesh::Sanitizer.ip_from_domain(domain)
      end

      # Proxy for {PotatoMesh::Sanitizer.sanitized_string}.
      #
      # @param value [Object] arbitrary input.
      # @return [String] trimmed string representation.
      def sanitized_string(value)
        PotatoMesh::Sanitizer.sanitized_string(value)
      end

      # Retrieve the site name presented to users.
      #
      # @return [String] sanitised site label.
      def sanitized_site_name
        PotatoMesh::Sanitizer.sanitized_site_name
      end

      # Retrieve the configured channel.
      #
      # @return [String] sanitised channel identifier.
      def sanitized_channel
        PotatoMesh::Sanitizer.sanitized_channel
      end

      # Retrieve the configured frequency descriptor.
      #
      # @return [String] sanitised frequency text.
      def sanitized_frequency
        PotatoMesh::Sanitizer.sanitized_frequency
      end

      # Build the configuration hash exposed to the frontend application.
      #
      # @return [Hash] JSON serialisable configuration payload.
      def frontend_app_config
        {
          refreshIntervalSeconds: PotatoMesh::Config.refresh_interval_seconds,
          refreshMs: PotatoMesh::Config.refresh_interval_seconds * 1000,
          chatEnabled: !private_mode?,
          channel: sanitized_channel,
          frequency: sanitized_frequency,
          contactLink: sanitized_contact_link,
          contactLinkUrl: sanitized_contact_link_url,
          mapCenter: {
            lat: PotatoMesh::Config.map_center_lat,
            lon: PotatoMesh::Config.map_center_lon,
          },
          maxDistanceKm: PotatoMesh::Config.max_distance_km,
          tileFilters: PotatoMesh::Config.tile_filters,
          instanceDomain: app_constant(:INSTANCE_DOMAIN),
        }
      end

      # Retrieve the configured contact link or nil when unset.
      #
      # @return [String, nil] contact link identifier.
      def sanitized_contact_link
        PotatoMesh::Sanitizer.sanitized_contact_link
      end

      # Retrieve the hyperlink derived from the configured contact link.
      #
      # @return [String, nil] hyperlink pointing to the community chat.
      def sanitized_contact_link_url
        PotatoMesh::Sanitizer.sanitized_contact_link_url
      end

      # Retrieve the configured maximum node distance in kilometres.
      #
      # @return [Numeric, nil] maximum distance or nil if disabled.
      def sanitized_max_distance_km
        PotatoMesh::Sanitizer.sanitized_max_distance_km
      end

      # Format a kilometre value for human readable output.
      #
      # @param distance [Numeric] distance in kilometres.
      # @return [String] formatted distance value.
      def formatted_distance_km(distance)
        PotatoMesh::Meta.formatted_distance_km(distance)
      end

      # Generate the meta description used in SEO tags.
      #
      # @return [String] combined descriptive sentence.
      def meta_description
        PotatoMesh::Meta.description(private_mode: private_mode?)
      end

      # Generate the structured meta configuration for the UI.
      #
      # @return [Hash] frozen configuration metadata.
      def meta_configuration
        PotatoMesh::Meta.configuration(private_mode: private_mode?)
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

      # Emit a structured debug log entry tagged with the calling context.
      #
      # @param message [String] text to emit.
      # @param context [String] logical source of the message.
      # @param metadata [Hash] additional structured key/value data.
      # @return [void]
      def debug_log(message, context: "app", **metadata)
        logger = PotatoMesh::Logging.logger_for(self)
        PotatoMesh::Logging.log(logger, :debug, message, context: context, **metadata)
      end

      # Emit a structured warning log entry tagged with the calling context.
      #
      # @param message [String] text to emit.
      # @param context [String] logical source of the message.
      # @param metadata [Hash] additional structured key/value data.
      # @return [void]
      def warn_log(message, context: "app", **metadata)
        logger = PotatoMesh::Logging.logger_for(self)
        PotatoMesh::Logging.log(logger, :warn, message, context: context, **metadata)
      end

      # Indicate whether private mode has been requested.
      #
      # @return [Boolean] true when PRIVATE=1.
      def private_mode?
        PotatoMesh::Config.private_mode_enabled?
      end

      # Identify whether the Rack environment corresponds to the test suite.
      #
      # @return [Boolean] true when RACK_ENV is "test".
      def test_environment?
        ENV["RACK_ENV"] == "test"
      end

      # Determine whether federation features should be active.
      #
      # @return [Boolean] true when federation configuration allows it.
      def federation_enabled?
        ENV.fetch("FEDERATION", "1") != "0" && !private_mode?
      end

      # Determine whether federation announcements should run asynchronously.
      #
      # @return [Boolean] true when announcements are enabled.
      def federation_announcements_active?
        federation_enabled? && !test_environment?
      end
    end
  end
end
