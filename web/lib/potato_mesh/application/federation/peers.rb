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
      # Build the ordered list of peer domains the local instance should
      # announce itself to.  Seed domains take precedence and are followed by
      # peers seen in the local +instances+ table within the freshness window.
      #
      # @param self_domain [String, nil] sanitized local instance domain.
      # @return [Array<String>] sanitized, deduplicated peer domains.
      def federation_target_domains(self_domain)
        normalized_self = sanitize_instance_domain(self_domain)&.downcase
        ordered = []
        seen = Set.new

        PotatoMesh::Config.federation_seed_domains.each do |seed|
          sanitized = sanitize_instance_domain(seed)&.downcase
          next unless sanitized
          next if normalized_self && sanitized == normalized_self
          next if seen.include?(sanitized)

          ordered << sanitized
          seen << sanitized
        end

        db = open_database(readonly: true)
        db.results_as_hash = false
        cutoff = Time.now.to_i - PotatoMesh::Config.week_seconds
        rows = with_busy_retry do
          db.execute(
            "SELECT domain, last_update_time FROM instances WHERE domain IS NOT NULL AND TRIM(domain) != ''",
          )
        end
        rows.each do |row|
          raw_domain = row[0]
          last_update_time = coerce_integer(row[1])
          next unless last_update_time && last_update_time >= cutoff

          sanitized = sanitize_instance_domain(raw_domain)&.downcase
          next unless sanitized
          next if normalized_self && sanitized == normalized_self
          next if seen.include?(sanitized)

          ordered << sanitized
          seen << sanitized
        end
        ordered
      rescue SQLite3::Exception
        fallback = PotatoMesh::Config.federation_seed_domains.filter_map do |seed|
          candidate = sanitize_instance_domain(seed)&.downcase
          next if normalized_self && candidate == normalized_self

          candidate
        end
        fallback.uniq
      ensure
        db&.close
      end
    end
  end
end
