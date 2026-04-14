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
      # Fetch positions optionally scoped by node and timestamp.
      #
      # @param limit [Integer] maximum number of rows to return.
      # @param node_ref [String, Integer, nil] optional node reference to scope results.
      # @param since [Integer] unix timestamp threshold applied in addition to the rolling window.
      # @return [Array<Hash>] compacted position rows suitable for API responses.
      def query_positions(limit, node_ref: nil, since: 0, protocol: nil)
        limit = coerce_query_limit(limit)
        db = open_database(readonly: true)
        db.results_as_hash = true
        params = []
        where_clauses = []
        now = Time.now.to_i
        min_rx_time = now - PotatoMesh::Config.week_seconds
        since_floor = node_ref ? 0 : min_rx_time
        since_threshold = normalize_since_threshold(since, floor: since_floor)
        where_clauses << "COALESCE(rx_time, position_time, 0) >= ?"
        params << since_threshold

        if node_ref
          clause = node_lookup_clause(node_ref, string_columns: ["node_id"], numeric_columns: ["node_num"], db: db)
          return [] unless clause
          where_clauses << clause.first
          params.concat(clause.last)
        end

        append_protocol_filter(where_clauses, params, protocol)

        sql = <<~SQL
          SELECT * FROM positions
        SQL
        sql += "    WHERE #{where_clauses.join(" AND ")}\n" if where_clauses.any?
        sql += <<~SQL
          ORDER BY rx_time DESC
          LIMIT ?
        SQL
        params << limit
        rows = db.execute(sql, params)
        rows.each do |r|
          rx_time = coerce_integer(r["rx_time"])
          r["rx_time"] = rx_time if rx_time
          r["rx_iso"] = Time.at(rx_time).utc.iso8601 if rx_time && string_or_nil(r["rx_iso"]).nil?

          node_num = coerce_integer(r["node_num"])
          r["node_num"] = node_num if node_num

          position_time = coerce_integer(r["position_time"])
          position_time = nil if position_time && position_time > now
          r["position_time"] = position_time
          r["position_time_iso"] = Time.at(position_time).utc.iso8601 if position_time

          r["precision_bits"] = coerce_integer(r["precision_bits"])
          r["sats_in_view"] = coerce_integer(r["sats_in_view"])
          r["pdop"] = coerce_float(r["pdop"])
          r["snr"] = coerce_float(r["snr"])
        end
        rows.map { |row| compact_api_row(row) }
      ensure
        db&.close
      end

      # Fetch neighbor relationships optionally scoped by node and timestamp.
      #
      # @param limit [Integer] maximum number of rows to return.
      # @param node_ref [String, Integer, nil] optional node reference to scope results.
      # @param since [Integer] unix timestamp threshold applied in addition to the rolling window for collections.
      # @return [Array<Hash>] compacted neighbor rows suitable for API responses.
      def query_neighbors(limit, node_ref: nil, since: 0, protocol: nil)
        limit = coerce_query_limit(limit)
        db = open_database(readonly: true)
        db.results_as_hash = true
        params = []
        where_clauses = []
        now = Time.now.to_i
        min_rx_time = now - PotatoMesh::Config.week_seconds
        since_floor = node_ref ? 0 : min_rx_time
        since_threshold = normalize_since_threshold(since, floor: since_floor)
        where_clauses << "COALESCE(rx_time, 0) >= ?"
        params << since_threshold

        if node_ref
          clause = node_lookup_clause(node_ref, string_columns: ["node_id", "neighbor_id"])
          return [] unless clause
          where_clauses << clause.first
          params.concat(clause.last)
        end

        append_protocol_filter(where_clauses, params, protocol)

        sql = <<~SQL
          SELECT * FROM neighbors
        SQL
        sql += "    WHERE #{where_clauses.join(" AND ")}\n" if where_clauses.any?
        sql += <<~SQL
          ORDER BY rx_time DESC
          LIMIT ?
        SQL
        params << limit
        rows = db.execute(sql, params)
        rows.each do |r|
          rx_time = coerce_integer(r["rx_time"])
          rx_time = now if rx_time && rx_time > now
          r["rx_time"] = rx_time if rx_time
          r["rx_iso"] = Time.at(rx_time).utc.iso8601 if rx_time
          r["snr"] = coerce_float(r["snr"])
        end
        rows.map { |row| compact_api_row(row) }
      ensure
        db&.close
      end

      # Fetch trace records optionally scoped by node and timestamp.
      #
      # @param limit [Integer] maximum number of rows to return.
      # @param node_ref [String, Integer, nil] optional node reference to scope results.
      # @param since [Integer] unix timestamp threshold applied in addition to the rolling window.
      # @return [Array<Hash>] compacted trace rows suitable for API responses.
      def query_traces(limit, node_ref: nil, since: 0, protocol: nil)
        limit = coerce_query_limit(limit)
        db = open_database(readonly: true)
        db.results_as_hash = true
        params = []
        where_clauses = []
        now = Time.now.to_i
        min_rx_time = now - PotatoMesh::Config.trace_neighbor_window_seconds
        since_threshold = normalize_since_threshold(since, floor: min_rx_time)
        where_clauses << "COALESCE(rx_time, 0) >= ?"
        params << since_threshold

        if node_ref
          tokens = node_reference_tokens(node_ref)
          numeric_values = tokens[:numeric_values]
          if numeric_values.empty?
            return []
          end
          placeholders = Array.new(numeric_values.length, "?").join(", ")
          candidate_clauses = []
          candidate_clauses << "src IN (#{placeholders})"
          candidate_clauses << "dest IN (#{placeholders})"
          candidate_clauses << "id IN (SELECT trace_id FROM trace_hops WHERE node_id IN (#{placeholders}))"
          where_clauses << "(#{candidate_clauses.join(" OR ")})"
          3.times { params.concat(numeric_values) }
        end

        append_protocol_filter(where_clauses, params, protocol)

        sql = <<~SQL
          SELECT id, request_id, src, dest, rx_time, rx_iso, rssi, snr, elapsed_ms, protocol
          FROM traces
        SQL
        sql += "    WHERE #{where_clauses.join(" AND ")}\n" if where_clauses.any?
        sql += <<~SQL
          ORDER BY rx_time DESC
          LIMIT ?
        SQL
        params << limit
        rows = db.execute(sql, params)

        trace_ids = rows.map { |row| coerce_integer(row["id"]) }.compact
        hops_by_trace = Hash.new { |hash, key| hash[key] = [] }
        unless trace_ids.empty?
          placeholders = Array.new(trace_ids.length, "?").join(", ")
          hop_rows =
            db.execute(
              "SELECT trace_id, hop_index, node_id FROM trace_hops WHERE trace_id IN (#{placeholders}) ORDER BY trace_id, hop_index",
              trace_ids,
            )
          hop_rows.each do |hop|
            trace_id = coerce_integer(hop["trace_id"])
            node_id = coerce_integer(hop["node_id"])
            next unless trace_id && node_id

            hops_by_trace[trace_id] << node_id
          end
        end

        rows.each do |r|
          rx_time = coerce_integer(r["rx_time"])
          r["rx_time"] = rx_time if rx_time
          r["rx_iso"] = Time.at(rx_time).utc.iso8601 if rx_time && string_or_nil(r["rx_iso"]).nil?
          r["request_id"] = coerce_integer(r["request_id"])
          r["src"] = coerce_integer(r["src"])
          r["dest"] = coerce_integer(r["dest"])
          r["rssi"] = coerce_integer(r["rssi"])
          r["snr"] = coerce_float(r["snr"])
          r["elapsed_ms"] = coerce_integer(r["elapsed_ms"])

          trace_id = coerce_integer(r["id"])
          if trace_id && hops_by_trace.key?(trace_id)
            r["hops"] = hops_by_trace[trace_id]
          end
        end
        rows.map { |row| compact_api_row(row) }
      ensure
        db&.close
      end
    end
  end
end
