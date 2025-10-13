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
        def self.registered(app)
          app.get "/version" do
            content_type :json
            last_update = latest_node_update_timestamp
            payload = {
              name: sanitized_site_name,
              version: app_constant(:APP_VERSION),
              lastNodeUpdate: last_update,
              config: {
                siteName: sanitized_site_name,
                defaultChannel: sanitized_channel,
                defaultFrequency: sanitized_frequency,
                refreshIntervalSeconds: PotatoMesh::Config.refresh_interval_seconds,
                mapCenter: {
                  lat: PotatoMesh::Config.map_center_lat,
                  lon: PotatoMesh::Config.map_center_lon,
                },
                maxNodeDistanceKm: PotatoMesh::Config.max_distance_km,
                contactLink: sanitized_contact_link,
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
            halt 404 if private_mode?
            content_type :json
            limit = [params["limit"]&.to_i || 200, 1000].min
            query_messages(limit).to_json
          end

          app.get "/api/messages/:id" do
            halt 404 if private_mode?
            content_type :json
            node_ref = string_or_nil(params["id"])
            halt 400, { error: "missing node id" }.to_json unless node_ref
            limit = [params["limit"]&.to_i || 200, 1000].min
            query_messages(limit, node_ref: node_ref).to_json
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

          app.get "/api/telemetry/:id" do
            content_type :json
            node_ref = string_or_nil(params["id"])
            halt 400, { error: "missing node id" }.to_json unless node_ref
            limit = [params["limit"]&.to_i || 200, 1000].min
            query_telemetry(limit, node_ref: node_ref).to_json
          end

          app.get "/api/instances" do
            content_type :json
            ensure_self_instance_record!
            db = open_database(readonly: true)
            db.results_as_hash = true
            rows = with_busy_retry do
              db.execute(
                <<~SQL,
                SELECT id, domain, pubkey, name, version, channel, frequency,
                       latitude, longitude, last_update_time, is_private, signature
                FROM instances
                WHERE domain IS NOT NULL AND TRIM(domain) != ''
                  AND pubkey IS NOT NULL AND TRIM(pubkey) != ''
                ORDER BY LOWER(domain)
              SQL
              )
            end
            payload = rows.map do |row|
              {
                "id" => row["id"],
                "domain" => row["domain"],
                "pubkey" => row["pubkey"],
                "name" => row["name"],
                "version" => row["version"],
                "channel" => row["channel"],
                "frequency" => row["frequency"],
                "latitude" => row["latitude"],
                "longitude" => row["longitude"],
                "lastUpdateTime" => row["last_update_time"]&.to_i,
                "isPrivate" => row["is_private"].to_i == 1,
                "signature" => row["signature"],
              }.reject { |_, value| value.nil? }
            end
            JSON.generate(payload)
          ensure
            db&.close
          end
        end
      end
    end
  end
end
