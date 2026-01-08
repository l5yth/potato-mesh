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

require "ipaddr"

require_relative "config"

module PotatoMesh
  # Utility module responsible for coercing and sanitising user provided
  # configuration strings.  Each helper is exposed as a module function so it
  # can be consumed both by the web layer and background jobs without
  # instantiation overhead.
  module Sanitizer
    module_function

    # Coerce an arbitrary value into a trimmed string unless the content is
    # empty.
    #
    # @param value [Object, nil] arbitrary input that should be converted.
    # @return [String, nil] trimmed string representation or +nil+ when blank.
    def string_or_nil(value)
      return nil if value.nil?

      str = value.is_a?(String) ? value : value.to_s
      trimmed = str.strip
      trimmed.empty? ? nil : trimmed
    end

    # Ensure a value is a valid instance domain according to RFC 1035/3986
    # rules.  Hostnames must include at least one dot-separated label and a
    # top-level domain containing an alphabetic character. Literal IP
    # addresses must be provided in standard dotted decimal form or enclosed in
    # brackets when IPv6 notation is used. Optional ports must fall within the
    # valid TCP/UDP range.  Any opaque identifiers, URIs, or malformed hosts are
    # rejected.
    #
    # @param value [String, Object, nil] candidate domain name.
    # @param downcase [Boolean] whether to force the result to lowercase.
    # @return [String, nil] canonical domain value or +nil+ when invalid.
    def sanitize_instance_domain(value, downcase: true)
      host = string_or_nil(value)
      return nil unless host

      trimmed = host.strip
      trimmed = trimmed.delete_suffix(".") while trimmed.end_with?(".")
      return nil if trimmed.empty?
      return nil if trimmed.match?(%r{[\s/\\@]})

      if trimmed.start_with?("[")
        match = trimmed.match(/\A\[(?<address>[^\]]+)\](?::(?<port>\d+))?\z/)
        return nil unless match

        address = match[:address]
        port = match[:port]

        return nil if port && !valid_port?(port)

        begin
          IPAddr.new(address)
        rescue IPAddr::InvalidAddressError
          return nil
        end

        sanitized_address = downcase ? address.downcase : address
        return "[#{sanitized_address}]#{port ? ":#{port}" : ""}"
      end

      domain = trimmed
      port = nil

      if domain.include?(":")
        host_part, port_part = domain.split(":", 2)
        return nil if host_part.nil? || host_part.empty?
        return nil unless port_part && port_part.match?(/\A\d+\z/)
        return nil unless valid_port?(port_part)
        return nil if port_part.include?(":")

        domain = host_part
        port = port_part
      end

      unless valid_hostname?(domain) || valid_ipv4_literal?(domain)
        return nil
      end

      sanitized_domain = downcase ? domain.downcase : domain
      port ? "#{sanitized_domain}:#{port}" : sanitized_domain
    end

    # Determine whether the supplied hostname conforms to RFC 1035 label
    # requirements and includes a valid top-level domain.
    #
    # @param hostname [String] host component without any port information.
    # @return [Boolean] true when the hostname is valid.
    def valid_hostname?(hostname)
      return false if hostname.length > 253

      labels = hostname.split(".")
      return false if labels.length < 2
      return false unless labels.all? { |label| valid_hostname_label?(label) }

      top_level = labels.last
      top_level.match?(/[a-z]/i)
    end

    # Validate a single hostname label ensuring the first and last characters
    # are alphanumeric and that no unsupported symbols are present.
    #
    # @param label [String] hostname component between dots.
    # @return [Boolean] true when the label is valid.
    def valid_hostname_label?(label)
      return false if label.empty?
      return false if label.length > 63

      label.match?(/\A[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\z/i)
    end

    # Validate whether a candidate represents a dotted decimal IPv4 literal.
    #
    # @param address [String] IP address string without port information.
    # @return [Boolean] true when the address is a valid IPv4 literal.
    def valid_ipv4_literal?(address)
      return false unless address.match?(/\A\d{1,3}(?:\.\d{1,3}){3}\z/)

      address.split(".").all? { |octet| octet.to_i.between?(0, 255) }
    end

    # Determine whether a port string represents a valid TCP/UDP port.
    #
    # @param port [String] numeric port representation.
    # @return [Boolean] true when the port falls within the acceptable range.
    def valid_port?(port)
      value = port.to_i
      value.positive? && value <= 65_535
    end

    # Extract the host component from a potentially bracketed domain literal.
    #
    # @param domain [String, nil] raw domain string received from the user.
    # @return [String, nil] host portion of the domain, or +nil+ when invalid.
    def instance_domain_host(domain)
      return nil if domain.nil?

      candidate = domain.strip
      return nil if candidate.empty?

      if candidate.start_with?("[")
        match = candidate.match(/\A\[(?<host>[^\]]+)\](?::(?<port>\d+))?\z/)
        return match[:host] if match
        return nil
      end

      host, port = candidate.split(":", 2)
      if port && !host.include?(":") && port.match?(/\A\d+\z/)
        return host
      end

      candidate
    end

    # Resolve a validated domain string into an IP address object.
    #
    # @param domain [String, nil] domain literal potentially including port.
    # @return [IPAddr, nil] parsed IP address when valid.
    def ip_from_domain(domain)
      host = instance_domain_host(domain)
      return nil unless host

      IPAddr.new(host)
    rescue IPAddr::InvalidAddressError
      nil
    end

    # Normalise a value into a trimmed string representation.
    #
    # @param value [Object] arbitrary object to coerce into text.
    # @return [String] trimmed string version of the supplied value.
    def sanitized_string(value)
      value.to_s.strip
    end

    # Retrieve the configured site name as a cleaned string.
    #
    # @return [String] trimmed configuration value.
    def sanitized_site_name
      sanitized_string(Config.site_name)
    end

    # Retrieve the configured announcement banner copy and normalise blank values to nil.
    #
    # @return [String, nil] announcement copy or +nil+ when blank.
    def sanitized_announcement
      value = sanitized_string(Config.announcement)
      value.empty? ? nil : value
    end

    # Retrieve the configured channel as a cleaned string.
    #
    # @return [String] trimmed configuration value.
    def sanitized_channel
      sanitized_string(Config.channel)
    end

    # Retrieve the configured frequency as a cleaned string.
    #
    # @return [String] trimmed configuration value.
    def sanitized_frequency
      sanitized_string(Config.frequency)
    end

    # Retrieve the configured contact link and normalise blank values to nil.
    #
    # @return [String, nil] contact link identifier or +nil+ when blank.
    def sanitized_contact_link
      value = sanitized_string(Config.contact_link)
      value.empty? ? nil : value
    end

    # Retrieve the best effort URL for the configured contact link.
    #
    # @return [String, nil] contact hyperlink when derivable.
    def sanitized_contact_link_url
      Config.contact_link_url
    end

    # Return a positive numeric maximum distance when configured.
    #
    # @return [Numeric, nil] distance value in kilometres.
    def sanitized_max_distance_km
      distance = Config.max_distance_km
      return nil unless distance.is_a?(Numeric)
      return nil unless distance.positive?

      distance
    end
  end
end
