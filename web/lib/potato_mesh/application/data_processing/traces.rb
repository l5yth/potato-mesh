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
    module DataProcessing
      # Normalise a traceroute hop entry to a numeric node identifier.
      #
      # @param hop [Object] raw hop entry from the payload.
      # @return [Integer, nil] coerced node ID or nil when the value is unusable.
      def coerce_trace_node_id(hop)
        case hop
        when Integer
          return hop
        when Numeric
          return hop.to_i
        when String
          trimmed = hop.strip
          return nil if trimmed.empty?
          return Integer(trimmed, 10) if trimmed.match?(/\A-?\d+\z/)

          parts = canonical_node_parts(trimmed)
          return parts[1] if parts
        when Hash
          candidate = hop["node_id"] || hop[:node_id] || hop["id"] || hop[:id] || hop["num"] || hop[:num]
          return coerce_trace_node_id(candidate)
        end

        nil
      end

      # Extract hop identifiers from a traceroute payload preserving order.
      #
      # @param hops_value [Object] raw hops array or path collection.
      # @return [Array<Integer>] ordered list of coerced hop identifiers.
      def normalize_trace_hops(hops_value)
        return [] if hops_value.nil?

        hop_entries = hops_value.is_a?(Array) ? hops_value : [hops_value]
        hop_entries.filter_map { |entry| coerce_trace_node_id(entry) }
      end

      # Persist a traceroute observation and its hop path.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param payload [Hash] traceroute payload as produced by the ingestor.
      # @param protocol_cache [Hash, nil] optional per-batch ingestor protocol cache.
      # @return [void]
      def insert_trace(db, payload, protocol_cache: nil)
        return unless payload.is_a?(Hash)

        trace_identifier = coerce_integer(payload["id"] || payload["packet_id"] || payload["packetId"])
        trace_identifier ||= coerce_integer(payload["trace_id"])
        request_id = coerce_integer(payload["request_id"] || payload["req"])
        trace_identifier ||= request_id

        now = Time.now.to_i
        rx_time = coerce_integer(payload["rx_time"])
        rx_time = now if rx_time.nil? || rx_time > now
        rx_iso = string_or_nil(payload["rx_iso"]) || Time.at(rx_time).utc.iso8601

        metrics = normalize_json_object(payload["metrics"]) || {}
        src = coerce_integer(payload["src"] || payload["source"] || payload["from"])
        dest = coerce_integer(payload["dest"] || payload["destination"] || payload["to"])
        rssi = coerce_integer(payload["rssi"]) || coerce_integer(metrics["rssi"])
        snr = coerce_float(payload["snr"]) || coerce_float(metrics["snr"])
        elapsed_ms = coerce_integer(
          payload["elapsed_ms"] ||
            payload["latency_ms"] ||
            metrics&.[]("elapsed_ms") ||
            metrics&.[]("latency_ms") ||
            metrics&.[]("latencyMs"),
        )
        ingestor = string_or_nil(payload["ingestor"])
        protocol = resolve_protocol(db, ingestor, cache: protocol_cache)

        hops_value = payload.key?("hops") ? payload["hops"] : payload["path"]
        hops = normalize_trace_hops(hops_value)

        all_nodes = [src, dest, *hops].compact.uniq
        all_nodes.each do |node|
          ensure_unknown_node(db, node, node, heard_time: rx_time, protocol: protocol)
          touch_node_last_seen(db, node, node, rx_time: rx_time, source: :trace)
        end

        with_busy_retry do
          db.execute <<~SQL, [trace_identifier, request_id, src, dest, rx_time, rx_iso, rssi, snr, elapsed_ms, ingestor, protocol]
                       INSERT INTO traces(id, request_id, src, dest, rx_time, rx_iso, rssi, snr, elapsed_ms, ingestor, protocol)
                            VALUES(?,?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(id) DO UPDATE SET
                         request_id=COALESCE(excluded.request_id,traces.request_id),
                         src=COALESCE(excluded.src,traces.src),
                         dest=COALESCE(excluded.dest,traces.dest),
                         rx_time=excluded.rx_time,
                         rx_iso=excluded.rx_iso,
                         rssi=COALESCE(excluded.rssi,traces.rssi),
                         snr=COALESCE(excluded.snr,traces.snr),
                         elapsed_ms=COALESCE(excluded.elapsed_ms,traces.elapsed_ms),
                         ingestor=COALESCE(NULLIF(traces.ingestor,''), excluded.ingestor),
                         protocol=COALESCE(NULLIF(traces.protocol,'meshtastic'), excluded.protocol)
                     SQL

          trace_id = trace_identifier || db.last_insert_row_id
          return unless trace_id

          db.execute("DELETE FROM trace_hops WHERE trace_id = ?", [trace_id])
          hops.each_with_index do |hop_id, index|
            db.execute(
              "INSERT INTO trace_hops(trace_id, hop_index, node_id) VALUES(?,?,?)",
              [trace_id, index, hop_id],
            )
          end
        end
      end
    end
  end
end
