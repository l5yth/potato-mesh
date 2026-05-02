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
      # Persist a position payload, populate the +nodes+ table for newly seen
      # senders, and update node rows with the freshest GPS fields.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param payload [Hash] inbound position payload.
      # @param protocol_cache [Hash, nil] optional per-batch ingestor protocol cache.
      # @return [void]
      def insert_position(db, payload, protocol_cache: nil)
        pos_id = coerce_integer(payload["id"] || payload["packet_id"])
        return unless pos_id

        now = Time.now.to_i
        rx_time = coerce_integer(payload["rx_time"])
        rx_time = now if rx_time.nil? || rx_time > now
        rx_iso = string_or_nil(payload["rx_iso"])
        rx_iso ||= Time.at(rx_time).utc.iso8601

        raw_node_id = payload["node_id"] || payload["from_id"] || payload["from"]
        raw_node_num = coerce_integer(payload["node_num"]) || coerce_integer(payload["num"])

        canonical_parts = canonical_node_parts(raw_node_id, raw_node_num)
        if canonical_parts
          node_id, node_num, = canonical_parts
        else
          node_id = string_or_nil(raw_node_id)
          node_id = "!#{node_id.delete_prefix("!").downcase}" if node_id&.start_with?("!")
          node_id ||= format("!%08x", raw_node_num & 0xFFFFFFFF) if node_id.nil? && raw_node_num

          payload_for_num = payload.is_a?(Hash) ? payload.dup : {}
          payload_for_num["num"] ||= raw_node_num if raw_node_num
          node_num = resolve_node_num(node_id, payload_for_num)
          node_num ||= raw_node_num
          canonical = normalize_node_id(db, node_id || node_num)
          node_id = canonical if canonical
        end

        lora_freq = coerce_integer(payload["lora_freq"] || payload["loraFrequency"])
        modem_preset = string_or_nil(payload["modem_preset"] || payload["modemPreset"])
        ingestor = string_or_nil(payload["ingestor"])
        protocol = resolve_protocol(db, ingestor, cache: protocol_cache)

        ensure_unknown_node(db, node_id || node_num, node_num, heard_time: rx_time, protocol: protocol)
        touch_node_last_seen(
          db,
          node_id || node_num,
          node_num,
          rx_time: rx_time,
          source: :position,
          lora_freq: lora_freq,
          modem_preset: modem_preset,
        )

        to_id = string_or_nil(payload["to_id"] || payload["to"])

        position_section = payload["position"].is_a?(Hash) ? payload["position"] : {}

        lat = coerce_float(payload["latitude"]) || coerce_float(position_section["latitude"])
        lon = coerce_float(payload["longitude"]) || coerce_float(position_section["longitude"])
        alt = coerce_float(payload["altitude"]) || coerce_float(position_section["altitude"])

        lat ||= begin
            lat_i = coerce_integer(position_section["latitudeI"] || position_section["latitude_i"] || position_section.dig("raw", "latitude_i"))
            lat_i ? lat_i / 1e7 : nil
          end
        lon ||= begin
            lon_i = coerce_integer(position_section["longitudeI"] || position_section["longitude_i"] || position_section.dig("raw", "longitude_i"))
            lon_i ? lon_i / 1e7 : nil
          end
        alt ||= coerce_float(position_section.dig("raw", "altitude"))

        position_time = coerce_integer(
          payload["position_time"] ||
            position_section["time"] ||
            position_section.dig("raw", "time"),
        )

        location_source = string_or_nil(
          payload["location_source"] ||
            payload["locationSource"] ||
            position_section["location_source"] ||
            position_section["locationSource"] ||
            position_section.dig("raw", "location_source"),
        )

        precision_bits = coerce_integer(
          payload["precision_bits"] ||
            payload["precisionBits"] ||
            position_section["precision_bits"] ||
            position_section["precisionBits"] ||
            position_section.dig("raw", "precision_bits"),
        )

        sats_in_view = coerce_integer(
          payload["sats_in_view"] ||
            payload["satsInView"] ||
            position_section["sats_in_view"] ||
            position_section["satsInView"] ||
            position_section.dig("raw", "sats_in_view"),
        )

        pdop = coerce_float(
          payload["pdop"] ||
            payload["PDOP"] ||
            position_section["pdop"] ||
            position_section["PDOP"] ||
            position_section.dig("raw", "PDOP") ||
            position_section.dig("raw", "pdop"),
        )

        ground_speed = coerce_float(
          payload["ground_speed"] ||
            payload["groundSpeed"] ||
            position_section["ground_speed"] ||
            position_section["groundSpeed"] ||
            position_section.dig("raw", "ground_speed"),
        )

        ground_track = coerce_float(
          payload["ground_track"] ||
            payload["groundTrack"] ||
            position_section["ground_track"] ||
            position_section["groundTrack"] ||
            position_section.dig("raw", "ground_track"),
        )

        snr = coerce_float(payload["snr"] || payload["rx_snr"] || payload["rxSnr"])
        rssi = coerce_integer(payload["rssi"] || payload["rx_rssi"] || payload["rxRssi"])
        hop_limit = coerce_integer(payload["hop_limit"] || payload["hopLimit"])
        bitfield = coerce_integer(payload["bitfield"])

        payload_b64 = string_or_nil(payload["payload_b64"] || payload["payload"])
        payload_b64 ||= string_or_nil(position_section.dig("payload", "__bytes_b64__"))

        row = [
          pos_id,
          node_id,
          node_num,
          rx_time,
          rx_iso,
          position_time,
          to_id,
          lat,
          lon,
          alt,
          location_source,
          precision_bits,
          sats_in_view,
          pdop,
          ground_speed,
          ground_track,
          snr,
          rssi,
          hop_limit,
          bitfield,
          payload_b64,
          ingestor,
          protocol,
        ]

        with_busy_retry do
          db.execute <<~SQL, row
                       INSERT INTO positions(id,node_id,node_num,rx_time,rx_iso,position_time,to_id,latitude,longitude,altitude,location_source,
                                             precision_bits,sats_in_view,pdop,ground_speed,ground_track,snr,rssi,hop_limit,bitfield,payload_b64,ingestor,protocol)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(id) DO UPDATE SET
                         node_id=COALESCE(excluded.node_id,positions.node_id),
                         node_num=COALESCE(excluded.node_num,positions.node_num),
                         rx_time=excluded.rx_time,
                         rx_iso=excluded.rx_iso,
                         position_time=COALESCE(excluded.position_time,positions.position_time),
                         to_id=COALESCE(excluded.to_id,positions.to_id),
                         latitude=COALESCE(excluded.latitude,positions.latitude),
                         longitude=COALESCE(excluded.longitude,positions.longitude),
                         altitude=COALESCE(excluded.altitude,positions.altitude),
                         location_source=COALESCE(excluded.location_source,positions.location_source),
                         precision_bits=COALESCE(excluded.precision_bits,positions.precision_bits),
                         sats_in_view=COALESCE(excluded.sats_in_view,positions.sats_in_view),
                         pdop=COALESCE(excluded.pdop,positions.pdop),
                         ground_speed=COALESCE(excluded.ground_speed,positions.ground_speed),
                         ground_track=COALESCE(excluded.ground_track,positions.ground_track),
                         snr=COALESCE(excluded.snr,positions.snr),
                         rssi=COALESCE(excluded.rssi,positions.rssi),
                         hop_limit=COALESCE(excluded.hop_limit,positions.hop_limit),
                         bitfield=COALESCE(excluded.bitfield,positions.bitfield),
                         payload_b64=COALESCE(excluded.payload_b64,positions.payload_b64),
                         ingestor=COALESCE(NULLIF(positions.ingestor,''), excluded.ingestor),
                         protocol=COALESCE(NULLIF(positions.protocol,'meshtastic'), excluded.protocol)
                     SQL
        end

        update_node_from_position(
          db,
          node_id,
          node_num,
          rx_time,
          position_time,
          location_source,
          precision_bits,
          lat,
          lon,
          alt,
          snr,
        )
      end
    end
  end
end
