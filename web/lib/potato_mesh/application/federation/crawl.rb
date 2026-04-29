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
    module Federation
      # Resolve the best matching active-node count from a remote /api/stats payload.
      #
      # @param payload [Hash, nil] decoded JSON payload from /api/stats.
      # @param max_age_seconds [Integer] activity window currently expected for federation freshness.
      # @return [Integer, nil] selected active-node count when available.
      def remote_active_node_count_from_stats(payload, max_age_seconds:)
        return nil unless payload.is_a?(Hash)

        active_nodes = payload["active_nodes"]
        return nil unless active_nodes.is_a?(Hash)

        age = coerce_integer(max_age_seconds) || 0
        key = if age <= 3600
            "hour"
          elsif age <= 86_400
            "day"
          elsif age <= PotatoMesh::Config.week_seconds
            "week"
          else
            "month"
          end

        value = coerce_integer(active_nodes[key])
        return nil unless value

        [value, 0].max
      end

      # Parse a remote federation instance payload into canonical attributes.
      #
      # @param payload [Hash] JSON object describing a remote instance.
      # @return [Array<(Hash, String), String>] tuple containing the attribute
      #   hash and signature when valid or a failure reason when invalid.
      def remote_instance_attributes_from_payload(payload)
        unless payload.is_a?(Hash)
          return [nil, nil, "instance payload is not an object"]
        end

        id = string_or_nil(payload["id"])
        return [nil, nil, "missing instance id"] unless id

        domain = sanitize_instance_domain(payload["domain"])
        return [nil, nil, "missing instance domain"] unless domain

        pubkey = sanitize_public_key_pem(payload["pubkey"])
        return [nil, nil, "missing instance public key"] unless pubkey

        signature = string_or_nil(payload["signature"])
        return [nil, nil, "missing instance signature"] unless signature

        private_value = if payload.key?("isPrivate")
            payload["isPrivate"]
          else
            payload["is_private"]
          end
        private_flag = coerce_boolean(private_value)
        if private_flag.nil?
          numeric_flag = coerce_integer(private_value)
          private_flag = !numeric_flag.to_i.zero? if numeric_flag
        end

        attributes = {
          id: id,
          domain: domain,
          pubkey: pubkey,
          name: string_or_nil(payload["name"]),
          version: string_or_nil(payload["version"]),
          channel: string_or_nil(payload["channel"]),
          frequency: string_or_nil(payload["frequency"]),
          latitude: coerce_float(payload["latitude"]),
          longitude: coerce_float(payload["longitude"]),
          last_update_time: coerce_integer(payload["lastUpdateTime"]),
          is_private: private_flag,
          contact_link: string_or_nil(payload["contactLink"]),
        }

        [attributes, signature, nil]
      rescue StandardError => e
        [nil, nil, e.message]
      end

      # Enqueue a federation crawl for the supplied domain using the worker pool.
      #
      # @param domain [String] sanitized remote domain to crawl.
      # @param per_response_limit [Integer, nil] maximum entries processed per response.
      # @param overall_limit [Integer, nil] maximum unique domains visited.
      # @return [Boolean] true when the crawl was scheduled successfully.
      def enqueue_federation_crawl(domain, per_response_limit:, overall_limit:)
        sanitized_domain = sanitize_instance_domain(domain)
        unless sanitized_domain
          warn_log(
            "Skipped remote instance crawl",
            context: "federation.instances",
            domain: domain,
            reason: "invalid domain",
          )
          return false
        end
        return false if federation_shutdown_requested?

        application = is_a?(Class) ? self : self.class
        pool = application.federation_worker_pool
        unless pool
          debug_log(
            "Skipped remote instance crawl",
            context: "federation.instances",
            domain: sanitized_domain,
            reason: "federation disabled",
          )
          return false
        end

        claim_result = application.claim_federation_crawl_slot(sanitized_domain)
        unless claim_result == :claimed
          debug_log(
            "Skipped remote instance crawl",
            context: "federation.instances",
            domain: sanitized_domain,
            reason: claim_result == :in_flight ? "crawl already in flight" : "recent crawl completed",
          )
          return false
        end

        pool.schedule do
          db = nil
          begin
            db = application.open_database
            application.ingest_known_instances_from!(
              db,
              sanitized_domain,
              per_response_limit: per_response_limit,
              overall_limit: overall_limit,
            )
          ensure
            db&.close
            application.release_federation_crawl_slot(sanitized_domain)
          end
        end

        true
      rescue PotatoMesh::App::WorkerPool::QueueFullError
        application.handle_failed_federation_crawl_schedule(sanitized_domain, "worker queue saturated")
      rescue PotatoMesh::App::WorkerPool::ShutdownError
        application.handle_failed_federation_crawl_schedule(sanitized_domain, "worker pool shut down")
      end

      # Handle a failed crawl schedule attempt without applying cooldown.
      #
      # @param domain [String] canonical domain that failed to schedule.
      # @param reason [String] human-readable failure reason.
      # @return [Boolean] always false because scheduling did not succeed.
      def handle_failed_federation_crawl_schedule(domain, reason)
        release_federation_crawl_slot(domain, record_completion: false)
        warn_log(
          "Skipped remote instance crawl",
          context: "federation.instances",
          domain: domain,
          reason: reason,
        )
        false
      end

      # Recursively ingest federation records exposed by the supplied domain.
      #
      # @param db [SQLite3::Database] open database connection used for writes.
      # @param domain [String] remote domain to crawl for federation records.
      # @param visited [Set<String>] domains processed during this crawl.
      # @param per_response_limit [Integer, nil] maximum entries processed per response.
      # @param overall_limit [Integer, nil] maximum unique domains visited.
      # @return [Set<String>] updated set of visited domains.
      def ingest_known_instances_from!(
        db,
        domain,
        visited: nil,
        per_response_limit: nil,
        overall_limit: nil
      )
        sanitized = sanitize_instance_domain(domain)
        return visited || Set.new unless sanitized
        return visited || Set.new if federation_shutdown_requested?

        visited ||= Set.new

        overall_limit ||= PotatoMesh::Config.federation_max_domains_per_crawl
        per_response_limit ||= PotatoMesh::Config.federation_max_instances_per_response

        if overall_limit && overall_limit.positive? && visited.size >= overall_limit
          debug_log(
            "Skipped remote instance crawl due to crawl limit",
            context: "federation.instances",
            domain: sanitized,
            limit: overall_limit,
          )
          return visited
        end

        return visited if visited.include?(sanitized)

        visited << sanitized

        payload, metadata = fetch_instance_json(sanitized, "/api/instances")
        unless payload.is_a?(Array)
          warn_log(
            "Failed to load remote federation instances",
            context: "federation.instances",
            domain: sanitized,
            reason: Array(metadata).map(&:to_s).join("; "),
          )
          return visited
        end

        processed_entries = 0
        recent_cutoff = Time.now.to_i - PotatoMesh::Config.remote_instance_max_node_age
        payload.each do |entry|
          break if federation_shutdown_requested?

          if per_response_limit && per_response_limit.positive? && processed_entries >= per_response_limit
            debug_log(
              "Skipped remote instance entry due to response limit",
              context: "federation.instances",
              domain: sanitized,
              limit: per_response_limit,
            )
            break
          end

          if overall_limit && overall_limit.positive? && visited.size >= overall_limit
            debug_log(
              "Skipped remote instance entry due to crawl limit",
              context: "federation.instances",
              domain: sanitized,
              limit: overall_limit,
            )
            break
          end

          processed_entries += 1
          attributes, signature, reason = remote_instance_attributes_from_payload(entry)
          unless attributes && signature
            warn_log(
              "Discarded remote instance entry",
              context: "federation.instances",
              domain: sanitized,
              reason: reason || "invalid payload",
            )
            next
          end

          if attributes[:is_private]
            debug_log(
              "Skipped private remote instance",
              context: "federation.instances",
              domain: attributes[:domain],
            )
            next
          end

          unless verify_instance_signature(attributes, signature, attributes[:pubkey])
            warn_log(
              "Discarded remote instance entry",
              context: "federation.instances",
              domain: attributes[:domain],
              reason: "invalid signature",
            )
            next
          end

          attributes[:is_private] = false if attributes[:is_private].nil?

          stats_payload, stats_metadata = fetch_instance_json(attributes[:domain], "/api/stats")
          stats_count = remote_active_node_count_from_stats(
            stats_payload,
            max_age_seconds: PotatoMesh::Config.remote_instance_max_node_age,
          )
          attributes[:nodes_count] = stats_count if stats_count

          # Extract per-protocol 24h counts (informational, not signed).
          if stats_payload.is_a?(Hash)
            mc_day = stats_payload.dig("meshcore", "day")
            mt_day = stats_payload.dig("meshtastic", "day")
            attributes[:meshcore_nodes_count] = coerce_integer(mc_day) if mc_day
            attributes[:meshtastic_nodes_count] = coerce_integer(mt_day) if mt_day
          end

          nodes_since_path = "/api/nodes?since=#{recent_cutoff}&limit=1000"
          nodes_since_window, nodes_since_metadata = fetch_instance_json(attributes[:domain], nodes_since_path)
          if stats_count.nil? && attributes[:nodes_count].nil? && nodes_since_window.is_a?(Array)
            attributes[:nodes_count] = nodes_since_window.length
          end

          remote_nodes, node_metadata = fetch_instance_json(attributes[:domain], "/api/nodes")
          remote_nodes = nodes_since_window if remote_nodes.nil? && nodes_since_window.is_a?(Array)
          if attributes[:nodes_count].nil? && remote_nodes.is_a?(Array)
            attributes[:nodes_count] = remote_nodes.length
          end

          if stats_count.nil? && Array(stats_metadata).any?
            debug_log(
              "Remote instance /api/stats unavailable; using node list fallback",
              context: "federation.instances",
              domain: attributes[:domain],
              reason: Array(stats_metadata).map(&:to_s).join("; "),
            )
          end
          unless remote_nodes
            warn_log(
              "Failed to load remote node data",
              context: "federation.instances",
              domain: attributes[:domain],
              reason: Array(node_metadata || nodes_since_metadata).map(&:to_s).join("; "),
            )
            next
          end

          fresh, freshness_reason = validate_remote_nodes(remote_nodes)
          unless fresh
            warn_log(
              "Discarded remote instance entry",
              context: "federation.instances",
              domain: attributes[:domain],
              reason: freshness_reason || "stale node data",
            )
            next
          end

          begin
            upsert_instance_record(db, attributes, signature)
            ingest_known_instances_from!(
              db,
              attributes[:domain],
              visited: visited,
              per_response_limit: per_response_limit,
              overall_limit: overall_limit,
            )
          rescue ArgumentError => e
            warn_log(
              "Failed to persist remote instance",
              context: "federation.instances",
              domain: attributes[:domain],
              error_class: e.class.name,
              error_message: e.message,
            )
          end
        end

        visited
      end
    end
  end
end
