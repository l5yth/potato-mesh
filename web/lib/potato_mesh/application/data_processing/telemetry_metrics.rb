# frozen_string_literal: true

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

module PotatoMesh
  module App
    module DataProcessing
      # Build metric definitions for one telemetry family (TI-A2).
      #
      # Each triple expands to a +[column, type, key_map]+ definition. The
      # flat payload is probed with the snake_case column name **only**; the
      # protobuf-JSON camelCase twin is accepted solely inside the family
      # sub-object (for third-party ingestors that post nested shapes).
      # Camel twins are not unique across families — +healthMetrics.temperature+
      # shares its camel name with the ambient +temperature+ metric — so
      # probing them against the flat payload would let one family's reading
      # corrupt another's column (the ambient-into-+health_temperature+ leak).
      #
      # @param source [Symbol] source-layer key of the family sub-object
      #   (e.g. +:power+) as registered in +insert_telemetry+'s sources hash.
      # @param triples [Array<Array>] list of +[column, type, camel_name]+.
      # @return [Array<Array>] metric definitions for the family.
      def self.build_family_metric_definitions(source, triples)
        triples.map do |column, type, camel|
          [column, type, { payload: [column], source => [column, camel].uniq }]
        end
      end

      # PowerMetrics channel triples: +ch1+–+ch8+, voltage + current each.
      POWER_CHANNEL_METRIC_TRIPLES = (1..8).flat_map do |ch|
        [
          ["ch#{ch}_voltage", :float, "ch#{ch}Voltage"],
          ["ch#{ch}_current", :float, "ch#{ch}Current"],
        ]
      end.freeze

      # Ordered metric definitions for the telemetry families beyond the
      # original device/environment pair: PowerMetrics, AirQualityMetrics,
      # HealthMetrics, LocalStats, HostMetrics, TrafficManagementStats, and
      # the repeated one-wire probe list.  Consumed by +insert_telemetry+
      # alongside +TELEMETRY_METRIC_DEFINITIONS+; the column order here is the
      # canonical order used by the INSERT/upsert SQL and the schema
      # auto-migration.
      EXTENDED_TELEMETRY_METRIC_DEFINITIONS = (build_family_metric_definitions(:power, POWER_CHANNEL_METRIC_TRIPLES) +
                                               build_family_metric_definitions(:air_quality, [
                                                 ["pm10_standard", :integer, "pm10Standard"],
                                                 ["pm25_standard", :integer, "pm25Standard"],
                                                 ["pm100_standard", :integer, "pm100Standard"],
                                                 ["pm40_standard", :integer, "pm40Standard"],
                                                 ["pm10_environmental", :integer, "pm10Environmental"],
                                                 ["pm25_environmental", :integer, "pm25Environmental"],
                                                 ["pm100_environmental", :integer, "pm100Environmental"],
                                                 ["particles_03um", :integer, "particles03um"],
                                                 ["particles_05um", :integer, "particles05um"],
                                                 ["particles_10um", :integer, "particles10um"],
                                                 ["particles_25um", :integer, "particles25um"],
                                                 ["particles_40um", :integer, "particles40um"],
                                                 ["particles_50um", :integer, "particles50um"],
                                                 ["particles_100um", :integer, "particles100um"],
                                                 ["particles_tps", :float, "particlesTps"],
                                                 ["co2", :integer, "co2"],
                                                 ["co2_temperature", :float, "co2Temperature"],
                                                 ["co2_humidity", :float, "co2Humidity"],
                                                 ["form_formaldehyde", :float, "formFormaldehyde"],
                                                 ["form_humidity", :float, "formHumidity"],
                                                 ["form_temperature", :float, "formTemperature"],
                                                 ["pm_temperature", :float, "pmTemperature"],
                                                 ["pm_humidity", :float, "pmHumidity"],
                                                 ["pm_voc_idx", :float, "pmVocIdx"],
                                                 ["pm_nox_idx", :float, "pmNoxIdx"],
                                               ]) +
                                               build_family_metric_definitions(:health, [
                                                 ["heart_bpm", :integer, "heartBpm"],
                                                 ["spo2", :integer, "spO2"],
                                                 # Body temperature stays apart from the ambient temperature column.
                                                 ["health_temperature", :float, "temperature"],
                                               ]) +
                                               build_family_metric_definitions(:local_stats, [
                                                 ["num_packets_tx", :integer, "numPacketsTx"],
                                                 ["num_packets_rx", :integer, "numPacketsRx"],
                                                 ["num_packets_rx_bad", :integer, "numPacketsRxBad"],
                                                 ["num_online_nodes", :integer, "numOnlineNodes"],
                                                 ["num_total_nodes", :integer, "numTotalNodes"],
                                                 ["num_rx_dupe", :integer, "numRxDupe"],
                                                 ["num_tx_relay", :integer, "numTxRelay"],
                                                 ["num_tx_relay_canceled", :integer, "numTxRelayCanceled"],
                                                 ["heap_total_bytes", :integer, "heapTotalBytes"],
                                                 ["heap_free_bytes", :integer, "heapFreeBytes"],
                                                 ["num_tx_dropped", :integer, "numTxDropped"],
                                                 ["noise_floor", :integer, "noiseFloor"],
                                               ]) +
                                               build_family_metric_definitions(:host, [
                                                 ["freemem_bytes", :integer, "freememBytes"],
                                                 ["diskfree1_bytes", :integer, "diskfree1Bytes"],
                                                 ["diskfree2_bytes", :integer, "diskfree2Bytes"],
                                                 ["diskfree3_bytes", :integer, "diskfree3Bytes"],
                                                 ["load1", :integer, "load1"],
                                                 ["load5", :integer, "load5"],
                                                 ["load15", :integer, "load15"],
                                                 ["user_string", :string, "userString"],
                                               ]) +
                                               build_family_metric_definitions(:traffic, [
                                                 ["packets_inspected", :integer, "packetsInspected"],
                                                 ["position_dedup_drops", :integer, "positionDedupDrops"],
                                                 ["nodeinfo_cache_hits", :integer, "nodeinfoCacheHits"],
                                                 ["rate_limit_drops", :integer, "rateLimitDrops"],
                                                 ["unknown_packet_drops", :integer, "unknownPacketDrops"],
                                                 ["hop_exhausted_packets", :integer, "hopExhaustedPackets"],
                                                 ["router_hops_preserved", :integer, "routerHopsPreserved"],
                                               ]) +
                                               build_family_metric_definitions(:environment, [
                                                 ["one_wire_temperature", :float_array, "oneWireTemperature"],
                                               ])).freeze

      # Ordered extended column names (canonical SQL order).
      EXTENDED_TELEMETRY_COLUMN_NAMES =
        EXTENDED_TELEMETRY_METRIC_DEFINITIONS.map(&:first).freeze

      # SQLite column type per coercion strategy.
      EXTENDED_TELEMETRY_SQL_TYPES = {
        float: "REAL",
        integer: "INTEGER",
        string: "TEXT",
        float_array: "TEXT",
      }.freeze

      # +[name, sqlite_type]+ pairs consumed by the boot-time schema
      # auto-migration (+ensure_schema_upgrades+) so existing databases gain
      # the extended columns without operator action.
      EXTENDED_TELEMETRY_COLUMN_TYPES =
        EXTENDED_TELEMETRY_METRIC_DEFINITIONS.map do |column, type, _|
          [column, EXTENDED_TELEMETRY_SQL_TYPES.fetch(type)]
        end.freeze

      # SQL fragment appended to the INSERT column list (leading comma form).
      EXTENDED_TELEMETRY_INSERT_COLUMNS_SQL =
        EXTENDED_TELEMETRY_COLUMN_NAMES.map { |column| ",#{column}" }.join.freeze

      # SQL fragment appended to the upsert SET list: keep the stored value
      # whenever the new row carries NULL, matching the base metric columns.
      EXTENDED_TELEMETRY_UPSERT_SQL =
        EXTENDED_TELEMETRY_COLUMN_NAMES.map do |column|
          ",\n  #{column}=COALESCE(excluded.#{column},telemetry.#{column})"
        end.join.freeze
    end
  end
end
