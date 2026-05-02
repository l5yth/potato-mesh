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

        remote_addresses = sort_addresses_for_connection(resolve_remote_ip_addresses(uri))
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
      rescue ArgumentError => e
        raise_instance_fetch_error(e)
      end

      # Execute a single HTTP GET request against the supplied URI, optionally
      # pinning the connection to a specific IP address.
      #
      # @param uri [URI::Generic] target endpoint.
      # @param ip_address [String, nil] resolved IP address to pin the
      #   connection to, or +nil+ to let {build_remote_http_client} resolve.
      # @return [String] raw HTTP response body.
      # @raise [InstanceFetchError] when the request fails.
      def perform_single_http_request(uri, ip_address: nil)
        http = build_remote_http_client(uri, ip_address: ip_address)
        Timeout.timeout(PotatoMesh::Config.remote_instance_request_timeout) do
          http.start do |connection|
            request = build_federation_http_request(Net::HTTP::Get, uri)
            response = connection.request(request)
            case response
            when Net::HTTPSuccess
              response.body
            else
              raise InstanceFetchError, "unexpected response #{response.code}"
            end
          end
        end
      rescue StandardError => e
        raise_instance_fetch_error(e)
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
      # @param domain [String] peer hostname.
      # @param path [String] request path.
      # @return [Array(Object, URI::Generic | Array<String>)] decoded payload
      #   plus the successful URI, or +[nil, errors]+ when every candidate fails.
      def fetch_instance_json(domain, path)
        return [nil, ["federation shutdown requested"]] if federation_shutdown_requested?

        errors = []
        instance_uri_candidates(domain, path).each do |uri|
          break if federation_shutdown_requested?

          begin
            body = perform_instance_http_request(uri)
            return [JSON.parse(body), uri] if body
          rescue JSON::ParserError => e
            errors << "#{uri}: invalid JSON (#{e.message})"
          rescue InstanceFetchError => e
            errors << "#{uri}: #{e.message}"
          end
        end
        [nil, errors]
      end
    end
  end
end
