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

require "spec_helper"
require "prometheus/client"
require_relative "support/metrics_spec_helpers"

RSpec.describe PotatoMesh::App::Prometheus do
  include MetricsSpecHelpers

  # Build a host class mixing in the module so we can call instance methods.
  let(:harness_class) do
    Class.new do
      include PotatoMesh::App::Prometheus
      include PotatoMesh::App::Queries
      include PotatoMesh::App::Helpers
      include PotatoMesh::App::DataProcessing

      def private_mode?
        false
      end

      def prom_report_ids
        ["*"]
      end

      def debug_log(message, **); end

      def warn_log(message, **); end

      def open_database(readonly: false)
        db = SQLite3::Database.new(PotatoMesh::Config.db_path, readonly: readonly)
        db.results_as_hash = true
        db.busy_timeout = PotatoMesh::Config.db_busy_timeout_ms
        db
      end

      def normalize_node_id(_db, node_ref)
        parts = canonical_node_parts(node_ref)
        parts ? parts[0] : nil
      end

      def with_busy_retry
        yield
      end

      def resolve_protocol(_db, _ingestor, cache: nil)
        "meshtastic"
      end
    end
  end

  subject(:prometheus) { harness_class.new }

  around do |example|
    Dir.mktmpdir("prometheus-spec-") do |dir|
      db_path = File.join(dir, "mesh.db")

      RSpec::Mocks.with_temporary_scope do
        allow(PotatoMesh::Config).to receive(:db_path).and_return(db_path)
        allow(PotatoMesh::Config).to receive(:db_busy_timeout_ms).and_return(5000)
        allow(PotatoMesh::Config).to receive(:week_seconds).and_return(604_800)
        allow(PotatoMesh::Config).to receive(:four_weeks_seconds).and_return(604_800)
        allow(PotatoMesh::Config).to receive(:debug?).and_return(false)
        db_helper = Object.new.extend(PotatoMesh::App::Database)
        db_helper.init_db
        db_helper.ensure_schema_upgrades
        example.run
      end
    end
  end

  # Run one SQL statement against the spec database.
  #
  # @param sql [String] statement to run.
  # @param params [Array] bind parameters.
  # @return [void]
  def execute_sql(sql, params = [])
    db = SQLite3::Database.new(PotatoMesh::Config.db_path)
    db.execute(sql, params)
  ensure
    db&.close
  end

  # Insert one +nodes+ row into the spec database.
  #
  # @param node_id [String] canonical node id.
  # @param long_name [String] long name; the opt-out marker in it opts the node out.
  # @param short_name [String] short name; the marker here opts the node out too.
  # @param role [String, nil] node role.
  # @param last_heard [Integer] last-heard timestamp.
  # @return [void]
  def insert_node_row(node_id, long_name: "Spec Node", short_name: "SN", role: "CLIENT", last_heard: Time.now.to_i)
    execute_sql(
      "INSERT INTO nodes(node_id, short_name, long_name, role, last_heard, first_heard) VALUES (?,?,?,?,?,?)",
      [node_id, short_name, long_name, role, last_heard, last_heard],
    )
  end

  # ---------------------------------------------------------------------------
  # Module-level metric constants
  # ---------------------------------------------------------------------------
  describe "metric constants" do
    it "defines MESSAGES_TOTAL as a Counter" do
      expect(PotatoMesh::App::Prometheus::MESSAGES_TOTAL).to be_a(::Prometheus::Client::Counter)
    end

    it "defines NODES_GAUGE as a Gauge" do
      expect(PotatoMesh::App::Prometheus::NODES_GAUGE).to be_a(::Prometheus::Client::Gauge)
    end

    it "defines NODE_GAUGE with the correct labels" do
      labels = PotatoMesh::App::Prometheus::NODE_GAUGE.instance_variable_get(:@labels)
      expect(labels).to include(:node, :short_name, :long_name, :hw_model, :role)
    end

    it "defines NODE_BATTERY_LEVEL with a node label" do
      labels = PotatoMesh::App::Prometheus::NODE_BATTERY_LEVEL.instance_variable_get(:@labels)
      expect(labels).to include(:node)
    end

    it "exposes all metrics in METRICS" do
      expect(PotatoMesh::App::Prometheus::METRICS).to be_an(Array)
      expect(PotatoMesh::App::Prometheus::METRICS).not_to be_empty
    end

    it "reads the column of every column gauge" do
      columns = PotatoMesh::App::Prometheus::NODE_COLUMN_GAUGES.values
      expect(PotatoMesh::App::Prometheus::NODE_SERIES_COLUMNS).to include(*columns)
    end

    it "builds every per-node family of METRICS" do
      built = PotatoMesh::App::Prometheus::NODE_COLUMN_GAUGES.keys + [
        PotatoMesh::App::Prometheus::NODE_GAUGE,
        PotatoMesh::App::Prometheus::NODE_LATITUDE,
        PotatoMesh::App::Prometheus::NODE_LONGITUDE,
        PotatoMesh::App::Prometheus::NODE_ALTITUDE,
      ]
      expect(built).to match_array(PotatoMesh::App::Prometheus::METRICS.select { |metric| metric.labels.include?(:node) })
    end
  end

  # ---------------------------------------------------------------------------
  # RouteCollector: the request metrics labelled by route (SPEC PG1)
  # ---------------------------------------------------------------------------
  describe PotatoMesh::App::Prometheus::RouteCollector do
    # A private registry keeps these series out of the global one.
    let(:registry) { ::Prometheus::Client::Registry.new }

    # Send GETs through one collector around +inner+.
    #
    # @param inner [#call] Rack application the collector wraps.
    # @param paths [Array<String>] request paths, in order.
    # @return [void]
    def collect(inner, *paths)
      collector = described_class.new(inner, registry: registry)
      paths.each { |path| collector.call(Rack::MockRequest.env_for(path)) }
    end

    it "labels a request with the route Sinatra matched" do
      routed = lambda do |env|
        env["sinatra.route"] = "GET /api/nodes/:id"
        [200, {}, []]
      end

      collect(routed, "/api/nodes/!0a2f0401")

      expect(registry.get(:http_server_requests_total).values.keys).to eq([{ code: "200", method: "get", path: "GET /api/nodes/:id" }])
      expect(registry.get(:http_server_request_duration_seconds).values.keys).to eq([{ method: "get", path: "GET /api/nodes/:id" }])
    end

    it "labels a static file static, the Exporter's path metrics and any other unrouted request unmatched" do
      inner = lambda do |env|
        case env["PATH_INFO"]
        when "/potatomesh-logo.svg"
          # Sinatra's static handler names the file it sends.
          env["sinatra.static_file"] = "/srv/public/potatomesh-logo.svg"
          [200, {}, []]
        when "/metrics" then [200, {}, []]
        else [404, {}, []]
        end
      end
      collect(inner, "/potatomesh-logo.svg", "/metrics", "/pg-nowhere/0a2f0402")

      expect(registry.get(:http_server_requests_total).values.keys).to eq(
        [
          { code: "200", method: "get", path: "static" },
          { code: "200", method: "get", path: "metrics" },
          { code: "404", method: "get", path: "unmatched" },
        ],
      )
    end

    it "makes a regular-expression route readable and leaves a string route as written" do
      expect(described_class.route_label("GET \\/map\\/?")).to eq("GET /map")
      expect(described_class.route_label("GET /api/nodes/:id")).to eq("GET /api/nodes/:id")
      expect(described_class.route_label("GET /")).to eq("GET /")
    end

    it "gives every route of the app its own readable label" do
      raw = PotatoMesh::Application.routes.flat_map do |verb, table|
        table.map { |pattern, _conditions, _block| "#{verb} #{pattern}" }
      end
      labels = raw.map { |route| described_class.route_label(route) }

      expect(labels.uniq.length).to eq(raw.length)
      expect(labels.grep(/\\/)).to eq([])
      expect(labels).to include("GET /map", "HEAD /map", "GET /nodes", "GET /nodes/:id", "GET /federation")
      expect(labels & %w[static metrics unmatched]).to eq([])
    end

    it "keeps the gem's metric names and labels" do
      collect(->(_env) { [200, {}, []] }, "/")

      expect(registry.metrics.map { |metric| [metric.name, metric.labels] }).to eq(
        [
          [:http_server_requests_total, %i[code method path]],
          [:http_server_request_duration_seconds, %i[method path]],
          [:http_server_exceptions_total, [:exception]],
        ],
      )
    end
  end

  # ---------------------------------------------------------------------------
  # prometheus_coordinates (SPEC PG3)
  # ---------------------------------------------------------------------------
  describe "#prometheus_coordinates" do
    it "keeps a pair on the globe, its edges included" do
      expect(prometheus.prometheus_coordinates(52.5, 13.4)).to eq([52.5, 13.4])
      expect(prometheus.prometheus_coordinates(90, -180)).to eq([90.0, -180.0])
      expect(prometheus.prometheus_coordinates(-90.0, 180.0)).to eq([-90.0, 180.0])
    end

    it "drops the pair when either axis is off the globe, also with the other axis absent" do
      [[90.0001, 13.4], [52.5, -180.5], [398.761944, 332.909167], [214.7483647, -214.7483647], [95.0, nil], [nil, 190.0]].each do |lat, lon|
        expect(prometheus.prometheus_coordinates(lat, lon)).to eq([nil, nil]), "kept (#{lat.inspect}, #{lon.inspect})"
      end
    end

    # Issue #782: a paired ``(0, 0)`` is the Meshtastic "no GPS lock"
    # sentinel, while a single-axis zero is a fix on the equator or the prime
    # meridian.
    it "drops the (0, 0) sentinel and keeps a single-axis zero" do
      expect(prometheus.prometheus_coordinates(0.0, 0.0)).to eq([nil, nil])
      expect(prometheus.prometheus_coordinates(0.0, 13.4)).to eq([0.0, 13.4])
      expect(prometheus.prometheus_coordinates(52.5, 0.0)).to eq([52.5, 0.0])
    end

    it "keeps a single axis on the globe and drops an axis that is no number" do
      expect(prometheus.prometheus_coordinates(52.5, nil)).to eq([52.5, nil])
      expect(prometheus.prometheus_coordinates("52.5", "east")).to eq([52.5, nil])
      expect(prometheus.prometheus_coordinates(Float::INFINITY, 13.4)).to eq([nil, 13.4])
    end
  end

  # ---------------------------------------------------------------------------
  # prometheus_node_count and the boot seed (SPEC PG4)
  # ---------------------------------------------------------------------------
  describe "#prometheus_node_count" do
    let(:marker) { PotatoMesh::Config.node_opt_out_marker }
    let(:now) { Time.now.to_i }

    it "counts what GET /api/nodes lists: heard within the week, not opted out, not hidden under PRIVATE=1" do
      insert_node_row("!0a2f0501", last_heard: now - 60)
      insert_node_row("!0a2f0502", last_heard: now - 8 * 86_400)
      insert_node_row("!0a2f0503", long_name: "Quiet #{marker} Station")
      insert_node_row("!0a2f0504", short_name: "Q#{marker}")
      insert_node_row("!0a2f0505", role: "CLIENT_HIDDEN")

      expect(prometheus.prometheus_node_count).to eq(2)
      expect(prometheus.query_nodes(1000).length).to eq(2)

      allow(prometheus).to receive(:private_mode?).and_return(true)
      expect(prometheus.prometheus_node_count).to eq(1)
      expect(prometheus.query_nodes(1000).length).to eq(1)
    end

    it "takes the week's floor inclusively" do
      insert_node_row("!0a2f0506", last_heard: now - 604_800)
      insert_node_row("!0a2f0507", last_heard: now - 604_801)

      expect(prometheus.prometheus_node_count(now: now)).to eq(1)
    end

    it "counts on a handle it is given and leaves it open, else opens and closes its own" do
      insert_node_row("!0a2f0508")
      handle = prometheus.open_database
      opened = []
      allow(prometheus).to receive(:open_database).and_wrap_original do |original, **options|
        original.call(**options).tap { |db| opened << db }
      end

      expect(prometheus.prometheus_node_count(handle)).to eq(1)
      expect(handle).not_to be_closed
      expect(opened).to be_empty

      expect(prometheus.prometheus_node_count).to eq(1)
      expect(opened.length).to eq(1)
      expect(opened.first).to be_closed
    ensure
      handle&.close
    end

    it "raises when it cannot open the database" do
      missing = File.join(File.dirname(PotatoMesh::Config.db_path), "missing", "mesh.db")
      allow(PotatoMesh::Config).to receive(:db_path).and_return(missing)

      expect { prometheus.prometheus_node_count }.to raise_error(SQLite3::CantOpenException)
    end
  end

  describe "#update_all_prometheus_metrics_from_nodes" do
    it "seeds the node-count gauge from the database and sets no per-node gauge" do
      insert_node_row("!0a2f0601")
      insert_node_row("!0a2f0602")
      per_node = PotatoMesh::App::Prometheus::METRICS.select { |metric| metric.labels.include?(:node) }
      per_node.each { |metric| allow(metric).to receive(:set) }
      allow(PotatoMesh::App::Prometheus::NODES_GAUGE).to receive(:set)

      prometheus.update_all_prometheus_metrics_from_nodes

      expect(PotatoMesh::App::Prometheus::NODES_GAUGE).to have_received(:set).with(2)
      per_node.each { |metric| expect(metric).not_to have_received(:set) }
    end
  end

  # ---------------------------------------------------------------------------
  # prometheus_node_rows: PM1's visible set, narrowed by PROM_REPORT_IDS
  # (SPEC PM1, PM2, PG2)
  # ---------------------------------------------------------------------------
  describe "#prometheus_node_rows" do
    let(:marker) { PotatoMesh::Config.node_opt_out_marker }
    let(:now) { Time.now.to_i }

    # Node ids of the rows a scrape reads.
    #
    # @param ids [Array<String>] report ids.
    # @return [Array<String>] node ids in row order.
    def row_ids(ids = ["*"])
      prometheus.prometheus_node_rows(ids).map { |row| row["node_id"] }
    end

    it "returns every node without the marker by node id, also one older than every API window" do
      insert_node_row("!0a2f0102", last_heard: now - 60 * 86_400)
      insert_node_row("!0a2f0101", last_heard: now)

      expect(row_ids).to eq(%w[!0a2f0101 !0a2f0102])
    end

    it "leaves out a node whose long or short name carries the opt-out marker" do
      insert_node_row("!0a2f0103")
      insert_node_row("!0a2f0104", long_name: "Quiet #{marker} Station")
      insert_node_row("!0a2f0105", short_name: "Q#{marker}")

      expect(row_ids).to eq(["!0a2f0103"])
    end

    it "leaves out a node whose row the retention purge deleted" do
      insert_node_row("!0a2f0106", last_heard: now)
      insert_node_row("!0a2f0107", last_heard: now - PotatoMesh::Config.year_seconds - 60)
      allow(PotatoMesh::Application).to receive(:info_log)
      PotatoMesh::Application.purge_old_data!(now: now)

      expect(row_ids).to eq(["!0a2f0106"])
    end

    it "returns a node again once it removes the marker" do
      insert_node_row("!0a2f0108", long_name: "Quiet #{marker} Station")
      expect(row_ids).to be_empty

      execute_sql("UPDATE nodes SET long_name = ? WHERE node_id = ?", ["Quiet Station", "!0a2f0108"])
      expect(row_ids).to eq(["!0a2f0108"])
    end

    it "leaves out CLIENT_HIDDEN nodes under PRIVATE=1 only, keeping a NULL role" do
      insert_node_row("!0a2f0109", role: "CLIENT_HIDDEN")
      insert_node_row("!0a2f010a", role: nil)
      insert_node_row("!0a2f010b", role: "ROUTER")
      expect(row_ids).to eq(%w[!0a2f0109 !0a2f010a !0a2f010b])

      allow(prometheus).to receive(:private_mode?).and_return(true)
      expect(row_ids).to eq(%w[!0a2f010a !0a2f010b])
    end

    it "keeps the visible nodes a list names, every node for a leading *, and runs no query without ids" do
      insert_node_row("!0a2f0110")
      insert_node_row("!0a2f0111")
      insert_node_row("!0a2f0112", long_name: "Quiet #{marker} Station")

      expect(row_ids(%w[!0a2f0111 !0a2f0112 !0a2f01ff])).to eq(["!0a2f0111"])
      # Only a leading * is the wildcard; anywhere else it names no node.
      expect(row_ids(%w[!0a2f0110 *])).to eq(["!0a2f0110"])
      expect(row_ids(["*"])).to eq(%w[!0a2f0110 !0a2f0111])

      expect(prometheus).not_to receive(:open_database)
      expect(prometheus.prometheus_node_rows([])).to eq([])
    end

    it "reads the configured report ids and every column the series need" do
      insert_node_row("!0a2f0113")

      rows = prometheus.prometheus_node_rows

      expect(rows.map { |row| row["node_id"] }).to eq(["!0a2f0113"])
      expect(rows.first.keys).to match_array(PotatoMesh::App::Prometheus::NODE_SERIES_COLUMNS)
    end
  end

  # ---------------------------------------------------------------------------
  # prometheus_node_series: the per-node series of one scrape (SPEC PG2, PG3)
  # ---------------------------------------------------------------------------
  describe "#prometheus_node_series" do
    let(:now) { Time.now.to_i }

    # Store measurements on a node row.
    #
    # @param node_id [String] canonical node id.
    # @param columns [Hash{Symbol => Object}] column values.
    # @return [void]
    def store_columns(node_id, **columns)
      assignments = columns.keys.map { |column| "#{column} = ?" }.join(", ")
      execute_sql("UPDATE nodes SET #{assignments} WHERE node_id = ?", columns.values + [node_id])
    end

    it "builds every per-node family from a full row" do
      insert_node_row("!0a2f0701", long_name: "Full Station", short_name: "FS")
      store_columns("!0a2f0701", hw_model: "TBEAM", battery_level: 80, voltage: 4.1, uptime_seconds: 3600,
                                 channel_utilization: 12.5, air_util_tx: 1.25, latitude: 52.5, longitude: 13.4, altitude: 40)
      node = { node: "!0a2f0701" }

      expect(prometheus.prometheus_node_series).to eq(
        meshtastic_node: { node.merge(short_name: "FS", long_name: "Full Station", hw_model: "TBEAM", role: "CLIENT") => 1.0 },
        meshtastic_node_battery_level: { node => 80.0 },
        meshtastic_node_voltage: { node => 4.1 },
        meshtastic_node_uptime_seconds: { node => 3600.0 },
        meshtastic_node_channel_utilization: { node => 12.5 },
        meshtastic_node_transmit_air_utilization: { node => 1.25 },
        meshtastic_node_latitude: { node => 52.5 },
        meshtastic_node_longitude: { node => 13.4 },
        meshtastic_node_altitude: { node => 40.0 },
      )
    end

    it "labels presence with empty names and model and the CLIENT role when they are NULL, and skips columns that hold no number" do
      execute_sql("INSERT INTO nodes(node_id, last_heard, voltage, altitude) VALUES (?, ?, ?, ?)", ["!0a2f0702", now, "four volts", 10])

      expect(prometheus.prometheus_node_series).to eq(
        meshtastic_node: { { node: "!0a2f0702", short_name: "", long_name: "", hw_model: "", role: "CLIENT" } => 1.0 },
      )
      # GET /api/nodes shows the same role for the row.
      expect(prometheus.query_nodes(10).map { |row| row["role"] }).to eq(["CLIENT"])
    end

    it "exports no coordinate gauge for a position off the globe or at (0, 0), and the altitude only beside a kept axis" do
      { "!0a2f0703" => [95.0, 13.4], "!0a2f0704" => [0.0, 0.0], "!0a2f0705" => [52.5, nil], "!0a2f0706" => [nil, nil] }.each do |node_id, (lat, lon)|
        insert_node_row(node_id)
        store_columns(node_id, latitude: lat, longitude: lon, altitude: 10)
      end

      series = prometheus.prometheus_node_series

      expect(series[:meshtastic_node_latitude]).to eq({ { node: "!0a2f0705" } => 52.5 })
      expect(series).not_to have_key(:meshtastic_node_longitude)
      expect(series[:meshtastic_node_altitude]).to eq({ { node: "!0a2f0705" } => 10.0 })
      expect(series[:meshtastic_node].length).to eq(4)
    end

    it "builds nothing without report ids" do
      insert_node_row("!0a2f0707")
      allow(prometheus).to receive(:prom_report_ids).and_return([])

      expect(prometheus.prometheus_node_series).to eq({})
    end
  end

  # ---------------------------------------------------------------------------
  # ExportRegistry: the view /metrics prints (SPEC PM1, PM2, PG2)
  # ---------------------------------------------------------------------------
  describe PotatoMesh::App::Prometheus::ExportRegistry do
    let(:marker) { PotatoMesh::Config.node_opt_out_marker }
    # A private registry with two of the real per-node families, a
    # node-labelled family the build does not fill, and two families without
    # a node label.
    let(:registry) do
      ::Prometheus::Client::Registry.new.tap do |private_registry|
        private_registry.register(PotatoMesh::App::Prometheus::NODE_BATTERY_LEVEL)
        private_registry.register(PotatoMesh::App::Prometheus::NODE_GAUGE)
      end
    end
    let!(:unbuilt) { registry.gauge(:spec_node_unbuilt, docstring: "Unbuilt", labels: [:node]) }
    let!(:requests) { registry.counter(:spec_requests_total, docstring: "Requests", labels: [:path]) }
    let!(:messages) { registry.counter(:spec_messages_total, docstring: "Messages") }

    subject(:export) { described_class.new(registry, prometheus) }

    # Print the view the way the Exporter middleware does.
    #
    # @return [String] text exposition of one scrape.
    def scrape
      ::Prometheus::Client::Formats::Text.marshal(export)
    end

    # Store a battery level on a node row.
    #
    # @param node_id [String] canonical node id.
    # @param level [Numeric] battery level.
    # @return [void]
    def store_battery(node_id, level)
      execute_sql("UPDATE nodes SET battery_level = ? WHERE node_id = ?", [level, node_id])
    end

    # The presence line +insert_node_row+'s defaults print.
    #
    # @param node_id [String] canonical node id.
    # @param long_name [String] stored long name.
    # @return [String] +meshtastic_node+ sample.
    def presence(node_id, long_name = "Spec Node")
      %(meshtastic_node{node="#{node_id}",short_name="SN",long_name="#{long_name}",hw_model="",role="CLIENT"} 1.0)
    end

    it "prints the stored series of visible nodes, none of opted-out or deleted nodes" do
      insert_node_row("!0a2f0201")
      insert_node_row("!0a2f0202", long_name: "Quiet #{marker} Station")
      store_battery("!0a2f0201", 50)
      store_battery("!0a2f0202", 51)
      # !0a2f0203 has a registry series but no row, as after a retention purge.
      unbuilt.set(52, labels: { node: "!0a2f0203" })

      text = scrape

      expect(node_samples(text, "!0a2f0201")).to eq(['meshtastic_node_battery_level{node="!0a2f0201"} 50.0', presence("!0a2f0201")])
      expect(node_samples(text, "!0a2f0202")).to eq([])
      expect(node_samples(text, "!0a2f0203")).to eq([])
    end

    it "prints no series of a node-labelled family the build does not fill, whatever the registry holds" do
      insert_node_row("!0a2f0209")
      unbuilt.set(9, labels: { node: "!0a2f0209" })

      text = scrape

      expect(text).to include("# TYPE spec_node_unbuilt gauge")
      expect(node_samples(text, "!0a2f0209")).to eq([presence("!0a2f0209")])
    end

    it "passes families without a node label through unchanged" do
      requests.increment(labels: { path: "GET /api/nodes/:id" })
      messages.increment

      families = export.metrics

      expect(families.map(&:name)).to eq(%i[meshtastic_node_battery_level meshtastic_node spec_node_unbuilt spec_requests_total spec_messages_total])
      expect(families[3]).to be(requests)
      expect(families[4]).to be(messages)
      expect(scrape).to include(%(spec_requests_total{path="GET /api/nodes/:id"} 1.0), "spec_messages_total 1.0")
    end

    it "wraps a per-node family without changing its name, type, help or labels" do
      family = export.metrics.first

      expect(family).to be_a(described_class::NodeFamily)
      expect([family.name, family.type, family.docstring, family.labels]).to eq(
        [:meshtastic_node_battery_level, :gauge, "Battery level of a Meshtastic node", [:node]],
      )
    end

    it "runs one node lookup per scrape" do
      allow(prometheus).to receive(:prometheus_node_series).and_call_original

      scrape

      expect(prometheus).to have_received(:prometheus_node_series).once
    end

    it "withholds every per-node family and logs a warning when the lookup raises" do
      insert_node_row("!0a2f0204")
      store_battery("!0a2f0204", 70)
      messages.increment
      # The node query cannot open the database.
      missing = File.join(File.dirname(PotatoMesh::Config.db_path), "missing", "mesh.db")
      allow(PotatoMesh::Config).to receive(:db_path).and_return(missing)
      allow(prometheus).to receive(:warn_log)

      text = scrape

      # No sample and no TYPE/HELP line of any per-node family.
      expect(text).not_to include("meshtastic_node", "spec_node")
      expect(text).to include("# TYPE spec_requests_total counter", "spec_messages_total 1.0")
      expect(prometheus).to have_received(:warn_log).with(
        "Withheld per-node metrics: visible node lookup failed",
        context: "prometheus.export",
        error_class: "SQLite3::CantOpenException",
        error_message: "unable to open database file",
      ).once
    end

    it "exports a node in an explicit PROM_REPORT_IDS list only while /api/nodes lists it" do
      allow(prometheus).to receive(:prom_report_ids).and_return(["!0a2f0205", "!0a2f0206"])
      insert_node_row("!0a2f0205")
      insert_node_row("!0a2f0206", long_name: "Quiet #{marker} Station")
      insert_node_row("!0a2f0207")
      %w[!0a2f0205 !0a2f0206 !0a2f0207].each { |node_id| store_battery(node_id, 40) }

      text = scrape

      expect(node_samples(text, "!0a2f0205")).to eq(['meshtastic_node_battery_level{node="!0a2f0205"} 40.0', presence("!0a2f0205")])
      expect(node_samples(text, "!0a2f0206")).to eq([])
      expect(node_samples(text, "!0a2f0207")).to eq([])
    end

    it "gives a node its series back, with its stored values, once it removes the marker" do
      insert_node_row("!0a2f0208", long_name: "Quiet #{marker} Station")
      store_battery("!0a2f0208", 33)
      expect(node_samples(scrape, "!0a2f0208")).to eq([])

      execute_sql("UPDATE nodes SET long_name = ? WHERE node_id = ?", ["Quiet Station", "!0a2f0208"])

      expect(node_samples(scrape, "!0a2f0208")).to eq(
        ['meshtastic_node_battery_level{node="!0a2f0208"} 33.0', presence("!0a2f0208", "Quiet Station")],
      )
    end
  end

  # ---------------------------------------------------------------------------
  # /metrics wiring: the collector, the Exporter and the route (SPEC PM1, PG1)
  # ---------------------------------------------------------------------------
  describe "/metrics wiring" do
    let(:export) { PotatoMesh::Application.settings.prometheus_export_registry }

    it "hands the Exporter middleware the application's export registry" do
      exporter = PotatoMesh::Application.middleware.find { |klass, _args, _block| klass == ::Prometheus::Middleware::Exporter }

      expect(export).to be_a(PotatoMesh::App::Prometheus::ExportRegistry)
      expect(exporter[1].first[:registry]).to be(export)
    end

    it "records requests through the route-labelled collector, outside the Exporter" do
      classes = PotatoMesh::Application.middleware.map(&:first)

      expect(classes).not_to include(::Prometheus::Middleware::Collector)
      expect(classes.index(PotatoMesh::App::Prometheus::RouteCollector)).to be < classes.index(::Prometheus::Middleware::Exporter)
    end

    it "mounts the Exporter at the path the collector labels metrics" do
      exporter = PotatoMesh::Application.middleware.find { |klass, _args, _block| klass == ::Prometheus::Middleware::Exporter }

      expect(exporter[1].first).not_to have_key(:path)
      expect(::Prometheus::Middleware::Exporter.new(->(_env) { [200, {}, []] }).path).to eq(PotatoMesh::App::Prometheus::METRICS_PATH)
    end

    it "prints the same view from the /metrics route" do
      marker = PotatoMesh::Config.node_opt_out_marker
      allow(PotatoMesh::Config).to receive(:prom_report_id_list).and_return(["*"])
      insert_node_row("!0a2f0301")
      insert_node_row("!0a2f0302", long_name: "Quiet #{marker} Station")
      execute_sql("UPDATE nodes SET battery_level = ?", [61])

      # The bare instance has no middleware, so the Sinatra route answers.
      response = Rack::MockRequest.new(PotatoMesh::Application.new!).get("/metrics")

      expect(response.status).to eq(200)
      expect(response.content_type).to start_with(::Prometheus::Client::Formats::Text::CONTENT_TYPE)
      expect(node_samples(response.body, "!0a2f0301")).to include('meshtastic_node_battery_level{node="!0a2f0301"} 61.0')
      expect(node_samples(response.body, "!0a2f0302")).to eq([])
    end
  end

  # ---------------------------------------------------------------------------
  # GET /metrics, the node opt-out marker and private mode (Invariant II,
  # SPEC PM1/PM2, ACCEPTANCE PM-A1)
  # ---------------------------------------------------------------------------
  describe "GET /metrics for a node that /api/nodes hides" do
    let(:app) { Sinatra::Application }
    let(:api_token) { "prometheus-spec-token" }
    let(:auth_headers) do
      { "CONTENT_TYPE" => "application/json", "HTTP_AUTHORIZATION" => "Bearer #{api_token}" }
    end
    let(:now) { Time.now.to_i }
    let(:marker) { PotatoMesh::Config.node_opt_out_marker }
    # Every family keyed on a +node+ label; +node_record+ sets all of them.
    let(:per_node_families) do
      PotatoMesh::App::Prometheus::METRICS.count { |metric| metric.labels.include?(:node) }
    end

    around do |example|
      saved = ENV.to_h.slice("API_TOKEN", "PROM_REPORT_IDS", "PRIVATE")
      ENV["API_TOKEN"] = api_token
      ENV["PROM_REPORT_IDS"] = "*"
      ENV.delete("PRIVATE")
      PotatoMesh::App::ApiCache.invalidate_all
      example.run
    ensure
      %w[API_TOKEN PROM_REPORT_IDS PRIVATE].each do |key|
        saved.key?(key) ? ENV[key] = saved[key] : ENV.delete(key)
      end
    end

    # Node record carrying every field a per-node gauge exports.
    #
    # @param long_name [String] display name; the marker in it opts the node out.
    # @param heard [Integer] lastHeard, so a later record wins the upsert guard.
    # @param role [String] node role; +CLIENT_HIDDEN+ hides it under +PRIVATE=1+.
    # @return [Hash] one node entry of a +POST /api/nodes+ body.
    def node_record(long_name, heard, role: "CLIENT")
      {
        "user" => { "longName" => long_name, "shortName" => "PM", "hwModel" => "TBEAM", "role" => role },
        "deviceMetrics" => {
          "batteryLevel" => 80, "voltage" => 4.0, "uptimeSeconds" => 60,
          "channelUtilization" => 9.5, "airUtilTx" => 1.25,
        },
        "position" => { "latitude" => 52.5, "longitude" => 13.4, "altitude" => 40, "time" => heard },
        "lastHeard" => heard,
      }
    end

    # Node ids +GET /api/nodes+ serves.
    #
    # @return [Array<String>] listed node ids.
    def listed_node_ids
      get "/api/nodes"
      JSON.parse(last_response.body).map { |node| node["node_id"] }
    end

    it "serves no series of an opted-out node on any write path, including series exported before the opt-out" do
      visible = "!0a2f0001"
      opted = "!0a2f0002"
      post "/api/nodes", { visible => node_record("Loud Station", now - 60), opted => node_record("Quiet Station", now - 60) }.to_json, auth_headers
      expect(last_response.status).to eq(201)
      # Before the opt-out the node is exported like any other.
      expect(scraped_node_samples(opted).length).to eq(per_node_families)

      post "/api/nodes", { opted => node_record("Quiet #{marker} Station", now - 30) }.to_json, auth_headers
      post "/api/telemetry", [{ id: 920_001, node_id: opted, rx_time: now - 20, battery_level: 55, voltage: 3.7 }].to_json, auth_headers
      post "/api/positions", [{ id: 920_002, node_id: opted, rx_time: now - 10, latitude: 48.1, longitude: 11.5, altitude: 520 }].to_json, auth_headers
      expect(listed_node_ids).to eq([visible])

      expect(scraped_node_samples(opted)).to eq([])
      expect(scraped_node_samples(visible).length).to eq(per_node_families)
    end

    it "serves no series of an opted-out node named in an explicit PROM_REPORT_IDS list" do
      visible = "!0a2f0003"
      opted = "!0a2f0004"
      ENV["PROM_REPORT_IDS"] = "#{visible},#{opted}"
      post "/api/nodes", { visible => node_record("Loud Station", now - 30), opted => node_record("Quiet #{marker} Station", now - 30) }.to_json, auth_headers
      expect(listed_node_ids).to eq([visible])

      expect(scraped_node_samples(opted)).to eq([])
      expect(scraped_node_samples(visible).length).to eq(per_node_families)
    end

    it "serves no series of an opted-out Reticulum node announced under an unmarked aspect" do
      ingestor = "!0a2f00ff"
      node_id = "!0a2f0005"
      post "/api/ingestors", { node_id: ingestor, start_time: now - 60, last_seen_time: now, version: "0.8.0", protocol: "reticulum" }.to_json, auth_headers
      announce = lambda do |name, aspect, role, dest_byte, heard|
        {
          node_id => {
            "user" => { "longName" => name, "shortName" => "0a2f", "publicKey" => "cd" * 64, "role" => role },
            "lastHeard" => heard,
            "protocol" => "reticulum",
            "identityHash" => "0a2f0005#{"00" * 12}",
            "destination" => { "id" => "0a2f0005#{dest_byte * 12}", "aspect" => aspect, "role" => role },
          },
          "ingestor" => ingestor,
          "protocol" => "reticulum",
        }
      end
      post "/api/nodes", announce.call("Argos Station", "lxmf.delivery", "PEER", "22", now - 40).to_json, auth_headers
      # Before the opt-out the Reticulum node is exported like any other.
      expect(scraped_node_samples(node_id)).not_to be_empty

      post "/api/nodes", announce.call("Quiet #{marker} Node", "nomadnetwork.node", "NODE", "11", now - 30).to_json, auth_headers
      # The PEER aspect announces again, without the marker. RE10 keeps the
      # NODE aspect's name as the headline, so the node stays opted out.
      post "/api/nodes", announce.call("Argos Station", "lxmf.delivery", "PEER", "22", now - 10).to_json, auth_headers
      expect(listed_node_ids).to eq([])

      expect(scraped_node_samples(node_id)).to eq([])
    end

    it "serves no series of a CLIENT_HIDDEN node under PRIVATE=1 while a visible node keeps every family" do
      ENV["PRIVATE"] = "1"
      visible = "!0a2f0006"
      hidden = "!0a2f0007"
      post "/api/nodes", { visible => node_record("Loud Station", now - 30), hidden => node_record("Hidden Station", now - 30, role: "CLIENT_HIDDEN") }.to_json, auth_headers
      expect(last_response.status).to eq(201)
      expect(listed_node_ids).to eq([visible])

      expect(scraped_node_samples(hidden)).to eq([])
      expect(scraped_node_samples(visible).length).to eq(per_node_families)
    end
  end
end
