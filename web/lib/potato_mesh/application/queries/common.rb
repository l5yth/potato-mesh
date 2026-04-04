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
      PROTOCOL_CLAUSE = "protocol = ?".freeze
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

      # Append a protocol equality clause to an existing WHERE clause list when a
      # protocol filter is specified. Mutates +where_clauses+ and +params+ in place.
      #
      # @param where_clauses [Array<String>] accumulating WHERE conditions.
      # @param params [Array] accumulating bind parameters.
      # @param protocol [String, nil] optional protocol value to filter by.
      # @param table_alias [String, nil] optional table alias prefix (e.g. "m" → "m.protocol = ?").
      # @return [void]
      def append_protocol_filter(where_clauses, params, protocol, table_alias: nil)
        return unless protocol

        clause = table_alias ? "#{table_alias}.#{PROTOCOL_CLAUSE}" : PROTOCOL_CLAUSE
        where_clauses << clause
        params << protocol
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
    end
  end
end
