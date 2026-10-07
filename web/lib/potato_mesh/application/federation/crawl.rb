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

        # Prefer the 0.7.0 shape (counts under total.nodes); fall back to the
        # pre-0.7.0 flat active_nodes for older peers (one-way federation
        # compatibility, SPEC S7).
        node_windows = remote_stats_node_windows(payload)
        return nil unless node_windows.is_a?(Hash)

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

        value = coerce_integer(node_windows[key])
        return nil unless value

        [value, 0].max
      end

      # Resolve the total node-activity window hash from either /api/stats shape.
      #
      # @param payload [Hash] decoded /api/stats payload.
      # @return [Hash, nil] +{ "hour", "day", "week", "month" }+ counts, or nil
      #   when neither the 0.7.0 (+total.nodes+) nor legacy (+active_nodes+) shape
      #   is present.
      def remote_stats_node_windows(payload)
        new_shape = payload.dig("total", "nodes")
        return new_shape if new_shape.is_a?(Hash)

        legacy = payload["active_nodes"]
        legacy if legacy.is_a?(Hash)
      end

      # Resolve a protocol's 24h node count from either /api/stats shape.
      #
      # Reads the 0.7.0 +<protocol>.nodes.day+ value, falling back to the
      # pre-0.7.0 flat +<protocol>.day+ for older peers.
      #
      # @param payload [Hash] decoded /api/stats payload.
      # @param protocol [String] protocol scope name (e.g. "meshcore").
      # @return [Integer, nil] node count active in the last day, or nil.
      def remote_stats_protocol_day(payload, protocol)
        value = payload.dig(protocol, "nodes", "day")
        value = payload.dig(protocol, "day") if value.nil?
        coerce_integer(value)
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

        # Accept both the v2 (snake_case) and legacy v1 (camelCase) wire keys so
        # the verifier can reconstruct either canonical, and so the parsed
        # attributes carry the signed counts needed to rebuild the v2 blob
        # (SPEC FS1/FS2/FS4).
        pubkey = sanitize_public_key_pem(payload["public_key"] || payload["pubkey"])
        return [nil, nil, "missing instance public key"] unless pubkey

        signature = string_or_nil(payload["signature"])
        return [nil, nil, "missing instance signature"] unless signature

        private_value = if payload.key?("is_private")
            payload["is_private"]
          elsif payload.key?("isPrivate")
            payload["isPrivate"]
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
          last_update_time: coerce_integer(payload["last_update"] || payload["lastUpdateTime"]),
          is_private: private_flag,
          contact_link: string_or_nil(payload["contactLink"] || payload["contact_link"]),
          nodes_count: coerce_integer(payload["nodes_count"] || payload["nodesCount"]),
          meshcore_nodes_count: coerce_integer(payload["meshcore_nodes_count"] || payload["meshcoreNodesCount"]),
          meshtastic_nodes_count: coerce_integer(payload["meshtastic_nodes_count"] || payload["meshtasticNodesCount"]),
          reticulum_nodes_count: coerce_integer(payload["reticulum_nodes_count"]),
        }

        [attributes, signature, nil]
      rescue StandardError => e
        [nil, nil, e.message]
      end

      # Count fields of a federation record.
      INSTANCE_COUNT_KEYS = %i[nodes_count meshcore_nodes_count meshtastic_nodes_count reticulum_nodes_count].freeze

      # Per-protocol count fields and the protocol each counts.
      PROTOCOL_COUNT_KEYS = {
        meshcore_nodes_count: "meshcore",
        meshtastic_nodes_count: "meshtastic",
        reticulum_nodes_count: "reticulum",
      }.freeze

      # Symbol a crawl throws once it spent a budget or passed its deadline;
      # each level of the crawl catches it and unwinds (SPEC FL6).
      FEDERATION_CRAWL_STOPPED = :potato_mesh_federation_crawl_stopped

      # Path of the node list a peer is judged on: its newest
      # {PotatoMesh::Config.remote_instance_min_node_count} nodes inside the
      # 7-day floor of every +GET /api/nodes+, the acceptance window of
      # ACCEPTANCE FS-A5 (SPEC FL2, RL9).
      #
      # @return [String] request path.
      def remote_instance_acceptance_path
        "/api/nodes?limit=#{PotatoMesh::Config.remote_instance_min_node_count}"
      end

      # Path of a peer's node list for the 24 hours of the federation counts
      # (SPEC RL9).
      #
      # @return [String] request path.
      def remote_instance_recent_nodes_path
        since = Time.now.to_i - PotatoMesh::Config.remote_instance_max_node_age
        "/api/nodes?since=#{since}&limit=1000"
      end

      # Fill the node counts a federation record lacks, on both paths, the
      # crawl and the registration (SPEC FL2, RL9).
      #
      # The signed counts stay as they are. Only when one is missing is the
      # peer's +/api/stats+ read for its 24-hour figures, and only when the
      # total is still missing its 24-hour node list, whose entries heard in
      # those 24 hours are counted, in total and per protocol. The node list
      # that decides acceptance never feeds a count.
      #
      # @param attributes [Hash] record attributes; nil counts are filled in
      #   place.
      # @param domain [String] peer domain, for the log.
      # @param stats [#call] returns the peer's +/api/stats+ fetch result.
      # @param recent_nodes [#call] returns the peer's 24-hour node list fetch
      #   result.
      # @return [Hash] +attributes+.
      def fill_missing_instance_counts!(attributes, domain:, stats:, recent_nodes:)
        return attributes unless INSTANCE_COUNT_KEYS.any? { |key| attributes[key].nil? }

        window = PotatoMesh::Config.remote_instance_max_node_age
        stats_payload, stats_metadata = stats.call
        if stats_payload.is_a?(Hash)
          total = remote_active_node_count_from_stats(stats_payload, max_age_seconds: window)
          attributes[:nodes_count] = total if total && attributes[:nodes_count].nil?
          PROTOCOL_COUNT_KEYS.each do |key, protocol|
            value = remote_stats_protocol_day(stats_payload, protocol)
            attributes[key] = value if value && attributes[key].nil?
          end
        end
        return attributes unless attributes[:nodes_count].nil?

        if Array(stats_metadata).any?
          debug_log(
            "Remote instance /api/stats unavailable; using node list fallback",
            context: "federation.instances",
            domain: domain,
            reason: Array(stats_metadata).map(&:to_s).join("; "),
          )
        end
        nodes, = recent_nodes.call
        return attributes unless nodes.is_a?(Array)

        cutoff = Time.now.to_i - window
        heard = nodes.select { |node| (remote_node_last_heard(node) || 0) >= cutoff }
        attributes[:nodes_count] = heard.length
        PROTOCOL_COUNT_KEYS.each do |key, protocol|
          next unless attributes[key].nil?

          attributes[key] = heard.count { |node| (node["protocol"] || node["mesh_protocol"]).to_s.downcase == protocol }
        end
        attributes
      end

      # Start the state of a new crawl, with its limits (SPEC FL1, FL6).
      #
      # @param max_domains [Integer, nil] most domains the crawl fetches;
      #   nil for {PotatoMesh::Config.federation_max_domains_per_crawl}.
      # @return [CrawlState] the new crawl.
      def new_federation_crawl(max_domains: nil)
        CrawlState.new(
          own_domain: federation_domain_key(sanitize_instance_domain(app_constant(:INSTANCE_DOMAIN))),
          max_domains: max_domains || PotatoMesh::Config.federation_max_domains_per_crawl,
          max_requests: PotatoMesh::Config.federation_max_requests_per_crawl,
          deadline_seconds: PotatoMesh::Config.federation_task_timeout_seconds,
        )
      end

      # Send one crawl request through the crawl's limits and the peer fetch
      # cooldown (SPEC FL1, FL3, FL6).
      #
      # When a request would pass the crawl's request budget, its domain
      # budget or its deadline, the crawl stops: this logs it and throws
      # {FEDERATION_CRAWL_STOPPED}. The first request to a host claims the
      # host's cooldown for this crawl, so its later requests in the crawl
      # pass while every other crawl and registration waits.
      #
      # @param crawl [CrawlState] the crawl.
      # @param domain [String] sanitized domain the request goes to.
      # @yieldreturn [Array(Object, Object)] the +fetch_instance_json+ result.
      # @return [Array(Object, Object)] the block's result, or
      #   +[nil, [reason]]+ when the host's cooldown is held elsewhere.
      def federation_crawl_request(crawl, domain)
        unless crawl.request_allowed?(domain)
          debug_log(
            "Stopped federation crawl",
            context: "federation.instances",
            domain: domain,
            reason: crawl.stop_reason,
            request_count: crawl.requests,
            domain_count: crawl.fetched_domains.size,
          )
          throw FEDERATION_CRAWL_STOPPED
        end

        host = federation_peer_host(domain)
        unless crawl.claimed?(host)
          wait = federation_peer_backoff.claim(host, cooldown: PotatoMesh::Config.federation_peer_fetch_cooldown_seconds)
          return [nil, ["#{domain}: peer fetch cooldown, #{wait.ceil} s left"]] if wait.positive?

          crawl.claim(host)
        end
        crawl.spend_request(domain)
        yield
      end

      # Whether a crawl leaves +host+ alone: another domain of the host was
      # already visited in this crawl, or the host was fetched inside its
      # cooldown, or backs off, outside this crawl (SPEC FL1, FL3). The
      # stored record is kept.
      #
      # @param crawl [CrawlState] the crawl.
      # @param host [String, nil] peer host.
      # @param domain [String] sanitized domain on the host.
      # @param message [String] debug log message for a skip.
      # @return [Boolean] true when the crawl must skip the host.
      def federation_crawl_skip?(crawl, host, domain, message)
        visit = crawl.visit(host)
        if visit && federation_domain_key(visit[:domain]) != federation_domain_key(domain)
          debug_log(
            message,
            context: "federation.instances",
            domain: domain,
            reason: "host already fetched in this crawl for #{visit[:domain]}",
          )
          return true
        end
        return false if crawl.claimed?(host)

        wait = federation_peer_backoff.wait_seconds(host, cooldown: PotatoMesh::Config.federation_peer_fetch_cooldown_seconds)
        return false unless wait.positive?

        debug_log(
          message,
          context: "federation.instances",
          domain: domain,
          reason: federation_peer_backoff.backoff_seconds(host).positive? ? "peer backoff" : "peer fetch cooldown",
          retry_in: wait.ceil,
        )
        true
      end

      # Judge a peer on the result of its acceptance-list fetch (SPEC FL2),
      # in the shape both paths keep for the host's cooldown (SPEC FL7).
      #
      # @param nodes [Array, nil] the decoded node list, nil when the fetch
      #   failed.
      # @param metadata [Object] the fetch's URI or its errors.
      # @return [Hash] +:accepted+; for a refusal also the response +:error+,
      #   the log +:reason+ and, for a failed fetch, the log +:details+.
      def remote_instance_acceptance(nodes, metadata)
        if nodes.nil?
          details = Array(metadata).map(&:to_s)
          return {
                   accepted: false, error: "failed to fetch nodes", reason: "failed to fetch nodes",
                   details: details.empty? ? "no response" : details.join("; "),
                 }
        end

        fresh, reason = validate_remote_nodes(nodes)
        return { accepted: true } if fresh

        { accepted: false, error: reason || "stale node data", reason: reason || "stale node data" }
      end

      # Judge +domain+ on its one node list, once per host and crawl (SPEC
      # FL1, FL2): later copies reuse the outcome, a failure included. The
      # outcome is also kept for the host's cooldown (SPEC FL7).
      #
      # @param crawl [CrawlState] the crawl.
      # @param domain [String] sanitized domain.
      # @param host [String, nil] the domain's host.
      # @return [Hash] the visit: +:domain+ and whether it was +:accepted+.
      def visit_crawled_instance(crawl, domain, host)
        visit = crawl.visit(host)
        return visit if visit

        acceptance = nil
        nodes, metadata = federation_crawl_request(crawl, domain) do
          fetch_instance_json(domain, remote_instance_acceptance_path).tap do |result|
            acceptance = remote_instance_acceptance(*result)
            federation_peer_backoff.record_acceptance(host, federation_domain_key(domain), acceptance)
          end
        end
        acceptance ||= remote_instance_acceptance(nodes, metadata)
        unless acceptance[:accepted]
          warn_log(
            nodes.nil? ? "Failed to load remote node data" : "Discarded remote instance entry",
            context: "federation.instances",
            domain: domain,
            reason: nodes.nil? ? acceptance[:details] : acceptance[:reason],
          )
        end
        crawl.record_visit(host, { domain: domain, accepted: acceptance[:accepted] })
      end

      # Store one accepted copy of a relayed record, unless the row stored
      # under its key is at least as new: among copies the newest signed
      # +last_update+ wins and an older copy never rolls a row back (SPEC
      # FL1). Missing counts are filled first, their fetches made once per
      # host; the row is checked again right before the write, as one stored
      # while they were fetched may be newer.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param crawl [CrawlState] the crawl.
      # @param host [String, nil] the record's host.
      # @param attributes [Hash] verified record attributes.
      # @param signature [String] the record's signature.
      # @return [Boolean] true when the copy was written.
      # @raise [ArgumentError] when the domain is invalid or restricted.
      def store_crawled_instance(db, crawl, host, attributes, signature)
        domain = attributes[:domain]
        return false if crawled_copy_outdated?(db, attributes)

        visit = crawl.visit(host)
        fill_missing_instance_counts!(
          attributes,
          domain: domain,
          stats: -> { visit[:stats] ||= federation_crawl_request(crawl, domain) { fetch_instance_json(domain, "/api/stats") } },
          recent_nodes: lambda {
            visit[:recent_nodes] ||= federation_crawl_request(crawl, domain) do
              fetch_instance_json(domain, remote_instance_recent_nodes_path)
            end
          },
        )
        return false if crawled_copy_outdated?(db, attributes)

        upsert_instance_record(db, attributes, signature)
        true
      end

      # Whether the row stored under a relayed copy's key is at least as new
      # as the copy, logging the copy kept out (SPEC FL1).
      #
      # @param db [SQLite3::Database] open database handle.
      # @param attributes [Hash] verified record attributes.
      # @return [Boolean] true when the copy must not be stored.
      def crawled_copy_outdated?(db, attributes)
        stored = stored_instance_copy(db, attributes)
        return false unless instance_copy_outdated?(stored, attributes)

        debug_log(
          "Kept stored remote instance",
          context: "federation.instances",
          domain: attributes[:domain],
          stored_last_update: stored.last,
          relayed_last_update: attributes[:last_update_time],
        )
        true
      end

      # Handle one entry of a peer's +/api/instances+ list.
      #
      # Every entry gets the local checks: its shape, the private flag, its
      # signature, then FS9's id rule and FS8's well-known check, the
      # document memoized per crawl. The network fetches after them, the
      # node list, the count fallbacks and the walk of the entry's own list,
      # happen once per host and crawl; the crawl never fetches this
      # instance's own domain nor a host inside its peer fetch cooldown
      # (SPEC FL1-FL3, FS8, FS9).
      #
      # @param db [SQLite3::Database] open database handle.
      # @param crawl [CrawlState] the crawl.
      # @param entry [Object] one decoded list entry.
      # @param relayed_by [String] domain whose list holds the entry.
      # @param per_response_limit [Integer] most entries read per list.
      # @return [void]
      def ingest_crawled_instance_entry(db, crawl, entry, relayed_by:, per_response_limit:)
        attributes, signature, reason = remote_instance_attributes_from_payload(entry)
        unless attributes && signature
          warn_log(
            "Discarded remote instance entry",
            context: "federation.instances",
            domain: relayed_by,
            reason: reason || "invalid payload",
          )
          return
        end

        if attributes[:is_private]
          debug_log(
            "Skipped private remote instance",
            context: "federation.instances",
            domain: attributes[:domain],
          )
          return
        end

        unless verify_instance_signature(attributes, signature, attributes[:pubkey])
          warn_log(
            "Discarded remote instance entry",
            context: "federation.instances",
            domain: attributes[:domain],
            reason: "invalid signature",
          )
          return
        end

        domain = attributes[:domain]
        if crawl.own_domain?(federation_domain_key(domain))
          debug_log(
            "Skipped remote instance entry",
            context: "federation.instances",
            domain: domain,
            reason: "own instance",
          )
          return
        end

        host = federation_peer_host(domain)
        return if federation_crawl_skip?(crawl, host, domain, "Skipped remote instance entry")

        # The signature proves only that the record was signed by the key it
        # carries. Its id must be the one that key derives, and unless the
        # record refreshes its domain's row under the stored key, the
        # domain's own well-known document must name that key (SPEC FS8,
        # FS9).
        key_confirmed, key_reason = confirm_relayed_instance_key(db, attributes, crawl: crawl)
        unless key_confirmed
          warn_log(
            "Discarded remote instance entry",
            context: "federation.instances",
            domain: domain,
            reason: key_reason,
            relayed_by: relayed_by,
          )
          return
        end

        attributes[:is_private] = false if attributes[:is_private].nil?
        return unless visit_crawled_instance(crawl, domain, host)[:accepted]

        begin
          store_crawled_instance(db, crawl, host, attributes, signature)
          ingest_known_instances_from!(db, domain, crawl: crawl, per_response_limit: per_response_limit)
        rescue ArgumentError => e
          warn_log(
            "Failed to persist remote instance",
            context: "federation.instances",
            domain: domain,
            error_class: e.class.name,
            error_message: e.message,
          )
        end
      end

      # Walk the federation records exposed by the supplied domain, and
      # recursively the lists of the peers it names.
      #
      # One crawl state runs through the recursion (SPEC FL1, FL6): each
      # host is fetched at most once, the walk stops at the crawl's request
      # budget, domain budget ({PotatoMesh::Config.federation_max_domains_per_crawl}
      # domains fetched) or deadline, and a host fetched inside its
      # {PotatoMesh::Config.federation_peer_fetch_cooldown_seconds} outside
      # this crawl is skipped. A peer is judged on one
      # +/api/nodes?limit=10+ list, its newest nodes inside the 7-day floor
      # (ACCEPTANCE FS-A5); node counts come from the signed record, else
      # from {#fill_missing_instance_counts!} (SPEC FL2, RL9).
      #
      # @param db [SQLite3::Database] open database connection used for writes.
      # @param domain [String] remote domain to crawl for federation records.
      # @param crawl [CrawlState, nil] the crawl this walk belongs to; nil
      #   starts a new one.
      # @param per_response_limit [Integer, nil] maximum entries processed per response.
      # @param overall_limit [Integer, nil] most domains a crawl started here
      #   fetches.
      # @return [CrawlState] the crawl.
      def ingest_known_instances_from!(
        db,
        domain,
        crawl: nil,
        per_response_limit: nil,
        overall_limit: nil
      )
        crawl ||= new_federation_crawl(max_domains: overall_limit)
        per_response_limit ||= PotatoMesh::Config.federation_max_instances_per_response
        sanitized = sanitize_instance_domain(domain)
        return crawl unless sanitized
        return crawl if federation_shutdown_requested? || crawl.stopped? || crawl.own_domain?(federation_domain_key(sanitized))

        host = federation_peer_host(sanitized)
        return crawl if crawl.walked?(host)
        return crawl if federation_crawl_skip?(crawl, host, sanitized, "Skipped remote instance crawl")

        crawl.walk(host)
        catch(FEDERATION_CRAWL_STOPPED) do
          walk_remote_instance_list(db, crawl, sanitized, per_response_limit)
        end
        crawl
      end

      # Fetch +domain+'s +/api/instances+ list and handle its entries.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param crawl [CrawlState] the crawl.
      # @param domain [String] sanitized domain whose list is walked.
      # @param per_response_limit [Integer, nil] most entries read.
      # @return [void]
      def walk_remote_instance_list(db, crawl, domain, per_response_limit)
        payload, metadata = federation_crawl_request(crawl, domain) do
          fetch_instance_json(domain, "/api/instances")
        end
        unless payload.is_a?(Array)
          warn_log(
            "Failed to load remote federation instances",
            context: "federation.instances",
            domain: domain,
            reason: Array(metadata).map(&:to_s).join("; "),
          )
          return
        end

        processed_entries = 0
        payload.each do |entry|
          break if federation_shutdown_requested? || crawl.stopped?

          if per_response_limit && per_response_limit.positive? && processed_entries >= per_response_limit
            debug_log(
              "Skipped remote instance entry due to response limit",
              context: "federation.instances",
              domain: domain,
              limit: per_response_limit,
            )
            break
          end

          processed_entries += 1
          ingest_crawled_instance_entry(db, crawl, entry, relayed_by: domain, per_response_limit: per_response_limit)
        end
      end

      # Crawl the federation once from this instance's seeds and known peers
      # under one crawl state (SPEC FL3). The announcer thread runs it every
      # announcement interval through {#run_federation_crawl_cycle}.
      #
      # @return [CrawlState] the finished crawl.
      def crawl_federation!
        crawl = new_federation_crawl
        roots = federation_target_domains(crawl.own_domain)
        db = open_database
        roots.each do |root|
          break if federation_shutdown_requested? || crawl.stopped?

          ingest_known_instances_from!(db, root, crawl: crawl)
        end
        info_log(
          "Federation crawl complete",
          context: "federation.instances",
          root_count: roots.length,
          domain_count: crawl.fetched_domains.size,
          request_count: crawl.requests,
          stop_reason: crawl.stop_reason,
        )
        crawl
      ensure
        db&.close
      end

      # Run one crawl on the federation worker pool and wait for it; the
      # pool's task timeout ends a crawl that outlives it (SPEC FL3, FL6).
      #
      # @return [Boolean] true when the crawl ran to its end.
      def run_federation_crawl_cycle
        return false if federation_shutdown_requested?

        pool = federation_worker_pool
        unless pool
          debug_log(
            "Skipped federation crawl",
            context: "federation.instances",
            reason: "federation disabled",
          )
          return false
        end

        timeout = PotatoMesh::Config.federation_task_timeout_seconds
        pool.schedule { crawl_federation! }.wait(timeout: timeout)
        true
      rescue PotatoMesh::App::WorkerPool::QueueFullError
        warn_log("Skipped federation crawl", context: "federation.instances", reason: "worker queue saturated")
        false
      rescue PotatoMesh::App::WorkerPool::ShutdownError
        warn_log("Skipped federation crawl", context: "federation.instances", reason: "worker pool shut down")
        false
      rescue PotatoMesh::App::WorkerPool::TaskTimeoutError => e
        warn_log(
          "Federation crawl timed out",
          context: "federation.instances",
          timeout: timeout,
          error_message: e.message,
        )
        false
      end
    end
  end
end
