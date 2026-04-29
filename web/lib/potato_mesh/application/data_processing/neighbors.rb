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
      # Persist a neighbours snapshot for a single reporting node.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param payload [Hash] inbound NeighborInfo payload.
      # @param protocol_cache [Hash, nil] optional per-batch ingestor protocol cache.
      # @return [void]
      def insert_neighbors(db, payload, protocol_cache: nil)
        return unless payload.is_a?(Hash)

        now = Time.now.to_i
        rx_time = coerce_integer(payload["rx_time"])
        rx_time = now if rx_time.nil? || rx_time > now

        raw_node_id = payload["node_id"] || payload["node"] || payload["from_id"]
        raw_node_num = coerce_integer(payload["node_num"]) || coerce_integer(payload["num"])

        canonical_parts = canonical_node_parts(raw_node_id, raw_node_num)
        if canonical_parts
          node_id, node_num, = canonical_parts
        else
          node_id = string_or_nil(raw_node_id)
          canonical = normalize_node_id(db, node_id || raw_node_num)
          node_id = canonical if canonical
          if node_id&.start_with?("!") && raw_node_num.nil?
            begin
              node_num = Integer(node_id.delete_prefix("!"), 16)
            rescue ArgumentError
              node_num = nil
            end
          else
            node_num = raw_node_num
          end
        end

        return unless node_id

        node_id = "!#{node_id.delete_prefix("!").downcase}" if node_id.start_with?("!")

        ingestor = string_or_nil(payload["ingestor"])
        protocol = resolve_protocol(db, ingestor, cache: protocol_cache)

        ensure_unknown_node(db, node_id || node_num, node_num, heard_time: rx_time, protocol: protocol)
        touch_node_last_seen(db, node_id || node_num, node_num, rx_time: rx_time, source: :neighborinfo)

        neighbor_entries = []
        neighbors_payload = payload["neighbors"]
        neighbors_list = neighbors_payload.is_a?(Array) ? neighbors_payload : []

        neighbors_list.each do |neighbor|
          next unless neighbor.is_a?(Hash)

          neighbor_ref = neighbor["neighbor_id"] || neighbor["node_id"] || neighbor["nodeId"] || neighbor["id"]
          neighbor_num = coerce_integer(
            neighbor["neighbor_num"] || neighbor["node_num"] || neighbor["nodeId"] || neighbor["id"],
          )

          canonical_neighbor = canonical_node_parts(neighbor_ref, neighbor_num)
          if canonical_neighbor
            neighbor_id, neighbor_num, = canonical_neighbor
          else
            neighbor_id = string_or_nil(neighbor_ref)
            canonical_neighbor_id = normalize_node_id(db, neighbor_id || neighbor_num)
            neighbor_id = canonical_neighbor_id if canonical_neighbor_id
            if neighbor_id&.start_with?("!") && neighbor_num.nil?
              begin
                neighbor_num = Integer(neighbor_id.delete_prefix("!"), 16)
              rescue ArgumentError
                neighbor_num = nil
              end
            end
          end

          next unless neighbor_id

          neighbor_id = "!#{neighbor_id.delete_prefix("!").downcase}" if neighbor_id.start_with?("!")

          entry_rx_time = coerce_integer(neighbor["rx_time"]) || rx_time
          entry_rx_time = now if entry_rx_time && entry_rx_time > now
          snr = coerce_float(neighbor["snr"])

          ensure_unknown_node(db, neighbor_id || neighbor_num, neighbor_num, heard_time: entry_rx_time, protocol: protocol)

          neighbor_entries << [neighbor_id, snr, entry_rx_time, ingestor, protocol]
        end

        with_busy_retry do
          db.transaction do
            if neighbor_entries.empty?
              db.execute("DELETE FROM neighbors WHERE node_id = ?", [node_id])
            else
              expected_neighbors = neighbor_entries.map(&:first).uniq
              existing_neighbors = db.execute(
                "SELECT neighbor_id FROM neighbors WHERE node_id = ?",
                [node_id],
              ).flatten
              stale_neighbors = existing_neighbors - expected_neighbors
              stale_neighbors.each_slice(500) do |slice|
                placeholders = slice.map { "?" }.join(",")
                db.execute(
                  "DELETE FROM neighbors WHERE node_id = ? AND neighbor_id IN (#{placeholders})",
                  [node_id] + slice,
                )
              end
            end

            neighbor_entries.each do |neighbor_id, snr_value, heard_time, reporter_id, proto|
              db.execute(
                <<~SQL,
                INSERT INTO neighbors(node_id, neighbor_id, snr, rx_time, ingestor, protocol)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(node_id, neighbor_id) DO UPDATE SET
                  snr = excluded.snr,
                  rx_time = excluded.rx_time,
                  ingestor = COALESCE(NULLIF(neighbors.ingestor,''), excluded.ingestor),
                  protocol = COALESCE(NULLIF(neighbors.protocol,'meshtastic'), excluded.protocol)
              SQL
                [node_id, neighbor_id, snr_value, heard_time, reporter_id, proto],
              )
            end
          end
        end
      end
    end
  end
end
