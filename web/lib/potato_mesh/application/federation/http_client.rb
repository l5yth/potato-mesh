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
      # Determine whether an HTTPS announcement failure should fall back to HTTP.
      #
      # @param error [StandardError] failure raised while attempting HTTPS.
      # @return [Boolean] true when the error corresponds to a refused TCP connection.
      def https_connection_refused?(error)
        current = error
        while current
          return true if current.is_a?(Errno::ECONNREFUSED)

          current = current.respond_to?(:cause) ? current.cause : nil
        end

        false
      end

      # Determine whether an error indicates a transport-level connection
      # failure that may succeed on an alternative resolved address.
      #
      # Connection refusals, host/network unreachable errors, and TCP open
      # timeouts signal that the selected IP address cannot be reached but
      # do not rule out alternative addresses for the same hostname.
      #
      # @param error [StandardError] failure raised during the connection attempt.
      # @return [Boolean] true when a retry with a different address is warranted.
      def connection_refused_or_unreachable?(error)
        retryable_classes = [
          Errno::ECONNREFUSED,
          Errno::EHOSTUNREACH,
          Errno::ENETUNREACH,
          Errno::ECONNRESET,
          Errno::ETIMEDOUT,
          Net::OpenTimeout,
        ]
        current = error
        while current
          return true if retryable_classes.any? { |klass| current.is_a?(klass) }

          current = current.respond_to?(:cause) ? current.cause : nil
        end

        false
      end

      # Build the HTTPS-then-HTTP URI candidates used to reach a remote peer.
      #
      # @param domain [String] peer hostname.
      # @param path [String] request path (must include leading slash).
      # @return [Array<URI::Generic>] ordered list of URI candidates.
      def instance_uri_candidates(domain, path)
        base = domain
        [
          URI.parse("https://#{base}#{path}"),
          URI.parse("http://#{base}#{path}"),
        ]
      rescue URI::InvalidURIError
        []
      end

      # Build an HTTP request decorated with the headers required for federation peers.
      #
      # @param request_class [Class<Net::HTTPRequest>] HTTP request class such as {Net::HTTP::Get}.
      # @param uri [URI::Generic] target URI describing the remote endpoint.
      # @return [Net::HTTPRequest] configured HTTP request including standard headers.
      def build_federation_http_request(request_class, uri)
        request = request_class.new(uri)
        request["User-Agent"] = federation_user_agent_header
        request["Accept"] = "application/json"
        request["Content-Type"] = "application/json" if request.request_body_permitted?
        request
      end

      # Compose the User-Agent string used when communicating with federation peers.
      #
      # @return [String] descriptive identifier for PotatoMesh federation requests.
      def federation_user_agent_header
        version = app_constant(:APP_VERSION).to_s
        version = "unknown" if version.empty?
        sanitized_domain = sanitize_instance_domain(app_constant(:INSTANCE_DOMAIN), downcase: true)
        base = "PotatoMesh/#{version}"
        return base unless sanitized_domain && !sanitized_domain.empty?

        "#{base} (+https://#{sanitized_domain})"
      end

      # Resolve the host component of a remote URI and ensure the destination is
      # safe for federation HTTP requests.
      #
      # The method performs a DNS lookup using Addrinfo to capture every
      # available address for the supplied URI host. The resulting addresses are
      # converted to {IPAddr} objects for consistent inspection via
      # {restricted_ip_address?}. When all resolved addresses fall within
      # restricted ranges, the method raises an ArgumentError so callers can
      # abort the federation request before contacting the remote endpoint.
      #
      # @param uri [URI::Generic] remote endpoint candidate.
      # @return [Array<IPAddr>] list of resolved, unrestricted IP addresses.
      # @raise [ArgumentError] when +uri.host+ is blank or resolves solely to
      #   restricted addresses.
      def resolve_remote_ip_addresses(uri)
        host = uri&.host
        raise ArgumentError, "URI missing host" unless host

        addrinfo_records = Addrinfo.getaddrinfo(host, nil, Socket::AF_UNSPEC, Socket::SOCK_STREAM)
        addresses = addrinfo_records.filter_map do |addr|
          begin
            IPAddr.new(addr.ip_address)
          rescue IPAddr::InvalidAddressError
            nil
          end
        end
        unique_addresses = addresses.uniq { |ip| [ip.family, ip.to_s] }
        unrestricted_addresses = unique_addresses.reject { |ip| restricted_ip_address?(ip) }

        if unique_addresses.any? && unrestricted_addresses.empty?
          raise ArgumentError, "restricted domain"
        end

        unrestricted_addresses
      end

      # Sort resolved addresses so that IPv4 precedes IPv6.
      #
      # Federation peers with dual-stack DNS may publish addresses where one
      # family is unreachable.  Placing IPv4 entries first mirrors the
      # preference used by {discover_local_ip_address} and improves the
      # likelihood that the first connection attempt succeeds.
      #
      # @param addresses [Array<IPAddr>] resolved IP address list.
      # @return [Array<IPAddr>] addresses sorted with IPv4 entries before IPv6.
      def sort_addresses_for_connection(addresses)
        return addresses if addresses.nil? || addresses.length <= 1

        v4, v6 = addresses.partition { |ip| !ip.ipv6? }
        v4 + v6
      end

      # Build an HTTP client configured for communication with a remote instance.
      #
      # When +ip_address+ is supplied the client is pinned to that specific
      # address, bypassing DNS resolution.  Callers that iterate over
      # multiple resolved addresses should pass each candidate in turn.
      #
      # @param uri [URI::Generic] target URI describing the remote endpoint.
      # @param ip_address [String, nil] explicit IP address to connect to,
      #   or +nil+ to resolve via DNS and use the first result.
      # @return [Net::HTTP] HTTP client ready to execute the request.
      def build_remote_http_client(uri, ip_address: nil)
        http = Net::HTTP.new(uri.host, uri.port)
        if ip_address
          http.ipaddr = ip_address if http.respond_to?(:ipaddr=)
        else
          remote_addresses = resolve_remote_ip_addresses(uri)
          if http.respond_to?(:ipaddr=) && remote_addresses.any?
            http.ipaddr = remote_addresses.first.to_s
          end
        end
        http.open_timeout = PotatoMesh::Config.remote_instance_http_timeout
        http.read_timeout = PotatoMesh::Config.remote_instance_read_timeout
        http.use_ssl = uri.scheme == "https"
        return http unless http.use_ssl?

        http.verify_mode = OpenSSL::SSL::VERIFY_PEER
        http.min_version = :TLS1_2 if http.respond_to?(:min_version=)
        store = remote_instance_cert_store
        http.cert_store = store if store
        callback = remote_instance_verify_callback
        http.verify_callback = callback if callback
        http
      end

      # Construct a certificate store that disables strict CRL enforcement.
      #
      # OpenSSL may fail remote requests when certificate revocation lists are
      # unavailable from the issuing authority. The returned store mirrors the
      # default system trust store while clearing CRL-related flags so that
      # federation announcements gracefully succeed when CRLs cannot be fetched.
      #
      # @return [OpenSSL::X509::Store, nil] configured store or nil when setup fails.
      def remote_instance_cert_store
        return @remote_instance_cert_store if defined?(@remote_instance_cert_store) && @remote_instance_cert_store

        store = OpenSSL::X509::Store.new
        store.set_default_paths
        store.flags = 0 if store.respond_to?(:flags=)
        @remote_instance_cert_store = store
      rescue OpenSSL::X509::StoreError => e
        debug_log(
          "Failed to initialize certificate store for federation HTTP: #{e.message}",
        )
        @remote_instance_cert_store = nil
      end

      # Build a TLS verification callback that tolerates CRL availability failures.
      #
      # Some certificate authorities publish CRL endpoints that may occasionally be
      # unreachable. When OpenSSL cannot download the CRL it raises the
      # V_ERR_UNABLE_TO_GET_CRL error which would otherwise cause HTTPS federation
      # announcements to abort. The generated callback accepts those specific
      # failures while preserving strict verification for all other errors.
      #
      # @return [Proc, nil] verification callback or nil when creation fails.
      def remote_instance_verify_callback
        if defined?(@remote_instance_verify_callback) && @remote_instance_verify_callback
          return @remote_instance_verify_callback
        end

        callback = lambda do |preverify_ok, store_context|
          return true if preverify_ok

          if store_context && crl_unavailable_error?(store_context.error)
            debug_log(
              "Ignoring TLS CRL retrieval failure during federation request",
              context: "federation.announce",
            )
            true
          else
            false
          end
        end

        @remote_instance_verify_callback = callback
      rescue StandardError => e
        debug_log(
          "Failed to initialize federation TLS verify callback: #{e.message}",
          context: "federation.announce",
        )
        @remote_instance_verify_callback = nil
      end

      # Determine whether the supplied OpenSSL verification error corresponds to a
      # missing certificate revocation list.
      #
      # @param error_code [Integer, nil] OpenSSL verification error value.
      # @return [Boolean] true when the error should be ignored.
      def crl_unavailable_error?(error_code)
        allowed_errors = [OpenSSL::X509::V_ERR_UNABLE_TO_GET_CRL]
        if defined?(OpenSSL::X509::V_ERR_UNABLE_TO_GET_CRL_ISSUER)
          allowed_errors << OpenSSL::X509::V_ERR_UNABLE_TO_GET_CRL_ISSUER
        end
        allowed_errors.include?(error_code)
      end
    end
  end
end
