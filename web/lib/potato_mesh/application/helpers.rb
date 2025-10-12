# frozen_string_literal: true

module PotatoMesh
  module App
    module Helpers
      def app_constant(name)
        PotatoMesh::Application.const_get(name)
      end

      def prom_report_ids
        PotatoMesh::Config.prom_report_id_list
      end

      def fetch_config_string(key, default)
        PotatoMesh::Config.fetch_string(key, default)
      end

      def string_or_nil(value)
        PotatoMesh::Sanitizer.string_or_nil(value)
      end

      def sanitize_instance_domain(value)
        PotatoMesh::Sanitizer.sanitize_instance_domain(value)
      end

      def instance_domain_host(domain)
        PotatoMesh::Sanitizer.instance_domain_host(domain)
      end

      def ip_from_domain(domain)
        PotatoMesh::Sanitizer.ip_from_domain(domain)
      end

      def sanitized_string(value)
        PotatoMesh::Sanitizer.sanitized_string(value)
      end

      def sanitized_site_name
        PotatoMesh::Sanitizer.sanitized_site_name
      end

      def sanitized_default_channel
        PotatoMesh::Sanitizer.sanitized_default_channel
      end

      def sanitized_default_frequency
        PotatoMesh::Sanitizer.sanitized_default_frequency
      end

      def frontend_app_config
        {
          refreshIntervalSeconds: PotatoMesh::Config.refresh_interval_seconds,
          refreshMs: PotatoMesh::Config.refresh_interval_seconds * 1000,
          chatEnabled: !private_mode?,
          defaultChannel: sanitized_default_channel,
          defaultFrequency: sanitized_default_frequency,
          mapCenter: {
            lat: PotatoMesh::Config.map_center_lat,
            lon: PotatoMesh::Config.map_center_lon,
          },
          maxNodeDistanceKm: PotatoMesh::Config.max_node_distance_km,
          tileFilters: PotatoMesh::Config.tile_filters,
          instanceDomain: app_constant(:INSTANCE_DOMAIN),
        }
      end

      def sanitized_matrix_room
        PotatoMesh::Sanitizer.sanitized_matrix_room
      end

      def sanitized_max_distance_km
        PotatoMesh::Sanitizer.sanitized_max_distance_km
      end

      def formatted_distance_km(distance)
        PotatoMesh::Meta.formatted_distance_km(distance)
      end

      def meta_description
        PotatoMesh::Meta.description(private_mode: private_mode?)
      end

      def meta_configuration
        PotatoMesh::Meta.configuration(private_mode: private_mode?)
      end

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

      def sanitize_public_key_pem(value)
        return nil if value.nil?

        pem = value.is_a?(String) ? value : value.to_s
        pem = pem.gsub(/\r\n?/, "\n")
        return nil if pem.strip.empty?

        pem
      end

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

      def debug_log(message)
        logger = settings.logger if respond_to?(:settings)
        logger&.debug(message)
      end

      def private_mode?
        ENV["PRIVATE"] == "1"
      end

      def test_environment?
        ENV["RACK_ENV"] == "test"
      end

      def federation_enabled?
        ENV.fetch("FEDERATION", "1") != "0" && !private_mode?
      end

      def federation_announcements_active?
        federation_enabled? && !test_environment?
      end
    end
  end
end
