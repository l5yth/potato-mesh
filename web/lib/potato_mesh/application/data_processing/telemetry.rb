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
      # Ordered list of telemetry metric definitions consulted by
      # +insert_telemetry+.  Each entry is a tuple of
      # +[column_name, coercion_type, key_map]+, where +key_map+ specifies the
      # candidate field names for each source layer.  Hoisted out of the method
      # body to keep +insert_telemetry+ scannable; the data is otherwise
      # identical to the inline definitions used previously.
      TELEMETRY_METRIC_DEFINITIONS = [
        [
          "battery_level",
          :float,
          {
            payload: %w[battery_level batteryLevel],
            telemetry: %w[batteryLevel],
            device: %w[battery_level batteryLevel],
            environment: %w[battery_level batteryLevel],
          },
        ],
        [
          "voltage",
          :float,
          {
            payload: %w[voltage],
            telemetry: %w[voltage],
            device: %w[voltage],
            environment: %w[voltage],
          },
        ],
        [
          "channel_utilization",
          :float,
          {
            payload: %w[channel_utilization channelUtilization],
            telemetry: %w[channelUtilization],
            device: %w[channel_utilization channelUtilization],
          },
        ],
        [
          "air_util_tx",
          :float,
          {
            payload: %w[air_util_tx airUtilTx],
            telemetry: %w[airUtilTx],
            device: %w[air_util_tx airUtilTx],
          },
        ],
        [
          "uptime_seconds",
          :integer,
          {
            payload: %w[uptime_seconds uptimeSeconds],
            telemetry: %w[uptimeSeconds],
            device: %w[uptime_seconds uptimeSeconds],
          },
        ],
        [
          "temperature",
          :float,
          {
            payload: %w[temperature temperatureC tempC],
            telemetry: %w[temperature temperatureC tempC],
            environment: %w[temperature temperatureC temperature_c tempC],
          },
        ],
        [
          "relative_humidity",
          :float,
          {
            payload: %w[relative_humidity relativeHumidity humidity],
            telemetry: %w[relative_humidity relativeHumidity humidity],
            environment: %w[relative_humidity relativeHumidity humidity],
          },
        ],
        [
          "barometric_pressure",
          :float,
          {
            payload: %w[barometric_pressure barometricPressure pressure],
            telemetry: %w[barometric_pressure barometricPressure pressure],
            environment: %w[barometric_pressure barometricPressure pressure],
          },
        ],
        [
          "gas_resistance",
          :float,
          {
            payload: %w[gas_resistance gasResistance],
            telemetry: %w[gas_resistance gasResistance],
            environment: %w[gas_resistance gasResistance],
          },
        ],
        [
          "current",
          :float,
          {
            payload: %w[current current_ma currentMa],
            telemetry: %w[current current_ma currentMa],
            device: %w[current current_ma currentMa],
            environment: %w[current],
          },
        ],
        [
          "iaq",
          :integer,
          {
            payload: %w[iaq iaqIndex iaq_index],
            telemetry: %w[iaq iaqIndex iaq_index],
            environment: %w[iaq iaqIndex iaq_index],
          },
        ],
        [
          "distance",
          :float,
          {
            payload: %w[distance range rangeMeters],
            telemetry: %w[distance range rangeMeters],
            environment: %w[distance range rangeMeters],
          },
        ],
        [
          "lux",
          :float,
          {
            payload: %w[lux illuminance lightLux],
            telemetry: %w[lux illuminance lightLux],
            environment: %w[lux illuminance lightLux],
          },
        ],
        [
          "white_lux",
          :float,
          {
            payload: %w[white_lux whiteLux],
            telemetry: %w[white_lux whiteLux],
            environment: %w[white_lux whiteLux],
          },
        ],
        [
          "ir_lux",
          :float,
          {
            payload: %w[ir_lux irLux],
            telemetry: %w[ir_lux irLux],
            environment: %w[ir_lux irLux],
          },
        ],
        [
          "uv_lux",
          :float,
          {
            payload: %w[uv_lux uvLux uvIndex],
            telemetry: %w[uv_lux uvLux uvIndex],
            environment: %w[uv_lux uvLux uvIndex],
          },
        ],
        [
          "wind_direction",
          :integer,
          {
            payload: %w[wind_direction windDirection],
            telemetry: %w[wind_direction windDirection],
            environment: %w[wind_direction windDirection],
          },
        ],
        [
          "wind_speed",
          :float,
          {
            payload: %w[wind_speed windSpeed windSpeedMps],
            telemetry: %w[wind_speed windSpeed windSpeedMps],
            environment: %w[wind_speed windSpeed windSpeedMps],
          },
        ],
        [
          "weight",
          :float,
          {
            payload: %w[weight mass],
            telemetry: %w[weight mass],
            environment: %w[weight mass],
          },
        ],
        [
          "wind_gust",
          :float,
          {
            payload: %w[wind_gust windGust],
            telemetry: %w[wind_gust windGust],
            environment: %w[wind_gust windGust],
          },
        ],
        [
          "wind_lull",
          :float,
          {
            payload: %w[wind_lull windLull],
            telemetry: %w[wind_lull windLull],
            environment: %w[wind_lull windLull],
          },
        ],
        [
          "radiation",
          :float,
          {
            payload: %w[radiation radiationLevel],
            telemetry: %w[radiation radiationLevel],
            environment: %w[radiation radiationLevel],
          },
        ],
        [
          "rainfall_1h",
          :float,
          {
            payload: %w[rainfall_1h rainfall1h rainfallOneHour],
            telemetry: %w[rainfall_1h rainfall1h rainfallOneHour],
            environment: %w[rainfall_1h rainfall1h rainfallOneHour],
          },
        ],
        [
          "rainfall_24h",
          :float,
          {
            payload: %w[rainfall_24h rainfall24h rainfallTwentyFourHour],
            telemetry: %w[rainfall_24h rainfall24h rainfallTwentyFourHour],
            environment: %w[rainfall_24h rainfall24h rainfallTwentyFourHour],
          },
        ],
        [
          "soil_moisture",
          :integer,
          {
            payload: %w[soil_moisture soilMoisture],
            telemetry: %w[soil_moisture soilMoisture],
            environment: %w[soil_moisture soilMoisture],
          },
        ],
        [
          "soil_temperature",
          :float,
          {
            payload: %w[soil_temperature soilTemperature],
            telemetry: %w[soil_temperature soilTemperature],
            environment: %w[soil_temperature soilTemperature],
          },
        ],
      ].freeze

      # Resolve a telemetry metric from the provided data sources.
      #
      # @param key_map [Hash{Symbol=>Array<String>}] ordered mapping of source names to candidate keys.
      # @param sources [Hash{Symbol=>Hash}] data structures to search for metric values.
      # @param type [Symbol] coercion strategy, ``:float`` or ``:integer``.
      # @return [Numeric, nil] coerced metric value or nil when no candidates exist.
      def resolve_numeric_metric(key_map, sources, type)
        key_map.each do |source, keys|
          next if keys.nil? || keys.empty?

          data = sources[source]
          next unless data.is_a?(Hash)

          keys.each do |name|
            next if name.nil?

            key = name.to_s
            value = if data.key?(key)
                data[key]
              else
                sym_key = key.to_sym
                data.key?(sym_key) ? data[sym_key] : nil
              end

            next if value.nil?

            coerced = case type
              when :float
                coerce_float(value)
              when :integer
                coerce_integer(value)
              else
                value
              end

            return coerced unless coerced.nil?
          end
        end

        nil
      end

      private :resolve_numeric_metric

      # Persist a telemetry packet and refresh the related node row.
      #
      # @param db [SQLite3::Database] open database handle.
      # @param payload [Hash] inbound telemetry payload.
      # @param protocol_cache [Hash, nil] optional per-batch ingestor protocol cache.
      # @return [void]
      def insert_telemetry(db, payload, protocol_cache: nil)
        return unless payload.is_a?(Hash)

        telemetry_id = coerce_integer(payload["id"] || payload["packet_id"])
        return unless telemetry_id

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

          payload_for_num = payload.dup
          payload_for_num["num"] ||= raw_node_num if raw_node_num
          node_num = resolve_node_num(node_id, payload_for_num)
          node_num ||= raw_node_num

          canonical = normalize_node_id(db, node_id || node_num)
          node_id = canonical if canonical
        end

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
        lora_freq = coerce_integer(payload["lora_freq"] || payload["loraFrequency"])
        modem_preset = string_or_nil(payload["modem_preset"] || payload["modemPreset"])
        ingestor = string_or_nil(payload["ingestor"])
        protocol = resolve_protocol(db, ingestor, cache: protocol_cache)

        telemetry_section = normalize_json_object(payload["telemetry"])
        device_metrics = normalize_json_object(payload["device_metrics"] || payload["deviceMetrics"])
        device_metrics ||= normalize_json_object(telemetry_section["deviceMetrics"]) if telemetry_section&.key?("deviceMetrics")
        environment_metrics = normalize_json_object(payload["environment_metrics"] || payload["environmentMetrics"])
        environment_metrics ||= normalize_json_object(telemetry_section["environmentMetrics"]) if telemetry_section&.key?("environmentMetrics")
        power_metrics = normalize_json_object(payload["power_metrics"] || payload["powerMetrics"])
        power_metrics ||= normalize_json_object(telemetry_section["powerMetrics"]) if telemetry_section&.key?("powerMetrics")
        air_quality_metrics = normalize_json_object(payload["air_quality_metrics"] || payload["airQualityMetrics"])
        air_quality_metrics ||= normalize_json_object(telemetry_section["airQualityMetrics"]) if telemetry_section&.key?("airQualityMetrics")

        telemetry_type = string_or_nil(payload["telemetry_type"])
        telemetry_type = nil unless VALID_TELEMETRY_TYPES.include?(telemetry_type)
        telemetry_type ||= if device_metrics&.any?
            "device"
          elsif environment_metrics&.any?
            "environment"
          elsif power_metrics&.any?
            "power"
          elsif air_quality_metrics&.any?
            "air_quality"
          end

        sources = {
          payload: payload,
          telemetry: telemetry_section,
          device: device_metrics,
          environment: environment_metrics,
        }

        metric_values = {}
        TELEMETRY_METRIC_DEFINITIONS.each do |column, type, key_map|
          value = resolve_numeric_metric(key_map, sources, type)
          metric_values[column] = value unless value.nil?
        end

        battery_level = metric_values["battery_level"]
        voltage = metric_values["voltage"]
        channel_utilization = metric_values["channel_utilization"]
        air_util_tx = metric_values["air_util_tx"]
        uptime_seconds = metric_values["uptime_seconds"]
        temperature = metric_values["temperature"]
        relative_humidity = metric_values["relative_humidity"]
        barometric_pressure = metric_values["barometric_pressure"]
        gas_resistance = metric_values["gas_resistance"]
        current = metric_values["current"]
        iaq = metric_values["iaq"]
        distance = metric_values["distance"]
        lux = metric_values["lux"]
        white_lux = metric_values["white_lux"]
        ir_lux = metric_values["ir_lux"]
        uv_lux = metric_values["uv_lux"]
        wind_direction = metric_values["wind_direction"]
        wind_speed = metric_values["wind_speed"]
        weight = metric_values["weight"]
        wind_gust = metric_values["wind_gust"]
        wind_lull = metric_values["wind_lull"]
        radiation = metric_values["radiation"]
        rainfall_1h = metric_values["rainfall_1h"]
        rainfall_24h = metric_values["rainfall_24h"]
        soil_moisture = metric_values["soil_moisture"]
        soil_temperature = metric_values["soil_temperature"]

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
          gas_resistance,
          current,
          iaq,
          distance,
          lux,
          white_lux,
          ir_lux,
          uv_lux,
          wind_direction,
          wind_speed,
          weight,
          wind_gust,
          wind_lull,
          radiation,
          rainfall_1h,
          rainfall_24h,
          soil_moisture,
          soil_temperature,
          ingestor,
          protocol,
          telemetry_type,
        ]

        placeholders = Array.new(row.length, "?").join(",")

        with_busy_retry do
          db.execute <<~SQL, row
                       INSERT INTO telemetry(id,node_id,node_num,from_id,to_id,rx_time,rx_iso,telemetry_time,channel,portnum,hop_limit,snr,rssi,bitfield,payload_b64,
                                             battery_level,voltage,channel_utilization,air_util_tx,uptime_seconds,temperature,relative_humidity,barometric_pressure,gas_resistance,current,iaq,distance,lux,white_lux,ir_lux,uv_lux,wind_direction,wind_speed,weight,wind_gust,wind_lull,radiation,rainfall_1h,rainfall_24h,soil_moisture,soil_temperature,ingestor,protocol,telemetry_type)
                       VALUES (#{placeholders})
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
                         barometric_pressure=COALESCE(excluded.barometric_pressure,telemetry.barometric_pressure),
                         gas_resistance=COALESCE(excluded.gas_resistance,telemetry.gas_resistance),
                         current=COALESCE(excluded.current,telemetry.current),
                         iaq=COALESCE(excluded.iaq,telemetry.iaq),
                         distance=COALESCE(excluded.distance,telemetry.distance),
                         lux=COALESCE(excluded.lux,telemetry.lux),
                         white_lux=COALESCE(excluded.white_lux,telemetry.white_lux),
                         ir_lux=COALESCE(excluded.ir_lux,telemetry.ir_lux),
                         uv_lux=COALESCE(excluded.uv_lux,telemetry.uv_lux),
                         wind_direction=COALESCE(excluded.wind_direction,telemetry.wind_direction),
                         wind_speed=COALESCE(excluded.wind_speed,telemetry.wind_speed),
                         weight=COALESCE(excluded.weight,telemetry.weight),
                         wind_gust=COALESCE(excluded.wind_gust,telemetry.wind_gust),
                         wind_lull=COALESCE(excluded.wind_lull,telemetry.wind_lull),
                         radiation=COALESCE(excluded.radiation,telemetry.radiation),
                         rainfall_1h=COALESCE(excluded.rainfall_1h,telemetry.rainfall_1h),
                         rainfall_24h=COALESCE(excluded.rainfall_24h,telemetry.rainfall_24h),
                         soil_moisture=COALESCE(excluded.soil_moisture,telemetry.soil_moisture),
                         soil_temperature=COALESCE(excluded.soil_temperature,telemetry.soil_temperature),
                         ingestor=COALESCE(NULLIF(telemetry.ingestor,''), excluded.ingestor),
                         protocol=COALESCE(NULLIF(telemetry.protocol,'meshtastic'), excluded.protocol),
                         telemetry_type=COALESCE(excluded.telemetry_type,telemetry.telemetry_type)
                     SQL
        end

        update_node_from_telemetry(
          db,
          node_id,
          node_num,
          rx_time,
          {
            battery_level: battery_level,
            voltage: voltage,
            channel_utilization: channel_utilization,
            air_util_tx: air_util_tx,
            uptime_seconds: uptime_seconds,
          },
          lora_freq: lora_freq,
          modem_preset: modem_preset,
          protocol: protocol,
        )
      end
    end
  end
end
