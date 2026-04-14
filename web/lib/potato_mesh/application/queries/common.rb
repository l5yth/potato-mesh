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

      # Resolve a collection of raw node reference strings to their canonical
      # +node_id+ values in a single batch query.  This avoids the N+1 pattern
      # of calling +normalize_node_id+ once per row.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param refs [Array<String>] raw node identifiers (hex strings or numeric
      #   strings) to resolve.
      # @return [Hash{String => String}] mapping from each input reference to its
      #   canonical +node_id+, omitting entries that could not be resolved.
      def batch_resolve_node_ids(db, refs)
        return {} if refs.nil? || refs.empty?

        result = {}
        string_refs = []
        numeric_refs = []

        refs.each do |ref|
          next if ref.nil? || ref.strip.empty?
          string_refs << ref.strip
          begin
            numeric_refs << Integer(ref.strip, 10)
          rescue ArgumentError
            # not a numeric reference — skip the numeric branch
          end
        end

        # Batch lookup by node_id (string match)
        unless string_refs.empty?
          placeholders = Array.new(string_refs.length, "?").join(", ")
          rows = db.execute("SELECT node_id FROM nodes WHERE node_id IN (#{placeholders})", string_refs)
          rows.each do |row|
            nid = row.is_a?(Hash) ? row["node_id"] : row[0]
            result[nid] = nid if nid
          end
        end

        # Batch lookup by num (numeric match) for refs not yet resolved
        unresolved_numeric = numeric_refs.select { |n| !result.key?(n.to_s) }
        unless unresolved_numeric.empty?
          placeholders = Array.new(unresolved_numeric.length, "?").join(", ")
          rows = db.execute("SELECT node_id, num FROM nodes WHERE num IN (#{placeholders})", unresolved_numeric)
          rows.each do |row|
            nid = row.is_a?(Hash) ? row["node_id"] : row[0]
            num = row.is_a?(Hash) ? row["num"] : row[1]
            result[num.to_s] = nid if nid && num
          end
        end

        result
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
