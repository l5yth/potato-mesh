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

      # Coerce a candidate unix-epoch value to a strictly positive integer,
      # returning +nil+ for any value that should be treated as absent.  Ruby
      # treats +0+ as truthy, so naive guards such as +Time.at(value).iso8601 if
      # value+ silently emit +"1970-01-01T00:00:00Z"+ for stored sentinel zeros
      # (see issue #782).  Routing timestamp columns through this helper before
      # any +if value+ check eliminates that class of bug at the read boundary.
      #
      # @param value [Object] raw value to coerce.
      # @param ceiling [Integer, nil] optional upper bound (inclusive); values
      #   exceeding the ceiling collapse to +nil+ so future-dated timestamps do
      #   not leak through.
      # @return [Integer, nil] coerced positive integer, or +nil+ when the input
      #   is nil, non-integer-coercible, non-positive, or beyond the ceiling.
      def coerce_positive_or_nil(value, ceiling: nil)
        coerced = begin
            if value.is_a?(Integer)
              value
            else
              Integer(value, 10)
            end
          rescue ArgumentError, TypeError
            nil
          end

        return nil if coerced.nil? || coerced <= 0
        return nil if ceiling && coerced > ceiling

        coerced
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

      # Append an inclusive upper-bound (+before+) cursor to an in-flight WHERE
      # clause builder for backward pagination of a bulk collection endpoint
      # (SPEC BP1-BP3; the +/api/messages+ #796 cursor generalised to every
      # list route).
      #
      # +before+ is an *inclusive* (+<=+) ceiling on the route's primary sort
      # column — the column it already +ORDER BY ... DESC+ — so a client can
      # walk the feed newest -> oldest by passing the oldest sort value of each
      # page as the next +before+ and de-duplicating by id, never skipping a row
      # that shares the boundary second.  Because the cursor only ever *narrows*
      # the result set it cannot widen the server-side window floor
      # (SPEC BP2 / acceptance C4): a +before+ older than the floor merely
      # returns fewer rows, and a +before+ in the future is a no-op.
      # Non-positive / non-integer values are ignored as absent via
      # {coerce_positive_or_nil}, matching the messages route.
      #
      # @param where_clauses [Array<String>] accumulating WHERE conditions (mutated).
      # @param params [Array] accumulating bind parameters (mutated).
      # @param before [Object] raw +before+ cursor from the request.
      # @param column [String] qualified sort column to bound (e.g. ``"last_heard"``,
      #   ``"m.rx_time"``).  Must match {SAFE_COLUMN_IDENTIFIER}; arbitrary user
      #   input is not accepted.
      # @return [Integer, nil] the coerced cursor that was applied, or +nil+ when
      #   +before+ was absent/invalid and no clause was added.
      def append_before_filter(where_clauses, params, before, column:)
        assert_safe_column_identifier!(column)
        cursor = coerce_positive_or_nil(before)
        return nil unless cursor

        where_clauses << "#{column} <= ?"
        params << cursor
        cursor
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

      # SQL fragment used by every read query to filter out opted-out nodes.
      #
      # Operators signal opt-out by placing
      # {PotatoMesh::Config::NODE_OPT_OUT_MARKER} (🛑) anywhere in their
      # +short_name+ or +long_name+.  The data layer still ingests records
      # for these nodes — the marker only suppresses them from API responses.
      #
      # Wrapping each display column in +COALESCE(...,'')+ matters because
      # SQL +LIKE+ against +NULL+ yields +NULL+, which is falsy in +WHERE+
      # but propagates through +NOT+ as +NULL+ — without the coalesce, any
      # node missing one display column would be incorrectly filtered out.
      OPT_OUT_NAME_PREDICATE =
        "(COALESCE(long_name, '') LIKE '%' || ? || '%' " \
        "OR COALESCE(short_name, '') LIKE '%' || ? || '%')".freeze

      # Returns the bind parameters required by every opt-out SQL fragment.
      #
      # The fragments embed two LIKE expressions (one per display column), so
      # each invocation needs the marker twice.  Centralising the binding
      # avoids drift between fragments that match against +nodes+ directly
      # versus those that join via a subquery.
      #
      # @return [Array<String>] bind parameters for the opt-out predicate.
      def opt_out_marker_params
        marker = PotatoMesh::Config.node_opt_out_marker
        [marker, marker]
      end

      # SQL fragment that excludes rows whose own +long_name+/+short_name+
      # carry the opt-out marker.  Intended for queries that read directly
      # from the +nodes+ table.
      #
      # @return [String] SQL predicate suitable for AND-composition.
      def opt_out_self_filter
        "NOT #{OPT_OUT_NAME_PREDICATE}"
      end

      # Regex matching the only column-name shapes the +opt_out_node_*_filter+
      # helpers accept: bare identifiers (+node_id+), and dotted qualifiers
      # (+m.from_id+).  Anything else is rejected because the value is
      # interpolated directly into SQL, where stray punctuation would either
      # corrupt the query or open a SQL-injection surface for any future
      # caller that forgets to pass a literal.
      SAFE_COLUMN_IDENTIFIER = /\A[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?\z/.freeze

      # Validate that +column+ is a plain identifier or dotted alias before
      # interpolation.  Raises +ArgumentError+ on anything more exotic.
      #
      # @param column [String] candidate column name.
      # @return [String] +column+ unchanged when safe to interpolate.
      def assert_safe_column_identifier!(column)
        unless column.is_a?(String) && column.match?(SAFE_COLUMN_IDENTIFIER)
          raise ArgumentError, "unsafe column identifier: #{column.inspect}"
        end
        column
      end

      # SQL fragment that excludes rows whose textual node reference column
      # points at an opted-out node.  Use for tables that join logically via
      # a +node_id+/+from_id+/+to_id+ column.
      #
      # NULL references on the outer column are preserved so anonymous chat
      # messages and other records without an attributable sender remain
      # visible.  The inner subquery also filters +node_id IS NOT NULL+: in
      # SQLite, +x NOT IN (subquery)+ returns UNKNOWN when the subquery
      # produces a NULL, which would silently exclude every row.  Guarding
      # the subquery keeps that failure mode out of reach if a future opt-out
      # row ever lands with a NULL +node_id+.
      #
      # @param column [String] qualified SQL column name (e.g. ``"m.from_id"``).
      #   Must match {SAFE_COLUMN_IDENTIFIER}; arbitrary user input is not
      #   accepted.
      # @return [String] SQL predicate suitable for AND-composition.
      def opt_out_node_id_filter(column)
        assert_safe_column_identifier!(column)
        "(#{column} IS NULL OR #{column} NOT IN (" \
        "SELECT node_id FROM nodes WHERE node_id IS NOT NULL AND #{OPT_OUT_NAME_PREDICATE}))"
      end

      # SQL fragment that excludes rows whose numeric node reference column
      # points at an opted-out node.  Use for tables that key on the legacy
      # numeric node identifier (+num+, +src+, +dest+, +trace_hops.node_id+).
      #
      # @param column [String] qualified SQL column name.  Must match
      #   {SAFE_COLUMN_IDENTIFIER}.
      # @return [String] SQL predicate suitable for AND-composition.
      def opt_out_node_num_filter(column)
        assert_safe_column_identifier!(column)
        "(#{column} IS NULL OR #{column} NOT IN (" \
        "SELECT num FROM nodes WHERE num IS NOT NULL AND #{OPT_OUT_NAME_PREDICATE}))"
      end

      # Append an opt-out filter to an in-flight WHERE clause builder.
      #
      # @param where_clauses [Array<String>] accumulating WHERE conditions.
      # @param params [Array] accumulating bind parameters.
      # @param fragment [String] SQL fragment produced by one of the
      #   +opt_out_*_filter+ helpers.
      # @return [void]
      def append_opt_out_filter(where_clauses, params, fragment)
        where_clauses << fragment
        params.concat(opt_out_marker_params)
      end

      # Clamp a caller-supplied window duration to the 28-day API visibility
      # cap.  Used by aggregate endpoints whose +windowSeconds+ parameter
      # could otherwise reach further back than the per-id read floor.
      #
      # @param window_seconds [Integer, nil] requested window duration.
      # @return [Integer, nil] +window_seconds+ clamped to at most 28 days,
      #   or +nil+ when the input is non-positive/nil.
      def clamp_window_seconds(window_seconds)
        return nil if window_seconds.nil?
        return nil if window_seconds <= 0
        cap = PotatoMesh::Config.four_weeks_seconds
        window_seconds > cap ? cap : window_seconds
      end
    end
  end
end
