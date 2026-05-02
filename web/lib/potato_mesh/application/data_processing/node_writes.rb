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
      # Insert a hidden placeholder node when an unknown reference is encountered.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param node_ref [Object] raw node reference from the inbound payload.
      # @param fallback_num [Integer, nil] numeric fallback when +node_ref+ is nil.
      # @param heard_time [Integer, nil] timestamp to record as +last_heard+/+first_heard+.
      # @param protocol [String] protocol identifier for placeholder generation.
      # @return [Boolean, nil] true when a row was inserted, false/nil otherwise.
      def ensure_unknown_node(db, node_ref, fallback_num = nil, heard_time: nil, protocol: "meshtastic")
        parts = canonical_node_parts(node_ref, fallback_num)
        return unless parts

        node_id, node_num, short_id = parts
        return if broadcast_node_ref?(node_id, node_num)

        existing = db.get_first_value(
          "SELECT 1 FROM nodes WHERE node_id = ? LIMIT 1",
          [node_id],
        )
        return if existing

        long_name = "#{protocol_display_label(protocol)} #{short_id}"
        default_role = case protocol
          when "meshcore" then "COMPANION"
          else "CLIENT_HIDDEN"
          end
        heard_time = coerce_integer(heard_time)
        inserted = false

        with_busy_retry do
          db.execute(
            <<~SQL,
            INSERT OR IGNORE INTO nodes(node_id,num,short_name,long_name,role,last_heard,first_heard,protocol)
            VALUES (?,?,?,?,?,?,?,?)
          SQL
            [node_id, node_num, short_id, long_name, default_role, heard_time, heard_time, protocol],
          )
          inserted = db.changes.positive?
        end

        if inserted
          debug_log(
            "Created hidden placeholder node",
            context: "data_processing.ensure_unknown_node",
            node_id: node_id,
            reference: node_ref,
            fallback: fallback_num,
            heard_time: heard_time,
          )
        end

        inserted
      end

      # Refresh a node's +last_heard+, +first_heard+, +lora_freq+, and
      # +modem_preset+ columns from a freshly received packet.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param node_ref [Object] raw node reference.
      # @param fallback_num [Integer, nil] numeric fallback when +node_ref+ is nil.
      # @param rx_time [Integer, nil] receive timestamp; the method exits early when nil.
      # @param source [Symbol, nil] originating subsystem (used for debug logs).
      # @param lora_freq [Integer, nil] LoRa frequency; only updated when non-nil.
      # @param modem_preset [String, nil] modem preset name; only updated when non-nil.
      # @return [Boolean] true when at least one row was updated.
      def touch_node_last_seen(
        db,
        node_ref,
        fallback_num = nil,
        rx_time: nil,
        source: nil,
        lora_freq: nil,
        modem_preset: nil
      )
        timestamp = coerce_integer(rx_time)
        return unless timestamp

        node_id = nil

        parts = canonical_node_parts(node_ref, fallback_num)
        if parts
          node_id, node_num = parts
          return if broadcast_node_ref?(node_id, node_num)
        end

        unless node_id
          trimmed = string_or_nil(node_ref)
          if trimmed
            node_id = normalize_node_id(db, trimmed) || trimmed
          elsif fallback_num
            fallback_parts = canonical_node_parts(fallback_num, nil)
            node_id, = fallback_parts if fallback_parts
          end
        end

        return if broadcast_node_ref?(node_id, fallback_num)
        return unless node_id

        lora_freq = coerce_integer(lora_freq)
        modem_preset = string_or_nil(modem_preset)
        updated = false
        with_busy_retry do
          db.execute <<~SQL, [timestamp, timestamp, timestamp, lora_freq, modem_preset, node_id]
                       UPDATE nodes
                          SET last_heard = CASE
                            WHEN COALESCE(last_heard, 0) >= ? THEN last_heard
                            ELSE ?
                          END,
                              first_heard = COALESCE(first_heard, ?),
                              lora_freq = COALESCE(?, lora_freq),
                              modem_preset = COALESCE(?, modem_preset)
                        WHERE node_id = ?
                     SQL
          updated ||= db.changes.positive?
        end

        if updated
          debug_log(
            "Updated node last seen timestamp",
            context: "data_processing.touch_node_last_seen",
            node_id: node_id,
            timestamp: timestamp,
            source: source || :unknown,
            lora_freq: lora_freq,
            modem_preset: modem_preset,
          )
        end

        updated
      end

      # Insert or update a node row from an inbound NodeInfo-style payload.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param node_id [String] canonical node identifier.
      # @param n [Hash] node payload extracted from the ingestor.
      # @param protocol [String] protocol identifier (default +meshtastic+).
      # @return [void]
      def upsert_node(db, node_id, n, protocol: "meshtastic")
        user = n["user"] || {}
        met = n["deviceMetrics"] || {}
        pos = n["position"] || {}
        # nil when user info absent; COALESCE in the conflict clause preserves
        # the stored role rather than overwriting with a default.
        role = user["role"]
        lh = coerce_integer(n["lastHeard"])
        pt = coerce_integer(pos["time"])
        now = Time.now.to_i
        pt = nil if pt && pt > now
        lh = now if lh && lh > now
        # 0 is truthy in Ruby — `lh ||= now` won't replace it, leaving the
        # 7-day list filter to evaluate `0 >= now-7days` → false (node hidden).
        lh = nil if lh && lh <= 0
        # position.time = 0 means no GPS fix; skip it as a last_heard anchor
        # (would re-introduce the same zero-timestamp exclusion bug for lh).
        lh = pt if pt && pt > 0 && (!lh || lh < pt)
        lh ||= now
        node_num = resolve_node_num(node_id, n)

        update_prometheus_metrics(node_id, user, role, met, pos)

        lora_freq = coerce_integer(n["lora_freq"] || n["loraFrequency"])
        modem_preset = string_or_nil(n["modem_preset"] || n["modemPreset"])
        # Synthetic flag: true for placeholder nodes created from channel message
        # sender names before the real contact advertisement is received.
        synthetic = user["synthetic"] ? 1 : 0
        long_name = user["longName"]

        # If the incoming long name is a generic placeholder, prefer any real
        # name already on record so we never stomp known data with fallback
        # text.  For new nodes there is nothing to preserve, so the generic
        # name is still written via the INSERT VALUES path.
        long_name_conflict_sql = if generic_fallback_name?(long_name, node_id, protocol)
            # Generic placeholder: keep any real name already on record.
            # COALESCE returns nodes.long_name when non-null, otherwise falls
            # back to the incoming generic — so brand-new nodes still get it.
            "COALESCE(nodes.long_name, excluded.long_name)"
          else
            # Real name (or nil): use the incoming value, preserving the
            # existing name only when the incoming value is nil.  A nil
            # long_name in the packet carries no information, so falling back
            # to what we already have is better than overwriting with NULL.
            "COALESCE(excluded.long_name, nodes.long_name)"
          end

        row = [
          node_id,
          node_num,
          user["shortName"],
          long_name,
          user["macaddr"],
          user["hwModel"] || n["hwModel"],
          role,
          user["publicKey"],
          coerce_bool(user["isUnmessagable"]),
          coerce_bool(n["isFavorite"]),
          n["hopsAway"],
          n["snr"],
          lh,
          lh,
          met["batteryLevel"],
          met["voltage"],
          met["channelUtilization"],
          met["airUtilTx"],
          met["uptimeSeconds"],
          pt,
          pos["locationSource"],
          coerce_integer(
            pos["precisionBits"] ||
              pos["precision_bits"] ||
              pos.dig("raw", "precision_bits"),
          ),
          pos["latitude"],
          pos["longitude"],
          pos["altitude"],
          lora_freq,
          modem_preset,
          protocol,
          synthetic,
        ]
        with_busy_retry do
          db.transaction do
            db.execute(<<~SQL, row)
              INSERT INTO nodes(node_id,num,short_name,long_name,macaddr,hw_model,role,public_key,is_unmessagable,is_favorite,
                                hops_away,snr,last_heard,first_heard,battery_level,voltage,channel_utilization,air_util_tx,uptime_seconds,
                                position_time,location_source,precision_bits,latitude,longitude,altitude,lora_freq,modem_preset,protocol,synthetic)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(node_id) DO UPDATE SET
                num=COALESCE(excluded.num, nodes.num),
                short_name=COALESCE(excluded.short_name, nodes.short_name),
                long_name=#{long_name_conflict_sql},
                macaddr=COALESCE(excluded.macaddr, nodes.macaddr),
                hw_model=COALESCE(excluded.hw_model, nodes.hw_model),
                role=COALESCE(excluded.role, nodes.role),
                public_key=COALESCE(excluded.public_key, nodes.public_key),
                is_unmessagable=COALESCE(excluded.is_unmessagable, nodes.is_unmessagable),
                is_favorite=excluded.is_favorite, hops_away=excluded.hops_away, snr=excluded.snr, last_heard=excluded.last_heard,
                first_heard=COALESCE(nodes.first_heard, excluded.first_heard, excluded.last_heard),
                battery_level=excluded.battery_level, voltage=excluded.voltage, channel_utilization=excluded.channel_utilization,
                air_util_tx=excluded.air_util_tx, uptime_seconds=excluded.uptime_seconds,
                position_time=COALESCE(excluded.position_time, nodes.position_time),
                location_source=COALESCE(excluded.location_source, nodes.location_source),
                precision_bits=COALESCE(excluded.precision_bits, nodes.precision_bits),
                latitude=COALESCE(excluded.latitude, nodes.latitude),
                longitude=COALESCE(excluded.longitude, nodes.longitude),
                altitude=COALESCE(excluded.altitude, nodes.altitude),
                lora_freq=excluded.lora_freq, modem_preset=excluded.modem_preset,
                protocol=COALESCE(NULLIF(nodes.protocol,'meshtastic'), excluded.protocol),
                synthetic=MIN(COALESCE(excluded.synthetic,1), COALESCE(nodes.synthetic,1))
              WHERE COALESCE(excluded.last_heard,0) >= COALESCE(nodes.last_heard,0)
                AND NOT (COALESCE(nodes.synthetic,0) = 0 AND excluded.synthetic = 1)
            SQL

            # Reconcile synthetic placeholder rows with their real counterparts
            # whenever a MeshCore node is upserted.  Both directions must fire —
            # the arrival order of chat messages vs contact advertisements is
            # not guaranteed and may differ across co-operating ingestors that
            # share this database.  See issue #755.
            if protocol == "meshcore" && long_name && !long_name.empty?
              if synthetic == 0
                merge_synthetic_nodes(db, node_id, long_name)
              else
                merge_into_real_node(db, node_id, long_name)
              end
            end
          end
        end
      end

      # Migrate messages from synthetic placeholder nodes to a newly confirmed
      # real node, then remove the placeholders.
      #
      # Called inside a transaction from +upsert_node+ when a real (non-synthetic)
      # MeshCore node with the same +long_name+ is upserted.
      #
      # Only +messages.from_id+ is migrated.  Synthetic nodes are placeholders
      # created solely from parsed channel message sender names, so they cannot
      # have associated positions, telemetry, neighbors, or traces — those tables
      # are intentionally left untouched.
      #
      # @param db [SQLite3::Database] open database connection.
      # @param real_node_id [String] canonical node ID for the real contact.
      # @param long_name [String] long name to match against synthetic rows.
      # @return [void]
      def merge_synthetic_nodes(db, real_node_id, long_name)
        # long_name is user-editable and not unique across pubkeys — two real
        # meshcore devices can legitimately share the same display name.  When
        # that happens we cannot tell which real node a given chat-derived
        # synthetic was acting as placeholder for, so any merge would risk
        # mis-attributing messages.  Bail out and leave the synthetic intact.
        other_real = db.execute(
          "SELECT 1 FROM nodes WHERE long_name = ? AND synthetic = 0 AND protocol = 'meshcore' AND node_id != ? LIMIT 1",
          [long_name, real_node_id],
        ).first
        return if other_real

        synthetic_ids = db.execute(
          "SELECT node_id FROM nodes WHERE long_name = ? AND synthetic = 1 AND protocol = 'meshcore' AND node_id != ?",
          [long_name, real_node_id],
        ).map { |row| row[0] }

        synthetic_ids.each do |synthetic_id|
          db.execute(
            "UPDATE messages SET from_id = ? WHERE from_id = ?",
            [real_node_id, synthetic_id],
          )
          db.execute(
            "DELETE FROM nodes WHERE node_id = ? AND synthetic = 1",
            [synthetic_id],
          )
        end
      end

      # Reverse of +merge_synthetic_nodes+: when a synthetic placeholder is
      # upserted for a MeshCore sender whose real contact advertisement has
      # already been stored (e.g. by a co-operating ingestor that saw the
      # advertisement first), migrate any messages from the synthetic id to the
      # real id and drop the synthetic row.
      #
      # Fixes duplication bug #755 where a chat-derived synthetic node and a
      # pubkey-derived real node coexisted because the forward merge only fired
      # on real-node upserts and never back-filled late-arriving synthetics.
      #
      # @param db [SQLite3::Database] open database connection.
      # @param synthetic_node_id [String] canonical node ID of the synthetic placeholder being upserted.
      # @param long_name [String] long name to match against existing real rows.
      # @return [void]
      def merge_into_real_node(db, synthetic_node_id, long_name)
        # Index by [0] rather than the hash key so this works whether the db
        # handle was opened with results_as_hash = true or not.
        real_rows = db.execute(
          "SELECT node_id FROM nodes WHERE long_name = ? AND synthetic = 0 AND protocol = 'meshcore' AND node_id != ? LIMIT 2",
          [long_name, synthetic_node_id],
        )
        # Ambiguous name: two distinct real meshcore devices share this
        # long_name.  The synthetic placeholder could legitimately represent
        # either, so we cannot pick one without risking mis-attribution.  Leave
        # the synthetic in place; an operator can resolve the duplicate
        # manually.
        return if real_rows.length > 1

        row = real_rows.first
        return unless row

        real_node_id = row[0]
        return unless real_node_id

        db.execute(
          "UPDATE messages SET from_id = ? WHERE from_id = ?",
          [real_node_id, synthetic_node_id],
        )
        db.execute(
          "DELETE FROM nodes WHERE node_id = ? AND synthetic = 1",
          [synthetic_node_id],
        )
      end

      # Update node row columns from a freshly observed position record.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param node_id [String, nil] canonical node identifier.
      # @param node_num [Integer, nil] numeric node identifier.
      # @param rx_time [Integer, nil] receive time.
      # @param position_time [Integer, nil] timestamp from the position payload.
      # @param location_source [String, nil] +location_source+ enum value.
      # @param precision_bits [Integer, nil] horizontal precision bits.
      # @param latitude [Float, nil] decoded latitude.
      # @param longitude [Float, nil] decoded longitude.
      # @param altitude [Float, nil] decoded altitude.
      # @param snr [Float, nil] signal-to-noise ratio.
      # @return [void]
      def update_node_from_position(db, node_id, node_num, rx_time, position_time, location_source, precision_bits, latitude, longitude, altitude, snr)
        num = coerce_integer(node_num)
        id = string_or_nil(node_id)
        if id&.start_with?("!")
          id = "!#{id.delete_prefix("!").downcase}"
        end
        id ||= format("!%08x", num & 0xFFFFFFFF) if num
        return unless id

        now = Time.now.to_i
        rx = coerce_integer(rx_time) || now
        rx = now if rx && rx > now
        pos_time = coerce_integer(position_time)
        pos_time = nil if pos_time && pos_time > now
        last_heard = [rx, pos_time].compact.max || rx
        last_heard = now if last_heard && last_heard > now

        loc = string_or_nil(location_source)
        lat = coerce_float(latitude)
        lon = coerce_float(longitude)
        alt = coerce_float(altitude)
        precision = coerce_integer(precision_bits)
        snr_val = coerce_float(snr)

        update_prometheus_metrics(node_id, nil, nil, nil, {
          "latitude" => lat,
          "longitude" => lon,
          "altitude" => alt,
        })

        row = [
          id,
          num,
          last_heard,
          last_heard,
          pos_time,
          loc,
          precision,
          lat,
          lon,
          alt,
          snr_val,
        ]
        with_busy_retry do
          db.execute <<~SQL, row
                       INSERT INTO nodes(node_id,num,last_heard,first_heard,position_time,location_source,precision_bits,latitude,longitude,altitude,snr)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(node_id) DO UPDATE SET
                         num=COALESCE(excluded.num,nodes.num),
                         snr=COALESCE(excluded.snr,nodes.snr),
                         last_heard=MAX(COALESCE(nodes.last_heard,0),COALESCE(excluded.last_heard,0)),
                         first_heard=COALESCE(nodes.first_heard, excluded.first_heard, excluded.last_heard),
                         position_time=CASE
                           WHEN COALESCE(excluded.position_time,0) >= COALESCE(nodes.position_time,0)
                             THEN excluded.position_time
                           ELSE nodes.position_time
                         END,
                         location_source=CASE
                           WHEN COALESCE(excluded.position_time,0) >= COALESCE(nodes.position_time,0)
                                AND excluded.location_source IS NOT NULL
                             THEN excluded.location_source
                           ELSE nodes.location_source
                         END,
                         precision_bits=CASE
                           WHEN COALESCE(excluded.position_time,0) >= COALESCE(nodes.position_time,0)
                                AND excluded.precision_bits IS NOT NULL
                             THEN excluded.precision_bits
                           ELSE nodes.precision_bits
                         END,
                         latitude=CASE
                           WHEN COALESCE(excluded.position_time,0) >= COALESCE(nodes.position_time,0)
                                AND excluded.latitude IS NOT NULL
                             THEN excluded.latitude
                           ELSE nodes.latitude
                         END,
                         longitude=CASE
                           WHEN COALESCE(excluded.position_time,0) >= COALESCE(nodes.position_time,0)
                                AND excluded.longitude IS NOT NULL
                             THEN excluded.longitude
                           ELSE nodes.longitude
                         END,
                         altitude=CASE
                           WHEN COALESCE(excluded.position_time,0) >= COALESCE(nodes.position_time,0)
                                AND excluded.altitude IS NOT NULL
                             THEN excluded.altitude
                           ELSE nodes.altitude
                         END
                     SQL
        end
      end

      # Update node columns based on metrics included in a telemetry packet.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param node_id [String, nil] canonical node identifier.
      # @param node_num [Integer, nil] numeric node identifier.
      # @param rx_time [Integer, nil] receive time used as +last_heard+.
      # @param metrics [Hash] decoded telemetry metric map.
      # @param lora_freq [Integer, nil] optional LoRa frequency.
      # @param modem_preset [String, nil] optional modem preset.
      # @param protocol [String] protocol identifier (default +meshtastic+).
      # @return [void]
      def update_node_from_telemetry(
        db,
        node_id,
        node_num,
        rx_time,
        metrics = {},
        lora_freq: nil,
        modem_preset: nil,
        protocol: "meshtastic"
      )
        num = coerce_integer(node_num)
        id = string_or_nil(node_id)
        if id&.start_with?("!")
          id = "!#{id.delete_prefix("!").downcase}"
        end
        id ||= format("!%08x", num & 0xFFFFFFFF) if num
        return unless id

        ensure_unknown_node(db, id, num, heard_time: rx_time, protocol: protocol)
        touch_node_last_seen(
          db,
          id,
          num,
          rx_time: rx_time,
          source: :telemetry,
          lora_freq: lora_freq,
          modem_preset: modem_preset,
        )

        battery = coerce_float(metrics[:battery_level] || metrics["battery_level"])
        voltage = coerce_float(metrics[:voltage] || metrics["voltage"])
        channel_util = coerce_float(metrics[:channel_utilization] || metrics["channel_utilization"])
        air_util_tx = coerce_float(metrics[:air_util_tx] || metrics["air_util_tx"])
        uptime = coerce_integer(metrics[:uptime_seconds] || metrics["uptime_seconds"])

        update_prometheus_metrics(node_id, nil, nil, {
          "batteryLevel" => battery,
          "voltage" => voltage,
          "uptimeSeconds" => uptime,
          "channelUtilization" => channel_util,
          "airUtilTx" => air_util_tx,
        }, nil)

        assignments = []
        params = []

        if num
          assignments << "num = ?"
          params << num
        end

        metric_updates = {
          "battery_level" => battery,
          "voltage" => voltage,
          "channel_utilization" => channel_util,
          "air_util_tx" => air_util_tx,
          "uptime_seconds" => uptime,
        }

        metric_updates.each do |column, value|
          next if value.nil?

          assignments << "#{column} = ?"
          params << value
        end

        return if assignments.empty?

        assignments_sql = assignments.join(", ")
        params << id

        with_busy_retry do
          db.execute("UPDATE nodes SET #{assignments_sql} WHERE node_id = ?", params)
        end
      end
    end
  end
end
