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
    module Queries
      # Fetch chat messages with optional filtering.
      #
      # @param limit [Integer] maximum number of rows to return.
      # @param node_ref [String, Integer, nil] optional node reference to scope results.
      # @param include_encrypted [Boolean] when true, include encrypted payloads in the response.
      # @param since [Integer] unix timestamp threshold; messages with rx_time older than this are excluded.
      # @return [Array<Hash>] compacted message rows safe for API responses.
      def query_messages(limit, node_ref: nil, include_encrypted: false, since: 0, protocol: nil)
        limit = coerce_query_limit(limit)
        since_threshold = normalize_since_threshold(since, floor: 0)
        db = open_database(readonly: true)
        db.results_as_hash = true
        params = []
        where_clauses = [
          "(COALESCE(TRIM(m.text), '') != '' OR COALESCE(TRIM(m.encrypted), '') != '' OR m.reply_id IS NOT NULL OR COALESCE(TRIM(m.emoji), '') != '')",
        ]
        include_encrypted = !!include_encrypted
        where_clauses << "m.rx_time >= ?"
        params << since_threshold

        unless include_encrypted
          where_clauses << "COALESCE(TRIM(m.encrypted), '') = ''"
        end

        if node_ref
          clause = node_lookup_clause(node_ref, string_columns: ["m.from_id", "m.to_id"])
          return [] unless clause
          where_clauses << clause.first
          params.concat(clause.last)
        end

        append_protocol_filter(where_clauses, params, protocol, table_alias: "m")

        sql = <<~SQL
          SELECT m.id, m.rx_time, m.rx_iso, m.from_id, m.to_id, m.channel,
                 m.portnum, m.text, m.encrypted, m.rssi, m.hop_limit,
                 m.lora_freq, m.modem_preset, m.channel_name, m.snr,
                 m.reply_id, m.emoji, m.ingestor, m.protocol
          FROM messages m
        SQL
        sql += "    WHERE #{where_clauses.join(" AND ")}\n"
        sql += <<~SQL
          ORDER BY m.rx_time DESC
          LIMIT ?
        SQL
        params << limit
        rows = db.execute(sql, params)

        # Batch-resolve all unique from_id values to canonical node_ids in a
        # single query instead of issuing 1-2 SELECTs per message row.
        raw_from_ids = rows.filter_map { |r| string_or_nil(r["from_id"]&.to_s&.strip) }.uniq
        canonical_map = batch_resolve_node_ids(db, raw_from_ids)

        rows.each do |r|
          r.delete_if { |key, _| key.is_a?(Integer) }
          r["reply_id"] = coerce_integer(r["reply_id"]) if r.key?("reply_id")
          r["emoji"] = string_or_nil(r["emoji"]) if r.key?("emoji")
          if string_or_nil(r["encrypted"])
            r.delete("portnum")
          end
          if PotatoMesh::Config.debug? && (r["from_id"].nil? || r["from_id"].to_s.strip.empty?)
            raw = db.execute("SELECT * FROM messages WHERE id = ?", [r["id"]]).first
            debug_log(
              "Message query produced empty sender",
              context: "queries.messages",
              stage: "raw_row",
              row: raw,
            )
          end

          canonical_from_id = canonical_map[r["from_id"]&.to_s&.strip]
          node_id = canonical_from_id || string_or_nil(r["from_id"])

          if canonical_from_id
            raw_from_id = string_or_nil(r["from_id"])
            if raw_from_id.nil? || raw_from_id.match?(/\A[0-9]+\z/)
              r["from_id"] = canonical_from_id
            elsif raw_from_id.start_with?("!") && raw_from_id.casecmp(canonical_from_id) != 0
              r["from_id"] = canonical_from_id
            end
          end

          r["node_id"] = node_id if node_id

          if PotatoMesh::Config.debug? && (r["from_id"].nil? || r["from_id"].to_s.strip.empty?)
            debug_log(
              "Message query produced empty sender",
              context: "queries.messages",
              stage: "after_normalization",
              row: r,
            )
          end
        end
        rows.map { |row| compact_api_row(row) }
      ensure
        db&.close
      end
    end
  end
end
