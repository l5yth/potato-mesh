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

      # CIDR ranges federation must never open a connection to (SPEC SS1).
      #
      # Stated explicitly rather than delegated to IPAddr's +loopback?+ /
      # +private?+ / +link_local?+ predicates. Those answer an address-taxonomy
      # question against a fixed stdlib table; this is a reachability decision,
      # and every range the table happens not to model becomes a silent bypass
      # that no test names. Four such omissions are covered here: RFC 6598
      # carrier-grade NAT, which +private?+ does not treat as private because it
      # is not RFC 1918; the RFC 1122 "this network" block, of which the
      # predicates saw only the single address 0.0.0.0; RFC 3879 site-local,
      # which no predicate models; and the reserved ::/16 slice below.
      #
      # Replacing the predicates also retires a stdlib defect rather than
      # inheriting it: +private?+, +loopback?+ and +link_local?+ recognise an
      # IPv4-mapped address by testing bits 80..95 == ffff *without* requiring
      # bits 0..79 to be zero, so they misreport ordinary global addresses as
      # internal: 2606:4700:4700::ffff:a9fe:a9fe reads as link-local (its low
      # 32 bits are 169.254.169.254) and 2001:db8:1:2:3:ffff:a00:1 as private.
      # Neither reaches anything internal — neither is IPv4-mapped at all — so
      # this list deliberately permits them where the predicates did not.
      RESTRICTED_IP_RANGES = [
        IPAddr.new("0.0.0.0/8"),        # RFC 1122 "this network" (0.0.0.0 reaches localhost)
        IPAddr.new("10.0.0.0/8"),       # RFC 1918 private
        IPAddr.new("100.64.0.0/10"),    # RFC 6598 carrier-grade NAT
        IPAddr.new("127.0.0.0/8"),      # RFC 1122 loopback
        IPAddr.new("169.254.0.0/16"),   # RFC 3927 link-local (cloud instance metadata)
        IPAddr.new("172.16.0.0/12"),    # RFC 1918 private
        IPAddr.new("192.168.0.0/16"),   # RFC 1918 private
        # RFC 4291 §2.4 reserves ::/8 outright. This /16 slice holds the
        # unspecified address, loopback (::1), IPv4-mapped (::ffff:0:0/96) and
        # the deprecated IPv4-compatible form (::a.b.c.d) — every one of which
        # either names or encodes an internal target, and none of which a
        # federation peer can legitimately publish. Restricting the slice
        # covers all four without a decode step. It deliberately stops at /16
        # rather than /8: the well-known NAT64 prefix 64:ff9b:: also sits in
        # ::/8, and SS2 requires that one be decoded, not blocked.
        IPAddr.new("::/16"),
        IPAddr.new("64:ff9b:1::/48"),   # RFC 8215 local-use NAT64 (local by definition)
        IPAddr.new("fc00::/7"),         # RFC 4193 unique local address
        IPAddr.new("fe80::/10"),        # RFC 4291 link-local
        IPAddr.new("fec0::/10"),        # RFC 3879 deprecated site-local
      ].freeze

      # RFC 6052 §3.1 well-known NAT64 prefix; the IPv4 destination is the low
      # 32 bits. Used with DNS64 to reach *global* IPv4, which the prefix's own
      # specification requires — so an embedded private address is already a
      # violation, and decoding is what detects it.
      NAT64_WELL_KNOWN_PREFIX = IPAddr.new("64:ff9b::/96").freeze

      # RFC 3056 6to4; the IPv4 address occupies bits 16..47 (2002:V4ADDR::/48).
      SIX_TO_FOUR_PREFIX = IPAddr.new("2002::/16").freeze

      # RFC 4380 Teredo; bits 32..63 carry the server's IPv4 and bits 96..127
      # the client's, obfuscated by XOR with all ones.
      TEREDO_PREFIX = IPAddr.new("2001::/32").freeze

      # RFC 5214 ISATAP interface identifiers. The IPv4 address follows the
      # +00-00-5E-FE+ (locally administered) or +02-00-5E-FE+ (globally unique)
      # marker in bits 64..95, so ISATAP is recognisable under *any* prefix
      # rather than a fixed one.
      ISATAP_IDENTIFIERS = [0x00005efe, 0x02005efe].freeze

      # Mask selecting a 32-bit IPv4 payload out of an IPv6 address.
      IPV4_PAYLOAD_MASK = 0xffffffff

      # Determine whether an IP should be restricted from exposure.
      #
      # An address is restricted when it names a forbidden destination directly
      # (SS1) *or* when it encodes one through an IPv6 transition mechanism
      # (SS2) — a NAT64/6to4/Teredo address is an IPv4 destination wrapped in
      # IPv6 notation, and a guard that inspects only the wrapper reaches the
      # target it meant to forbid. Recursion terminates after one step because
      # {embedded_ipv4_addresses} yields IPv4 addresses, which embed nothing.
      #
      # @param ip [IPAddr] candidate IP address.
      # @return [Boolean] true when the IP should not be exposed.
      def restricted_ip_address?(ip)
        return true if ip.to_i.zero?
        return true if RESTRICTED_IP_RANGES.any? { |range| range.include?(ip) }

        embedded_ipv4_addresses(ip).any? { |embedded| restricted_ip_address?(embedded) }
      end

      # Extract the IPv4 destinations an IPv6 transition address encodes.
      #
      # Decoding rather than blanket-blocking the transition prefixes is what
      # keeps the guard from costing reachability (SPEC SS2): on an IPv6-only
      # network with DNS64 every IPv4-only federation peer is synthesised into
      # the well-known NAT64 prefix, so refusing the prefix outright would end
      # federation with all of them while blocking nothing an attacker could
      # have used.
      #
      # @param ip [IPAddr] candidate IP address.
      # @return [Array<IPAddr>] embedded IPv4 addresses, empty when none apply.
      def embedded_ipv4_addresses(ip)
        return [] unless ip.ipv6?

        value = ip.to_i
        addresses = if NAT64_WELL_KNOWN_PREFIX.include?(ip)
            [ipv4_from_integer(value & IPV4_PAYLOAD_MASK)]
          elsif SIX_TO_FOUR_PREFIX.include?(ip)
            [ipv4_from_integer((value >> 80) & IPV4_PAYLOAD_MASK)]
          elsif TEREDO_PREFIX.include?(ip)
            # Both endpoints are attacker-chosen, so both are checked.
            [
              ipv4_from_integer((value >> 64) & IPV4_PAYLOAD_MASK),
              ipv4_from_integer((value & IPV4_PAYLOAD_MASK) ^ IPV4_PAYLOAD_MASK),
            ]
          else
            []
          end

        # ISATAP is carried in the interface identifier, not in the prefix, so
        # it can ride under a global prefix the branch above does not match and
        # is therefore tested independently rather than as another branch.
        if ISATAP_IDENTIFIERS.include?((value >> 32) & IPV4_PAYLOAD_MASK)
          addresses += [ipv4_from_integer(value & IPV4_PAYLOAD_MASK)]
        end

        addresses
      end

      # Build an IPv4 address from its 32-bit integer representation.
      #
      # @param value [Integer] 32-bit IPv4 address value.
      # @return [IPAddr] parsed IPv4 address.
      def ipv4_from_integer(value)
        IPAddr.new(value, Socket::AF_INET)
      end

      # Normalize IPv6 instance domains so that they remain bracketed and URI-compatible.
      #
      # RFC 3986 §3.2.2 requires IPv6 literals inside a URI authority component to
      # be enclosed in square brackets (e.g. [::1]).  Bare IPv6 addresses stored in
      # the database or supplied via the INSTANCE_DOMAIN environment variable must
      # therefore be wrapped before they can appear in outbound federation URLs.
      # This method handles three forms: already-bracketed (may include port),
      # bare IPv6 with an appended decimal port, and bare IPv6 with no port.
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
