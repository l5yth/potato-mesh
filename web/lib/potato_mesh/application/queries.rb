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
            Integer(value, 10)
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

      def query_nodes(limit, node_ref: nil)
        limit = coerce_query_limit(limit)
        db = open_database(readonly: true)
        db.results_as_hash = true
        now = Time.now.to_i
        min_last_heard = now - PotatoMesh::Config.week_seconds
        params = []
        where_clauses = []

        if node_ref
          clause = node_lookup_clause(node_ref, string_columns: ["node_id"], numeric_columns: ["num"])
          return [] unless clause
          where_clauses << clause.first
          params.concat(clause.last)
        else
          where_clauses << "last_heard >= ?"
          params << min_last_heard
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
          last_candidate && last_candidate >= min_last_heard
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
        rows
      ensure
        db&.close
      end

      def query_messages(limit, node_ref: nil)
        limit = coerce_query_limit(limit)
        db = open_database(readonly: true)
        db.results_as_hash = true
        params = []
        where_clauses = ["COALESCE(TRIM(m.encrypted), '') = ''"]
        now = Time.now.to_i
        min_rx_time = now - PotatoMesh::Config.week_seconds
        where_clauses << "m.rx_time >= ?"
        params << min_rx_time

        if node_ref
          clause = node_lookup_clause(node_ref, string_columns: ["m.from_id", "m.to_id"])
          return [] unless clause
          where_clauses << clause.first
          params.concat(clause.last)
        end

        sql = <<~SQL
          SELECT m.id, m.rx_time, m.rx_iso, m.from_id, m.to_id, m.channel,
                 m.portnum, m.text, m.encrypted, m.rssi, m.hop_limit,
                 m.lora_freq AS msg_lora_freq, m.modem_preset AS msg_modem_preset,
                 m.channel_name AS msg_channel_name, m.snr AS msg_snr,
                 n.node_id AS node_node_id, n.num AS node_num,
                 n.short_name AS node_short_name, n.long_name AS node_long_name,
                 n.macaddr AS node_macaddr, n.hw_model AS node_hw_model,
                 n.role AS node_role, n.public_key AS node_public_key,
                 n.is_unmessagable AS node_is_unmessagable,
                 n.is_favorite AS node_is_favorite,
                 n.hops_away AS node_hops_away, n.snr AS node_snr,
                 n.last_heard AS node_last_heard, n.first_heard AS node_first_heard,
                 n.battery_level AS node_battery_level, n.voltage AS node_voltage,
                 n.channel_utilization AS node_channel_utilization,
                 n.air_util_tx AS node_air_util_tx,
                 n.uptime_seconds AS node_uptime_seconds,
                 n.position_time AS node_position_time,
                 n.location_source AS node_location_source,
                 n.precision_bits AS node_precision_bits,
                 n.latitude AS node_latitude, n.longitude AS node_longitude,
                 n.altitude AS node_altitude,
                 n.lora_freq AS node_lora_freq, n.modem_preset AS node_modem_preset
          FROM messages m
          LEFT JOIN nodes n ON (
            m.from_id IS NOT NULL AND TRIM(m.from_id) <> '' AND (
              m.from_id = n.node_id OR (
                m.from_id GLOB '[0-9]*' AND CAST(m.from_id AS INTEGER) = n.num
              )
            )
          )
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
          r["lora_freq"] = r.delete("msg_lora_freq")
          r["modem_preset"] = r.delete("msg_modem_preset")
          r["channel_name"] = r.delete("msg_channel_name")
          snr_value = r.delete("msg_snr")
          if PotatoMesh::Config.debug? && (r["from_id"].nil? || r["from_id"].to_s.empty?)
            raw = db.execute("SELECT * FROM messages WHERE id = ?", [r["id"]]).first
            debug_log(
              "Message join produced empty sender",
              context: "queries.messages",
              stage: "before_join",
              row: raw,
            )
            debug_log(
              "Message join produced empty sender",
              context: "queries.messages",
              stage: "after_join",
              row: r,
            )
          end
          node = {}
          r.keys.grep(/^node_/).each do |k|
            attribute = k.delete_prefix("node_")
            node[attribute] = r.delete(k)
          end
          r["snr"] = snr_value
          references = [r["from_id"]].compact
          if references.any? && (node["node_id"].nil? || node["node_id"].to_s.empty?)
            lookup_keys = []
            canonical = normalize_node_id(db, r["from_id"])
            lookup_keys << canonical if canonical
            raw_ref = r["from_id"].to_s.strip
            lookup_keys << raw_ref unless raw_ref.empty?
            lookup_keys << raw_ref.to_i if raw_ref.match?(/\A[0-9]+\z/)
            fallback = nil
            lookup_keys.uniq.each do |ref|
              sql = ref.is_a?(Integer) ? "SELECT * FROM nodes WHERE num = ?" : "SELECT * FROM nodes WHERE node_id = ?"
              fallback = db.get_first_row(sql, [ref])
              break if fallback
            end
            if fallback
              fallback.each do |key, value|
                next unless key.is_a?(String)
                node[key] = value if node[key].nil?
              end
            end
          end
          node["role"] = "CLIENT" if node.key?("role") && (node["role"].nil? || node["role"].to_s.empty?)
          r["node"] = node

          canonical_from_id = string_or_nil(node["node_id"]) || string_or_nil(normalize_node_id(db, r["from_id"]))
          if canonical_from_id
            raw_from_id = string_or_nil(r["from_id"])
            if raw_from_id.nil? || raw_from_id.match?(/\A[0-9]+\z/)
              r["from_id"] = canonical_from_id
            elsif raw_from_id.start_with?("!") && raw_from_id.casecmp(canonical_from_id) != 0
              r["from_id"] = canonical_from_id
            end
          end

          if PotatoMesh::Config.debug? && (r["from_id"].nil? || r["from_id"].to_s.empty?)
            debug_log(
              "Message row missing sender after processing",
              context: "queries.messages",
              stage: "after_processing",
              row: r,
            )
          end
        end
        rows
      ensure
        db&.close
      end

      def query_positions(limit, node_ref: nil)
        limit = coerce_query_limit(limit)
        db = open_database(readonly: true)
        db.results_as_hash = true
        params = []
        where_clauses = []
        now = Time.now.to_i
        min_rx_time = now - PotatoMesh::Config.week_seconds
        where_clauses << "COALESCE(rx_time, position_time, 0) >= ?"
        params << min_rx_time

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
        rows
      ensure
        db&.close
      end

      def query_neighbors(limit, node_ref: nil)
        limit = coerce_query_limit(limit)
        db = open_database(readonly: true)
        db.results_as_hash = true
        params = []
        where_clauses = []
        now = Time.now.to_i
        min_rx_time = now - PotatoMesh::Config.week_seconds
        where_clauses << "COALESCE(rx_time, 0) >= ?"
        params << min_rx_time

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
        rows
      ensure
        db&.close
      end

      def query_telemetry(limit, node_ref: nil)
        limit = coerce_query_limit(limit)
        db = open_database(readonly: true)
        db.results_as_hash = true
        params = []
        where_clauses = []
        now = Time.now.to_i
        min_rx_time = now - PotatoMesh::Config.week_seconds
        where_clauses << "COALESCE(rx_time, telemetry_time, 0) >= ?"
        params << min_rx_time

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
          r["battery_level"] = coerce_float(r["battery_level"])
          r["voltage"] = coerce_float(r["voltage"])
          r["channel_utilization"] = coerce_float(r["channel_utilization"])
          r["air_util_tx"] = coerce_float(r["air_util_tx"])
          r["uptime_seconds"] = coerce_integer(r["uptime_seconds"])
          r["temperature"] = coerce_float(r["temperature"])
          r["relative_humidity"] = coerce_float(r["relative_humidity"])
          r["barometric_pressure"] = coerce_float(r["barometric_pressure"])
        end
        rows
      ensure
        db&.close
      end
    end
  end
end
