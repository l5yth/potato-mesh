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

require_relative "config"
require_relative "sanitizer"

module PotatoMesh
  module Meta
    module_function

    def formatted_distance_km(distance)
      format("%.1f", distance).sub(/\.0\z/, "")
    end

    def description(private_mode:)
      site = Sanitizer.sanitized_site_name
      channel = Sanitizer.sanitized_default_channel
      frequency = Sanitizer.sanitized_default_frequency
      matrix = Sanitizer.sanitized_matrix_room

      summary = "Live Meshtastic mesh map for #{site}"
      if channel.empty? && frequency.empty?
        summary += "."
      elsif channel.empty?
        summary += " tuned to #{frequency}."
      elsif frequency.empty?
        summary += " on #{channel}."
      else
        summary += " on #{channel} (#{frequency})."
      end

      activity_sentence = if private_mode
          "Track nodes and coverage in real time."
        else
          "Track nodes, messages, and coverage in real time."
        end

      sentences = [summary, activity_sentence]
      if (distance = Sanitizer.sanitized_max_distance_km)
        sentences << "Shows nodes within roughly #{formatted_distance_km(distance)} km of the map center."
      end
      sentences << "Join the community in #{matrix} on Matrix." if matrix

      sentences.join(" ")
    end

    def configuration(private_mode:)
      site = Sanitizer.sanitized_site_name
      {
        title: site,
        name: site,
        description: description(private_mode: private_mode),
      }.freeze
    end
  end
end
