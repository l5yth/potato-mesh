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
      def node_reference_tokens(node_ref)
        parts = canonical_node_parts(node_ref)
        canonical_id, numeric_id = parts ? parts[0, 2] : [nil, nil]

        string_values = []
        numeric_values = []

        case node_ref
        when Integer
          numeric_values << node_ref
          string_values << node_ref.to_s
        when Numeric
          coerced = node_ref.to_i
          numeric_values << coerced
          string_values << coerced.to_s
        when String
          trimmed = node_ref.strip
          unless trimmed.empty?
            string_values << trimmed
            numeric_values << trimmed.to_i if trimmed.match?(/\A-?\d+\z/)
          end
        when nil
          # no-op
        else
          coerced = node_ref.to_s.strip
          string_values << coerced unless coerced.empty?
        end

        if canonical_id
          string_values << canonical_id
          string_values << canonical_id.upcase
        end

        if numeric_id
          numeric_values << numeric_id
          string_values << numeric_id.to_s
        end

        cleaned_strings = string_values.compact.map(&:to_s).map(&:strip).reject(&:empty?).uniq
        cleaned_numbers = numeric_values.compact.map do |value|
          begin
            value.is_a?(String) ? Integer(value, 10) : Integer(value)
          rescue ArgumentError, TypeError
            nil
          end
        end.compact.uniq

        {
          string_values: cleaned_strings,
          numeric_values: cleaned_numbers,
        }
      end

      def node_lookup_clause(node_ref, string_columns:, numeric_columns: [])
        tokens = node_reference_tokens(node_ref)
        string_values = tokens[:string_values]
        numeric_values = tokens[:numeric_values]

        clauses = []
        params = []

        unless string_columns.empty? || string_values.empty?
          string_columns.each do |column|
            placeholders = Array.new(string_values.length, "?").join(", ")
            clauses << "#{column} IN (#{placeholders})"
            params.concat(string_values)
          end
        end

        unless numeric_columns.empty? || numeric_values.empty?
          numeric_columns.each do |column|
            placeholders = Array.new(numeric_values.length, "?").join(", ")
            clauses << "#{column} IN (#{placeholders})"
            params.concat(numeric_values)
          end
        end

        return nil if clauses.empty?

        ["(#{clauses.join(" OR ")})", params]
      end

      # Fetch node state optionally scoped by identifier and timestamp.
      #
      # @param limit [Integer] maximum number of rows to return.
      # @param node_ref [String, Integer, nil] optional node reference to narrow results.
      # @param since [Integer] unix timestamp threshold applied in addition to the rolling window for collections.
      # @return [Array<Hash>] compacted node rows suitable for API responses.
      def query_nodes(limit, node_ref: nil, since: 0, protocol: nil)
        limit = coerce_query_limit(limit)
        db = open_database(readonly: true)
        db.results_as_hash = true
        now = Time.now.to_i
        min_last_heard = now - PotatoMesh::Config.week_seconds
        since_floor = node_ref ? 0 : min_last_heard
        since_threshold = normalize_since_threshold(since, floor: since_floor)
        params = []
        where_clauses = []

        if node_ref
          clause = node_lookup_clause(node_ref, string_columns: ["node_id"], numeric_columns: ["num"])
          return [] unless clause
          where_clauses << clause.first
          params.concat(clause.last)
        else
          where_clauses << "last_heard >= ?"
          params << since_threshold
        end

        if private_mode?
          where_clauses << "(role IS NULL OR role <> 'CLIENT_HIDDEN')"
        end

        append_protocol_filter(where_clauses, params, protocol)

        sql = <<~SQL
          SELECT node_id, short_name, long_name, hw_model, role, snr,
                 battery_level, voltage, last_heard, first_heard,
                 uptime_seconds, channel_utilization, air_util_tx,
                 position_time, location_source, precision_bits,
                 latitude, longitude, altitude, lora_freq, modem_preset, protocol
          FROM nodes
        SQL
        sql += "    WHERE #{where_clauses.join(" AND ")}\n" if where_clauses.any?
        sql += <<~SQL
          ORDER BY last_heard DESC
          LIMIT ?
        SQL
        params << limit

        rows = db.execute(sql, params)
        rows = rows.select do |r|
          last_candidate = [r["last_heard"], r["position_time"], r["first_heard"]]
            .map { |value| coerce_integer(value) }
            .compact
            .max
          last_candidate && last_candidate >= since_threshold
        end
        rows.each do |r|
          r["role"] ||= "CLIENT"
          lh = r["last_heard"]&.to_i
          pt = r["position_time"]&.to_i
          lh = now if lh && lh > now
          pt = nil if pt && pt > now
          r["last_heard"] = lh
          r["position_time"] = pt
          r["last_seen_iso"] = Time.at(lh).utc.iso8601 if lh
          r["pos_time_iso"] = Time.at(pt).utc.iso8601 if pt
          pb = r["precision_bits"]
          r["precision_bits"] = pb.to_i if pb
        end
        rows.map { |row| compact_api_row(row) }
      ensure
        db&.close
      end

      # Fetch ingestor heartbeats with optional freshness filtering.
      #
      # @param limit [Integer] maximum number of ingestors to return.
      # @param since [Integer] unix timestamp threshold applied in addition to the rolling window for collections.
      # @return [Array<Hash>] compacted ingestor rows suitable for API responses.
      def query_ingestors(limit, since: 0, protocol: nil)
        limit = coerce_query_limit(limit)
        db = open_database(readonly: true)
        db.results_as_hash = true
        now = Time.now.to_i
        cutoff = now - PotatoMesh::Config.week_seconds
        since_threshold = normalize_since_threshold(since, floor: cutoff)
        where_clauses = ["last_seen_time >= ?"]
        params = [since_threshold]
        append_protocol_filter(where_clauses, params, protocol)
        sql = <<~SQL
          SELECT node_id, start_time, last_seen_time, version, lora_freq, modem_preset, protocol
          FROM ingestors
          WHERE #{where_clauses.join(" AND ")}
          ORDER BY last_seen_time DESC
          LIMIT ?
        SQL
        params << limit

        rows = db.execute(sql, params)
        rows.each do |row|
          row.delete_if { |key, _| key.is_a?(Integer) }
          start_time = coerce_integer(row["start_time"])
          last_seen_time = coerce_integer(row["last_seen_time"])
          start_time = now if start_time && start_time > now
          last_seen_time = now if last_seen_time && last_seen_time > now
          if start_time && last_seen_time && last_seen_time < start_time
            last_seen_time = start_time
          end
          row["start_time"] = start_time
          row["last_seen_time"] = last_seen_time
          row["start_time_iso"] = Time.at(start_time).utc.iso8601 if start_time
          row["last_seen_iso"] = Time.at(last_seen_time).utc.iso8601 if last_seen_time
        end

        rows.map { |row| compact_api_row(row) }
      ensure
        db&.close
      end

      # Return exact active-node counts across common activity windows.
      #
      # Counts are resolved directly in SQL with COUNT(*) thresholds against
      # +nodes.last_heard+ to avoid sampling bias from list endpoint limits.
      #
      # @param now [Integer] reference unix timestamp in seconds.
      # @param db [SQLite3::Database, nil] optional open database handle to reuse.
      # @return [Hash{String => Integer}] counts keyed by hour/day/week/month.
      def query_active_node_stats(now: Time.now.to_i, db: nil)
        handle = db || open_database(readonly: true)
        handle.results_as_hash = true
        reference_now = coerce_integer(now) || Time.now.to_i
        hour_cutoff = reference_now - 3600
        day_cutoff = reference_now - 86_400
        week_cutoff = reference_now - PotatoMesh::Config.week_seconds
        month_cutoff = reference_now - (30 * 24 * 60 * 60)
        private_filter = private_mode? ? " AND (role IS NULL OR role <> 'CLIENT_HIDDEN')" : ""
        sql = <<~SQL
          SELECT
            (SELECT COUNT(*) FROM nodes WHERE last_heard >= ?#{private_filter}) AS hour_count,
            (SELECT COUNT(*) FROM nodes WHERE last_heard >= ?#{private_filter}) AS day_count,
            (SELECT COUNT(*) FROM nodes WHERE last_heard >= ?#{private_filter}) AS week_count,
            (SELECT COUNT(*) FROM nodes WHERE last_heard >= ?#{private_filter}) AS month_count
        SQL
        row = with_busy_retry do
          handle.get_first_row(sql, [hour_cutoff, day_cutoff, week_cutoff, month_cutoff])
        end || {}
        {
          "hour" => row["hour_count"].to_i,
          "day" => row["day_count"].to_i,
          "week" => row["week_count"].to_i,
          "month" => row["month_count"].to_i,
        }
      ensure
        handle&.close unless db
      end
    end
  end
end
