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
      # Decode and store decrypted payloads in domain-specific tables.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param message [Hash] original message payload.
      # @param packet_id [Integer] packet identifier for the message.
      # @param decrypted [Hash] decrypted payload metadata.
      # @param rx_time [Integer] receive time.
      # @param rx_iso [String] ISO 8601 receive timestamp.
      # @param from_id [String, nil] canonical sender identifier.
      # @param to_id [String, nil] destination identifier.
      # @param channel [Integer, nil] channel index.
      # @param portnum [Object, nil] port number identifier.
      # @param hop_limit [Integer, nil] hop limit value.
      # @param snr [Numeric, nil] signal-to-noise ratio.
      # @param rssi [Integer, nil] RSSI value.
      # @return [void]
      def store_decrypted_payload(
        db,
        message,
        packet_id,
        decrypted,
        rx_time:,
        rx_iso:,
        from_id:,
        to_id:,
        channel:,
        portnum:,
        hop_limit:,
        snr:,
        rssi:
      )
        payload_bytes = decrypted[:payload]
        return false unless payload_bytes

        portnum_value = coerce_integer(portnum || decrypted[:portnum])
        return false unless portnum_value

        payload_b64 = Base64.strict_encode64(payload_bytes)
        supported_ports = [3, 4, 67, 70, 71]
        return false unless supported_ports.include?(portnum_value)

        decoded = PotatoMesh::App::Meshtastic::PayloadDecoder.decode(
          portnum: portnum_value,
          payload_b64: payload_b64,
        )
        return false unless decoded.is_a?(Hash)
        return false unless decoded["payload"].is_a?(Hash)

        common_payload = {
          "id" => packet_id,
          "packet_id" => packet_id,
          "rx_time" => rx_time,
          "rx_iso" => rx_iso,
          "from_id" => from_id,
          "to_id" => to_id,
          "channel" => channel,
          "portnum" => portnum_value.to_s,
          "hop_limit" => hop_limit,
          "snr" => snr,
          "rssi" => rssi,
          "lora_freq" => coerce_integer(message["lora_freq"] || message["loraFrequency"]),
          "modem_preset" => string_or_nil(message["modem_preset"] || message["modemPreset"]),
          "payload_b64" => payload_b64,
          "ingestor" => string_or_nil(message["ingestor"]),
        }

        case decoded["type"]
        when "POSITION_APP"
          payload = common_payload.merge("position" => decoded["payload"])
          insert_position(db, payload)
          debug_log(
            "Stored decrypted position payload",
            context: "data_processing.store_decrypted_payload",
            message_id: packet_id,
            portnum: portnum_value,
          )
          true
        when "NODEINFO_APP"
          node_payload = normalize_decrypted_nodeinfo_payload(decoded["payload"])
          return false unless valid_decrypted_nodeinfo_payload?(node_payload)

          node_id = string_or_nil(node_payload["id"]) || from_id
          node_num = coerce_integer(node_payload["num"]) ||
                     coerce_integer(message["from_num"]) ||
                     resolve_node_num(from_id, message)
          node_id ||= format("!%08x", node_num & 0xFFFFFFFF) if node_num
          return false unless node_id

          payload = node_payload.merge(
            "num" => node_num,
            "lastHeard" => coerce_integer(node_payload["lastHeard"] || node_payload["last_heard"]) || rx_time,
            "snr" => node_payload.key?("snr") ? node_payload["snr"] : snr,
            "lora_freq" => common_payload["lora_freq"],
            "modem_preset" => common_payload["modem_preset"],
          )
          upsert_node(db, node_id, payload)
          debug_log(
            "Stored decrypted node payload",
            context: "data_processing.store_decrypted_payload",
            message_id: packet_id,
            portnum: portnum_value,
            node_id: node_id,
          )
          true
        when "TELEMETRY_APP"
          payload = common_payload.merge("telemetry" => decoded["payload"])
          insert_telemetry(db, payload)
          debug_log(
            "Stored decrypted telemetry payload",
            context: "data_processing.store_decrypted_payload",
            message_id: packet_id,
            portnum: portnum_value,
          )
          true
        when "NEIGHBORINFO_APP"
          neighbor_payload = decoded["payload"]
          neighbors = neighbor_payload["neighbors"]
          neighbors = [] unless neighbors.is_a?(Array)
          normalized_neighbors = neighbors.map do |neighbor|
            next unless neighbor.is_a?(Hash)
            {
              "neighbor_id" => neighbor["node_id"] || neighbor["nodeId"] || neighbor["id"],
              "snr" => neighbor["snr"],
              "rx_time" => neighbor["last_rx_time"],
            }.compact
          end.compact
          return false if normalized_neighbors.empty?

          payload = common_payload.merge(
            "node_id" => neighbor_payload["node_id"] || from_id,
            "neighbors" => normalized_neighbors,
            "node_broadcast_interval_secs" => neighbor_payload["node_broadcast_interval_secs"],
            "last_sent_by_id" => neighbor_payload["last_sent_by_id"],
          )
          insert_neighbors(db, payload)
          debug_log(
            "Stored decrypted neighbor payload",
            context: "data_processing.store_decrypted_payload",
            message_id: packet_id,
            portnum: portnum_value,
          )
          true
        when "TRACEROUTE_APP"
          route = decoded["payload"]["route"]
          route_back = decoded["payload"]["route_back"]
          hops = route.is_a?(Array) ? route : route_back.is_a?(Array) ? route_back : []
          dest = hops.last if hops.is_a?(Array) && !hops.empty?
          src_num = coerce_integer(message["from_num"]) || resolve_node_num(from_id, message)
          payload = common_payload.merge(
            "src" => src_num,
            "dest" => dest,
            "hops" => hops,
          )
          insert_trace(db, payload)
          debug_log(
            "Stored decrypted traceroute payload",
            context: "data_processing.store_decrypted_payload",
            message_id: packet_id,
            portnum: portnum_value,
          )
          true
        else
          false
        end
      end

      # Validate decoded NodeInfo payloads before upserting node records.
      #
      # @param payload [Object] decoded payload candidate.
      # @return [Boolean] true when the payload resembles a Meshtastic NodeInfo.
      def valid_decrypted_nodeinfo_payload?(payload)
        return false unless payload.is_a?(Hash)
        return false if payload.empty?
        return false unless payload["user"].is_a?(Hash)

        return false if payload.key?("position") && !payload["position"].is_a?(Hash)
        return false if payload.key?("deviceMetrics") && !payload["deviceMetrics"].is_a?(Hash)
        return false unless nodeinfo_user_has_identifying_fields?(payload["user"])

        true
      end

      # Normalize decoded NodeInfo payload keys for +upsert_node+ compatibility.
      #
      # The Python decoder preserves protobuf field names, so nested hashes may
      # use +snake_case+ keys that +upsert_node+ does not read.
      #
      # @param payload [Object] decoded NodeInfo payload.
      # @return [Hash] normalized payload hash.
      def normalize_decrypted_nodeinfo_payload(payload)
        return {} unless payload.is_a?(Hash)

        user = payload["user"]
        normalized_user = user.is_a?(Hash) ? user.dup : nil
        if normalized_user
          normalized_user["shortName"] ||= normalized_user["short_name"]
          normalized_user["longName"] ||= normalized_user["long_name"]
          normalized_user["hwModel"] ||= normalized_user["hw_model"]
          normalized_user["publicKey"] ||= normalized_user["public_key"]
          normalized_user["isUnmessagable"] = normalized_user["is_unmessagable"] if normalized_user.key?("is_unmessagable")
        end

        metrics = payload["deviceMetrics"] || payload["device_metrics"]
        normalized_metrics = metrics.is_a?(Hash) ? metrics.dup : nil
        if normalized_metrics
          normalized_metrics["batteryLevel"] ||= normalized_metrics["battery_level"]
          normalized_metrics["channelUtilization"] ||= normalized_metrics["channel_utilization"]
          normalized_metrics["airUtilTx"] ||= normalized_metrics["air_util_tx"]
          normalized_metrics["uptimeSeconds"] ||= normalized_metrics["uptime_seconds"]
        end

        position = payload["position"]
        normalized_position = position.is_a?(Hash) ? position.dup : nil
        if normalized_position
          normalized_position["precisionBits"] ||= normalized_position["precision_bits"]
          normalized_position["locationSource"] ||= normalized_position["location_source"]
        end

        normalized = payload.dup
        normalized["user"] = normalized_user if normalized_user
        normalized["deviceMetrics"] = normalized_metrics if normalized_metrics
        normalized["position"] = normalized_position if normalized_position
        normalized["lastHeard"] ||= normalized["last_heard"]
        normalized["hopsAway"] ||= normalized["hops_away"]
        normalized["isFavorite"] = normalized["is_favorite"] if normalized.key?("is_favorite")
        normalized["hwModel"] ||= normalized["hw_model"]
        normalized
      end

      # Validate that a decoded NodeInfo user section contains identifying data.
      #
      # @param user [Hash] decoded NodeInfo user payload.
      # @return [Boolean] true when at least one identifying field is present.
      def nodeinfo_user_has_identifying_fields?(user)
        identifying_fields = [
          user["id"],
          user["shortName"],
          user["short_name"],
          user["longName"],
          user["long_name"],
          user["macaddr"],
          user["hwModel"],
          user["hw_model"],
          user["publicKey"],
          user["public_key"],
        ]

        identifying_fields.any? do |value|
          value.is_a?(String) ? !value.strip.empty? : !value.nil?
        end
      end
    end
  end
end
