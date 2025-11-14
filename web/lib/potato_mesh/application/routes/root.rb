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
    module Routes
      module Root
        module Helpers
          # Determine the initial theme from the request cookie and persist
          # sanitised values back to the client to avoid invalid states.
          #
          # @return [String] normalised theme value ('dark' or 'light').
          def resolve_initial_theme
            raw_theme = request.cookies["theme"]
            theme = %w[dark light].include?(raw_theme) ? raw_theme : "dark"
            if raw_theme != theme
              response.set_cookie(
                "theme",
                value: theme,
                path: "/",
                max_age: 60 * 60 * 24 * 7,
                same_site: :lax,
              )
            end
            theme
          end

          # Render a dashboard-oriented ERB template within the shared layout.
          #
          # @param template [Symbol] identifier for the ERB template.
          # @param view_mode [Symbol, String] logical view identifier for CSS hooks.
          # @param extra_locals [Hash] additional locals merged into the rendering context.
          # @return [String] rendered ERB output.
          def render_root_view(template, view_mode: :dashboard, extra_locals: {})
            meta = meta_configuration
            config = frontend_app_config
            theme = resolve_initial_theme
            view_mode_sym = view_mode.respond_to?(:to_sym) ? view_mode.to_sym : view_mode

            base_locals = {
              site_name: meta[:name],
              meta_title: meta[:title],
              meta_name: meta[:name],
              meta_description: meta[:description],
              channel: sanitized_channel,
              frequency: sanitized_frequency,
              map_center_lat: PotatoMesh::Config.map_center_lat,
              map_center_lon: PotatoMesh::Config.map_center_lon,
              max_distance_km: PotatoMesh::Config.max_distance_km,
              contact_link: sanitized_contact_link,
              contact_link_url: sanitized_contact_link_url,
              version: app_constant(:APP_VERSION),
              private_mode: private_mode?,
              federation_enabled: federation_enabled?,
              refresh_interval_seconds: PotatoMesh::Config.refresh_interval_seconds,
              app_config_json: JSON.generate(config),
              initial_theme: theme,
              current_view_mode: view_mode_sym,
            }
            sanitized_locals = extra_locals.is_a?(Hash) ? extra_locals : {}
            merged_locals = base_locals.merge(sanitized_locals)

            erb template, layout: :"layouts/app", locals: merged_locals
          end

          # Remove keys with +nil+ values from the provided hash, returning a
          # shallow copy. Hash#compact is only available in newer Ruby
          # versions; this helper keeps behaviour consistent across supported
          # releases.
          #
          # @param value [Hash, nil] collection subject to filtering.
          # @return [Hash] hash excluding +nil+ values.
          def reject_nil_values(value)
            return {} unless value.is_a?(Hash)

            value.each_with_object({}) do |(key, entry), memo|
              memo[key] = entry unless entry.nil?
            end
          end

          # Assemble the payload embedded into the node detail view. The
          # payload provides a canonical identifier alongside any cached node,
          # telemetry, or position rows that may already exist in the
          # database. When no persisted data is available the method returns
          # +nil+ so the caller can surface a 404 error.
          #
          # @param node_ref [Object] raw node identifier from the request.
          # @return [Hash, nil] structured node reference payload or nil when
          #   the node cannot be located.
          def build_node_detail_reference(node_ref)
            tokens = canonical_node_parts(node_ref)
            search_ref = tokens ? tokens.first : node_ref

            node_row = query_nodes(1, node_ref: search_ref).first
            telemetry_row = query_telemetry(1, node_ref: search_ref).first
            position_row = query_positions(1, node_ref: search_ref).first

            candidates = [node_row, telemetry_row, position_row].compact
            return nil if candidates.empty?

            canonical_id = string_or_nil(node_row&.fetch("node_id", nil))
            canonical_id ||= string_or_nil(telemetry_row&.fetch("node_id", nil))
            canonical_id ||= string_or_nil(position_row&.fetch("node_id", nil))
            canonical_id ||= string_or_nil(tokens&.fetch(0, nil))
            if canonical_id
              canonical_id = canonical_id.start_with?("!") ? canonical_id : "!#{canonical_id}"
            end
            return nil unless canonical_id

            numeric_id = coerce_integer(node_row&.fetch("num", nil))
            numeric_id ||= coerce_integer(telemetry_row&.fetch("node_num", nil))
            numeric_id ||= coerce_integer(position_row&.fetch("node_num", nil))
            numeric_id ||= tokens&.fetch(1, nil)

            short_id = string_or_nil(node_row&.fetch("short_name", nil))
            short_id ||= string_or_nil(telemetry_row&.fetch("short_name", nil))
            short_id ||= string_or_nil(position_row&.fetch("short_name", nil))
            short_id ||= tokens&.fetch(2, nil)

            fallback_row = node_row || telemetry_row || position_row
            fallback = fallback_row ? compact_api_row(fallback_row) : nil
            telemetry = telemetry_row ? compact_api_row(telemetry_row) : nil
            position = position_row ? compact_api_row(position_row) : nil

            {
              "nodeId" => canonical_id,
              "nodeNum" => numeric_id,
              "shortId" => short_id,
              "fallback" => fallback,
              "telemetry" => telemetry,
              "position" => position,
            }
          end
        end

        def self.registered(app)
          app.helpers Helpers
          app.get "/favicon.ico" do
            cache_control :public, max_age: PotatoMesh::Config.week_seconds
            ico_path = File.join(settings.public_folder, "favicon.ico")
            if File.file?(ico_path)
              send_file ico_path, type: "image/x-icon"
            else
              send_file File.join(settings.public_folder, "potatomesh-logo.svg"), type: "image/svg+xml"
            end
          end

          app.get "/potatomesh-logo.svg" do
            path = File.expand_path("potatomesh-logo.svg", settings.public_folder)
            settings.logger&.info("logo_path=#{path} exist=#{File.exist?(path)} file=#{File.file?(path)}")
            halt 404, "Not Found" unless File.exist?(path) && File.readable?(path)

            content_type "image/svg+xml"
            last_modified File.mtime(path)
            cache_control :public, max_age: 3600
            send_file path
          end

          app.get "/" do
            render_root_view(:index, view_mode: :dashboard)
          end

          app.get %r{/map/?} do
            render_root_view(:map, view_mode: :map)
          end

          app.get %r{/chat/?} do
            render_root_view(:chat, view_mode: :chat)
          end

          app.get %r{/nodes/?} do
            render_root_view(:nodes, view_mode: :nodes)
          end

          app.get "/nodes/:id" do
            node_ref = params.fetch("id", nil)
            reference_payload = build_node_detail_reference(node_ref)
            halt 404, "Not Found" unless reference_payload

            fallback = reference_payload["fallback"] || {}
            short_name = string_or_nil(fallback["short_name"]) || reference_payload["shortId"]
            long_name = string_or_nil(fallback["long_name"])
            role = string_or_nil(fallback["role"])
            canonical_id = string_or_nil(reference_payload["nodeId"])

            render_root_view(
              :node_detail,
              view_mode: :node_detail,
              extra_locals: {
                node_reference_json: JSON.generate(reject_nil_values(reference_payload)),
                node_page_short_name: short_name,
                node_page_long_name: long_name,
                node_page_role: role,
                node_page_identifier: canonical_id,
              },
            )
          end

          app.get "/metrics" do
            content_type ::Prometheus::Client::Formats::Text::CONTENT_TYPE
            ::Prometheus::Client::Formats::Text.marshal(::Prometheus::Client.registry)
          end
        end
      end
    end
  end
end
