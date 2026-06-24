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
      # @param before [Integer, nil] inclusive upper-bound +rx_time+ cursor for
      #   backward pagination (SPEC BP1); rows newer than this are excluded.
      # @return [Array<Hash>] compacted position rows suitable for API responses.
      def query_positions(limit, node_ref: nil, since: 0, before: nil, protocol: nil)
        limit = coerce_query_limit(limit)
        db = open_database(readonly: true)
        db.results_as_hash = true
        params = []
        where_clauses = []
        now = Time.now.to_i
        # Bulk positions follow the seven-day default; per-id lookups widen
        # to twenty-eight days for backfill of historical track data.
        since_floor = node_ref ? now - PotatoMesh::Config.four_weeks_seconds : now - PotatoMesh::Config.week_seconds
        since_threshold = normalize_since_threshold(since, floor: since_floor)
        where_clauses << "COALESCE(rx_time, position_time, 0) >= ?"
        params << since_threshold

        if node_ref
          clause = node_lookup_clause(node_ref, string_columns: ["node_id"], numeric_columns: ["node_num"], db: db)
          return [] unless clause
          where_clauses << clause.first
          params.concat(clause.last)
        end

        # Inclusive upper-bound cursor for backward pagination (SPEC BP1);
        # bounds the +rx_time+ sort column.
        append_before_filter(where_clauses, params, before, column: "rx_time")

        append_opt_out_filter(where_clauses, params, opt_out_node_id_filter("node_id"))
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

          position_time = coerce_positive_or_nil(r["position_time"], ceiling: now)
          r["position_time"] = position_time
          # I2: only position_time (unix int) is emitted; no ISO twin.

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
      # @param before [Integer, nil] inclusive upper-bound +rx_time+ cursor for
      #   backward pagination (SPEC BP1); rows newer than this are excluded.
      # @return [Array<Hash>] compacted neighbor rows suitable for API responses.
      def query_neighbors(limit, node_ref: nil, since: 0, before: nil, protocol: nil)
        limit = coerce_query_limit(limit)
        db = open_database(readonly: true)
        db.results_as_hash = true
        params = []
        where_clauses = []
        now = Time.now.to_i
        # Neighbor relationships are reported sporadically and are easy to
        # lose between scrapes, so use the twenty-eight-day extended window
        # for both bulk and per-id queries.
        min_rx_time = now - PotatoMesh::Config.four_weeks_seconds
        since_threshold = normalize_since_threshold(since, floor: min_rx_time)
        where_clauses << "COALESCE(rx_time, 0) >= ?"
        params << since_threshold

        if node_ref
          clause = node_lookup_clause(node_ref, string_columns: ["node_id", "neighbor_id"])
          return [] unless clause
          where_clauses << clause.first
          params.concat(clause.last)
        end

        # Either endpoint of the neighbour relationship may carry the
        # opt-out marker — filter both so a silenced node never appears as
        # a source or destination of an RF link.
        # Inclusive upper-bound cursor for backward pagination (SPEC BP1);
        # bounds the +rx_time+ sort column.
        append_before_filter(where_clauses, params, before, column: "rx_time")

        append_opt_out_filter(where_clauses, params, opt_out_node_id_filter("node_id"))
        append_opt_out_filter(where_clauses, params, opt_out_node_id_filter("neighbor_id"))
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
      # @param before [Integer, nil] inclusive upper-bound +rx_time+ cursor for
      #   backward pagination (SPEC BP1); rows newer than this are excluded.
      # @return [Array<Hash>] compacted trace rows suitable for API responses.
      def query_traces(limit, node_ref: nil, since: 0, before: nil, protocol: nil)
        limit = coerce_query_limit(limit)
        db = open_database(readonly: true)
        db.results_as_hash = true
        params = []
        where_clauses = []
        now = Time.now.to_i
        min_rx_time = now - PotatoMesh::Config.four_weeks_seconds
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

        # Drop traces whose endpoints carry the opt-out marker.  Hops are
        # filtered separately at hydration time so a trace that only relays
        # through a silenced node still surfaces with the offending hop
        # removed.
        # Inclusive upper-bound cursor for backward pagination (SPEC BP1);
        # bounds the +rx_time+ sort column.
        append_before_filter(where_clauses, params, before, column: "rx_time")

        append_opt_out_filter(where_clauses, params, opt_out_node_num_filter("src"))
        append_opt_out_filter(where_clauses, params, opt_out_node_num_filter("dest"))
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
          # Hide opted-out intermediate hops too — otherwise a single trace
          # could expose a silenced node's numeric ID via the relay chain.
          hop_filter = opt_out_node_num_filter("th.node_id")
          hop_rows =
            db.execute(
              "SELECT th.trace_id, th.hop_index, th.node_id FROM trace_hops th " \
              "WHERE th.trace_id IN (#{placeholders}) AND #{hop_filter} " \
              "ORDER BY th.trace_id, th.hop_index",
              trace_ids + opt_out_marker_params,
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
