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
      # Thread-local key of the deadline that bounds every federation request
      # on a thread, set by {#with_federation_deadline}.
      FEDERATION_DEADLINE_KEY = :potato_mesh_federation_deadline

      # Run the block with every federation request this thread sends, DNS
      # lookups included, ending within +seconds+ from now (SPEC FL7). Each
      # request's own timeout shrinks to what is left, so no timeout nests in
      # another; once the deadline has passed a request fails at once.
      #
      # @param seconds [Numeric] seconds the block's requests may take.
      # @return [Object] the block's result.
      def with_federation_deadline(seconds)
        previous = Thread.current[FEDERATION_DEADLINE_KEY]
        Thread.current[FEDERATION_DEADLINE_KEY] = Process.clock_gettime(Process::CLOCK_MONOTONIC) + seconds
        yield
      ensure
        Thread.current[FEDERATION_DEADLINE_KEY] = previous
      end

      # Seconds the next federation request on this thread may take:
      # +REMOTE_INSTANCE_REQUEST_TIMEOUT+, or what is left of the thread's
      # deadline when that is less.
      #
      # @return [Numeric] positive seconds.
      # @raise [FederationDeadlineError] when the thread's deadline has passed.
      def federation_request_timeout_seconds
        timeout = PotatoMesh::Config.remote_instance_request_timeout
        deadline = Thread.current[FEDERATION_DEADLINE_KEY]
        return timeout unless deadline

        remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
        raise FederationDeadlineError, "verification deadline passed" unless remaining.positive?

        [timeout, remaining].min
      end

      # Run the block within what is left of the thread's federation
      # deadline, or unbounded when no deadline is set.
      #
      # @return [Object] the block's result.
      # @raise [FederationDeadlineError] when the deadline has passed.
      # @raise [Timeout::Error] when the block outlives the deadline.
      def within_federation_deadline(&block)
        return yield unless Thread.current[FEDERATION_DEADLINE_KEY]

        Timeout.timeout(federation_request_timeout_seconds, &block)
      end

      # Execute a GET request against the supplied federation URI, cycling
      # through resolved IP addresses when a transport-level connection
      # failure occurs.
      #
      # DNS resolution is performed once and the resulting addresses are
      # sorted with IPv4 first via {sort_addresses_for_connection}.  Each
      # address is attempted sequentially; when a connection-level error
      # (refused, unreachable, timeout) is raised the next address is tried.
      # Non-connection errors (SSL failures, HTTP-level errors) are raised
      # immediately without trying further addresses.
      #
      # @param uri [URI::Generic] target endpoint to request.
      # @return [String] raw HTTP response body on success.
      # @raise [InstanceFetchError] when all addresses are exhausted or a
      #   non-retryable error occurs.
      def perform_instance_http_request(uri)
        raise InstanceFetchError, "federation shutdown requested" if federation_shutdown_requested?

        resolved = within_federation_deadline { resolve_remote_ip_addresses(uri) }
        remote_addresses = sort_addresses_for_connection(resolved)
        addresses = remote_addresses.empty? ? [nil] : remote_addresses

        last_error = nil
        addresses.each do |address|
          break if federation_shutdown_requested?

          begin
            return perform_single_http_request(uri, ip_address: address&.to_s)
          rescue InstanceFetchError => e
            if connection_refused_or_unreachable?(e)
              last_error = e
            else
              raise
            end
          end
        end

        raise last_error || InstanceFetchError.new("all resolved addresses failed")
      rescue ArgumentError, SocketError, Timeout::Error => e
        # +resolve_remote_ip_addresses+ runs the DNS lookup before the wrapped
        # HTTP attempt: a blank/restricted host raises ArgumentError, an
        # unresolvable domain raises Socket::ResolutionError (a SocketError),
        # and a lookup that outlives the thread's federation deadline raises
        # Timeout::Error. All are converted to InstanceFetchError so every
        # fetch_instance_json caller rejects the peer gracefully instead of
        # letting a raw resolution error escape as a 500.  (HTTP-attempt errors
        # are already wrapped inside perform_single_http_request, so this never
        # masks a live connection.)
        raise_instance_fetch_error(e)
      end

      # Execute a single HTTP GET request against the supplied URI, optionally
      # pinning the connection to a specific IP address.
      #
      # A request to a stable path (one without +since=+) revalidates what an
      # earlier answer from the same URL left in the peer store: it sends
      # +If-None-Match+ with that answer's +ETag+ and +If-Modified-Since+ with
      # its +Last-Modified+, and a 304 returns the kept body (SPEC FL4).
      # +Cache-Control+ +max-age+ never skips a request, so the identity
      # check always reads the peer's current well-known (SPEC FS8).
      #
      # @param uri [URI::Generic] target endpoint.
      # @param ip_address [String, nil] resolved IP address to pin the
      #   connection to, or +nil+ to let {build_remote_http_client} resolve.
      # @return [String] raw HTTP response body.
      # @raise [InstanceFetchError] when the request fails.
      # @raise [PotatoMesh::App::WorkerPool::TaskTimeoutError] when the worker
      #   pool's task timeout ends the task running the request.
      def perform_single_http_request(uri, ip_address: nil)
        timeout = federation_request_timeout_seconds
        http = build_remote_http_client(uri, ip_address: ip_address)
        revalidate = federation_revalidated_path?(uri)
        kept = revalidate ? federation_peer_backoff.validators(uri.host, uri.to_s) : nil
        Timeout.timeout(timeout) do
          http.start do |connection|
            request = build_federation_http_request(Net::HTTP::Get, uri)
            request["If-None-Match"] = kept[:etag] if kept && kept[:etag]
            request["If-Modified-Since"] = kept[:last_modified] if kept && kept[:last_modified]
            # Stream the response with the block form of +request+ so the size
            # cap (mirroring the inbound +read_json_body+ ceiling) is enforced
            # *incrementally*. The non-block form buffers the whole body into
            # memory before we could inspect it, so a malicious/oversized peer
            # could still cause a large allocation before we raise. Reading in
            # chunks lets us abort as soon as the limit is exceeded.
            max_bytes = PotatoMesh::Config.remote_instance_max_response_bytes
            body = nil
            connection.request(request) do |response|
              # Unchanged since the kept answer: reuse its body.
              if kept && response.is_a?(Net::HTTPNotModified)
                body = kept[:body]
                next
              end

              unless response.is_a?(Net::HTTPSuccess)
                raise InstanceHttpResponseError.new(
                  "unexpected response #{response.code}",
                  status: response.code.to_i,
                  retry_after: federation_retry_after_seconds(response["Retry-After"]),
                )
              end

              buffer = +""
              response.read_body do |chunk|
                buffer << chunk
                if buffer.bytesize > max_bytes
                  raise InstanceHttpResponseError,
                        "response exceeds maximum size of #{max_bytes} bytes"
                end
              end
              body = buffer
              if revalidate
                federation_peer_backoff.store_validators(
                  uri.host, uri.to_s,
                  etag: response["ETag"], last_modified: response["Last-Modified"], body: body,
                )
              end
            end
            body
          end
        end
      rescue PotatoMesh::App::WorkerPool::TaskTimeoutError
        # The worker pool raises its task timeout into the task's thread; it
        # ends the whole task, a crawl included, not this one request (SPEC
        # FL6).
        raise
      rescue InstanceFetchError
        # Reached the peer at the HTTP layer (an InstanceHttpResponseError),
        # or the thread's federation deadline has passed; do not wrap so
        # callers can distinguish "peer responded with non-2xx" from
        # "transport failure".
        raise
      rescue StandardError => e
        raise_instance_fetch_error(e)
      end

      # Whether requests to +uri+ revalidate a kept answer: every path except
      # the +since=+ queries, whose URL changes with each request (SPEC FL4).
      #
      # @param uri [URI::Generic] request URI.
      # @return [Boolean] true for a stable path.
      def federation_revalidated_path?(uri)
        URI.decode_www_form(uri.query.to_s).none? { |name, _| name == "since" }
      end

      # Build a human readable error message for a failed instance request.
      #
      # @param error [StandardError] failure raised while performing the request.
      # @return [String] description including the error class when necessary.
      def instance_fetch_error_message(error)
        message = error.message.to_s.strip
        class_name = error.class.name || error.class.to_s
        return class_name if message.empty?

        message.include?(class_name) ? message : "#{class_name}: #{message}"
      end

      # Raise an InstanceFetchError that preserves the original context.
      #
      # @param error [StandardError] failure raised while performing the request.
      # @return [void]
      def raise_instance_fetch_error(error)
        message = instance_fetch_error_message(error)
        wrapped = InstanceFetchError.new(message)
        wrapped.set_backtrace(error.backtrace)
        raise wrapped
      end

      # Fetch and JSON-decode a federation document from a peer.
      #
      # A host backing off sends nothing (SPEC FL4). The outcome feeds the
      # backoff: a transport failure, a 429 or a 503 backs off the host,
      # honouring a +Retry-After+; any other answer clears it. A request this
      # instance's own deadline kept from being sent counts neither way.
      #
      # @param domain [String] peer hostname.
      # @param path [String] request path.
      # @return [Array(Object, URI::Generic | Array<String>)] decoded payload
      #   plus the successful URI, or +[nil, errors]+ when every candidate fails.
      def fetch_instance_json(domain, path)
        return [nil, ["federation shutdown requested"]] if federation_shutdown_requested?

        host = federation_peer_host(domain)
        backoff = federation_peer_backoff.backoff_seconds(host)
        return [nil, ["#{domain}#{path}: backing off for #{backoff.ceil} s"]] if backoff.positive?

        errors = []
        failed = false
        retry_after = nil
        instance_uri_candidates(domain, path).each do |uri|
          break if federation_shutdown_requested?

          begin
            body = perform_instance_http_request(uri)
            if body
              payload = JSON.parse(body)
              federation_peer_backoff.record_success(host)
              return [payload, uri]
            end
          rescue JSON::ParserError => e
            errors << "#{uri}: invalid JSON (#{e.message})"
          rescue InstanceHttpResponseError => e
            # Peer answered at the HTTP layer (e.g. 4xx/5xx).  Falling back to
            # the next transport candidate (http:// after https://) adds noise
            # without adding any chance of success — stop here.
            errors << "#{uri}: #{e.message}"
            failed = e.peer_failure?
            retry_after = e.retry_after
            federation_peer_backoff.record_success(host) unless failed
            break
          rescue FederationDeadlineError => e
            # Nothing was sent, and no later candidate could be: the time was
            # this instance's to spend, not the peer's to lose (SPEC FL7).
            errors << "#{uri}: #{e.message}"
            break
          rescue InstanceFetchError => e
            errors << "#{uri}: #{e.message}"
            failed = true
          end
        end
        federation_peer_backoff.record_failure(host, retry_after: retry_after) if failed
        [nil, errors]
      end
    end
  end
end
