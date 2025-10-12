# frozen_string_literal: true

module PotatoMesh
  module App
    module DataProcessing
      def resolve_node_num(node_id, payload)
        raw = payload["num"]

        case raw
        when Integer
          return raw
        when Numeric
          return raw.to_i
        when String
          trimmed = raw.strip
          return nil if trimmed.empty?
          return Integer(trimmed, 10) if trimmed.match?(/\A[0-9]+\z/)
          return Integer(trimmed.delete_prefix("0x").delete_prefix("0X"), 16) if trimmed.match?(/\A0[xX][0-9A-Fa-f]+\z/)
          if trimmed.match?(/\A[0-9A-Fa-f]+\z/)
            canonical = node_id.is_a?(String) ? node_id.strip : ""
            return Integer(trimmed, 16) if canonical.match?(/\A!?[0-9A-Fa-f]+\z/)
          end
        end

        return nil unless node_id.is_a?(String)

        hex = node_id.strip
        return nil if hex.empty?
        hex = hex.delete_prefix("!")
        return nil unless hex.match?(/\A[0-9A-Fa-f]+\z/)

        Integer(hex, 16)
      rescue ArgumentError
        nil
      end

      def canonical_node_parts(node_ref, fallback_num = nil)
        fallback = coerce_integer(fallback_num)

        hex = nil
        num = nil

        case node_ref
        when Integer
          num = node_ref
        when Numeric
          num = node_ref.to_i
        when String
          trimmed = node_ref.strip
          return nil if trimmed.empty?

          if trimmed.start_with?("!")
            hex = trimmed.delete_prefix("!")
          elsif trimmed.match?(/\A0[xX][0-9A-Fa-f]+\z/)
            hex = trimmed[2..].to_s
          elsif trimmed.match?(/\A-?\d+\z/)
            num = trimmed.to_i
          elsif trimmed.match?(/\A[0-9A-Fa-f]+\z/)
            hex = trimmed
          else
            return nil
          end
        when nil
          num = fallback if fallback
        else
          return nil
        end

        num ||= fallback if fallback

        if hex
          begin
            num ||= Integer(hex, 16)
          rescue ArgumentError
            return nil
          end
        elsif num
          return nil if num.negative?
          hex = format("%08x", num & 0xFFFFFFFF)
        else
          return nil
        end

        return nil if hex.nil? || hex.empty?

        begin
          parsed = Integer(hex, 16)
        rescue ArgumentError
          return nil
        end

        parsed &= 0xFFFFFFFF
        canonical_hex = format("%08x", parsed)
        short_id = canonical_hex[-4, 4].upcase

        ["!#{canonical_hex}", parsed, short_id]
      end

      def ensure_unknown_node(db, node_ref, fallback_num = nil, heard_time: nil)
        parts = canonical_node_parts(node_ref, fallback_num)
        return unless parts

        node_id, node_num, short_id = parts

        existing = db.get_first_value(
          "SELECT 1 FROM nodes WHERE node_id = ? LIMIT 1",
          [node_id],
        )
        return if existing

        long_name = "Meshtastic #{short_id}"
        heard_time = coerce_integer(heard_time)
        inserted = false

        with_busy_retry do
          db.execute(
            <<~SQL,
            INSERT OR IGNORE INTO nodes(node_id,num,short_name,long_name,role,last_heard,first_heard)
            VALUES (?,?,?,?,?,?,?)
          SQL
            [node_id, node_num, short_id, long_name, "CLIENT_HIDDEN", heard_time, heard_time],
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

      def touch_node_last_seen(db, node_ref, fallback_num = nil, rx_time: nil, source: nil)
        timestamp = coerce_integer(rx_time)
        return unless timestamp

        node_id = nil

        parts = canonical_node_parts(node_ref, fallback_num)
        node_id, = parts if parts

        unless node_id
          trimmed = string_or_nil(node_ref)
          if trimmed
            node_id = normalize_node_id(db, trimmed) || trimmed
          elsif fallback_num
            fallback_parts = canonical_node_parts(fallback_num, nil)
            node_id, = fallback_parts if fallback_parts
          end
        end

        return unless node_id

        updated = false
        with_busy_retry do
          db.execute <<~SQL, [timestamp, timestamp, timestamp, node_id]
                       UPDATE nodes
                          SET last_heard = CASE
                            WHEN COALESCE(last_heard, 0) >= ? THEN last_heard
                            ELSE ?
                          END,
                              first_heard = COALESCE(first_heard, ?)
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
          )
        end

        updated
      end

      def upsert_node(db, node_id, n)
        user = n["user"] || {}
        met = n["deviceMetrics"] || {}
        pos = n["position"] || {}
        role = user["role"] || "CLIENT"
        lh = coerce_integer(n["lastHeard"])
        pt = coerce_integer(pos["time"])
        now = Time.now.to_i
        pt = nil if pt && pt > now
        lh = now if lh && lh > now
        lh = pt if pt && (!lh || lh < pt)
        lh ||= now
        bool = ->(v) {
          case v
          when true then 1
          when false then 0
          else v
          end
        }
        node_num = resolve_node_num(node_id, n)

        update_prometheus_metrics(node_id, user, role, met, pos)

        row = [
          node_id,
          node_num,
          user["shortName"],
          user["longName"],
          user["macaddr"],
          user["hwModel"] || n["hwModel"],
          role,
          user["publicKey"],
          bool.call(user["isUnmessagable"]),
          bool.call(n["isFavorite"]),
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
        ]
        with_busy_retry do
          db.execute <<~SQL, row
                       INSERT INTO nodes(node_id,num,short_name,long_name,macaddr,hw_model,role,public_key,is_unmessagable,is_favorite,
                                         hops_away,snr,last_heard,first_heard,battery_level,voltage,channel_utilization,air_util_tx,uptime_seconds,
                                         position_time,location_source,precision_bits,latitude,longitude,altitude)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(node_id) DO UPDATE SET
                         num=excluded.num, short_name=excluded.short_name, long_name=excluded.long_name, macaddr=excluded.macaddr,
                         hw_model=excluded.hw_model, role=excluded.role, public_key=excluded.public_key, is_unmessagable=excluded.is_unmessagable,
                         is_favorite=excluded.is_favorite, hops_away=excluded.hops_away, snr=excluded.snr, last_heard=excluded.last_heard,
                         first_heard=COALESCE(nodes.first_heard, excluded.first_heard, excluded.last_heard),
                         battery_level=excluded.battery_level, voltage=excluded.voltage, channel_utilization=excluded.channel_utilization,
                         air_util_tx=excluded.air_util_tx, uptime_seconds=excluded.uptime_seconds, position_time=excluded.position_time,
                         location_source=excluded.location_source, precision_bits=excluded.precision_bits, latitude=excluded.latitude, longitude=excluded.longitude,
                         altitude=excluded.altitude
                       WHERE COALESCE(excluded.last_heard,0) >= COALESCE(nodes.last_heard,0)
                     SQL
        end
      end

      def require_token!
        token = ENV["API_TOKEN"]
        provided = request.env["HTTP_AUTHORIZATION"].to_s.sub(/^Bearer\s+/i, "")
        halt 403, { error: "Forbidden" }.to_json unless token && !token.empty? && secure_token_match?(token, provided)
      end

      def secure_token_match?(expected, provided)
        return false unless expected.is_a?(String) && provided.is_a?(String)

        expected_bytes = expected.b
        provided_bytes = provided.b
        return false unless expected_bytes.bytesize == provided_bytes.bytesize
        Rack::Utils.secure_compare(expected_bytes, provided_bytes)
      rescue Rack::Utils::SecurityError
        false
      end

      def read_json_body(limit: nil)
        max_bytes = limit || PotatoMesh::Config.max_json_body_bytes
        max_bytes = max_bytes.to_i
        if max_bytes <= 0
          max_bytes = PotatoMesh::Config.max_json_body_bytes
        end

        body = request.body.read(max_bytes + 1)
        body = "" if body.nil?
        halt 413, { error: "payload too large" }.to_json if body.bytesize > max_bytes

        body
      ensure
        request.body.rewind if request.body.respond_to?(:rewind)
      end

      def prefer_canonical_sender?(message)
        message.is_a?(Hash) && message.key?("packet_id") && !message.key?("id")
      end

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

      def insert_position(db, payload)
        pos_id = coerce_integer(payload["id"] || payload["packet_id"])
        return unless pos_id

        now = Time.now.to_i
        rx_time = coerce_integer(payload["rx_time"])
        rx_time = now if rx_time.nil? || rx_time > now
        rx_iso = string_or_nil(payload["rx_iso"])
        rx_iso ||= Time.at(rx_time).utc.iso8601

        raw_node_id = payload["node_id"] || payload["from_id"] || payload["from"]
        node_id = string_or_nil(raw_node_id)
        node_id = "!#{node_id.delete_prefix("!").downcase}" if node_id&.start_with?("!")
        raw_node_num = coerce_integer(payload["node_num"]) || coerce_integer(payload["num"])
        node_id ||= format("!%08x", raw_node_num & 0xFFFFFFFF) if node_id.nil? && raw_node_num

        payload_for_num = payload.is_a?(Hash) ? payload.dup : {}
        payload_for_num["num"] ||= raw_node_num if raw_node_num
        node_num = resolve_node_num(node_id, payload_for_num)
        node_num ||= raw_node_num
        canonical = normalize_node_id(db, node_id || node_num)
        node_id = canonical if canonical

        ensure_unknown_node(db, node_id || node_num, node_num, heard_time: rx_time)
        touch_node_last_seen(db, node_id || node_num, node_num, rx_time: rx_time, source: :position)

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
        ]

        with_busy_retry do
          db.execute <<~SQL, row
                       INSERT INTO positions(id,node_id,node_num,rx_time,rx_iso,position_time,to_id,latitude,longitude,altitude,location_source,
                                             precision_bits,sats_in_view,pdop,ground_speed,ground_track,snr,rssi,hop_limit,bitfield,payload_b64)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
                         payload_b64=COALESCE(excluded.payload_b64,positions.payload_b64)
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

      def insert_neighbors(db, payload)
        return unless payload.is_a?(Hash)

        now = Time.now.to_i
        rx_time = coerce_integer(payload["rx_time"])
        rx_time = now if rx_time.nil? || rx_time > now

        raw_node_id = payload["node_id"] || payload["node"] || payload["from_id"]
        raw_node_num = coerce_integer(payload["node_num"]) || coerce_integer(payload["num"])

        canonical_parts = canonical_node_parts(raw_node_id, raw_node_num)
        if canonical_parts
          node_id, node_num, = canonical_parts
        else
          node_id = string_or_nil(raw_node_id)
          canonical = normalize_node_id(db, node_id || raw_node_num)
          node_id = canonical if canonical
          if node_id&.start_with?("!") && raw_node_num.nil?
            begin
              node_num = Integer(node_id.delete_prefix("!"), 16)
            rescue ArgumentError
              node_num = nil
            end
          else
            node_num = raw_node_num
          end
        end

        return unless node_id

        node_id = "!#{node_id.delete_prefix("!").downcase}" if node_id.start_with?("!")

        ensure_unknown_node(db, node_id || node_num, node_num, heard_time: rx_time)
        touch_node_last_seen(db, node_id || node_num, node_num, rx_time: rx_time, source: :neighborinfo)

        neighbor_entries = []
        neighbors_payload = payload["neighbors"]
        neighbors_list = neighbors_payload.is_a?(Array) ? neighbors_payload : []

        neighbors_list.each do |neighbor|
          next unless neighbor.is_a?(Hash)

          neighbor_ref = neighbor["neighbor_id"] || neighbor["node_id"] || neighbor["nodeId"] || neighbor["id"]
          neighbor_num = coerce_integer(
            neighbor["neighbor_num"] || neighbor["node_num"] || neighbor["nodeId"] || neighbor["id"],
          )

          canonical_neighbor = canonical_node_parts(neighbor_ref, neighbor_num)
          if canonical_neighbor
            neighbor_id, neighbor_num, = canonical_neighbor
          else
            neighbor_id = string_or_nil(neighbor_ref)
            canonical_neighbor_id = normalize_node_id(db, neighbor_id || neighbor_num)
            neighbor_id = canonical_neighbor_id if canonical_neighbor_id
            if neighbor_id&.start_with?("!") && neighbor_num.nil?
              begin
                neighbor_num = Integer(neighbor_id.delete_prefix("!"), 16)
              rescue ArgumentError
                neighbor_num = nil
              end
            end
          end

          next unless neighbor_id

          neighbor_id = "!#{neighbor_id.delete_prefix("!").downcase}" if neighbor_id.start_with?("!")

          entry_rx_time = coerce_integer(neighbor["rx_time"]) || rx_time
          entry_rx_time = now if entry_rx_time && entry_rx_time > now
          snr = coerce_float(neighbor["snr"])

          ensure_unknown_node(db, neighbor_id || neighbor_num, neighbor_num, heard_time: entry_rx_time)
          touch_node_last_seen(db, neighbor_id || neighbor_num, neighbor_num, rx_time: entry_rx_time, source: :neighborinfo)

          neighbor_entries << [neighbor_id, snr, entry_rx_time]
        end

        with_busy_retry do
          db.transaction do
            db.execute("DELETE FROM neighbors WHERE node_id = ?", [node_id])
            neighbor_entries.each do |neighbor_id, snr_value, heard_time|
              db.execute(
                <<~SQL,
                INSERT OR REPLACE INTO neighbors(node_id, neighbor_id, snr, rx_time)
                VALUES (?, ?, ?, ?)
              SQL
                [node_id, neighbor_id, snr_value, heard_time],
              )
            end
          end
        end
      end

      def update_node_from_telemetry(db, node_id, node_num, rx_time, metrics = {})
        num = coerce_integer(node_num)
        id = string_or_nil(node_id)
        if id&.start_with?("!")
          id = "!#{id.delete_prefix("!").downcase}"
        end
        id ||= format("!%08x", num & 0xFFFFFFFF) if num
        return unless id

        ensure_unknown_node(db, id, num, heard_time: rx_time)
        touch_node_last_seen(db, id, num, rx_time: rx_time, source: :telemetry)

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

      def insert_telemetry(db, payload)
        return unless payload.is_a?(Hash)

        telemetry_id = coerce_integer(payload["id"] || payload["packet_id"])
        return unless telemetry_id

        now = Time.now.to_i
        rx_time = coerce_integer(payload["rx_time"])
        rx_time = now if rx_time.nil? || rx_time > now
        rx_iso = string_or_nil(payload["rx_iso"])
        rx_iso ||= Time.at(rx_time).utc.iso8601

        raw_node_id = payload["node_id"] || payload["from_id"] || payload["from"]
        node_id = string_or_nil(raw_node_id)
        node_id = "!#{node_id.delete_prefix("!").downcase}" if node_id&.start_with?("!")
        raw_node_num = coerce_integer(payload["node_num"]) || coerce_integer(payload["num"])

        payload_for_num = payload.dup
        payload_for_num["num"] ||= raw_node_num if raw_node_num
        node_num = resolve_node_num(node_id, payload_for_num)
        node_num ||= raw_node_num

        canonical = normalize_node_id(db, node_id || node_num)
        node_id = canonical if canonical

        from_id = string_or_nil(payload["from_id"]) || node_id
        to_id = string_or_nil(payload["to_id"] || payload["to"])

        telemetry_time = coerce_integer(payload["telemetry_time"] || payload["time"] || payload.dig("telemetry", "time"))
        telemetry_time = nil if telemetry_time && telemetry_time > now

        channel = coerce_integer(payload["channel"])
        portnum = string_or_nil(payload["portnum"])
        hop_limit = coerce_integer(payload["hop_limit"] || payload["hopLimit"])
        snr = coerce_float(payload["snr"])
        rssi = coerce_integer(payload["rssi"])
        bitfield = coerce_integer(payload["bitfield"])
        payload_b64 = string_or_nil(payload["payload_b64"] || payload["payload"])

        telemetry_section = normalize_json_object(payload["telemetry"])
        device_metrics = normalize_json_object(payload["device_metrics"] || payload["deviceMetrics"])
        device_metrics ||= normalize_json_object(telemetry_section["deviceMetrics"]) if telemetry_section&.key?("deviceMetrics")
        environment_metrics = normalize_json_object(payload["environment_metrics"] || payload["environmentMetrics"])
        environment_metrics ||= normalize_json_object(telemetry_section["environmentMetrics"]) if telemetry_section&.key?("environmentMetrics")

        fetch_metric = lambda do |map, *names|
          next nil unless map.is_a?(Hash)
          names.each do |name|
            next unless name
            key = name.to_s
            return map[key] if map.key?(key)
          end
          nil
        end

        battery_level = payload.key?("battery_level") ? payload["battery_level"] : nil
        battery_level = coerce_float(battery_level)
        battery_level ||= coerce_float(fetch_metric.call(device_metrics, :battery_level, :batteryLevel))

        voltage = payload.key?("voltage") ? payload["voltage"] : nil
        voltage = coerce_float(voltage)
        voltage ||= coerce_float(fetch_metric.call(device_metrics, :voltage))

        channel_utilization = payload.key?("channel_utilization") ? payload["channel_utilization"] : nil
        channel_utilization ||= payload["channelUtilization"] if payload.key?("channelUtilization")
        channel_utilization = coerce_float(channel_utilization)
        channel_utilization ||= coerce_float(fetch_metric.call(device_metrics, :channel_utilization, :channelUtilization))

        air_util_tx = payload.key?("air_util_tx") ? payload["air_util_tx"] : nil
        air_util_tx ||= payload["airUtilTx"] if payload.key?("airUtilTx")
        air_util_tx = coerce_float(air_util_tx)
        air_util_tx ||= coerce_float(fetch_metric.call(device_metrics, :air_util_tx, :airUtilTx))

        uptime_seconds = payload.key?("uptime_seconds") ? payload["uptime_seconds"] : nil
        uptime_seconds ||= payload["uptimeSeconds"] if payload.key?("uptimeSeconds")
        uptime_seconds = coerce_integer(uptime_seconds)
        uptime_seconds ||= coerce_integer(fetch_metric.call(device_metrics, :uptime_seconds, :uptimeSeconds))

        temperature = payload.key?("temperature") ? payload["temperature"] : nil
        temperature = coerce_float(temperature)
        temperature ||= coerce_float(fetch_metric.call(environment_metrics, :temperature, :temperatureC, :temperature_c, :tempC))

        relative_humidity = payload.key?("relative_humidity") ? payload["relative_humidity"] : nil
        relative_humidity ||= payload["relativeHumidity"] if payload.key?("relativeHumidity")
        relative_humidity ||= payload["humidity"] if payload.key?("humidity")
        relative_humidity = coerce_float(relative_humidity)
        relative_humidity ||= coerce_float(fetch_metric.call(environment_metrics, :relative_humidity, :relativeHumidity, :humidity))

        barometric_pressure = payload.key?("barometric_pressure") ? payload["barometric_pressure"] : nil
        barometric_pressure ||= payload["barometricPressure"] if payload.key?("barometricPressure")
        barometric_pressure ||= payload["pressure"] if payload.key?("pressure")
        barometric_pressure = coerce_float(barometric_pressure)
        barometric_pressure ||= coerce_float(fetch_metric.call(environment_metrics, :barometric_pressure, :barometricPressure, :pressure))

        row = [
          telemetry_id,
          node_id,
          node_num,
          from_id,
          to_id,
          rx_time,
          rx_iso,
          telemetry_time,
          channel,
          portnum,
          hop_limit,
          snr,
          rssi,
          bitfield,
          payload_b64,
          battery_level,
          voltage,
          channel_utilization,
          air_util_tx,
          uptime_seconds,
          temperature,
          relative_humidity,
          barometric_pressure,
        ]

        with_busy_retry do
          db.execute <<~SQL, row
                       INSERT INTO telemetry(id,node_id,node_num,from_id,to_id,rx_time,rx_iso,telemetry_time,channel,portnum,hop_limit,snr,rssi,bitfield,payload_b64,
                                             battery_level,voltage,channel_utilization,air_util_tx,uptime_seconds,temperature,relative_humidity,barometric_pressure)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(id) DO UPDATE SET
                         node_id=COALESCE(excluded.node_id,telemetry.node_id),
                         node_num=COALESCE(excluded.node_num,telemetry.node_num),
                         from_id=COALESCE(excluded.from_id,telemetry.from_id),
                         to_id=COALESCE(excluded.to_id,telemetry.to_id),
                         rx_time=excluded.rx_time,
                         rx_iso=excluded.rx_iso,
                         telemetry_time=COALESCE(excluded.telemetry_time,telemetry.telemetry_time),
                         channel=COALESCE(excluded.channel,telemetry.channel),
                         portnum=COALESCE(excluded.portnum,telemetry.portnum),
                         hop_limit=COALESCE(excluded.hop_limit,telemetry.hop_limit),
                         snr=COALESCE(excluded.snr,telemetry.snr),
                         rssi=COALESCE(excluded.rssi,telemetry.rssi),
                         bitfield=COALESCE(excluded.bitfield,telemetry.bitfield),
                         payload_b64=COALESCE(excluded.payload_b64,telemetry.payload_b64),
                         battery_level=COALESCE(excluded.battery_level,telemetry.battery_level),
                         voltage=COALESCE(excluded.voltage,telemetry.voltage),
                         channel_utilization=COALESCE(excluded.channel_utilization,telemetry.channel_utilization),
                         air_util_tx=COALESCE(excluded.air_util_tx,telemetry.air_util_tx),
                         uptime_seconds=COALESCE(excluded.uptime_seconds,telemetry.uptime_seconds),
                         temperature=COALESCE(excluded.temperature,telemetry.temperature),
                         relative_humidity=COALESCE(excluded.relative_humidity,telemetry.relative_humidity),
                         barometric_pressure=COALESCE(excluded.barometric_pressure,telemetry.barometric_pressure)
                     SQL
        end

        update_node_from_telemetry(db, node_id, node_num, rx_time, {
          battery_level: battery_level,
          voltage: voltage,
          channel_utilization: channel_utilization,
          air_util_tx: air_util_tx,
          uptime_seconds: uptime_seconds,
        })
      end

      def insert_message(db, message)
        return unless message.is_a?(Hash)

        msg_id = coerce_integer(message["id"] || message["packet_id"])
        return unless msg_id

        now = Time.now.to_i
        rx_time = coerce_integer(message["rx_time"])
        rx_time = now if rx_time.nil? || rx_time > now
        rx_iso = string_or_nil(message["rx_iso"])
        rx_iso ||= Time.at(rx_time).utc.iso8601

        raw_from_id = message["from_id"]
        if raw_from_id.nil? || raw_from_id.to_s.strip.empty?
          alt_from = message["from"]
          raw_from_id = alt_from unless alt_from.nil? || alt_from.to_s.strip.empty?
        end

        trimmed_from_id = string_or_nil(raw_from_id)
        canonical_from_id = string_or_nil(normalize_node_id(db, raw_from_id))
        from_id = trimmed_from_id
        if canonical_from_id
          if from_id.nil?
            from_id = canonical_from_id
          elsif prefer_canonical_sender?(message)
            from_id = canonical_from_id
          elsif from_id.start_with?("!") && from_id.casecmp(canonical_from_id) != 0
            from_id = canonical_from_id
          end
        end

        raw_to_id = message["to_id"]
        raw_to_id = message["to"] if raw_to_id.nil? || raw_to_id.to_s.strip.empty?
        trimmed_to_id = string_or_nil(raw_to_id)
        canonical_to_id = string_or_nil(normalize_node_id(db, raw_to_id))
        to_id = trimmed_to_id
        if canonical_to_id
          if to_id.nil?
            to_id = canonical_to_id
          elsif to_id.start_with?("!") && to_id.casecmp(canonical_to_id) != 0
            to_id = canonical_to_id
          end
        end

        encrypted = string_or_nil(message["encrypted"])

        ensure_unknown_node(db, from_id || raw_from_id, message["from_num"], heard_time: rx_time)
        touch_node_last_seen(
          db,
          from_id || raw_from_id || message["from_num"],
          message["from_num"],
          rx_time: rx_time,
          source: :message,
        )

        row = [
          msg_id,
          rx_time,
          rx_iso,
          from_id,
          to_id,
          message["channel"],
          message["portnum"],
          message["text"],
          encrypted,
          message["snr"],
          message["rssi"],
          message["hop_limit"],
        ]

        with_busy_retry do
          existing = db.get_first_row(
            "SELECT from_id, to_id, encrypted FROM messages WHERE id = ?",
            [msg_id],
          )
          if existing
            updates = {}

            if from_id
              existing_from = existing.is_a?(Hash) ? existing["from_id"] : existing[0]
              existing_from_str = existing_from&.to_s
              should_update = existing_from_str.nil? || existing_from_str.strip.empty?
              should_update ||= existing_from != from_id
              updates["from_id"] = from_id if should_update
            end

            if to_id
              existing_to = existing.is_a?(Hash) ? existing["to_id"] : existing[1]
              existing_to_str = existing_to&.to_s
              should_update = existing_to_str.nil? || existing_to_str.strip.empty?
              should_update ||= existing_to != to_id
              updates["to_id"] = to_id if should_update
            end

            if encrypted
              existing_encrypted = existing.is_a?(Hash) ? existing["encrypted"] : existing[2]
              existing_encrypted_str = existing_encrypted&.to_s
              should_update = existing_encrypted_str.nil? || existing_encrypted_str.strip.empty?
              should_update ||= existing_encrypted != encrypted
              updates["encrypted"] = encrypted if should_update
            end

            unless updates.empty?
              assignments = updates.keys.map { |column| "#{column} = ?" }.join(", ")
              db.execute("UPDATE messages SET #{assignments} WHERE id = ?", updates.values + [msg_id])
            end
          else
            PotatoMesh::App::Prometheus::MESSAGES_TOTAL.increment

            begin
              db.execute <<~SQL, row
                           INSERT INTO messages(id,rx_time,rx_iso,from_id,to_id,channel,portnum,text,encrypted,snr,rssi,hop_limit)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                         SQL
            rescue SQLite3::ConstraintException
              fallback_updates = {}
              fallback_updates["from_id"] = from_id if from_id
              fallback_updates["to_id"] = to_id if to_id
              fallback_updates["encrypted"] = encrypted if encrypted
              unless fallback_updates.empty?
                assignments = fallback_updates.keys.map { |column| "#{column} = ?" }.join(", ")
                db.execute("UPDATE messages SET #{assignments} WHERE id = ?", fallback_updates.values + [msg_id])
              end
            end
          end
        end
      end

      def normalize_node_id(db, node_ref)
        return nil if node_ref.nil?
        ref_str = node_ref.to_s.strip
        return nil if ref_str.empty?

        node_id = db.get_first_value("SELECT node_id FROM nodes WHERE node_id = ?", [ref_str])
        return node_id if node_id

        begin
          ref_num = Integer(ref_str, 10)
        rescue ArgumentError
          return nil
        end

        db.get_first_value("SELECT node_id FROM nodes WHERE num = ?", [ref_num])
      end
    end
  end
end
