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
      # Announce the local instance record to a remote federation peer,
      # cycling through resolved IP addresses when transport-level failures
      # occur. The plain http candidate follows only a refused https
      # connection or a domain with a port of its own (SPEC FT1); the worker
      # pool's task timeout ends the announcement (SPEC FT4).
      #
      # @param domain [String] remote peer hostname.
      # @param payload_json [String] JSON-encoded announcement body.
      # @return [Boolean] true when the announcement was accepted.
      def announce_instance_to_domain(domain, payload_json)
        return false unless domain && !domain.empty?
        return false if federation_shutdown_requested?

        https_failures = []
        answer = nil

        published = instance_uri_candidates(domain, "/api/instances").any? do |uri|
          break false if federation_shutdown_requested?

          begin
            response = perform_announce_request(uri, payload_json)
            answer = response
            if response.is_a?(Net::HTTPSuccess)
              debug_log(
                "Published federation announcement",
                context: "federation.announce",
                target: uri.to_s,
                status: response.code,
              )
              true
            else
              debug_log(
                "Federation announcement failed",
                context: "federation.announce",
                target: uri.to_s,
                status: response.code,
              )
              # Peer answered at the HTTP layer (e.g. 4xx from an older peer
              # that does not understand the v2 signature, SPEC FS5).  Falling
              # back to the http:// candidate adds noise — port 80 is firewalled
              # on most production peers — without adding any chance of success.
              break false
            end
          rescue PotatoMesh::App::WorkerPool::TaskTimeoutError
            # The task is over: the peer backs off as after any failed
            # announcement (SPEC FB5), and no later candidate is sent (SPEC
            # FT4).
            record_announce_outcome(domain, nil)
            raise
          rescue StandardError => e
            metadata = {
              context: "federation.announce",
              target: uri.to_s,
              error_class: e.class.name,
              error_message: e.message,
            }

            if federation_http_fallback?(uri, e)
              debug_log(
                "HTTPS federation announcement failed, retrying with HTTP",
                **metadata,
              )
              https_failures << metadata
            else
              warn_log(
                "Federation announcement raised exception",
                **metadata,
              )
              break false
            end
            false
          end
        end

        unless published
          https_failures.each do |metadata|
            warn_log(
              "Federation announcement raised exception",
              **metadata,
            )
          end
        end

        record_announce_outcome(domain, answer)
        published
      end

      # Execute a POST announcement request against the supplied URI, cycling
      # through resolved IP addresses on connection-level failures. When
      # every address fails, a refusal on any of them is raised (SPEC FT1);
      # the worker pool's task timeout is raised at once (SPEC FT4).
      #
      # @param uri [URI::Generic] target endpoint.
      # @param payload_json [String] JSON-encoded announcement body.
      # @return [Net::HTTPResponse] the HTTP response from the first reachable address.
      # @raise [StandardError] when all addresses fail or a non-retryable error occurs.
      def perform_announce_request(uri, payload_json)
        remote_addresses = sort_addresses_for_connection(resolve_remote_ip_addresses(uri))
        addresses = remote_addresses.empty? ? [nil] : remote_addresses

        last_error = nil
        refused = nil
        addresses.each do |address|
          break if federation_shutdown_requested?

          begin
            return perform_single_announce_request(uri, payload_json, ip_address: address&.to_s)
          rescue PotatoMesh::App::WorkerPool::TaskTimeoutError
            # Never another address after the task's timeout (SPEC FT4).
            raise
          rescue StandardError => e
            if connection_refused_or_unreachable?(e)
              last_error = e
              refused ||= e if https_connection_refused?(e)
            else
              raise
            end
          end
        end

        # A refusal on any address is the host's refusal (SPEC FT1).
        raise(refused || last_error || StandardError.new("all resolved addresses failed"))
      end

      # Execute a single POST announcement request, optionally pinning the
      # connection to a specific IP address.
      #
      # @param uri [URI::Generic] target endpoint.
      # @param payload_json [String] JSON-encoded announcement body.
      # @param ip_address [String, nil] resolved IP address to pin the
      #   connection to, or +nil+ to let {build_remote_http_client} resolve.
      # @return [Net::HTTPResponse] the HTTP response.
      # @raise [StandardError] when the request fails.
      def perform_single_announce_request(uri, payload_json, ip_address: nil)
        http = build_remote_http_client(uri, ip_address: ip_address)
        # Timeout::Error, so Net::HTTP closes a socket the timeout
        # interrupts, mid-handshake too (SPEC FT3).
        Timeout.timeout(PotatoMesh::Config.remote_instance_request_timeout, Timeout::Error) do
          http.start do |connection|
            request = build_federation_http_request(Net::HTTP::Post, uri)
            request.body = payload_json
            connection.request(request)
          end
        end
      end

      # Run the periodic announcement cycle by signing the local payload and
      # dispatching it (preferably via the worker pool) to every peer domain.
      # A peer that backs off, and an announcement the full worker queue
      # refuses, are skipped until the next cycle, which offers the skipped
      # ones first (SPEC FB5); an instance on an IP address announces nothing
      # (SPEC FB10).
      #
      # @return [void]
      def announce_instance_to_all_domains
        return unless federation_enabled?
        return if federation_shutdown_requested?

        # The instance housekeeping GET /api/instances no longer does: merge
        # duplicate domains, hold the rows to the caps, then refresh the self
        # record (SPEC RC4, FB3, FB4).
        clean_duplicate_instances!
        enforce_instance_caps!
        attributes, signature = ensure_self_instance_record!
        # An instance on an IP address does not federate (SPEC FB10).
        refusal = federation_domain_refusal(attributes[:domain])
        if refusal
          info_log("Skipped federation announcement cycle", context: "federation.announce", reason: refusal)
          return
        end

        payload_json = JSON.generate(instance_announcement_payload(attributes, signature))
        # What the full queue skipped last cycle goes first (SPEC FB5).
        domains = order_by_announce_backlog(federation_target_domains(attributes[:domain]))
        pool = federation_worker_pool
        scheduled = []
        sync_results = []
        skipped = 0
        backlog = []

        unless domains.empty?
          info_log(
            "Federation announcement cycle started",
            context: "federation.announce",
            target_count: domains.length,
          )
        end

        domains.each_with_object(scheduled) do |domain, scheduled_tasks|
          break if federation_shutdown_requested?

          backoff = federation_peer_backoff.backoff_seconds(federation_peer_host(domain))
          if backoff.positive?
            debug_log(
              "Skipped federation announcement",
              context: "federation.announce",
              domain: domain,
              reason: "peer backoff",
              retry_in: backoff.ceil,
            )
            skipped += 1
            next
          end

          if pool
            begin
              task = pool.schedule do
                announce_instance_to_domain(domain, payload_json)
              end
              scheduled_tasks << [domain, task]
              next
            rescue PotatoMesh::App::WorkerPool::QueueFullError
              warn_log(
                "Skipped federation announcement",
                context: "federation.announce",
                domain: domain,
                reason: "worker queue saturated",
              )
              skipped += 1
              backlog << domain
              next
            rescue PotatoMesh::App::WorkerPool::ShutdownError
              warn_log(
                "Worker pool unavailable, falling back to synchronous announcement",
                context: "federation.announce",
                domain: domain,
              )
              pool = nil
            end
          end

          sync_results << announce_instance_to_domain(domain, payload_json)
        end

        remember_announce_backlog(backlog)
        async_results = wait_for_federation_tasks(scheduled)
        all_results = sync_results + Array(async_results)

        unless domains.empty?
          success_count = all_results.count { |r| r == true }
          failure_count = all_results.length - success_count
          info_log(
            "Federation announcement cycle complete",
            context: "federation.announce",
            target_count: domains.length,
            success_count: success_count,
            failure_count: failure_count,
            skipped_count: skipped,
          )
        end
      end

      # Wait for scheduled federation tasks to complete while logging failures.
      #
      # @param scheduled [Array<(String, PotatoMesh::App::WorkerPool::Task)>] pairs of domains and tasks.
      # @return [Array<Boolean>] per-task result (true on successful publish,
      #   false on timeout/failure); empty when no tasks were scheduled.
      def wait_for_federation_tasks(scheduled)
        return [] if scheduled.empty?

        timeout = PotatoMesh::Config.federation_task_timeout_seconds
        results = []
        scheduled.each do |domain, task|
          break if federation_shutdown_requested?

          begin
            results << (task.wait(timeout: timeout) == true)
          rescue PotatoMesh::App::WorkerPool::TaskTimeoutError => e
            warn_log(
              "Federation announcement task timed out",
              context: "federation.announce",
              domain: domain,
              timeout: timeout,
              error_class: e.class.name,
              error_message: e.message,
            )
            results << false
          rescue StandardError => e
            warn_log(
              "Federation announcement task failed",
              context: "federation.announce",
              domain: domain,
              error_class: e.class.name,
              error_message: e.message,
            )
            results << false
          end
        end
        results
      end
    end
  end
end
