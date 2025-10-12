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
      module Ingest
        def self.registered(app)
          app.post "/api/nodes" do
            require_token!
            content_type :json
            begin
              data = JSON.parse(read_json_body)
            rescue JSON::ParserError
              halt 400, { error: "invalid JSON" }.to_json
            end
            unless data.is_a?(Hash)
              halt 400, { error: "invalid payload" }.to_json
            end
            halt 400, { error: "too many nodes" }.to_json if data.size > 1000
            db = open_database
            data.each do |node_id, node|
              upsert_node(db, node_id, node)
            end
            PotatoMesh::App::Prometheus::NODES_GAUGE.set(query_nodes(1000).length)
            { status: "ok" }.to_json
          ensure
            db&.close
          end

          app.post "/api/messages" do
            halt 404 if private_mode?
            require_token!
            content_type :json
            begin
              data = JSON.parse(read_json_body)
            rescue JSON::ParserError
              halt 400, { error: "invalid JSON" }.to_json
            end
            messages = data.is_a?(Array) ? data : [data]
            halt 400, { error: "too many messages" }.to_json if messages.size > 1000
            db = open_database
            messages.each do |msg|
              insert_message(db, msg)
            end
            { status: "ok" }.to_json
          ensure
            db&.close
          end

          app.post "/api/instances" do
            content_type :json
            begin
              payload = JSON.parse(read_json_body)
            rescue JSON::ParserError
              warn "[warn] instance registration rejected: invalid JSON"
              halt 400, { error: "invalid JSON" }.to_json
            end

            unless payload.is_a?(Hash)
              warn "[warn] instance registration rejected: payload is not an object"
              halt 400, { error: "invalid payload" }.to_json
            end

            id = string_or_nil(payload["id"]) || string_or_nil(payload["instanceId"])
            domain = sanitize_instance_domain(payload["domain"])
            pubkey = sanitize_public_key_pem(payload["pubkey"])
            name = string_or_nil(payload["name"])
            version = string_or_nil(payload["version"])
            channel = string_or_nil(payload["channel"])
            frequency = string_or_nil(payload["frequency"])
            latitude = coerce_float(payload["latitude"])
            longitude = coerce_float(payload["longitude"])
            last_update_time = coerce_integer(payload["last_update_time"] || payload["lastUpdateTime"])
            raw_private = payload.key?("isPrivate") ? payload["isPrivate"] : payload["is_private"]
            is_private = coerce_boolean(raw_private)
            signature = string_or_nil(payload["signature"])

            attributes = {
              id: id,
              domain: domain,
              pubkey: pubkey,
              name: name,
              version: version,
              channel: channel,
              frequency: frequency,
              latitude: latitude,
              longitude: longitude,
              last_update_time: last_update_time,
              is_private: is_private,
            }

            if [attributes[:id], attributes[:domain], attributes[:pubkey], signature, attributes[:last_update_time]].any?(&:nil?)
              warn "[warn] instance registration rejected: missing required fields"
              halt 400, { error: "missing required fields" }.to_json
            end

            unless verify_instance_signature(attributes, signature, attributes[:pubkey])
              warn "[warn] instance registration rejected for #{attributes[:domain]}: invalid signature"
              halt 400, { error: "invalid signature" }.to_json
            end

            if attributes[:is_private]
              warn "[warn] instance registration rejected for #{attributes[:domain]}: instance marked private"
              halt 403, { error: "instance marked private" }.to_json
            end

            ip = ip_from_domain(attributes[:domain])
            if ip && restricted_ip_address?(ip)
              warn "[warn] instance registration rejected for #{attributes[:domain]}: restricted IP address"
              halt 400, { error: "restricted domain" }.to_json
            end

            well_known, well_known_meta = fetch_instance_json(attributes[:domain], "/.well-known/potato-mesh")
            unless well_known
              details_list = Array(well_known_meta).map(&:to_s)
              details = details_list.empty? ? "no response" : details_list.join("; ")
              warn "[warn] instance registration rejected for #{attributes[:domain]}: failed to fetch well-known document (#{details})"
              halt 400, { error: "failed to verify well-known document" }.to_json
            end

            valid, reason = validate_well_known_document(well_known, attributes[:domain], attributes[:pubkey])
            unless valid
              warn "[warn] instance registration rejected for #{attributes[:domain]}: #{reason}"
              halt 400, { error: reason || "invalid well-known document" }.to_json
            end

            remote_nodes, node_source = fetch_instance_json(attributes[:domain], "/api/nodes")
            unless remote_nodes
              details_list = Array(node_source).map(&:to_s)
              details = details_list.empty? ? "no response" : details_list.join("; ")
              warn "[warn] instance registration rejected for #{attributes[:domain]}: failed to fetch nodes (#{details})"
              halt 400, { error: "failed to fetch nodes" }.to_json
            end

            fresh, freshness_reason = validate_remote_nodes(remote_nodes)
            unless fresh
              warn "[warn] instance registration rejected for #{attributes[:domain]}: #{freshness_reason}"
              halt 400, { error: freshness_reason || "stale node data" }.to_json
            end

            db = open_database
            upsert_instance_record(db, attributes, signature)
            debug_log("Registered instance #{attributes[:domain]} (id: #{attributes[:id]})")
            status 201
            { status: "registered" }.to_json
          ensure
            db&.close
          end

          app.post "/api/positions" do
            require_token!
            content_type :json
            begin
              data = JSON.parse(read_json_body)
            rescue JSON::ParserError
              halt 400, { error: "invalid JSON" }.to_json
            end
            positions = data.is_a?(Array) ? data : [data]
            halt 400, { error: "too many positions" }.to_json if positions.size > 1000
            db = open_database
            positions.each do |pos|
              insert_position(db, pos)
            end
            { status: "ok" }.to_json
          ensure
            db&.close
          end

          app.post "/api/neighbors" do
            require_token!
            content_type :json
            begin
              data = JSON.parse(read_json_body)
            rescue JSON::ParserError
              halt 400, { error: "invalid JSON" }.to_json
            end
            neighbor_payloads = data.is_a?(Array) ? data : [data]
            halt 400, { error: "too many neighbor packets" }.to_json if neighbor_payloads.size > 1000
            db = open_database
            neighbor_payloads.each do |packet|
              insert_neighbors(db, packet)
            end
            { status: "ok" }.to_json
          ensure
            db&.close
          end

          app.post "/api/telemetry" do
            require_token!
            content_type :json
            begin
              data = JSON.parse(read_json_body)
            rescue JSON::ParserError
              halt 400, { error: "invalid JSON" }.to_json
            end
            telemetry_packets = data.is_a?(Array) ? data : [data]
            halt 400, { error: "too many telemetry packets" }.to_json if telemetry_packets.size > 1000
            db = open_database
            telemetry_packets.each do |packet|
              insert_telemetry(db, packet)
            end
            { status: "ok" }.to_json
          ensure
            db&.close
          end
        end
      end
    end
  end
end
