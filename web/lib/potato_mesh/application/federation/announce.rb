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
      # occur.
      #
      # @param domain [String] remote peer hostname.
      # @param payload_json [String] JSON-encoded announcement body.
      # @return [Boolean] true when the announcement was accepted.
      def announce_instance_to_domain(domain, payload_json)
        return false unless domain && !domain.empty?
        return false if federation_shutdown_requested?

        https_failures = []

        published = instance_uri_candidates(domain, "/api/instances").any? do |uri|
          break false if federation_shutdown_requested?

          begin
            response = perform_announce_request(uri, payload_json)
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
              false
            end
          rescue StandardError => e
            metadata = {
              context: "federation.announce",
              target: uri.to_s,
              error_class: e.class.name,
              error_message: e.message,
            }

            if uri.scheme == "https" && https_connection_refused?(e)
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

        published
      end

      # Execute a POST announcement request against the supplied URI, cycling
      # through resolved IP addresses on connection-level failures.
      #
      # @param uri [URI::Generic] target endpoint.
      # @param payload_json [String] JSON-encoded announcement body.
      # @return [Net::HTTPResponse] the HTTP response from the first reachable address.
      # @raise [StandardError] when all addresses fail or a non-retryable error occurs.
      def perform_announce_request(uri, payload_json)
        remote_addresses = sort_addresses_for_connection(resolve_remote_ip_addresses(uri))
        addresses = remote_addresses.empty? ? [nil] : remote_addresses

        last_error = nil
        addresses.each do |address|
          break if federation_shutdown_requested?

          begin
            return perform_single_announce_request(uri, payload_json, ip_address: address&.to_s)
          rescue StandardError => e
            if connection_refused_or_unreachable?(e)
              last_error = e
            else
              raise
            end
          end
        end

        raise(last_error || StandardError.new("all resolved addresses failed"))
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
        Timeout.timeout(PotatoMesh::Config.remote_instance_request_timeout) do
          http.start do |connection|
            request = build_federation_http_request(Net::HTTP::Post, uri)
            request.body = payload_json
            connection.request(request)
          end
        end
      end

      # Run the periodic announcement cycle by signing the local payload and
      # dispatching it (preferably via the worker pool) to every peer domain.
      #
      # @return [void]
      def announce_instance_to_all_domains
        return unless federation_enabled?
        return if federation_shutdown_requested?

        attributes, signature = ensure_self_instance_record!
        payload_json = JSON.generate(instance_announcement_payload(attributes, signature))
        domains = federation_target_domains(attributes[:domain])
        pool = federation_worker_pool
        scheduled = []

        domains.each_with_object(scheduled) do |domain, scheduled_tasks|
          break if federation_shutdown_requested?

          if pool
            begin
              task = pool.schedule do
                announce_instance_to_domain(domain, payload_json)
              end
              scheduled_tasks << [domain, task]
              next
            rescue PotatoMesh::App::WorkerPool::QueueFullError
              warn_log(
                "Skipped asynchronous federation announcement",
                context: "federation.announce",
                domain: domain,
                reason: "worker queue saturated",
              )
            rescue PotatoMesh::App::WorkerPool::ShutdownError
              warn_log(
                "Worker pool unavailable, falling back to synchronous announcement",
                context: "federation.announce",
                domain: domain,
              )
              pool = nil
            end
          end

          announce_instance_to_domain(domain, payload_json)
        end

        wait_for_federation_tasks(scheduled)

        unless domains.empty?
          debug_log(
            "Federation announcement cycle complete",
            context: "federation.announce",
            targets: domains,
          )
        end
      end

      # Wait for scheduled federation tasks to complete while logging failures.
      #
      # @param scheduled [Array<(String, PotatoMesh::App::WorkerPool::Task)>] pairs of domains and tasks.
      # @return [void]
      def wait_for_federation_tasks(scheduled)
        return if scheduled.empty?

        timeout = PotatoMesh::Config.federation_task_timeout_seconds
        scheduled.all? do |domain, task|
          break false if federation_shutdown_requested?

          begin
            task.wait(timeout: timeout)
          rescue PotatoMesh::App::WorkerPool::TaskTimeoutError => e
            warn_log(
              "Federation announcement task timed out",
              context: "federation.announce",
              domain: domain,
              timeout: timeout,
              error_class: e.class.name,
              error_message: e.message,
            )
          rescue StandardError => e
            warn_log(
              "Federation announcement task failed",
              context: "federation.announce",
              domain: domain,
              error_class: e.class.name,
              error_message: e.message,
            )
          end
          true
        end
      end
    end
  end
end
