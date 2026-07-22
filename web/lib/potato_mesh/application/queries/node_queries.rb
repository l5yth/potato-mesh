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

      # Build a WHERE clause fragment for looking up a node across one or more
      # columns.  When +numeric_columns+ are provided together with an open +db+
      # handle the numeric identifiers are resolved to canonical +node_id+
      # strings up-front so the resulting SQL uses only string-column +IN+
      # predicates.  This avoids an +OR+ across heterogeneous columns which
      # prevents SQLite from choosing the optimal index.
      #
      # @param node_ref [String, Integer, nil] raw node reference from the request.
      # @param string_columns [Array<String>] SQL column names holding string identifiers.
      # @param numeric_columns [Array<String>] SQL column names holding numeric identifiers.
      # @param db [SQLite3::Database, nil] open database handle used to resolve
      #   numeric IDs to canonical strings.  When provided and +numeric_columns+
      #   is non-empty the numeric branch is folded into the string branch.
      # @return [Array(String, Array), nil] SQL fragment and bind parameters, or
      #   +nil+ when no lookup can be constructed.
      def node_lookup_clause(node_ref, string_columns:, numeric_columns: [], db: nil)
        tokens = node_reference_tokens(node_ref)
        string_values = tokens[:string_values]
        numeric_values = tokens[:numeric_values]

        # When a database handle is available, resolve numeric identifiers to
        # canonical node_id strings so the query can use a single indexed column
        # instead of an OR across string and numeric columns.
        if db && !numeric_columns.empty? && !numeric_values.empty?
          numeric_values.each do |num|
            resolved = db.get_first_value("SELECT node_id FROM nodes WHERE num = ? LIMIT 1", [num])
            if resolved
              string_values << resolved unless string_values.include?(resolved)
            end
          end
          # All numeric values have been folded into string_values; drop the
          # numeric branch so the generated SQL avoids an OR.
          numeric_columns = []
          numeric_values = []
        end

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
      # @param before [Integer, nil] inclusive upper-bound +last_heard+ cursor for
      #   backward pagination (SPEC BP1); nodes newer than this are excluded.
      # @return [Array<Hash>] compacted node rows suitable for API responses.
      def query_nodes(limit, node_ref: nil, since: 0, before: nil, protocol: nil)
        limit = coerce_query_limit(limit)
        db = open_database(readonly: true)
        db.results_as_hash = true
        now = Time.now.to_i
        # Bulk listings stay on the seven-day window so the dashboard does not
        # render stale nodes; per-id lookups widen to twenty-eight days so
        # callers can backfill older records that fall outside the bulk floor.
        since_floor = node_ref ? now - PotatoMesh::Config.four_weeks_seconds : now - PotatoMesh::Config.week_seconds
        since_threshold = normalize_since_threshold(since, floor: since_floor)
        params = []
        where_clauses = []

        if node_ref
          clause = node_lookup_clause(node_ref, string_columns: ["node_id"], numeric_columns: ["num"], db: db)
          return [] unless clause
          where_clauses << clause.first
          params.concat(clause.last)
        else
          where_clauses << "last_heard >= ?"
          params << since_threshold
        end

        # Inclusive upper-bound cursor for backward pagination (SPEC BP1-BP3).
        # Bounds the +last_heard+ sort column so callers can page newest ->
        # oldest past the +MAX_QUERY_LIMIT+ cap; only ever narrows (BP2).  The
        # per-id route never supplies +before+, so single-node lookups are
        # unaffected.
        append_before_filter(where_clauses, params, before, column: "last_heard")

        if private_mode?
          where_clauses << "(role IS NULL OR role <> 'CLIENT_HIDDEN')"
        end

        append_opt_out_filter(where_clauses, params, opt_out_self_filter)
        append_protocol_filter(where_clauses, params, protocol)

        sql = <<~SQL
          SELECT node_id, short_name, long_name, hw_model, role, snr,
                 rssi, hops_away,
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
          if r["role"] == "COMPANION"
            derived = meshcore_companion_display_short_name(r["long_name"])
            if derived
              r["short_name"] = derived
            elsif r["short_name"].nil? || r["short_name"].strip.empty?
              # No derived name and no stored public-key hex — synthesise from
              # the node ID (first four hex chars after the leading "!") so the
              # badge is stable, unique, and consistent with how the ingestor
              # builds short names from public keys.
              node_id = r["node_id"].to_s.delete_prefix("!")
              r["short_name"] = node_id[0, 4] unless node_id.empty?
            end
          end
          lh = coerce_positive_or_nil(r["last_heard"])
          pt = coerce_positive_or_nil(r["position_time"], ceiling: now)
          lh = now if lh && lh > now
          r["last_heard"] = lh
          r["position_time"] = pt
          r["last_seen_iso"] = Time.at(lh).utc.iso8601 if lh
          # I2: position_time (unix int) is the sole position-time key; the
          # redundant ISO twin (pos_time_iso / position_time_iso) is not emitted.
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
      # @param before [Integer, nil] inclusive upper-bound +last_seen_time+ cursor
      #   for backward pagination (SPEC BP1); ingestors newer than this are excluded.
      # @return [Array<Hash>] compacted ingestor rows suitable for API responses.
      def query_ingestors(limit, since: 0, before: nil, protocol: nil)
        limit = coerce_query_limit(limit)
        db = open_database(readonly: true)
        db.results_as_hash = true
        now = Time.now.to_i
        # Ingestor heartbeats are sparse (one per ingestor per cycle) so widen
        # the rolling window to twenty-eight days to keep slow-tick ingestors
        # visible in the federation overview.
        cutoff = now - PotatoMesh::Config.four_weeks_seconds
        since_threshold = normalize_since_threshold(since, floor: cutoff)
        where_clauses = ["last_seen_time >= ?"]
        params = [since_threshold]
        # Inclusive upper-bound cursor for backward pagination (SPEC BP1);
        # bounds the +last_seen_time+ sort column.
        append_before_filter(where_clauses, params, before, column: "last_seen_time")
        append_opt_out_filter(where_clauses, params, opt_out_node_id_filter("node_id"))
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

      # Activity windows shared by every /api/stats metric, in a fixed order so
      # generated column aliases (+total_hour+, +mc_day+, …) line up with their
      # bind parameters.
      STATS_WINDOWS = %w[hour day week month].freeze

      # Per-protocol scopes counted alongside the unfiltered +total+, paired with
      # the short column-alias prefix used in the generated SQL.
      STATS_PROTOCOL_SCOPES = [["meshcore", "mc"], ["meshtastic", "mt"]].freeze

      # Return exact activity counts for /api/stats as a scope → metric → window
      # tree.
      #
      # The shape is:
      #
      #   { "total"      => { "nodes" => {...}, "messages" => {...}, "telemetry" => {...} },
      #     "meshcore"   => { ... }, "meshtastic" => { ... },
      #     "reticulum"  => { ... all zero (stub) } }
      #
      # where each metric maps to a +{ "hour", "day", "week", "month" }+ window
      # hash. +total+ counts every visible row regardless of protocol; the
      # protocol scopes are +WHERE protocol = ?+ subsets, so
      # +total ≥ Σ named protocols+. Counts are resolved directly in SQL with
      # COUNT(*) thresholds (no sampling bias from list-endpoint limits) and honor
      # the node opt-out marker on every metric. +messages+ counts are forced to
      # zero in private mode (SPEC S5 / Invariant II).
      #
      # @param now [Integer] reference unix timestamp in seconds.
      # @param db [SQLite3::Database, nil] optional open database handle to reuse.
      # @return [Hash{String => Hash}] scope → metric → window count tree.
      def query_active_node_stats(now: Time.now.to_i, db: nil)
        handle = db || open_database(readonly: true)
        handle.results_as_hash = true
        reference_now = coerce_integer(now) || Time.now.to_i
        # The "month" bucket reuses the four-week cap so no stats endpoint can
        # surface activity from beyond the 28-day API visibility floor.
        cutoffs = {
          "hour" => reference_now - 3600,
          "day" => reference_now - 86_400,
          "week" => reference_now - PotatoMesh::Config.week_seconds,
          "month" => reference_now - PotatoMesh::Config.four_weeks_seconds,
        }

        metrics = {
          "nodes" => node_activity_counts(handle, cutoffs),
          "messages" => message_activity_counts(handle, cutoffs),
          "telemetry" => telemetry_activity_counts(handle, cutoffs),
        }
        assemble_stats_scopes(metrics)
      ensure
        handle&.close unless db
      end

      # Per-protocol node-activity counts keyed on +nodes.last_heard+, honoring
      # the opt-out self-filter and, in private mode, the CLIENT_HIDDEN exclusion.
      #
      # @param handle [SQLite3::Database] open database handle.
      # @param cutoffs [Hash{String => Integer}] window => lower-bound timestamp.
      # @return [Hash{String => Hash}] scope => window counts.
      def node_activity_counts(handle, cutoffs)
        private_clause = private_mode? ? " AND (role IS NULL OR role <> 'CLIENT_HIDDEN')" : ""
        projection = "SELECT last_heard AS t, protocol AS p FROM nodes " \
                     "WHERE #{opt_out_self_filter}#{private_clause}"
        windowed_protocol_counts(
          handle,
          projection_sql: projection,
          projection_params: opt_out_marker_params,
          cutoffs: cutoffs,
        )
      end

      # Per-protocol message-activity counts keyed on +messages.rx_time+. Privacy
      # mode forces every count to zero, mirroring the +PRIVATE=1+ message-API 404
      # so /api/stats never leaks message volume that privacy hides
      # (SPEC S5 / Invariant II).
      #
      # @param handle [SQLite3::Database] open database handle.
      # @param cutoffs [Hash{String => Integer}] window => lower-bound timestamp.
      # @return [Hash{String => Hash}] scope => window counts.
      def message_activity_counts(handle, cutoffs)
        return zero_scope_counts if private_mode?

        fragments = [opt_out_node_id_filter("from_id"), opt_out_node_id_filter("to_id")]
        projection = "SELECT rx_time AS t, protocol AS p FROM messages " \
                     "WHERE #{fragments.join(" AND ")}"
        windowed_protocol_counts(
          handle,
          projection_sql: projection,
          projection_params: opt_out_marker_params * fragments.length,
          cutoffs: cutoffs,
        )
      end

      # Per-protocol telemetry-activity counts. "Telemetry" is the umbrella over
      # every non-message packet record — positions + telemetry + neighbors +
      # traces — unioned on +(rx_time, protocol)+, each table honoring the same
      # opt-out filter its list endpoint applies (SPEC S3).
      #
      # @param handle [SQLite3::Database] open database handle.
      # @param cutoffs [Hash{String => Integer}] window => lower-bound timestamp.
      # @return [Hash{String => Hash}] scope => window counts.
      def telemetry_activity_counts(handle, cutoffs)
        sources = [
          ["positions", [opt_out_node_id_filter("node_id")]],
          ["telemetry", [opt_out_node_id_filter("node_id")]],
          ["neighbors", [opt_out_node_id_filter("node_id"), opt_out_node_id_filter("neighbor_id")]],
          ["traces", [opt_out_node_num_filter("src"), opt_out_node_num_filter("dest")]],
        ]
        projections = []
        params = []
        sources.each do |table, fragments|
          projections << "SELECT rx_time AS t, protocol AS p FROM #{table} WHERE #{fragments.join(" AND ")}"
          params.concat(opt_out_marker_params * fragments.length)
        end
        windowed_protocol_counts(
          handle,
          projection_sql: projections.join("\nUNION ALL\n"),
          projection_params: params,
          cutoffs: cutoffs,
        )
      end

      # Count visible rows from a +(t, p)+ projection across every window, as an
      # unfiltered +total+ plus one subset per protocol scope. The projection is
      # materialised in a CTE so its opt-out predicate is evaluated once; each
      # COUNT then runs over the pre-filtered set.
      #
      # @param handle [SQLite3::Database] open database handle.
      # @param projection_sql [String] SELECT yielding +t+ (activity time) and
      #   +p+ (protocol) columns for the visible rows of one metric.
      # @param projection_params [Array] bind parameters for +projection_sql+.
      # @param cutoffs [Hash{String => Integer}] window => lower-bound timestamp.
      # @return [Hash{String => Hash}] +total+/+meshcore+/+meshtastic+ => window
      #   counts.
      def windowed_protocol_counts(handle, projection_sql:, projection_params:, cutoffs:)
        selects = []
        window_params = []

        STATS_WINDOWS.each do |window|
          selects << "(SELECT COUNT(*) FROM visible WHERE t >= ?) AS total_#{window}"
          window_params << cutoffs.fetch(window)
        end
        STATS_PROTOCOL_SCOPES.each do |protocol, prefix|
          STATS_WINDOWS.each do |window|
            selects << "(SELECT COUNT(*) FROM visible WHERE t >= ? AND p = ?) AS #{prefix}_#{window}"
            window_params << cutoffs.fetch(window)
            window_params << protocol
          end
        end

        sql = "WITH visible AS (#{projection_sql})\nSELECT #{selects.join(",\n  ")}"
        row = with_busy_retry { handle.get_first_row(sql, projection_params + window_params) } || {}

        scopes = { "total" => stats_window_hash(row, "total") }
        STATS_PROTOCOL_SCOPES.each { |protocol, prefix| scopes[protocol] = stats_window_hash(row, prefix) }
        scopes
      end

      # Extract one alias prefix's window-count hash from a result row.
      #
      # @param row [Hash] row returned by {windowed_protocol_counts}.
      # @param prefix [String] column-alias prefix (+total+, +mc+, +mt+).
      # @return [Hash{String => Integer}] window => count.
      def stats_window_hash(row, prefix)
        STATS_WINDOWS.each_with_object({}) do |window, acc|
          acc[window] = row["#{prefix}_#{window}"].to_i
        end
      end

      # Transpose metric → scope counts into the scope → metric tree returned by
      # /api/stats and append the always-zero +reticulum+ stub.
      #
      # @param metrics [Hash{String => Hash}] metric => (scope => window counts).
      # @return [Hash{String => Hash}] scope => (metric => window counts).
      def assemble_stats_scopes(metrics)
        scopes = {}
        (["total"] + STATS_PROTOCOL_SCOPES.map(&:first)).each do |scope|
          scopes[scope] = metrics.transform_values { |by_scope| by_scope[scope] }
        end
        # reticulum is a forward-looking stub: PotatoMesh has no Reticulum
        # ingestor yet, so every count is zero. Emitting the scope now lets the
        # response shape absorb the protocol later without another breaking change
        # (SPEC S6).
        scopes["reticulum"] = metrics.keys.each_with_object({}) do |metric, acc|
          acc[metric] = zero_window_counts
        end
        scopes
      end

      # A fresh zero-filled window hash (+{ "hour" => 0, … }+), returned by value
      # so callers never alias a shared mutable hash.
      #
      # @return [Hash{String => Integer}] zeroed window counts.
      def zero_window_counts
        STATS_WINDOWS.each_with_object({}) { |window, acc| acc[window] = 0 }
      end

      # A scope → window hash with every count zero (total + each protocol). Used
      # for metrics suppressed by privacy mode.
      #
      # @return [Hash{String => Hash}] zeroed per-scope window counts.
      def zero_scope_counts
        scopes = { "total" => zero_window_counts }
        STATS_PROTOCOL_SCOPES.each { |protocol, _| scopes[protocol] = zero_window_counts }
        scopes
      end
    end
  end
end
