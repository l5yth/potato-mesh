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
    module DataProcessing
      # Look up the protocol registered by a given ingestor node.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param ingestor_node_id [String, nil] the node_id of the reporting ingestor.
      # @param cache [Hash, nil] optional per-request memoization hash; pass a shared
      #   Hash instance across a batch to avoid redundant DB lookups per record.
      # @return [String] protocol string; defaults to "meshtastic" when absent or unknown.
      def resolve_protocol(db, ingestor_node_id, cache: nil)
        return "meshtastic" if ingestor_node_id.nil? || ingestor_node_id.to_s.strip.empty?

        if cache
          return cache[ingestor_node_id] if cache.key?(ingestor_node_id)

          result = db.get_first_value(
            "SELECT protocol FROM ingestors WHERE node_id = ? LIMIT 1",
            [ingestor_node_id],
          ) || "meshtastic"
          cache[ingestor_node_id] = result
          return result
        end

        db.get_first_value(
          "SELECT protocol FROM ingestors WHERE node_id = ? LIMIT 1",
          [ingestor_node_id],
        ) || "meshtastic"
      end

      private :resolve_protocol
    end
  end
end
