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
      MAX_QUERY_LIMIT = 1000
      DEFAULT_TELEMETRY_WINDOW_SECONDS = 86_400
      DEFAULT_TELEMETRY_BUCKET_SECONDS = 300
      TELEMETRY_ZERO_INVALID_COLUMNS = %w[battery_level voltage].freeze
      TELEMETRY_AGGREGATE_COLUMNS =
        %w[
          battery_level
          voltage
          channel_utilization
          air_util_tx
          temperature
          relative_humidity
          barometric_pressure
          gas_resistance
          current
          iaq
          distance
          lux
          white_lux
          ir_lux
          uv_lux
          wind_direction
          wind_speed
          wind_gust
          wind_lull
          weight
          radiation
          rainfall_1h
          rainfall_24h
          soil_moisture
          soil_temperature
        ].freeze
      TELEMETRY_AGGREGATE_SCALERS = {
        "current" => 0.001,
      }.freeze

      # Remove nil or empty values from an API response hash to reduce payload size
      # while preserving legitimate zero-valued measurements.
      # Integer keys emitted by SQLite are ignored because the JSON representation
      # only exposes symbolic keys. Strings containing only whitespace are treated
      # as empty to mirror sanitisation elsewhere in the application, and any other
      # objects responding to `empty?` are dropped when they contain no data.
      #
      # @param row [Hash] raw database row to compact.
      # @return [Hash] cleaned hash without blank values.
      def compact_api_row(row)
        return {} unless row.is_a?(Hash)

        row.each_with_object({}) do |(key, value), acc|
          next if key.is_a?(Integer)
          next if value.nil?

          if value.is_a?(String)
            trimmed = value.strip
            next if trimmed.empty?
            acc[key] = value
            next
          end

          next if value.respond_to?(:empty?) && value.empty?

          acc[key] = value
        end
      end

      # Treat zero-valued telemetry measurements that are known to be invalid
      # (such as battery level or voltage) as missing data so they are omitted
      # from API responses. Metrics that can legitimately be zero will remain
      # untouched when routed through this helper.
      #
      # @param value [Numeric, nil] telemetry measurement.
      # @return [Numeric, nil] nil when the value is zero, otherwise the original value.
      def nil_if_zero(value)
        return nil if value.respond_to?(:zero?) && value.zero?

        value
      end

      # Normalise a caller-provided limit to a sane, positive integer.
      #
      # @param limit [Object] value coerced to an integer.
      # @param default [Integer] fallback used when coercion fails.
      # @return [Integer] limit clamped between 1 and MAX_QUERY_LIMIT.
      def coerce_query_limit(limit, default: 200)
        coerced = begin
            if limit.is_a?(Integer)
              limit
            else
              Integer(limit, 10)
            end
          rescue ArgumentError, TypeError
            nil
          end

        coerced = default if coerced.nil? || coerced <= 0
        coerced = MAX_QUERY_LIMIT if coerced > MAX_QUERY_LIMIT
        coerced
      end

      # Normalise a caller-supplied timestamp for API pagination windows.
      #
      # @param since [Object] requested lower bound expressed as seconds since the epoch.
      # @param floor [Integer] minimum allowable timestamp used to clamp the value.
      # @return [Integer] non-negative timestamp greater than or equal to +floor+.
      def normalize_since_threshold(since, floor: 0)
        threshold = coerce_integer(since)
        threshold = 0 if threshold.nil? || threshold.negative?
        [threshold, floor].max
      end

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
      def query_nodes(limit, node_ref: nil, since: 0)
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

        sql = <<~SQL
          SELECT node_id, short_name, long_name, hw_model, role, snr,
                 battery_level, voltage, last_heard, first_heard,
                 uptime_seconds, channel_utilization, air_util_tx,
                 position_time, location_source, precision_bits,
                 latitude, longitude, altitude, lora_freq, modem_preset
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
      def query_ingestors(limit, since: 0)
        limit = coerce_query_limit(limit)
        db = open_database(readonly: true)
        db.results_as_hash = true
        now = Time.now.to_i
        cutoff = now - PotatoMesh::Config.week_seconds
        since_threshold = normalize_since_threshold(since, floor: cutoff)
        sql = <<~SQL
          SELECT node_id, start_time, last_seen_time, version, lora_freq, modem_preset
          FROM ingestors
          WHERE last_seen_time >= ?
          ORDER BY last_seen_time DESC
          LIMIT ?
        SQL

        rows = db.execute(sql, [since_threshold, limit])
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

      # Fetch chat messages with optional filtering.
      #
      # @param limit [Integer] maximum number of rows to return.
      # @param node_ref [String, Integer, nil] optional node reference to scope results.
      # @param include_encrypted [Boolean] when true, include encrypted payloads in the response.
      # @param since [Integer] unix timestamp threshold; messages with rx_time older than this are excluded.
      # @return [Array<Hash>] compacted message rows safe for API responses.
      def query_messages(limit, node_ref: nil, include_encrypted: false, since: 0)
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

        sql = <<~SQL
          SELECT m.id, m.rx_time, m.rx_iso, m.from_id, m.to_id, m.channel,
                 m.portnum, m.text, m.encrypted, m.rssi, m.hop_limit,
                 m.lora_freq, m.modem_preset, m.channel_name, m.snr,
                 m.reply_id, m.emoji
          FROM messages m
        SQL
        sql += "    WHERE #{where_clauses.join(" AND ")}\n"
        sql += <<~SQL
          ORDER BY m.rx_time DESC
          LIMIT ?
        SQL
        params << limit
        rows = db.execute(sql, params)
        rows.each do |r|
          r.delete_if { |key, _| key.is_a?(Integer) }
          r["reply_id"] = coerce_integer(r["reply_id"]) if r.key?("reply_id")
          r["emoji"] = string_or_nil(r["emoji"]) if r.key?("emoji")
          if PotatoMesh::Config.debug? && (r["from_id"].nil? || r["from_id"].to_s.strip.empty?)
            raw = db.execute("SELECT * FROM messages WHERE id = ?", [r["id"]]).first
            debug_log(
              "Message query produced empty sender",
              context: "queries.messages",
              stage: "raw_row",
              row: raw,
            )
          end

          canonical_from_id = string_or_nil(normalize_node_id(db, r["from_id"]))
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

      # Fetch positions optionally scoped by node and timestamp.
      #
      # @param limit [Integer] maximum number of rows to return.
      # @param node_ref [String, Integer, nil] optional node reference to scope results.
      # @param since [Integer] unix timestamp threshold applied in addition to the rolling window.
      # @return [Array<Hash>] compacted position rows suitable for API responses.
      def query_positions(limit, node_ref: nil, since: 0)
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
          clause = node_lookup_clause(node_ref, string_columns: ["node_id"], numeric_columns: ["node_num"])
          return [] unless clause
          where_clauses << clause.first
          params.concat(clause.last)
        end

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
      def query_neighbors(limit, node_ref: nil, since: 0)
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

      # Fetch telemetry packets optionally scoped by node and timestamp.
      #
      # @param limit [Integer] maximum number of rows to return.
      # @param node_ref [String, Integer, nil] optional node reference to scope results.
      # @param since [Integer] unix timestamp threshold applied in addition to the rolling window for collections.
      # @return [Array<Hash>] compacted telemetry rows suitable for API responses.
      def query_telemetry(limit, node_ref: nil, since: 0)
        limit = coerce_query_limit(limit)
        db = open_database(readonly: true)
        db.results_as_hash = true
        params = []
        where_clauses = []
        now = Time.now.to_i
        min_rx_time = now - PotatoMesh::Config.week_seconds
        since_floor = node_ref ? 0 : min_rx_time
        since_threshold = normalize_since_threshold(since, floor: since_floor)
        where_clauses << "COALESCE(rx_time, telemetry_time, 0) >= ?"
        params << since_threshold

        if node_ref
          clause = node_lookup_clause(node_ref, string_columns: ["node_id"], numeric_columns: ["node_num"])
          return [] unless clause
          where_clauses << clause.first
          params.concat(clause.last)
        end

        sql = <<~SQL
          SELECT * FROM telemetry
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

          telemetry_time = coerce_integer(r["telemetry_time"])
          telemetry_time = nil if telemetry_time && telemetry_time > now
          r["telemetry_time"] = telemetry_time
          r["telemetry_time_iso"] = Time.at(telemetry_time).utc.iso8601 if telemetry_time

          r["channel"] = coerce_integer(r["channel"])
          r["hop_limit"] = coerce_integer(r["hop_limit"])
          r["rssi"] = coerce_integer(r["rssi"])
          r["bitfield"] = coerce_integer(r["bitfield"])
          r["snr"] = coerce_float(r["snr"])
          r["battery_level"] = sanitize_zero_invalid_metric("battery_level", coerce_float(r["battery_level"]))
          r["voltage"] = sanitize_zero_invalid_metric("voltage", coerce_float(r["voltage"]))
          r["channel_utilization"] = coerce_float(r["channel_utilization"])
          r["air_util_tx"] = coerce_float(r["air_util_tx"])
          r["uptime_seconds"] = coerce_integer(r["uptime_seconds"])
          r["temperature"] = coerce_float(r["temperature"])
          r["relative_humidity"] = coerce_float(r["relative_humidity"])
          r["barometric_pressure"] = coerce_float(r["barometric_pressure"])
          r["gas_resistance"] = coerce_float(r["gas_resistance"])
          current_ma = coerce_float(r["current"])
          r["current"] = current_ma.nil? ? nil : current_ma / 1000.0
          r["iaq"] = coerce_integer(r["iaq"])
          r["distance"] = coerce_float(r["distance"])
          r["lux"] = coerce_float(r["lux"])
          r["white_lux"] = coerce_float(r["white_lux"])
          r["ir_lux"] = coerce_float(r["ir_lux"])
          r["uv_lux"] = coerce_float(r["uv_lux"])
          r["wind_direction"] = coerce_integer(r["wind_direction"])
          r["wind_speed"] = coerce_float(r["wind_speed"])
          r["weight"] = coerce_float(r["weight"])
          r["wind_gust"] = coerce_float(r["wind_gust"])
          r["wind_lull"] = coerce_float(r["wind_lull"])
          r["radiation"] = coerce_float(r["radiation"])
          r["rainfall_1h"] = coerce_float(r["rainfall_1h"])
          r["rainfall_24h"] = coerce_float(r["rainfall_24h"])
          r["soil_moisture"] = coerce_integer(r["soil_moisture"])
          r["soil_temperature"] = coerce_float(r["soil_temperature"])
        end
        rows.map { |row| compact_api_row(row) }
      ensure
        db&.close
      end

      # Aggregate telemetry metrics into time buckets.
      #
      # @param window_seconds [Integer] duration expressed in seconds to include in the query.
      # @param bucket_seconds [Integer] size of each aggregation bucket in seconds.
      # @param since [Integer] unix timestamp threshold applied in addition to the requested window.
      # @return [Array<Hash>] aggregated telemetry metrics grouped by bucket start time.
      def query_telemetry_buckets(window_seconds:, bucket_seconds:, since: 0)
        window = coerce_integer(window_seconds) || DEFAULT_TELEMETRY_WINDOW_SECONDS
        window = DEFAULT_TELEMETRY_WINDOW_SECONDS if window <= 0
        bucket = coerce_integer(bucket_seconds) || DEFAULT_TELEMETRY_BUCKET_SECONDS
        bucket = DEFAULT_TELEMETRY_BUCKET_SECONDS if bucket <= 0

        db = open_database(readonly: true)
        db.results_as_hash = true
        now = Time.now.to_i
        min_timestamp = now - window
        since_threshold = normalize_since_threshold(since, floor: min_timestamp)
        bucket_expression = "((COALESCE(rx_time, telemetry_time) / ?) * ?)"
        select_clauses = [
          "#{bucket_expression} AS bucket_start",
          "COUNT(*) AS sample_count",
          "MIN(COALESCE(rx_time, telemetry_time)) AS first_timestamp",
          "MAX(COALESCE(rx_time, telemetry_time)) AS last_timestamp",
        ]

        TELEMETRY_AGGREGATE_COLUMNS.each do |column|
          aggregate_source = telemetry_aggregate_source(column)
          select_clauses << "AVG(#{aggregate_source}) AS #{column}_avg"
          select_clauses << "MIN(#{aggregate_source}) AS #{column}_min"
          select_clauses << "MAX(#{aggregate_source}) AS #{column}_max"
        end

        sql = <<~SQL
          SELECT
            #{select_clauses.join(",\n            ")}
          FROM telemetry
          WHERE COALESCE(rx_time, telemetry_time) IS NOT NULL
            AND COALESCE(rx_time, telemetry_time, 0) >= ?
          GROUP BY bucket_start
          ORDER BY bucket_start ASC
          LIMIT ?
        SQL
        params = [bucket, bucket, since_threshold, MAX_QUERY_LIMIT]
        rows = db.execute(sql, params)
        rows.map do |row|
          bucket_start = coerce_integer(row["bucket_start"])
          bucket_end = bucket_start ? bucket_start + bucket : nil
          first_timestamp = coerce_integer(row["first_timestamp"])
          last_timestamp = coerce_integer(row["last_timestamp"])

          aggregates = {}
          TELEMETRY_AGGREGATE_COLUMNS.each do |column|
            avg = coerce_float(row["#{column}_avg"])
            min_value = coerce_float(row["#{column}_min"])
            max_value = coerce_float(row["#{column}_max"])
            scale = TELEMETRY_AGGREGATE_SCALERS[column]
            if scale
              avg *= scale unless avg.nil?
              min_value *= scale unless min_value.nil?
              max_value *= scale unless max_value.nil?
            end

            metrics = {}
            avg = sanitize_zero_invalid_metric(column, avg)
            min_value = sanitize_zero_invalid_metric(column, min_value)
            max_value = sanitize_zero_invalid_metric(column, max_value)

            metrics["avg"] = avg unless avg.nil?
            metrics["min"] = min_value unless min_value.nil?
            metrics["max"] = max_value unless max_value.nil?
            aggregates[column] = metrics unless metrics.empty?
          end

          bucket_response = {
            "bucket_start" => bucket_start,
            "bucket_start_iso" => bucket_start ? Time.at(bucket_start).utc.iso8601 : nil,
            "bucket_end" => bucket_end,
            "bucket_end_iso" => bucket_end ? Time.at(bucket_end).utc.iso8601 : nil,
            "bucket_seconds" => bucket,
            "sample_count" => coerce_integer(row["sample_count"]),
            "first_timestamp" => first_timestamp,
            "first_timestamp_iso" => first_timestamp ? Time.at(first_timestamp).utc.iso8601 : nil,
            "last_timestamp" => last_timestamp,
            "last_timestamp_iso" => last_timestamp ? Time.at(last_timestamp).utc.iso8601 : nil,
            "aggregates" => aggregates,
          }
          bucket_response["timestamp"] = bucket_start if bucket_start
          bucket_response["timestamp_iso"] = bucket_response["bucket_start_iso"] if bucket_response["bucket_start_iso"]
          compact_api_row(bucket_response)
        end
      ensure
        db&.close
      end

      # Normalise telemetry metrics that cannot legitimately be zero so API
      # consumers do not mistake absent readings for valid measurements. Values
      # for fields such as battery level and voltage are treated as missing data
      # when they are zero.
      #
      # @param column [String] telemetry metric name.
      # @param value [Numeric, nil] raw metric value.
      # @return [Numeric, nil] metric value or nil when zero is invalid.
      def sanitize_zero_invalid_metric(column, value)
        return nil_if_zero(value) if TELEMETRY_ZERO_INVALID_COLUMNS.include?(column)

        value
      end

      # Choose the SQL expression used to aggregate telemetry metrics. Metrics
      # that cannot legitimately be zero are wrapped in a NULLIF to ensure
      # invalid zero readings are ignored by aggregate functions such as AVG,
      # MIN, and MAX, aligning the database semantics with API-level
      # zero-as-missing handling.
      #
      # @param column [String] telemetry metric name.
      # @return [String] SQL fragment used in aggregate expressions.
      def telemetry_aggregate_source(column)
        return "NULLIF(#{column}, 0)" if TELEMETRY_ZERO_INVALID_COLUMNS.include?(column)

        column
      end

      # Fetch trace records optionally scoped by node and timestamp.
      #
      # @param limit [Integer] maximum number of rows to return.
      # @param node_ref [String, Integer, nil] optional node reference to scope results.
      # @param since [Integer] unix timestamp threshold applied in addition to the rolling window.
      # @return [Array<Hash>] compacted trace rows suitable for API responses.
      def query_traces(limit, node_ref: nil, since: 0)
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

        sql = <<~SQL
          SELECT id, request_id, src, dest, rx_time, rx_iso, rssi, snr, elapsed_ms
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
