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
      # Set of protocol values recognised by the ingest pipeline.  Records may
      # carry an explicit protocol stamp via {#resolve_record_protocol}; values
      # outside this set are treated as malformed and fall back to the
      # ingestor-derived default.
      KNOWN_PROTOCOLS = %w[meshtastic meshcore].freeze

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

      # Normalise a candidate protocol value, returning the whitelisted string
      # form or +nil+ when the value is absent, malformed, or outside
      # {KNOWN_PROTOCOLS}.  Callers use the +nil+ return as a "fall back to
      # the next source" signal.
      #
      # @param value [Object] candidate protocol value.
      # @return [String, nil] canonical protocol string or +nil+ when invalid.
      def normalize_protocol_value(value)
        return nil unless value.respond_to?(:to_s)

        normalized = value.to_s.strip.downcase
        KNOWN_PROTOCOLS.include?(normalized) ? normalized : nil
      end

      # Resolve the protocol for a single inbound record, preferring an
      # explicit ``record["protocol"]`` stamp when it is one of the
      # whitelisted values.  Without an explicit stamp the helper falls back
      # to the existing ingestor-derived lookup (see {#resolve_protocol}).
      #
      # Closes the startup race where the web app processes a message/node
      # record before the corresponding ingestor heartbeat registers a
      # protocol mapping; without the per-record stamp the ingestor lookup
      # would return ``"meshtastic"`` for any unknown ingestor — which
      # silently misclassifies MeshCore traffic.  See ``CONTRACTS.md``.
      #
      # Emits a one-line +warn_log+ when the record carries a non-empty but
      # unrecognised value so a misbehaving custom protocol adapter is easy
      # to spot in the operator log instead of being silently coerced.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param record [Hash, nil] inbound JSON record (message, node, position, …).
      # @param ingestor_node_id [String, nil] reporting ingestor node id.
      # @param cache [Hash, nil] optional per-batch memoization hash forwarded
      #   to {#resolve_protocol}.
      # @return [String] one of {KNOWN_PROTOCOLS}; defaults via the ingestor
      #   lookup chain.
      def resolve_record_protocol(db, record, ingestor_node_id, cache: nil)
        raw = record.is_a?(Hash) ? record["protocol"] : nil
        if raw && !raw.to_s.strip.empty?
          explicit = normalize_protocol_value(raw)
          return explicit if explicit

          warn_log(
            "Rejected malformed protocol stamp; falling back to ingestor lookup",
            context: "data_processing.resolve_record_protocol",
            value: raw.to_s,
            ingestor: ingestor_node_id,
          )
        end

        resolve_protocol(db, ingestor_node_id, cache: cache)
      end

      private :resolve_protocol, :resolve_record_protocol, :normalize_protocol_value
    end
  end
end
