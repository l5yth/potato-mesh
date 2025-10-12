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
  module Sanitizer
    module_function

    def string_or_nil(value)
      return nil if value.nil?

      str = value.is_a?(String) ? value : value.to_s
      trimmed = str.strip
      trimmed.empty? ? nil : trimmed
    end

    def sanitize_instance_domain(value)
      host = string_or_nil(value)
      return nil unless host

      trimmed = host.strip
      trimmed = trimmed.delete_suffix(".") while trimmed.end_with?(".")
      return nil if trimmed.empty?
      return nil if trimmed.match?(%r{[\s/\\@]})

      trimmed
    end

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

    def ip_from_domain(domain)
      host = instance_domain_host(domain)
      return nil unless host

      IPAddr.new(host)
    rescue IPAddr::InvalidAddressError
      nil
    end

    def sanitized_string(value)
      value.to_s.strip
    end

    def sanitized_site_name
      sanitized_string(Config.site_name)
    end

    def sanitized_default_channel
      sanitized_string(Config.default_channel)
    end

    def sanitized_default_frequency
      sanitized_string(Config.default_frequency)
    end

    def sanitized_matrix_room
      value = sanitized_string(Config.matrix_room)
      value.empty? ? nil : value
    end

    def sanitized_max_distance_km
      distance = Config.max_node_distance_km
      return nil unless distance.is_a?(Numeric)
      return nil unless distance.positive?

      distance
    end
  end
end
