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
      # Fetch telemetry packets optionally scoped by node and timestamp.
      #
      # @param limit [Integer] maximum number of rows to return.
      # @param node_ref [String, Integer, nil] optional node reference to scope results.
      # @param since [Integer] unix timestamp threshold applied in addition to the rolling window for collections.
      # @return [Array<Hash>] compacted telemetry rows suitable for API responses.
      def query_telemetry(limit, node_ref: nil, since: 0, protocol: nil)
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
          clause = node_lookup_clause(node_ref, string_columns: ["node_id"], numeric_columns: ["node_num"], db: db)
          return [] unless clause
          where_clauses << clause.first
          params.concat(clause.last)
        end

        append_protocol_filter(where_clauses, params, protocol)

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
          r["telemetry_type"] = string_or_nil(r["telemetry_type"])
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
    end
  end
end
