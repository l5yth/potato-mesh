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
      # Insert or update an ingestor heartbeat payload.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param payload [Hash] ingestor payload from the collector.
      # @return [Boolean] true when persistence succeeded.
      def upsert_ingestor(db, payload)
        return false unless payload.is_a?(Hash)

        parts = canonical_node_parts(payload["node_id"] || payload["id"])
        return false unless parts

        node_id, = parts
        now = Time.now.to_i

        start_time = coerce_integer(payload["start_time"] || payload["startTime"]) || now
        last_seen_time =
          coerce_integer(payload["last_seen_time"] || payload["lastSeenTime"]) || start_time

        start_time = 0 if start_time.negative?
        last_seen_time = 0 if last_seen_time.negative?
        start_time = now if start_time > now
        last_seen_time = now if last_seen_time > now
        last_seen_time = start_time if last_seen_time < start_time

        version = string_or_nil(payload["version"] || payload["ingestorVersion"])
        return false unless version
        lora_freq = coerce_integer(payload["lora_freq"])
        modem_preset = string_or_nil(payload["modem_preset"])
        protocol = string_or_nil(payload["protocol"]) || "meshtastic"

        with_busy_retry do
          db.execute <<~SQL, [node_id, start_time, last_seen_time, version, lora_freq, modem_preset, protocol]
                       INSERT INTO ingestors(node_id, start_time, last_seen_time, version, lora_freq, modem_preset, protocol)
                            VALUES(?,?,?,?,?,?,?)
                       ON CONFLICT(node_id) DO UPDATE SET
                         start_time = CASE
                           WHEN excluded.start_time > ingestors.start_time THEN excluded.start_time
                           ELSE ingestors.start_time
                         END,
                         last_seen_time = CASE
                           WHEN excluded.last_seen_time > ingestors.last_seen_time THEN excluded.last_seen_time
                           ELSE ingestors.last_seen_time
                         END,
                         version = COALESCE(excluded.version, ingestors.version),
                         lora_freq = COALESCE(excluded.lora_freq, ingestors.lora_freq),
                         modem_preset = COALESCE(excluded.modem_preset, ingestors.modem_preset),
                         protocol = excluded.protocol
                     SQL
        end

        true
      rescue SQLite3::SQLException => e
        warn_log(
          "Failed to upsert ingestor record",
          context: "data_processing.ingestors",
          node_id: node_id,
          error_class: e.class.name,
          error_message: e.message,
        )
        false
      end
    end
  end
end
