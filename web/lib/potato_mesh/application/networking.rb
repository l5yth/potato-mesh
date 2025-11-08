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
    module Networking
      # Normalise the configured instance domain by stripping schemes and verifying structure.
      #
      # @param raw [String, nil] environment supplied domain or URL.
      # @return [String, nil] canonicalised hostname with optional port.
      def canonicalize_configured_instance_domain(raw)
        return nil if raw.nil?

        trimmed = raw.to_s.strip
        return nil if trimmed.empty?

        candidate = trimmed

        if candidate.include?("://")
          begin
            uri = URI.parse(candidate)
          rescue URI::InvalidURIError => e
            raise "INSTANCE_DOMAIN must be a valid hostname or URL, but parsing #{candidate.inspect} failed: #{e.message}"
          end

          unless uri.host
            raise "INSTANCE_DOMAIN URL must include a hostname: #{candidate.inspect}"
          end

          if uri.userinfo
            raise "INSTANCE_DOMAIN URL must not include credentials: #{candidate.inspect}"
          end

          if uri.path && !uri.path.empty? && uri.path != "/"
            raise "INSTANCE_DOMAIN URL must not include a path component: #{candidate.inspect}"
          end

          if uri.query || uri.fragment
            raise "INSTANCE_DOMAIN URL must not include query or fragment data: #{candidate.inspect}"
          end

          hostname = uri.hostname
          unless hostname
            raise "INSTANCE_DOMAIN URL must include a hostname: #{candidate.inspect}"
          end

          ip_host = ipv6_literal?(hostname)
          candidate_host = ip_host ? "[#{ip_host}]" : hostname
          candidate = candidate_host
          port = uri.port
          candidate = "#{candidate_host}:#{port}" if port_required?(uri, trimmed)
        end

        ipv6_with_port = candidate.match(/\A(?<address>.+):(?<port>\d+)\z/)
        if ipv6_with_port
          address = ipv6_with_port[:address]
          port = ipv6_with_port[:port]
          literal = ipv6_literal?(address)
          if literal && PotatoMesh::Sanitizer.valid_port?(port)
            candidate = "[#{literal}]:#{port}"
          else
            ipv6_literal = ipv6_literal?(candidate)
            candidate = "[#{ipv6_literal}]" if ipv6_literal
          end
        else
          ipv6_literal = ipv6_literal?(candidate)
          candidate = "[#{ipv6_literal}]" if ipv6_literal
        end

        sanitized = sanitize_instance_domain(candidate)
        unless sanitized
          raise "INSTANCE_DOMAIN must be a bare hostname (optionally with a port) without schemes or paths: #{raw.inspect}"
        end

        ensure_ipv6_instance_domain(sanitized).downcase
      end

      # Resolve the best domain for the running instance using configuration and network discovery.
      #
      # @return [Array(String, Symbol)] tuple containing the domain and the discovery source.
      def determine_instance_domain
        raw = ENV["INSTANCE_DOMAIN"]
        if raw
          canonical = canonicalize_configured_instance_domain(raw)
          return [canonical, :environment] if canonical
        end

        reverse = sanitize_instance_domain(reverse_dns_domain)
        return [reverse, :reverse_dns] if reverse

        public_ip = discover_public_ip_address
        return [public_ip, :public_ip] if public_ip

        protected_ip = discover_protected_ip_address
        return [protected_ip, :protected_ip] if protected_ip

        [discover_local_ip_address, :local_ip]
      end

      # Attempt to determine the reverse DNS hostname for the local machine.
      #
      # @return [String, nil] resolved hostname or nil when unavailable.
      def reverse_dns_domain
        Socket.ip_address_list.each do |address|
          next unless address.respond_to?(:ip?) && address.ip?

          loopback =
            (address.respond_to?(:ipv4_loopback?) && address.ipv4_loopback?) ||
            (address.respond_to?(:ipv6_loopback?) && address.ipv6_loopback?)
          next if loopback

          link_local =
            address.respond_to?(:ipv6_linklocal?) && address.ipv6_linklocal?
          next if link_local

          ip = address.ip_address
          next if ip.nil? || ip.empty?

          begin
            hostname = Resolv.getname(ip)
            trimmed = hostname&.strip
            return trimmed unless trimmed.nil? || trimmed.empty?
          rescue Resolv::ResolvError, Resolv::ResolvTimeout, SocketError
            next
          end
        end

        nil
      end

      # Identify the first public IP address of the current host.
      #
      # @return [String, nil] public IP address string or nil.
      def discover_public_ip_address
        address = ip_address_candidates.find { |candidate| public_ip_address?(candidate) }
        address&.ip_address
      end

      # Identify a private yet non-loopback IP address suitable for protected networks.
      #
      # @return [String, nil] protected network address or nil.
      def discover_protected_ip_address
        address = ip_address_candidates.find { |candidate| protected_ip_address?(candidate) }
        address&.ip_address
      end

      # Collect viable socket addresses for evaluation.
      #
      # @return [Array<#ip?>] list of socket addresses supporting IP queries.
      def ip_address_candidates
        Socket.ip_address_list.select { |addr| addr.respond_to?(:ip?) && addr.ip? }
      end

      # Determine whether a socket address represents a public IP.
      #
      # @param addr [Addrinfo] candidate socket address.
      # @return [Boolean] true when the address is publicly routable.
      def public_ip_address?(addr)
        ip = ipaddr_from(addr)
        return false unless ip
        return false if loopback_address?(addr, ip)
        return false if link_local_address?(addr, ip)
        return false if private_address?(addr, ip)
        return false if unspecified_address?(ip)

        true
      end

      # Determine whether a socket address resides on a protected private network.
      #
      # @param addr [Addrinfo] candidate socket address.
      # @return [Boolean] true when the address is private but not loopback/link-local.
      def protected_ip_address?(addr)
        ip = ipaddr_from(addr)
        return false unless ip
        return false if loopback_address?(addr, ip)
        return false if link_local_address?(addr, ip)

        private_address?(addr, ip)
      end

      # Parse an IP address from the provided socket address.
      #
      # @param addr [Addrinfo] socket address to examine.
      # @return [IPAddr, nil] parsed IP or nil when invalid.
      def ipaddr_from(addr)
        ip = addr.ip_address
        return nil if ip.nil? || ip.empty?

        IPAddr.new(ip)
      rescue IPAddr::InvalidAddressError
        nil
      end

      # Determine whether a socket address is loopback.
      #
      # @param addr [Addrinfo] socket address to inspect.
      # @param ip [IPAddr] parsed IP representation of the address.
      # @return [Boolean] true when the address is loopback.
      def loopback_address?(addr, ip)
        (addr.respond_to?(:ipv4_loopback?) && addr.ipv4_loopback?) ||
          (addr.respond_to?(:ipv6_loopback?) && addr.ipv6_loopback?) ||
          ip.loopback?
      end

      # Determine whether a socket address is link-local.
      #
      # @param addr [Addrinfo] socket address to inspect.
      # @param ip [IPAddr] parsed IP representation of the address.
      # @return [Boolean] true when the address is link-local.
      def link_local_address?(addr, ip)
        (addr.respond_to?(:ipv6_linklocal?) && addr.ipv6_linklocal?) ||
          (ip.respond_to?(:link_local?) && ip.link_local?)
      end

      # Determine whether a socket address is private.
      #
      # @param addr [Addrinfo] socket address to inspect.
      # @param ip [IPAddr] parsed IP representation of the address.
      # @return [Boolean] true when the address is private.
      def private_address?(addr, ip)
        if addr.respond_to?(:ipv4?) && addr.ipv4? && addr.respond_to?(:ipv4_private?)
          addr.ipv4_private?
        else
          ip.private?
        end
      end

      # Identify unspecified IP addresses.
      #
      # @param ip [IPAddr] parsed IP.
      # @return [Boolean] true for unspecified addresses (0.0.0.0 / ::).
      def unspecified_address?(ip)
        (ip.ipv4? || ip.ipv6?) && ip.to_i.zero?
      end

      # Choose the most appropriate local IP address for the instance domain.
      #
      # @return [String] selected IP address string.
      def discover_local_ip_address
        candidates = ip_address_candidates

        ipv4 = candidates.find do |addr|
          addr.respond_to?(:ipv4?) && addr.ipv4? && !(addr.respond_to?(:ipv4_loopback?) && addr.ipv4_loopback?)
        end
        return ipv4.ip_address if ipv4

        non_loopback = candidates.find do |addr|
          !(addr.respond_to?(:ipv4_loopback?) && addr.ipv4_loopback?) &&
            !(addr.respond_to?(:ipv6_loopback?) && addr.ipv6_loopback?)
        end
        return non_loopback.ip_address if non_loopback

        loopback = candidates.find do |addr|
          (addr.respond_to?(:ipv4_loopback?) && addr.ipv4_loopback?) ||
            (addr.respond_to?(:ipv6_loopback?) && addr.ipv6_loopback?)
        end
        return loopback.ip_address if loopback

        "127.0.0.1"
      end

      # Determine whether an IP should be restricted from exposure.
      #
      # @param ip [IPAddr] candidate IP address.
      # @return [Boolean] true when the IP should not be exposed.
      def restricted_ip_address?(ip)
        return true if ip.loopback?
        return true if ip.private?
        return true if ip.link_local?
        return true if ip.to_i.zero?

        false
      end

      # Normalize IPv6 instance domains so that they remain bracketed and URI-compatible.
      #
      # @param domain [String] sanitized hostname optionally including a port suffix.
      # @return [String] domain with IPv6 literals wrapped in brackets when necessary.
      def ensure_ipv6_instance_domain(domain)
        bracketed_match = domain.match(/\A\[(?<host>[^\]]+)\](?::(?<port>\d+))?\z/)
        if bracketed_match
          host = bracketed_match[:host]
          port = bracketed_match[:port]
          ipv6 = ipv6_literal?(host)
          if ipv6
            return "[#{ipv6}]#{port ? ":#{port}" : ""}"
          end

          return domain
        end

        host_candidate = domain
        port_candidate = nil
        split_host, separator, split_port = domain.rpartition(":")
        if !separator.empty? && split_port.match?(/\A\d+\z/) && !split_host.empty? && !split_host.end_with?(":")
          host_candidate = split_host
          port_candidate = split_port
        end

        if port_candidate
          ipv6_host = ipv6_literal?(host_candidate)
          return "[#{ipv6_host}]:#{port_candidate}" if ipv6_host

          host_candidate = domain
          port_candidate = nil
        end

        ipv6 = ipv6_literal?(host_candidate)
        return "[#{ipv6}]" if ipv6

        domain
      end

      # Parse an IPv6 literal and return its canonical representation when valid.
      #
      # @param candidate [String] potential IPv6 literal.
      # @return [String, nil] normalized IPv6 literal or nil when the candidate is not IPv6.
      def ipv6_literal?(candidate)
        IPAddr.new(candidate).yield_self do |ip|
          return ip.ipv6? ? ip.to_s : nil
        end
      rescue IPAddr::InvalidAddressError
        nil
      end

      # Determine whether a URI's port should be included in the canonicalized domain.
      #
      # @param uri [URI::Generic] parsed URI for the instance domain.
      # @param raw [String] original sanitized input string.
      # @return [Boolean] true when the port must be preserved.
      def port_required?(uri, raw)
        port = uri.port
        return false unless port

        return true unless uri.respond_to?(:default_port) && uri.default_port && port == uri.default_port

        raw_port_fragment = ":#{port}"
        sanitized_raw = raw.strip
        sanitized_raw.end_with?(raw_port_fragment)
      end
    end
  end
end
