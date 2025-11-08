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
    module Prometheus
      MESSAGES_TOTAL = ::Prometheus::Client::Counter.new(
        :meshtastic_messages_total,
        docstring: "Total number of messages received",
      )

      NODES_GAUGE = ::Prometheus::Client::Gauge.new(
        :meshtastic_nodes,
        docstring: "Number of nodes tracked",
      )

      NODE_GAUGE = ::Prometheus::Client::Gauge.new(
        :meshtastic_node,
        docstring: "Presence of a Meshtastic node",
        labels: %i[node short_name long_name hw_model role],
      )

      NODE_BATTERY_LEVEL = ::Prometheus::Client::Gauge.new(
        :meshtastic_node_battery_level,
        docstring: "Battery level of a Meshtastic node",
        labels: [:node],
      )

      NODE_VOLTAGE = ::Prometheus::Client::Gauge.new(
        :meshtastic_node_voltage,
        docstring: "Battery voltage of a Meshtastic node",
        labels: [:node],
      )

      NODE_UPTIME = ::Prometheus::Client::Gauge.new(
        :meshtastic_node_uptime_seconds,
        docstring: "Uptime reported by a Meshtastic node",
        labels: [:node],
      )

      NODE_CHANNEL_UTIL = ::Prometheus::Client::Gauge.new(
        :meshtastic_node_channel_utilization,
        docstring: "Channel utilization reported by a Meshtastic node",
        labels: [:node],
      )

      NODE_AIR_UTIL_TX = ::Prometheus::Client::Gauge.new(
        :meshtastic_node_transmit_air_utilization,
        docstring: "Transmit air utilization reported by a Meshtastic node",
        labels: [:node],
      )

      NODE_LATITUDE = ::Prometheus::Client::Gauge.new(
        :meshtastic_node_latitude,
        docstring: "Latitude of a Meshtastic node",
        labels: [:node],
      )

      NODE_LONGITUDE = ::Prometheus::Client::Gauge.new(
        :meshtastic_node_longitude,
        docstring: "Longitude of a Meshtastic node",
        labels: [:node],
      )

      NODE_ALTITUDE = ::Prometheus::Client::Gauge.new(
        :meshtastic_node_altitude,
        docstring: "Altitude of a Meshtastic node",
        labels: [:node],
      )

      METRICS = [
        MESSAGES_TOTAL,
        NODES_GAUGE,
        NODE_GAUGE,
        NODE_BATTERY_LEVEL,
        NODE_VOLTAGE,
        NODE_UPTIME,
        NODE_CHANNEL_UTIL,
        NODE_AIR_UTIL_TX,
        NODE_LATITUDE,
        NODE_LONGITUDE,
        NODE_ALTITUDE,
      ].freeze

      METRICS.each do |metric|
        ::Prometheus::Client.registry.register(metric)
      rescue ::Prometheus::Client::Registry::AlreadyRegisteredError
        # Ignore duplicate registrations when the code is reloaded.
      end

      def update_prometheus_metrics(node_id, user = nil, role = "", met = nil, pos = nil)
        ids = prom_report_ids
        return if ids.empty? || !node_id

        return unless ids[0] == "*" || ids.include?(node_id)

        if user && user.is_a?(Hash) && role && role != ""
          NODE_GAUGE.set(
            1,
            labels: {
              node: node_id,
              short_name: user["shortName"],
              long_name: user["longName"],
              hw_model: user["hwModel"],
              role: role,
            },
          )
        end

        if met && met.is_a?(Hash)
          if met["batteryLevel"]
            NODE_BATTERY_LEVEL.set(met["batteryLevel"], labels: { node: node_id })
          end

          if met["voltage"]
            NODE_VOLTAGE.set(met["voltage"], labels: { node: node_id })
          end

          if met["uptimeSeconds"]
            NODE_UPTIME.set(met["uptimeSeconds"], labels: { node: node_id })
          end

          if met["channelUtilization"]
            NODE_CHANNEL_UTIL.set(met["channelUtilization"], labels: { node: node_id })
          end

          if met["airUtilTx"]
            NODE_AIR_UTIL_TX.set(met["airUtilTx"], labels: { node: node_id })
          end
        end

        if pos && pos.is_a?(Hash)
          if pos["latitude"]
            NODE_LATITUDE.set(pos["latitude"], labels: { node: node_id })
          end

          if pos["longitude"]
            NODE_LONGITUDE.set(pos["longitude"], labels: { node: node_id })
          end

          if pos["altitude"]
            NODE_ALTITUDE.set(pos["altitude"], labels: { node: node_id })
          end
        end
      end

      def update_all_prometheus_metrics_from_nodes
        nodes = query_nodes(1000)

        NODES_GAUGE.set(nodes.size)

        ids = prom_report_ids
        unless ids.empty?
          nodes.each do |n|
            node_id = n["node_id"]

            next if ids[0] != "*" && !ids.include?(node_id)

            update_prometheus_metrics(
              node_id,
              {
                "shortName" => n["short_name"] || "",
                "longName" => n["long_name"] || "",
                "hwModel" => n["hw_model"] || "",
              },
              n["role"] || "",
              {
                "batteryLevel" => n["battery_level"],
                "voltage" => n["voltage"],
                "uptimeSeconds" => n["uptime_seconds"],
                "channelUtilization" => n["channel_utilization"],
                "airUtilTx" => n["air_util_tx"],
              },
              {
                "latitude" => n["latitude"],
                "longitude" => n["longitude"],
                "altitude" => n["altitude"],
              },
            )
          end
        end
      end
    end
  end
end
