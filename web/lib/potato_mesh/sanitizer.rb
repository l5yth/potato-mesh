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
    # rules. This rejects whitespace, path separators, and trailing dots.
    #
    # @param value [String, Object, nil] candidate domain name.
    # @return [String, nil] canonical domain value or +nil+ when invalid.
    def sanitize_instance_domain(value)
      host = string_or_nil(value)
      return nil unless host

      trimmed = host.strip
      trimmed = trimmed.delete_suffix(".") while trimmed.end_with?(".")
      return nil if trimmed.empty?
      return nil if trimmed.match?(%r{[\s/\\@]})

      trimmed
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

    # Retrieve the configured default channel as a cleaned string.
    #
    # @return [String] trimmed configuration value.
    def sanitized_channel
      sanitized_string(Config.channel)
    end

    # Retrieve the configured default frequency as a cleaned string.
    #
    # @return [String] trimmed configuration value.
    def sanitized_frequency
      sanitized_string(Config.frequency)
    end

    # Retrieve the configured contact link and normalise blank values to nil.
    #
    # @return [String, nil] contact link or +nil+ when blank.
    def sanitized_contact_link
      value = sanitized_string(Config.contact_link)
      value.empty? ? nil : value
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
