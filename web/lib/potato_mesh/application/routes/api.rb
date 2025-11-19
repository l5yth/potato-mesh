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
      module Api
        # Register read-only API endpoints that expose cached mesh data and
        # instance metadata. Invoked by Sinatra during extension registration.
        #
        # @param app [Sinatra::Base] application instance receiving the routes.
        # @return [void]
        def self.registered(app)
          app.before "/api/messages*" do
            halt 404 if private_mode?
          end

          app.get "/version" do
            content_type :json
            last_update = latest_node_update_timestamp
            payload = {
              name: sanitized_site_name,
              version: app_constant(:APP_VERSION),
              lastNodeUpdate: last_update,
              config: {
                siteName: sanitized_site_name,
                channel: sanitized_channel,
                frequency: sanitized_frequency,
                contactLink: sanitized_contact_link,
                contactLinkUrl: sanitized_contact_link_url,
                refreshIntervalSeconds: PotatoMesh::Config.refresh_interval_seconds,
                mapCenter: {
                  lat: PotatoMesh::Config.map_center_lat,
                  lon: PotatoMesh::Config.map_center_lon,
                },
                maxDistanceKm: PotatoMesh::Config.max_distance_km,
                instanceDomain: app_constant(:INSTANCE_DOMAIN),
                privateMode: private_mode?,
              },
            }
            payload.to_json
          end

          app.get "/.well-known/potato-mesh" do
            refresh_well_known_document_if_stale
            cache_control :public, max_age: PotatoMesh::Config.well_known_refresh_interval
            content_type :json
            send_file well_known_file_path
          end

          app.get "/api/nodes" do
            content_type :json
            limit = [params["limit"]&.to_i || 200, 1000].min
            query_nodes(limit).to_json
          end

          app.get "/api/nodes/:id" do
            content_type :json
            node_ref = string_or_nil(params["id"])
            halt 400, { error: "missing node id" }.to_json unless node_ref
            limit = [params["limit"]&.to_i || 200, 1000].min
            rows = query_nodes(limit, node_ref: node_ref)
            halt 404, { error: "not found" }.to_json if rows.empty?
            rows.first.to_json
          end

          app.get "/api/messages" do
            content_type :json
            limit = [params["limit"]&.to_i || 200, 1000].min
            include_encrypted = coerce_boolean(params["encrypted"]) || false
            query_messages(limit, include_encrypted: include_encrypted).to_json
          end

          app.get "/api/messages/:id" do
            content_type :json
            node_ref = string_or_nil(params["id"])
            halt 400, { error: "missing node id" }.to_json unless node_ref
            limit = [params["limit"]&.to_i || 200, 1000].min
            include_encrypted = coerce_boolean(params["encrypted"]) || false
            query_messages(limit, node_ref: node_ref, include_encrypted: include_encrypted).to_json
          end

          app.get "/api/positions" do
            content_type :json
            limit = [params["limit"]&.to_i || 200, 1000].min
            query_positions(limit).to_json
          end

          app.get "/api/positions/:id" do
            content_type :json
            node_ref = string_or_nil(params["id"])
            halt 400, { error: "missing node id" }.to_json unless node_ref
            limit = [params["limit"]&.to_i || 200, 1000].min
            query_positions(limit, node_ref: node_ref).to_json
          end

          app.get "/api/neighbors" do
            content_type :json
            limit = [params["limit"]&.to_i || 200, 1000].min
            query_neighbors(limit).to_json
          end

          app.get "/api/neighbors/:id" do
            content_type :json
            node_ref = string_or_nil(params["id"])
            halt 400, { error: "missing node id" }.to_json unless node_ref
            limit = [params["limit"]&.to_i || 200, 1000].min
            query_neighbors(limit, node_ref: node_ref).to_json
          end

          app.get "/api/telemetry" do
            content_type :json
            limit = [params["limit"]&.to_i || 200, 1000].min
            query_telemetry(limit).to_json
          end

          app.get "/api/telemetry/aggregated" do
            content_type :json
            default_window = PotatoMesh::App::Queries::DEFAULT_TELEMETRY_WINDOW_SECONDS
            default_bucket = PotatoMesh::App::Queries::DEFAULT_TELEMETRY_BUCKET_SECONDS

            window_seconds = if params.key?("windowSeconds")
                coerce_integer(params["windowSeconds"])
              else
                default_window
              end
            bucket_seconds = if params.key?("bucketSeconds")
                coerce_integer(params["bucketSeconds"])
              else
                default_bucket
              end

            if window_seconds.nil? || window_seconds <= 0
              halt 400, { error: "windowSeconds must be positive" }.to_json
            end
            if bucket_seconds.nil? || bucket_seconds <= 0
              halt 400, { error: "bucketSeconds must be positive" }.to_json
            end

            bucket_count = (window_seconds.to_f / bucket_seconds).ceil
            if bucket_count > PotatoMesh::App::Queries::MAX_QUERY_LIMIT
              halt 400, { error: "bucketSeconds too small for requested window" }.to_json
            end

            query_telemetry_buckets(window_seconds: window_seconds, bucket_seconds: bucket_seconds).to_json
          end

          app.get "/api/telemetry/:id" do
            content_type :json
            node_ref = string_or_nil(params["id"])
            halt 400, { error: "missing node id" }.to_json unless node_ref
            limit = [params["limit"]&.to_i || 200, 1000].min
            query_telemetry(limit, node_ref: node_ref).to_json
          end

          app.get "/api/traces" do
            content_type :json
            limit = [params["limit"]&.to_i || 200, 1000].min
            query_traces(limit).to_json
          end

          app.get "/api/traces/:id" do
            content_type :json
            node_ref = string_or_nil(params["id"])
            halt 400, { error: "missing node id" }.to_json unless node_ref
            limit = [params["limit"]&.to_i || 200, 1000].min
            query_traces(limit, node_ref: node_ref).to_json
          end

          app.get "/api/instances" do
            # Prevent the federation catalog from being exposed when federation is disabled.
            halt 404 unless federation_enabled?

            content_type :json
            ensure_self_instance_record!
            payload = load_instances_for_api
            JSON.generate(payload)
          end
        end
      end
    end
  end
end
