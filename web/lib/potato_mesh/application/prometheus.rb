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

require "prometheus/middleware/collector"

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

      # Per-node gauges that read one node-row column each, mapped to that
      # column (SPEC PG2).  {#prometheus_node_series} builds the presence
      # gauge and the coordinate gauges itself.
      NODE_COLUMN_GAUGES = {
        NODE_BATTERY_LEVEL => "battery_level",
        NODE_VOLTAGE => "voltage",
        NODE_UPTIME => "uptime_seconds",
        NODE_CHANNEL_UTIL => "channel_utilization",
        NODE_AIR_UTIL_TX => "air_util_tx",
      }.freeze

      # Node-row columns one scrape reads (SPEC PG2).
      NODE_SERIES_COLUMNS = %w[
        node_id short_name long_name hw_model role latitude longitude altitude
        battery_level voltage uptime_seconds channel_utilization air_util_tx
      ].freeze

      # Role the presence gauge reports for a row without one: the role
      # +query_nodes+ gives it, so +/metrics+ and +GET /api/nodes+ agree (PG2).
      DEFAULT_ROLE = "CLIENT"

      # Latitudes on the globe, in degrees, ends included: the bound SPEC IB2
      # gives +normalize_lat_lon+, mirrored for the coordinate gauges (PG3).
      LATITUDE_RANGE = (-90.0..90.0)

      # Longitudes on the globe, in degrees, ends included (SPEC IB2, PG3).
      LONGITUDE_RANGE = (-180.0..180.0)

      # +path+ label of a static file Sinatra's static handler sent (SPEC PG1).
      STATIC_ROUTE = "static"

      # +path+ label of the Exporter's own response (SPEC PG1).
      METRICS_ROUTE = "metrics"

      # +path+ label of any other request no Sinatra route answered, such as
      # an unknown path (SPEC PG1).
      UNMATCHED_ROUTE = "unmatched"

      # Path the Exporter answers: the gem's default, which +application.rb+
      # keeps.
      METRICS_PATH = "/metrics"

      # Rack middleware recording the HTTP request metrics of
      # +Prometheus::Middleware::Collector+, labelled by route (SPEC PG1).
      #
      # The gem labels a request with its raw path and rewrites only UUID and
      # all-digit segments, so every distinct path (a node id in
      # +/api/nodes/:id+, any 404) added series that were never removed.  The
      # metric names and the +code+, +method+ and +exception+ labels are the
      # gem's.
      class RouteCollector < ::Prometheus::Middleware::Collector
        # Readable label of a route Sinatra matched.  Sinatra writes a
        # regular-expression route as Ruby prints the regexp, slashes escaped
        # (+GET \/map\/?+); the label unescapes them and drops an optional
        # trailing slash (+GET /map+).  A string route reads as written
        # (+GET /api/nodes/:id+).
        #
        # @param route [String] +env["sinatra.route"]+, +VERB pattern+.
        # @return [String] route label.
        def self.route_label(route)
          route.gsub("\\/", "/").delete_suffix("/?")
        end

        protected

        # The +path+ label of one request: the {.route_label} of the route
        # Sinatra matched (+env["sinatra.route"]+), also when that route
        # answers 404; else {STATIC_ROUTE} for a static file, {METRICS_ROUTE}
        # for the Exporter's own response and {UNMATCHED_ROUTE} for any other
        # request, all of which come before or without routing.
        #
        # @param env [Hash] Rack environment after the application answered.
        # @return [String] route label.
        def generate_path(env)
          route = env["sinatra.route"]
          return self.class.route_label(route) if route
          return STATIC_ROUTE if env["sinatra.static_file"]
          return METRICS_ROUTE if env["PATH_INFO"] == METRICS_PATH

          UNMATCHED_ROUTE
        end
      end

      # Number of nodes +GET /api/nodes+ lists, without its row cap (SPEC PG4).
      #
      # The filters of the bulk read in +query_nodes+: heard since
      # +node_window_floor+ (seven days), neither name carrying the opt-out
      # marker and, with +PRIVATE=1+, a role other than +CLIENT_HIDDEN+.
      #
      # @param db [SQLite3::Database, nil] open handle to count on; nil opens
      #   and closes a read-only one.
      # @param now [Integer] reference unix time.
      # @return [Integer] node count.
      def prometheus_node_count(db = nil, now: Time.now.to_i)
        handle = db || open_database(readonly: true)
        where_clauses = ["last_heard >= ?"]
        params = [node_window_floor(nil, now)]
        where_clauses << hidden_client_filter if private_mode?
        append_opt_out_filter(where_clauses, params, opt_out_self_filter)
        handle.get_first_value("SELECT COUNT(*) FROM nodes WHERE #{where_clauses.join(" AND ")}", params).to_i
      ensure
        handle&.close unless db
      end

      # Seed {NODES_GAUGE} from the database at boot (SPEC PG4).  The per-node
      # series need no seeding: every scrape builds them from the node rows
      # (SPEC PG2).
      #
      # @return [void]
      def update_all_prometheus_metrics_from_nodes
        NODES_GAUGE.set(prometheus_node_count)
      end

      # Node rows whose series a scrape exports (SPEC PM1, PM2, PG2).
      #
      # One read-only query with the filter +GET /api/nodes+ applies: neither
      # name carries the opt-out marker and, with +PRIVATE=1+, the role is not
      # +CLIENT_HIDDEN+.  It has no age window and no row cap; a node whose row
      # retention deleted is absent.  +PROM_REPORT_IDS+ narrows it: +*+ as the
      # first entry keeps every node, a list keeps the nodes it names, and an
      # empty setting runs no query.
      #
      # @param ids [Array<String>] configured report ids.
      # @return [Array<Hash>] rows holding {NODE_SERIES_COLUMNS}, by node id.
      def prometheus_node_rows(ids = prom_report_ids)
        return [] if ids.empty?

        db = open_database(readonly: true)
        db.results_as_hash = true
        where_clauses = []
        params = []
        where_clauses << hidden_client_filter if private_mode?
        append_opt_out_filter(where_clauses, params, opt_out_self_filter)
        unless ids[0] == "*"
          where_clauses << "node_id IN (#{Array.new(ids.length, "?").join(", ")})"
          params.concat(ids)
        end
        db.execute(
          "SELECT #{NODE_SERIES_COLUMNS.join(", ")} FROM nodes WHERE #{where_clauses.join(" AND ")} ORDER BY node_id",
          params,
        )
      ensure
        db&.close
      end

      # Per-node series of one scrape, built from {#prometheus_node_rows}
      # (SPEC PG2, PG3).
      #
      # The series are the reported nodes' own: a rename replaces its node's
      # presence series, and a node that leaves the rows (opt-out, retention,
      # +PRIVATE=1+) takes every series with it.  Per row: +meshtastic_node+
      # 1, labelled with the stored names and hardware model (NULL reads as
      # empty) and the stored role, {DEFAULT_ROLE} when there is none; one
      # series for each {NODE_COLUMN_GAUGES} column that holds a number; and,
      # for a position {#prometheus_coordinates} keeps, its latitude,
      # longitude and altitude, each when it is a number.
      #
      # @return [Hash{Symbol => Hash{Hash => Float}}] label set to value by
      #   family name; a family without a series is absent.
      def prometheus_node_series
        prometheus_node_rows.each_with_object({}) do |row, series|
          node = { node: row["node_id"] }
          presence = node.merge(
            short_name: row["short_name"].to_s,
            long_name: row["long_name"].to_s,
            hw_model: row["hw_model"].to_s,
            role: (row["role"] || DEFAULT_ROLE).to_s,
          )
          prometheus_add_series(series, NODE_GAUGE, presence, 1.0)
          NODE_COLUMN_GAUGES.each do |metric, column|
            prometheus_add_series(series, metric, node, coerce_float(row[column]))
          end
          lat, lon = prometheus_coordinates(row["latitude"], row["longitude"])
          next if lat.nil? && lon.nil?

          prometheus_add_series(series, NODE_LATITUDE, node, lat)
          prometheus_add_series(series, NODE_LONGITUDE, node, lon)
          prometheus_add_series(series, NODE_ALTITUDE, node, coerce_float(row["altitude"]))
        end
      end

      # Add one series to a {#prometheus_node_series} result.
      #
      # @param series [Hash{Symbol => Hash}] result being built.
      # @param metric [Prometheus::Client::Metric] family of the series.
      # @param labels [Hash{Symbol => String}] label set.
      # @param value [Float, nil] value; nil adds nothing.
      # @return [void]
      def prometheus_add_series(series, metric, labels, value)
        return if value.nil?

        (series[metric.name] ||= {})[labels] = value
      end

      # Coordinates a node's gauges export (SPEC PG3).
      #
      # +normalize_lat_lon+ coerces both axes and drops the #782 +(0, 0)+
      # sentinel; a latitude outside {LATITUDE_RANGE} or a longitude outside
      # {LONGITUDE_RANGE} then drops the pair, one axis being enough, as SPEC
      # IB2 has +normalize_lat_lon+ do.  A single axis on the globe is kept,
      # as the write path keeps it.
      #
      # @param lat [Object] stored latitude.
      # @param lon [Object] stored longitude.
      # @return [Array(Float, Float)] +[lat, lon]+, nil on each axis dropped.
      def prometheus_coordinates(lat, lon)
        lat_f, lon_f = normalize_lat_lon(lat, lon)
        return [nil, nil] if (lat_f && !LATITUDE_RANGE.cover?(lat_f)) || (lon_f && !LONGITUDE_RANGE.cover?(lon_f))

        [lat_f, lon_f]
      end

      # Registry view that +/metrics+ prints in place of the registry
      # (SPEC PM1, PM2, PG2).
      #
      # Nothing writes the per-node gauges: each {#metrics} call asks
      # +source+ once for the per-node series of the visible, reported nodes,
      # built from their stored rows, and a family labelled +node+ prints
      # those series under its own name, type and help.  A family labelled
      # +node+ that the build does not fill prints none.  Families without a
      # +node+ label pass through unchanged.  If the lookup raises, the scrape
      # carries no per-node family at all (fail closed).
      class ExportRegistry
        # Label that marks a metric family as per-node.
        NODE_LABEL = :node

        # @param registry [#metrics] registry the metrics are registered in.
        # @param source [#prometheus_node_series, #warn_log] object that
        #   builds the per-node series and logs a failed lookup.
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
          series = node_series
          @registry.metrics.filter_map do |metric|
            next metric unless metric.labels.include?(NODE_LABEL)

            NodeFamily.new(metric, series.fetch(metric.name, {})) if series
          end
        end

        private

        # Build the per-node series, logging a failure instead of raising.
        #
        # @return [Hash{Symbol => Hash}, nil] series by family name, or +nil+
        #   when the lookup raised.
        def node_series
          @source.prometheus_node_series
        rescue StandardError => e
          @source.warn_log(
            "Withheld per-node metrics: visible node lookup failed",
            context: "prometheus.export",
            error_class: e.class.name,
            error_message: e.message,
          )
          nil
        end

        # One per-node family holding the series one scrape built.  It offers
        # the readers the text formatter calls (+name+, +type+, +docstring+,
        # +values+) plus +labels+, and never writes to the wrapped metric.
        class NodeFamily
          # @param metric [Prometheus::Client::Metric] family labelled +node+.
          # @param values [Hash{Hash => Float}] label set to value.
          def initialize(metric, values)
            @metric = metric
            @values = values
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

          # Series of the family's reported nodes, with their stored values.
          #
          # @return [Hash{Hash => Float}] label set to value.
          def values
            @values
          end
        end
      end
    end
  end
end
