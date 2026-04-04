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
          mapZoom: PotatoMesh::Config.map_zoom,
          maxDistanceKm: PotatoMesh::Config.max_distance_km,
          tileFilters: PotatoMesh::Config.tile_filters,
          instanceDomain: app_constant(:INSTANCE_DOMAIN),
          instancesFeatureEnabled: federation_enabled? && !private_mode?,
        }
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

      # Determine whether the application is running in a production environment.
      #
      # @return [Boolean] true when APP_ENV or RACK_ENV resolves to "production".
      def production_environment?
        app_env = string_or_nil(ENV["APP_ENV"])&.downcase
        rack_env = string_or_nil(ENV["RACK_ENV"])&.downcase

        app_env == "production" || rack_env == "production"
      end

      # Determine whether federation features should be active.
      #
      # @return [Boolean] true when federation configuration allows it.
      def federation_enabled?
        PotatoMesh::Config.federation_enabled?
      end

      # Determine whether federation announcements should run asynchronously.
      #
      # @return [Boolean] true when announcements are enabled.
      def federation_announcements_active?
        federation_enabled? && !test_environment?
      end

      # Format a kilometre value for human readable output.
      #
      # @param distance [Numeric] distance in kilometres.
      # @return [String] formatted distance value.
      def formatted_distance_km(distance)
        PotatoMesh::Meta.formatted_distance_km(distance)
      end
    end
  end
end
