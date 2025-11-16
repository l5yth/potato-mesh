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
      module Ingest
        # Register ingest endpoints used by the Python collector to persist
        # nodes, messages, and federation announcements.
        #
        # @param app [Sinatra::Base] application instance receiving the routes.
        # @return [void]
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
            rescue JSON::ParserError => e
              warn_log(
                "Instance registration rejected",
                context: "ingest.register",
                reason: "invalid JSON",
                error_class: e.class.name,
                error_message: e.message,
              )
              halt 400, { error: "invalid JSON" }.to_json
            end

            unless payload.is_a?(Hash)
              warn_log(
                "Instance registration rejected",
                context: "ingest.register",
                reason: "payload is not an object",
              )
              halt 400, { error: "invalid payload" }.to_json
            end

            id = string_or_nil(payload["id"]) || string_or_nil(payload["instanceId"])
            raw_domain_input = payload["domain"]
            raw_domain = sanitize_instance_domain(raw_domain_input, downcase: false)
            normalized_domain = raw_domain && sanitize_instance_domain(raw_domain)
            unless raw_domain && normalized_domain
              warn_log(
                "Instance registration rejected",
                context: "ingest.register",
                domain: string_or_nil(raw_domain_input),
                reason: "invalid domain",
              )
              halt 400, { error: "invalid domain" }.to_json
            end
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
              domain: normalized_domain,
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
              warn_log(
                "Instance registration rejected",
                context: "ingest.register",
                reason: "missing required fields",
              )
              halt 400, { error: "missing required fields" }.to_json
            end

            signature_valid = verify_instance_signature(attributes, signature, attributes[:pubkey])
            # Some remote peers sign payloads using a canonicalised lowercase
            # domain while still sending a mixed-case domain. Retry signature
            # verification with the original casing when the first attempt
            # fails to maximise interoperability.
            if !signature_valid && raw_domain && normalized_domain && raw_domain.casecmp?(normalized_domain) && raw_domain != normalized_domain
              alternate_attributes = attributes.merge(domain: raw_domain)
              signature_valid = verify_instance_signature(alternate_attributes, signature, attributes[:pubkey])
            end

            unless signature_valid
              warn_log(
                "Instance registration rejected",
                context: "ingest.register",
                domain: raw_domain || attributes[:domain],
                reason: "invalid signature",
              )
              halt 400, { error: "invalid signature" }.to_json
            end

            if attributes[:is_private]
              warn_log(
                "Instance registration rejected",
                context: "ingest.register",
                domain: attributes[:domain],
                reason: "instance marked private",
              )
              halt 403, { error: "instance marked private" }.to_json
            end

            ip = ip_from_domain(attributes[:domain])
            if ip && restricted_ip_address?(ip)
              warn_log(
                "Instance registration rejected",
                context: "ingest.register",
                domain: attributes[:domain],
                reason: "restricted IP address",
                resolved_ip: ip,
              )
              halt 400, { error: "restricted domain" }.to_json
            end

            begin
              resolve_remote_ip_addresses(URI.parse("https://#{attributes[:domain]}"))
            rescue ArgumentError => e
              warn_log(
                "Instance registration rejected",
                context: "ingest.register",
                domain: attributes[:domain],
                reason: "restricted domain",
                error_message: e.message,
              )
              halt 400, { error: "restricted domain" }.to_json
            rescue SocketError
              # DNS lookups that fail to resolve are handled later when the
              # registration flow attempts to contact the remote instance.
            end

            well_known, well_known_meta = fetch_instance_json(attributes[:domain], "/.well-known/potato-mesh")
            unless well_known
              details_list = Array(well_known_meta).map(&:to_s)
              details = details_list.empty? ? "no response" : details_list.join("; ")
              warn_log(
                "Instance registration rejected",
                context: "ingest.register",
                domain: attributes[:domain],
                reason: "failed to fetch well-known document",
                details: details,
              )
              halt 400, { error: "failed to verify well-known document" }.to_json
            end

            valid, reason = validate_well_known_document(well_known, attributes[:domain], attributes[:pubkey])
            unless valid
              warn_log(
                "Instance registration rejected",
                context: "ingest.register",
                domain: attributes[:domain],
                reason: reason || "invalid well-known document",
              )
              halt 400, { error: reason || "invalid well-known document" }.to_json
            end

            remote_nodes, node_source = fetch_instance_json(attributes[:domain], "/api/nodes")
            unless remote_nodes
              details_list = Array(node_source).map(&:to_s)
              details = details_list.empty? ? "no response" : details_list.join("; ")
              warn_log(
                "Instance registration rejected",
                context: "ingest.register",
                domain: attributes[:domain],
                reason: "failed to fetch nodes",
                details: details,
              )
              halt 400, { error: "failed to fetch nodes" }.to_json
            end

            fresh, freshness_reason = validate_remote_nodes(remote_nodes)
            unless fresh
              warn_log(
                "Instance registration rejected",
                context: "ingest.register",
                domain: attributes[:domain],
                reason: freshness_reason || "stale node data",
              )
              halt 400, { error: freshness_reason || "stale node data" }.to_json
            end

            db = open_database
            upsert_instance_record(db, attributes, signature)
            enqueued = enqueue_federation_crawl(
              attributes[:domain],
              per_response_limit: PotatoMesh::Config.federation_max_instances_per_response,
              overall_limit: PotatoMesh::Config.federation_max_domains_per_crawl,
            )
            debug_log(
              "Registered remote instance",
              context: "ingest.register",
              domain: attributes[:domain],
              instance_id: attributes[:id],
              crawl_enqueued: enqueued,
            )
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

          app.post "/api/traces" do
            require_token!
            content_type :json
            begin
              data = JSON.parse(read_json_body)
            rescue JSON::ParserError
              halt 400, { error: "invalid JSON" }.to_json
            end
            trace_packets = data.is_a?(Array) ? data : [data]
            halt 400, { error: "too many traces" }.to_json if trace_packets.size > 1000
            db = open_database
            trace_packets.each do |packet|
              insert_trace(db, packet)
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
