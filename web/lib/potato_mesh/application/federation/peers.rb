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
      # announce itself to, and the roots of each crawl.  Seed domains take
      # precedence and are followed by the rows this instance verified
      # within the freshness window, by its own clock, longest-standing
      # first; at most {INSTANCE_ROW_LIMIT} domains in all, each in its
      # canonical form and none that federation refuses (SPEC FB2, FB4,
      # FB9, FB10).
      #
      # @param self_domain [String, nil] sanitized local instance domain.
      # @return [Array<String>] canonical, deduplicated peer domains.
      def federation_target_domains(self_domain)
        normalized_self = federation_canonical_domain(self_domain)
        ordered = []
        seen = Set.new
        take = lambda do |domain|
          candidate = federation_canonical_domain(domain)
          next if candidate.nil? || candidate == normalized_self || seen.include?(candidate)
          next if federation_domain_refusal(candidate)

          ordered << candidate
          seen << candidate
        end

        PotatoMesh::Config.federation_seed_domains.each(&take)

        db = open_database(readonly: true)
        db.results_as_hash = false
        now = Time.now.to_i
        # Our own row and the seeds' rows can come first: one row more than
        # the limit always leaves enough after them.
        rows = with_busy_retry do
          db.execute(
            "SELECT domain FROM instances WHERE domain IS NOT NULL AND TRIM(domain) != '' " \
            "AND #{FRESH_ROW_SQL} ORDER BY #{ROOT_ORDER_SQL} LIMIT ?",
            [now - PotatoMesh::Config.week_seconds, INSTANCE_ROW_LIMIT + 1],
          )
        end
        rows.each { |row| take.call(row[0]) }
        ordered.first(INSTANCE_ROW_LIMIT)
      rescue SQLite3::Exception
        # The seeds, taken before the database was read.
        ordered
      ensure
        db&.close
      end
    end
  end
end
