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

      # Update per-node Prometheus gauges for a single node event.
      #
      # The method is a no-op when the configured report-ID list is empty or when
      # +node_id+ does not match an entry in that list.  When the wildcard +*+ is
      # present all nodes are reported.
      #
      # @param node_id [String, nil] canonical node identifier (+!xxxxxxxx+ form).
      # @param user [Hash, nil] user payload hash containing +shortName+,
      #   +longName+, and +hwModel+ keys.
      # @param role [String] node role label; an empty string skips the NODE_GAUGE.
      # @param met [Hash, nil] device metrics hash containing keys such as
      #   +batteryLevel+, +voltage+, +uptimeSeconds+, +channelUtilization+, and
      #   +airUtilTx+.
      # @param pos [Hash, nil] position payload hash containing +latitude+,
      #   +longitude+, and +altitude+.
      # @return [void]
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
          lat = pos["latitude"]
          lon = pos["longitude"]
          # Issue #782: paired ``(0, 0)`` is the Meshtastic "no GPS lock"
          # sentinel.  In Ruby ``0.0`` is truthy, so the previous
          # ``if pos["latitude"]`` guard let the gauge be clobbered to 0
          # on every sentinel nodeinfo.  Skip both gauges when the pair is
          # sentinel so each retains its last real value.  Single-axis
          # zero — a legitimate equator / prime-meridian fix — survives.
          is_null_island = lat.is_a?(Numeric) && lon.is_a?(Numeric) &&
                           lat.abs < 1e-9 && lon.abs < 1e-9
          unless is_null_island
            NODE_LATITUDE.set(lat, labels: { node: node_id }) if lat
            NODE_LONGITUDE.set(lon, labels: { node: node_id }) if lon
          end

          if pos["altitude"]
            NODE_ALTITUDE.set(pos["altitude"], labels: { node: node_id })
          end
        end
      end

      # Refresh all Prometheus node metrics from the current database snapshot.
      #
      # Queries up to 1 000 nodes and updates the {NODES_GAUGE} with the total
      # count.  For each node that matches the report-ID filter the per-node
      # gauges are refreshed via {#update_prometheus_metrics}.
      #
      # @return [void]
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

      # Node ids whose per-node series a scrape may print (SPEC PM1/PM2).
      #
      # Runs one read-only query with the filter +GET /api/nodes+ applies:
      # neither name carries the opt-out marker and, with +PRIVATE=1+, the
      # role is not +CLIENT_HIDDEN+.  It has no age window and no row cap,
      # so the gauges keep their meaning; a node whose row retention deleted
      # is absent, so its series are dropped too.
      #
      # @return [Set<String>] node ids a scrape may export.
      def prometheus_visible_node_ids
        db = open_database(readonly: true)
        db.results_as_hash = true
        where_clauses = []
        params = []
        where_clauses << hidden_client_filter if private_mode?
        append_opt_out_filter(where_clauses, params, opt_out_self_filter)
        sql = "SELECT node_id FROM nodes WHERE #{where_clauses.join(" AND ")}"
        db.execute(sql, params).each_with_object(Set.new) { |row, ids| ids << row["node_id"] }
      ensure
        db&.close
      end

      # Registry view that +/metrics+ prints in place of the registry
      # (SPEC PM1/PM2).
      #
      # Ingest keeps writing every series to the registry, and
      # prometheus-client 5 cannot remove a label set, so the filter runs at
      # export.  Each {#metrics} call asks +source+ once for the visible node
      # ids and keeps a series of a family labelled +node+ only when its node
      # is in that set.  Families without a +node+ label pass through
      # unchanged.  If the lookup raises, the scrape carries no per-node
      # family at all (fail closed).
      class ExportRegistry
        # Label that marks a metric family as per-node.
        NODE_LABEL = :node

        # @param registry [#metrics] registry the gauges write to.
        # @param source [#prometheus_visible_node_ids, #warn_log] object that
        #   runs the visibility query and logs a failed lookup.
        def initialize(registry, source)
          @registry = registry
          @source = source
        end

        # Metric families for one scrape, in registry order.  This is the
        # only registry method +Prometheus::Client::Formats::Text.marshal+
        # calls.
        #
        # @return [Array<#name, #type, #docstring, #values>] families to
        #   print; per-node families are wrapped in {NodeFamily}.
        def metrics
          visible = visible_node_ids
          @registry.metrics.filter_map do |metric|
            next metric unless metric.labels.include?(NODE_LABEL)

            NodeFamily.new(metric, visible) if visible
          end
        end

        private

        # Look up the visible node ids, logging a failure instead of raising.
        #
        # @return [Set<String>, nil] visible node ids, or +nil+ when the
        #   lookup raised.
        def visible_node_ids
          @source.prometheus_visible_node_ids
        rescue StandardError => e
          @source.warn_log(
            "Withheld per-node metrics: visible node lookup failed",
            context: "prometheus.export",
            error_class: e.class.name,
            error_message: e.message,
          )
          nil
        end

        # One per-node family limited to the series of visible nodes.  It
        # offers the readers the text formatter calls (+name+, +type+,
        # +docstring+, +values+) plus +labels+, and never writes to the
        # wrapped metric.
        class NodeFamily
          # @param metric [Prometheus::Client::Metric] family labelled +node+.
          # @param visible_node_ids [#include?] node ids whose series stay.
          def initialize(metric, visible_node_ids)
            @metric = metric
            @visible_node_ids = visible_node_ids
          end

          # @return [Symbol] metric name.
          def name
            @metric.name
          end

          # @return [Symbol] metric type.
          def type
            @metric.type
          end

          # @return [String] help text.
          def docstring
            @metric.docstring
          end

          # @return [Array<Symbol>] label names of the family.
          def labels
            @metric.labels
          end

          # Series of visible nodes with their current values.
          #
          # @return [Hash{Hash => Object}] label set to value.
          def values
            @metric.values.select { |label_set, _value| @visible_node_ids.include?(label_set[NODE_LABEL]) }
          end
        end
      end
    end
  end
end
