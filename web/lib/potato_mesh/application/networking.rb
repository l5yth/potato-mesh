# frozen_string_literal: true

module PotatoMesh
  module App
    module Networking
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

          candidate = hostname
          port = uri.port
          if port && (!uri.respond_to?(:default_port) || uri.default_port.nil? || port != uri.default_port)
            candidate = "#{candidate}:#{port}"
          elsif port && uri.to_s.match?(/:\d+/)
            candidate = "#{candidate}:#{port}"
          end
        end

        sanitized = sanitize_instance_domain(candidate)
        unless sanitized
          raise "INSTANCE_DOMAIN must be a bare hostname (optionally with a port) without schemes or paths: #{raw.inspect}"
        end

        sanitized.downcase
      end

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

      def discover_public_ip_address
        address = ip_address_candidates.find { |candidate| public_ip_address?(candidate) }
        address&.ip_address
      end

      def discover_protected_ip_address
        address = ip_address_candidates.find { |candidate| protected_ip_address?(candidate) }
        address&.ip_address
      end

      def ip_address_candidates
        Socket.ip_address_list.select { |addr| addr.respond_to?(:ip?) && addr.ip? }
      end

      def public_ip_address?(addr)
        ip = ipaddr_from(addr)
        return false unless ip
        return false if loopback_address?(addr, ip)
        return false if link_local_address?(addr, ip)
        return false if private_address?(addr, ip)
        return false if unspecified_address?(ip)

        true
      end

      def protected_ip_address?(addr)
        ip = ipaddr_from(addr)
        return false unless ip
        return false if loopback_address?(addr, ip)
        return false if link_local_address?(addr, ip)

        private_address?(addr, ip)
      end

      def ipaddr_from(addr)
        ip = addr.ip_address
        return nil if ip.nil? || ip.empty?

        IPAddr.new(ip)
      rescue IPAddr::InvalidAddressError
        nil
      end

      def loopback_address?(addr, ip)
        (addr.respond_to?(:ipv4_loopback?) && addr.ipv4_loopback?) ||
          (addr.respond_to?(:ipv6_loopback?) && addr.ipv6_loopback?) ||
          ip.loopback?
      end

      def link_local_address?(addr, ip)
        (addr.respond_to?(:ipv6_linklocal?) && addr.ipv6_linklocal?) ||
          (ip.respond_to?(:link_local?) && ip.link_local?)
      end

      def private_address?(addr, ip)
        if addr.respond_to?(:ipv4?) && addr.ipv4? && addr.respond_to?(:ipv4_private?)
          addr.ipv4_private?
        else
          ip.private?
        end
      end

      def unspecified_address?(ip)
        (ip.ipv4? || ip.ipv6?) && ip.to_i.zero?
      end

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

      def restricted_ip_address?(ip)
        return true if ip.loopback?
        return true if ip.private?
        return true if ip.link_local?
        return true if ip.to_i.zero?

        false
      end
    end
  end
end
