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
            node_count = data.count { |k, _| k != "ingestor" && k != "protocol" }
            halt 400, { error: "too many nodes" }.to_json if node_count > 1000
            db = open_database
            ingestor_node_id = string_or_nil(data["ingestor"])
            # Wrapper-level protocol is captured once and used as the
            # per-node fallback.  An explicit per-node ``"protocol"`` stamp
            # still wins so a future heterogeneous payload can mix protocols
            # within a single POST.  Both checks honour the same
            # KNOWN_PROTOCOLS whitelist.
            batch_protocol = resolve_record_protocol(db, data, ingestor_node_id)
            data.each do |node_id, node|
              next if node_id == "ingestor"
              next if node_id == "protocol"
              per_node = node.is_a?(Hash) ? normalize_protocol_value(node["protocol"]) : nil
              upsert_node(db, node_id, node, protocol: per_node || batch_protocol)
            end
            PotatoMesh::App::Prometheus::NODES_GAUGE.set(query_nodes(1000).length)
            PotatoMesh::App::ApiCache.invalidate_prefix("api:nodes:", "api:stats:")
            PotatoMesh::App::PubSub.publish("nodes", private_mode: private_mode?)
            status 201
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
            unless data.is_a?(Array) || data.is_a?(Hash)
              halt 400, { error: "invalid payload" }.to_json
            end
            messages = data.is_a?(Array) ? data : [data]
            halt 400, { error: "too many messages" }.to_json if messages.size > 1000
            db = open_database
            protocol_cache = {}
            messages.each do |msg|
              insert_message(db, msg, protocol_cache: protocol_cache)
            end
            # A message ingest also touches the author node's last_heard (#822),
            # so invalidate the nodes cache and publish a nodes change in addition
            # to messages — the dashboard then refreshes (and flashes) that node.
            # Mirrors how the positions route invalidates api:nodes:.
            PotatoMesh::App::ApiCache.invalidate_prefix("api:messages:", "api:nodes:", "api:stats:")
            PotatoMesh::App::PubSub.publish("messages", private_mode: private_mode?)
            PotatoMesh::App::PubSub.publish("nodes", private_mode: private_mode?)
            status 201
            { status: "ok" }.to_json
          ensure
            db&.close
          end

          app.post "/api/ingestors" do
            require_token!
            content_type :json
            begin
              payload = JSON.parse(read_json_body)
            rescue JSON::ParserError
              halt 400, { error: "invalid JSON" }.to_json
            end
            unless payload.is_a?(Hash)
              halt 400, { error: "invalid payload" }.to_json
            end
            db = open_database
            stored = upsert_ingestor(db, payload)
            halt 400, { error: "invalid payload" }.to_json unless stored
            PotatoMesh::App::ApiCache.invalidate_prefix("api:ingestors:")
            status 201
            { status: "ok" }.to_json
          ensure
            db&.close
          end

          app.post "/api/instances" do
            # Reject federation registrations outright when federation is
            # disabled (mirrors the GET /api/instances guard in api.rb) so a
            # PRIVATE=1 or FEDERATION=0 deployment never performs outbound
            # federation fetches or writes in response to an unsolicited,
            # signed announcement.
            halt 404 unless federation_enabled?

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
            pubkey = sanitize_public_key_pem(payload["public_key"] || payload["pubkey"])
            name = string_or_nil(payload["name"])
            version = string_or_nil(payload["version"])
            channel = string_or_nil(payload["channel"])
            frequency = string_or_nil(payload["frequency"])
            latitude = coerce_float(payload["latitude"])
            longitude = coerce_float(payload["longitude"])
            last_update_time = coerce_integer(payload["last_update"] || payload["last_update_time"] || payload["lastUpdateTime"])
            raw_private = if payload.key?("is_private")
                payload["is_private"]
              elsif payload.key?("isPrivate")
                payload["isPrivate"]
              end
            is_private = coerce_boolean(raw_private)
            signature = string_or_nil(payload["signature"])
            # Accept both v2 (snake_case) and legacy v1 (camelCase) wire keys
            # (SPEC FS4); the parsed counts (incl. reticulum) feed v2 signature
            # verification before they are recomputed from the live node list.
            contact_link = string_or_nil(payload["contactLink"] || payload["contact_link"])
            nodes_count = coerce_integer(payload["nodes_count"] || payload["nodesCount"])
            meshcore_nodes_count = coerce_integer(payload["meshcore_nodes_count"] || payload["meshcoreNodesCount"])
            meshtastic_nodes_count = coerce_integer(payload["meshtastic_nodes_count"] || payload["meshtasticNodesCount"])
            reticulum_nodes_count = coerce_integer(payload["reticulum_nodes_count"])

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
              contact_link: contact_link,
              nodes_count: nodes_count,
              meshcore_nodes_count: meshcore_nodes_count,
              meshtastic_nodes_count: meshtastic_nodes_count,
              # Carried for v2 signature verification only (no DB column; always 0
              # until a Reticulum ingestor exists).
              reticulum_nodes_count: reticulum_nodes_count,
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
            if !signature_valid && contact_link
              stripped_attributes = attributes.merge(contact_link: nil)
              signature_valid = verify_instance_signature(stripped_attributes, signature, attributes[:pubkey])
            end
            # Some remote peers sign payloads using a canonicalised lowercase
            # domain while still sending a mixed-case domain. Retry signature
            # verification with the original casing when the first attempt
            # fails to maximise interoperability.
            if !signature_valid && raw_domain && normalized_domain && raw_domain.casecmp?(normalized_domain) && raw_domain != normalized_domain
              alternate_attributes = attributes.merge(domain: raw_domain)
              signature_valid = verify_instance_signature(alternate_attributes, signature, attributes[:pubkey])
              if !signature_valid && contact_link
                stripped_alternate = alternate_attributes.merge(contact_link: nil)
                signature_valid = verify_instance_signature(stripped_alternate, signature, attributes[:pubkey])
              end
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

            # Node-count fallback only (SPEC FS2/(a)): v2 announcements carry
            # SIGNED counts, which we keep verbatim so the stored — and later
            # relayed — record stays signature-consistent (a re-verifying peer
            # rebuilds the same canonical).  We derive counts from the fetched
            # node list only when the announcement omits them.
            if remote_nodes.is_a?(Array) && attributes[:nodes_count].nil?
              cutoff = Time.now.to_i - PotatoMesh::Config.remote_instance_max_node_age
              total = 0
              meshcore = 0
              meshtastic = 0
              remote_nodes.each do |n|
                next unless n.is_a?(Hash)
                ts = coerce_integer(n["lastHeard"] || n["last_heard"])
                next unless ts && ts >= cutoff
                total += 1
                case (n["protocol"] || n["mesh_protocol"]).to_s.downcase
                when "meshcore" then meshcore += 1
                when "meshtastic" then meshtastic += 1
                end
              end
              attributes[:nodes_count] = total
              attributes[:meshcore_nodes_count] = meshcore
              attributes[:meshtastic_nodes_count] = meshtastic
            end

            db = open_database
            upsert_instance_record(db, attributes, signature)
            # Drop the cached /api/instances payload so the new peer becomes
            # visible on the next dashboard refresh instead of after the TTL
            # naturally expires.
            PotatoMesh::App::ApiCache.invalidate_prefix("api:instances:")
            enqueued = enqueue_federation_crawl(
              attributes[:domain],
              per_response_limit: PotatoMesh::Config.federation_max_instances_per_response,
              overall_limit: PotatoMesh::Config.federation_max_domains_per_crawl,
            )
            info_log(
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
            unless data.is_a?(Array) || data.is_a?(Hash)
              halt 400, { error: "invalid payload" }.to_json
            end
            positions = data.is_a?(Array) ? data : [data]
            halt 400, { error: "too many positions" }.to_json if positions.size > 1000
            db = open_database
            protocol_cache = {}
            positions.each do |pos|
              insert_position(db, pos, protocol_cache: protocol_cache)
            end
            PotatoMesh::App::ApiCache.invalidate_prefix("api:positions:", "api:nodes:", "api:stats:")
            PotatoMesh::App::PubSub.publish("positions", private_mode: private_mode?)
            # A position ingest also advances the node's last_heard
            # (touch_node_last_seen), so publish a nodes change as well
            # (mirrors the messages route, #822): the dashboard re-pulls and
            # flashes that node with a freshly-updated "last seen".
            PotatoMesh::App::PubSub.publish("nodes", private_mode: private_mode?)
            status 201
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
            unless data.is_a?(Array) || data.is_a?(Hash)
              halt 400, { error: "invalid payload" }.to_json
            end
            neighbor_payloads = data.is_a?(Array) ? data : [data]
            halt 400, { error: "too many neighbor packets" }.to_json if neighbor_payloads.size > 1000
            db = open_database
            protocol_cache = {}
            neighbor_payloads.each do |packet|
              insert_neighbors(db, packet, protocol_cache: protocol_cache)
            end
            PotatoMesh::App::ApiCache.invalidate_prefix("api:neighbors:", "api:stats:")
            PotatoMesh::App::PubSub.publish("neighbors", private_mode: private_mode?)
            status 201
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
            unless data.is_a?(Array) || data.is_a?(Hash)
              halt 400, { error: "invalid payload" }.to_json
            end
            telemetry_packets = data.is_a?(Array) ? data : [data]
            halt 400, { error: "too many telemetry packets" }.to_json if telemetry_packets.size > 1000
            db = open_database
            protocol_cache = {}
            telemetry_packets.each do |packet|
              insert_telemetry(db, packet, protocol_cache: protocol_cache)
            end
            # A telemetry ingest advances the node's last_heard
            # (update_node_from_telemetry -> touch_node_last_seen), so also
            # invalidate the nodes cache and publish a nodes change (mirrors
            # the positions/messages routes): the dashboard re-pulls and
            # flashes that node with a freshly-updated "last seen".
            PotatoMesh::App::ApiCache.invalidate_prefix("api:telemetry:", "api:nodes:", "api:stats:")
            PotatoMesh::App::PubSub.publish("telemetry", private_mode: private_mode?)
            PotatoMesh::App::PubSub.publish("nodes", private_mode: private_mode?)
            status 201
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
            unless data.is_a?(Array) || data.is_a?(Hash)
              halt 400, { error: "invalid payload" }.to_json
            end
            trace_packets = data.is_a?(Array) ? data : [data]
            halt 400, { error: "too many traces" }.to_json if trace_packets.size > 1000
            db = open_database
            protocol_cache = {}
            trace_packets.each do |packet|
              insert_trace(db, packet, protocol_cache: protocol_cache)
            end
            PotatoMesh::App::ApiCache.invalidate_prefix("api:traces:", "api:stats:")
            PotatoMesh::App::PubSub.publish("traces", private_mode: private_mode?)
            status 201
            { status: "ok" }.to_json
          ensure
            db&.close
          end
        end
      end
    end
  end
end
