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
      # Persist a waypoint payload (SPEC W1/W5), populate the +nodes+ table for
      # newly seen senders, and advance the author node's +last_heard+.
      #
      # Rows upsert on +(id, protocol)+: a re-broadcast of the same waypoint id
      # replaces the content fields outright — the newest broadcast is the full
      # new state, so a cleared description or moved pin propagates — guarded by
      # +excluded.rx_time >= waypoints.rx_time+ so an out-of-order relay from a
      # second ingestor can never clobber a newer edit (cross-ingestor dedup,
      # C5 applied to POIs).
      #
      # @param db [SQLite3::Database] open database handle.
      # @param payload [Hash] inbound waypoint payload.
      # @param protocol_cache [Hash, nil] optional per-batch ingestor protocol cache.
      # @return [void]
      def insert_waypoint(db, payload, protocol_cache: nil)
        return unless payload.is_a?(Hash)

        waypoint_id = coerce_integer(payload["id"] || payload["waypoint_id"])
        return unless waypoint_id

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

          payload_for_num = payload.dup
          payload_for_num["num"] ||= raw_node_num if raw_node_num
          node_num = resolve_node_num(node_id, payload_for_num)
          node_num ||= raw_node_num
          canonical = normalize_node_id(db, node_id || node_num)
          node_id = canonical if canonical
        end

        ingestor = string_or_nil(payload["ingestor"])
        protocol = resolve_record_protocol(db, payload, ingestor, cache: protocol_cache)

        ensure_unknown_node(db, node_id || node_num, node_num, heard_time: rx_time, protocol: protocol)
        touch_node_last_seen(db, node_id || node_num, node_num, rx_time: rx_time, source: :waypoint)

        name = string_or_nil(payload["name"])
        description = string_or_nil(payload["description"])
        icon = coerce_integer(payload["icon"])

        lat = coerce_float(payload["latitude"])
        lon = coerce_float(payload["longitude"])
        lat ||= begin
            lat_i = coerce_integer(payload["latitude_i"] || payload["latitudeI"])
            lat_i ? lat_i / 1e7 : nil
          end
        lon ||= begin
            lon_i = coerce_integer(payload["longitude_i"] || payload["longitudeI"])
            lon_i ? lon_i / 1e7 : nil
          end
        # Paired (0, 0) is the Meshtastic "no fix" sentinel (issue #782); a
        # waypoint pinned there is meaningless, so collapse both axes to NULL.
        lat, lon = normalize_lat_lon(lat, lon)

        # 0/absent means "never expires" (SPEC W5); store NULL so the read-side
        # `expire IS NULL OR expire > now` exclusion treats it as immortal.
        expire = coerce_positive_or_nil(payload["expire"])

        locked_to = canonical_locked_to(payload["locked_to"] || payload["lockedTo"])

        snr = coerce_float(payload["snr"] || payload["rx_snr"] || payload["rxSnr"])
        rssi = coerce_integer(payload["rssi"] || payload["rx_rssi"] || payload["rxRssi"])
        hop_limit = coerce_integer(payload["hop_limit"] || payload["hopLimit"])
        payload_b64 = string_or_nil(payload["payload_b64"] || payload["payload"])

        row = [
          waypoint_id,
          node_id,
          node_num,
          rx_time,
          rx_iso,
          name,
          description,
          icon,
          lat,
          lon,
          expire,
          locked_to,
          snr,
          rssi,
          hop_limit,
          payload_b64,
          ingestor,
          protocol,
        ]

        with_busy_retry do
          db.execute <<~SQL, row
                       INSERT INTO waypoints(id,node_id,node_num,rx_time,rx_iso,name,description,icon,latitude,longitude,
                                             expire,locked_to,snr,rssi,hop_limit,payload_b64,ingestor,protocol)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(id, protocol) DO UPDATE SET
                         node_id=COALESCE(excluded.node_id,waypoints.node_id),
                         node_num=COALESCE(excluded.node_num,waypoints.node_num),
                         rx_time=excluded.rx_time,
                         rx_iso=excluded.rx_iso,
                         name=excluded.name,
                         description=excluded.description,
                         icon=excluded.icon,
                         latitude=excluded.latitude,
                         longitude=excluded.longitude,
                         expire=excluded.expire,
                         locked_to=excluded.locked_to,
                         snr=COALESCE(excluded.snr,waypoints.snr),
                         rssi=COALESCE(excluded.rssi,waypoints.rssi),
                         hop_limit=COALESCE(excluded.hop_limit,waypoints.hop_limit),
                         payload_b64=COALESCE(excluded.payload_b64,waypoints.payload_b64),
                         ingestor=COALESCE(NULLIF(waypoints.ingestor,''), excluded.ingestor)
                       WHERE excluded.rx_time >= waypoints.rx_time
                     SQL
        end
      end

      # Canonicalise a waypoint's +locked_to+ reference to the `!%08x` id space.
      #
      # Meshtastic transmits +locked_to+ as a node num (uint32) where +0+ means
      # "not locked"; ingestors may also relay an already-canonical id string.
      # Both are mapped onto the canonical id (C3); unlockable values yield nil.
      #
      # @param value [Object] raw +locked_to+ reference (num, hex string, or nil).
      # @return [String, nil] canonical `!%08x` id, or nil when unlocked/invalid.
      def canonical_locked_to(value)
        numeric = coerce_integer(value)
        return nil if numeric&.zero?

        parts = canonical_node_parts(value, nil)
        parts&.first
      end
    end
  end
end
