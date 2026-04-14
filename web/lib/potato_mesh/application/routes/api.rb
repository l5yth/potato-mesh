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
        # Accepted protocol filter values.  Unknown values are discarded to
        # prevent attacker-controlled strings from polluting the cache keyspace.
        KNOWN_PROTOCOLS = Set.new(%w[meshcore meshtastic]).freeze

        # Register read-only API endpoints that expose cached mesh data and
        # instance metadata. Invoked by Sinatra during extension registration.
        #
        # @param app [Sinatra::Base] application instance receiving the routes.
        # @return [void]
        def self.registered(app)
          known_protocols = KNOWN_PROTOCOLS

          app.helpers do
            # Sanitise the protocol query parameter to a known value.
            define_method(:sanitize_protocol) do |raw|
              val = raw&.to_s&.strip&.downcase
              known_protocols.include?(val) ? val : nil
            end

            # Set Cache-Control headers appropriate for the current mode.
            # Private-mode instances must not allow intermediary caches to
            # store responses that may contain filtered data.
            define_method(:api_cache_control) do |max_age: 10|
              visibility = private_mode? ? :private : :public
              cache_control visibility, :must_revalidate, max_age: max_age
            end
          end

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
            limit = coerce_query_limit(params["limit"])
            since = params["since"]
            protocol = sanitize_protocol(params["protocol"])
            since_val = coerce_integer(since) || 0
            priv = private_mode? ? 1 : 0

            if since_val > 0
              json_body = query_nodes(limit, since: since, protocol: protocol).to_json
              etag Digest::MD5.hexdigest(json_body), kind: :weak
              api_cache_control
              json_body
            else
              cached = PotatoMesh::App::ApiCache.fetch("api:nodes:#{limit}:#{protocol}:#{priv}", ttl_seconds: 15) do
                query_nodes(limit, since: since, protocol: protocol).to_json
              end
              etag cached[:etag], kind: :weak
              api_cache_control
              cached[:value]
            end
          end

          app.get "/api/stats" do
            content_type :json
            priv = private_mode? ? 1 : 0
            cached = PotatoMesh::App::ApiCache.fetch("api:stats:#{priv}", ttl_seconds: 15) do
              stats = query_active_node_stats
              {
                active_nodes: {
                  "hour" => stats["hour"], "day" => stats["day"],
                  "week" => stats["week"], "month" => stats["month"],
                },
                meshcore: stats["meshcore"],
                meshtastic: stats["meshtastic"],
                sampled: false,
              }.to_json
            end

            etag cached[:etag], kind: :weak
            api_cache_control
            cached[:value]
          end

          app.get "/api/nodes/:id" do
            content_type :json
            node_ref = string_or_nil(params["id"])
            halt 400, { error: "missing node id" }.to_json unless node_ref
            limit = coerce_query_limit(params["limit"])
            rows = query_nodes(limit, node_ref: node_ref, since: params["since"])
            halt 404, { error: "not found" }.to_json if rows.empty?
            json_body = rows.first.to_json
            etag Digest::MD5.hexdigest(json_body), kind: :weak
            api_cache_control
            json_body
          end

          app.get "/api/ingestors" do
            content_type :json
            limit = coerce_query_limit(params["limit"])
            protocol = sanitize_protocol(params["protocol"])
            since = params["since"]
            since_val = coerce_integer(since) || 0

            if since_val > 0
              json_body = query_ingestors(limit, since: since, protocol: protocol).to_json
              etag Digest::MD5.hexdigest(json_body), kind: :weak
              api_cache_control
              json_body
            else
              cached = PotatoMesh::App::ApiCache.fetch("api:ingestors:#{limit}:#{protocol}", ttl_seconds: 30) do
                query_ingestors(limit, since: since, protocol: protocol).to_json
              end
              etag cached[:etag], kind: :weak
              api_cache_control
              cached[:value]
            end
          end

          app.get "/api/messages" do
            content_type :json
            limit = coerce_query_limit(params["limit"])
            include_encrypted = coerce_boolean(params["encrypted"]) || false
            since = coerce_integer(params["since"])
            since = 0 if since.nil? || since.negative?
            protocol = sanitize_protocol(params["protocol"])
            enc_key = include_encrypted ? "1" : "0"

            if since > 0
              json_body = query_messages(limit, include_encrypted: include_encrypted, since: since, protocol: protocol).to_json
              etag Digest::MD5.hexdigest(json_body), kind: :weak
              api_cache_control
              json_body
            else
              cached = PotatoMesh::App::ApiCache.fetch("api:messages:#{limit}:#{enc_key}:#{protocol}", ttl_seconds: 10) do
                query_messages(limit, include_encrypted: include_encrypted, since: since, protocol: protocol).to_json
              end
              etag cached[:etag], kind: :weak
              api_cache_control
              cached[:value]
            end
          end

          app.get "/api/messages/:id" do
            content_type :json
            node_ref = string_or_nil(params["id"])
            halt 400, { error: "missing node id" }.to_json unless node_ref
            limit = coerce_query_limit(params["limit"])
            include_encrypted = coerce_boolean(params["encrypted"]) || false
            since = coerce_integer(params["since"])
            since = 0 if since.nil? || since.negative?
            json_body = query_messages(
              limit,
              node_ref: node_ref,
              include_encrypted: include_encrypted,
              since: since,
              protocol: sanitize_protocol(params["protocol"]),
            ).to_json
            etag Digest::MD5.hexdigest(json_body), kind: :weak
            api_cache_control
            json_body
          end

          app.get "/api/positions" do
            content_type :json
            limit = coerce_query_limit(params["limit"])
            since = params["since"]
            protocol = sanitize_protocol(params["protocol"])
            since_val = coerce_integer(since) || 0

            if since_val > 0
              json_body = query_positions(limit, since: since, protocol: protocol).to_json
              etag Digest::MD5.hexdigest(json_body), kind: :weak
              api_cache_control
              json_body
            else
              cached = PotatoMesh::App::ApiCache.fetch("api:positions:#{limit}:#{protocol}", ttl_seconds: 15) do
                query_positions(limit, since: since, protocol: protocol).to_json
              end
              etag cached[:etag], kind: :weak
              api_cache_control
              cached[:value]
            end
          end

          app.get "/api/positions/:id" do
            content_type :json
            node_ref = string_or_nil(params["id"])
            halt 400, { error: "missing node id" }.to_json unless node_ref
            limit = coerce_query_limit(params["limit"])
            json_body = query_positions(limit, node_ref: node_ref, since: params["since"], protocol: sanitize_protocol(params["protocol"])).to_json
            etag Digest::MD5.hexdigest(json_body), kind: :weak
            api_cache_control
            json_body
          end

          app.get "/api/neighbors" do
            content_type :json
            limit = coerce_query_limit(params["limit"])
            since = params["since"]
            protocol = sanitize_protocol(params["protocol"])
            since_val = coerce_integer(since) || 0

            if since_val > 0
              json_body = query_neighbors(limit, since: since, protocol: protocol).to_json
              etag Digest::MD5.hexdigest(json_body), kind: :weak
              api_cache_control
              json_body
            else
              cached = PotatoMesh::App::ApiCache.fetch("api:neighbors:#{limit}:#{protocol}", ttl_seconds: 30) do
                query_neighbors(limit, since: since, protocol: protocol).to_json
              end
              etag cached[:etag], kind: :weak
              api_cache_control
              cached[:value]
            end
          end

          app.get "/api/neighbors/:id" do
            content_type :json
            node_ref = string_or_nil(params["id"])
            halt 400, { error: "missing node id" }.to_json unless node_ref
            limit = coerce_query_limit(params["limit"])
            json_body = query_neighbors(limit, node_ref: node_ref, since: params["since"], protocol: sanitize_protocol(params["protocol"])).to_json
            etag Digest::MD5.hexdigest(json_body), kind: :weak
            api_cache_control
            json_body
          end

          app.get "/api/telemetry" do
            content_type :json
            limit = coerce_query_limit(params["limit"])
            since = params["since"]
            protocol = sanitize_protocol(params["protocol"])
            since_val = coerce_integer(since) || 0

            if since_val > 0
              json_body = query_telemetry(limit, since: since, protocol: protocol).to_json
              etag Digest::MD5.hexdigest(json_body), kind: :weak
              api_cache_control
              json_body
            else
              cached = PotatoMesh::App::ApiCache.fetch("api:telemetry:#{limit}:#{protocol}", ttl_seconds: 15) do
                query_telemetry(limit, since: since, protocol: protocol).to_json
              end
              etag cached[:etag], kind: :weak
              api_cache_control
              cached[:value]
            end
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

            since = params["since"]
            since_val = coerce_integer(since) || 0

            if since_val > 0
              json_body = query_telemetry_buckets(window_seconds: window_seconds, bucket_seconds: bucket_seconds, since: since).to_json
              etag Digest::MD5.hexdigest(json_body), kind: :weak
              api_cache_control(max_age: 30)
              json_body
            else
              cache_key = "api:telemetry_agg:#{window_seconds}:#{bucket_seconds}"
              cached = PotatoMesh::App::ApiCache.fetch(cache_key, ttl_seconds: 60) do
                query_telemetry_buckets(window_seconds: window_seconds, bucket_seconds: bucket_seconds, since: since).to_json
              end
              etag cached[:etag], kind: :weak
              api_cache_control(max_age: 30)
              cached[:value]
            end
          end

          app.get "/api/telemetry/:id" do
            content_type :json
            node_ref = string_or_nil(params["id"])
            halt 400, { error: "missing node id" }.to_json unless node_ref
            limit = coerce_query_limit(params["limit"])
            json_body = query_telemetry(limit, node_ref: node_ref, since: params["since"], protocol: sanitize_protocol(params["protocol"])).to_json
            etag Digest::MD5.hexdigest(json_body), kind: :weak
            api_cache_control
            json_body
          end

          app.get "/api/traces" do
            content_type :json
            limit = coerce_query_limit(params["limit"])
            since = params["since"]
            protocol = sanitize_protocol(params["protocol"])
            since_val = coerce_integer(since) || 0

            if since_val > 0
              json_body = query_traces(limit, since: since, protocol: protocol).to_json
              etag Digest::MD5.hexdigest(json_body), kind: :weak
              api_cache_control
              json_body
            else
              cached = PotatoMesh::App::ApiCache.fetch("api:traces:#{limit}:#{protocol}", ttl_seconds: 30) do
                query_traces(limit, since: since, protocol: protocol).to_json
              end
              etag cached[:etag], kind: :weak
              api_cache_control
              cached[:value]
            end
          end

          app.get "/api/traces/:id" do
            content_type :json
            node_ref = string_or_nil(params["id"])
            halt 400, { error: "missing node id" }.to_json unless node_ref
            limit = coerce_query_limit(params["limit"])
            json_body = query_traces(limit, node_ref: node_ref, since: params["since"], protocol: sanitize_protocol(params["protocol"])).to_json
            etag Digest::MD5.hexdigest(json_body), kind: :weak
            api_cache_control
            json_body
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
