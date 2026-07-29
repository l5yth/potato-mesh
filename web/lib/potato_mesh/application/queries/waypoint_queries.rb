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
      # Fetch waypoints (community POIs, SPEC W1/W4/W5) for the
      # +GET /api/waypoints+ collection and the per-author
      # +GET /api/waypoints/:id+ lookup (SPEC W11).
      #
      # Semantics mirror the other bulk collections: a 7-day rolling window
      # floor on +rx_time+ that callers cannot widen (C4) — widened to the
      # 28-day per-id window when +node_ref+ scopes the query, matching every
      # other per-id route — the BP1 inclusive +before+ cursor for backward
      # pagination, the +KNOWN_PROTOCOLS+-gated protocol filter, and the
      # author opt-out exclusion (W3). Additionally — unique to waypoints —
      # a row whose +expire+ timestamp has passed is excluded from the moment
      # of expiry (W5); +expire+ is stored NULL for never-expiring waypoints,
      # which are served until the window drops them.
      #
      # @param limit [Integer] maximum number of rows to return.
      # @param node_ref [String, Integer, nil] optional author reference that
      #   scopes the result to one node's broadcasts (W11 node-page section).
      # @param since [Integer] unix lower bound applied in addition to the rolling window.
      # @param before [Integer, nil] inclusive upper-bound +rx_time+ cursor for
      #   backward pagination (SPEC BP1); rows newer than this are excluded.
      # @param protocol [String, nil] optional protocol filter value.
      # @param now [Integer] reference unix timestamp (injectable for tests).
      # @return [Array<Hash>] compacted waypoint rows suitable for API responses.
      def query_waypoints(limit, node_ref: nil, since: 0, before: nil, protocol: nil, now: Time.now.to_i)
        limit = coerce_query_limit(limit)
        db = open_database(readonly: true)
        db.results_as_hash = true
        params = []
        where_clauses = []
        reference_now = coerce_integer(now) || Time.now.to_i

        # Bulk waypoints follow the seven-day default window on rx_time (C4);
        # per-author lookups widen to twenty-eight days like every other
        # per-id route so the node page can show the full retained history.
        since_floor = node_ref ? reference_now - PotatoMesh::Config.four_weeks_seconds : reference_now - PotatoMesh::Config.week_seconds
        where_clauses << "rx_time >= ?"
        params << normalize_since_threshold(since, floor: since_floor)

        if node_ref
          clause = node_lookup_clause(node_ref, string_columns: ["node_id"], numeric_columns: ["node_num"], db: db)
          return [] unless clause
          where_clauses << clause.first
          params.concat(clause.last)
        end

        # W5: an expired waypoint drops off the read surface at its expire
        # time; NULL means "never expires" and stays visible.
        where_clauses << "(expire IS NULL OR expire > ?)"
        params << reference_now

        # Inclusive upper-bound cursor for backward pagination (SPEC BP1);
        # bounds the +rx_time+ sort column.
        append_before_filter(where_clauses, params, before, column: "rx_time")

        append_opt_out_filter(where_clauses, params, opt_out_node_id_filter("node_id"))
        append_protocol_filter(where_clauses, params, protocol)

        sql = <<~SQL
          SELECT * FROM waypoints
        SQL
        sql += "    WHERE #{where_clauses.join(" AND ")}\n"
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

          r["node_num"] = coerce_integer(r["node_num"])
          r["icon"] = coerce_integer(r["icon"])
          # No ceiling: a waypoint's expiry is legitimately in the future.
          r["expire"] = coerce_positive_or_nil(r["expire"])
          r["snr"] = coerce_float(r["snr"])
          r["rssi"] = coerce_integer(r["rssi"])
          r["hop_limit"] = coerce_integer(r["hop_limit"])
        end
        rows.map { |row| compact_api_row(row) }
      ensure
        db&.close
      end
    end
  end
end
