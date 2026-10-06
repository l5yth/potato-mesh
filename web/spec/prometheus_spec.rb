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

RSpec.describe PotatoMesh::App::Prometheus do
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

      def update_prometheus_metrics(*); end

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

  # Sample lines labelled with one node id, comments excluded.
  #
  # @param text [String] Prometheus text exposition.
  # @param node_id [String] canonical node id.
  # @return [Array<String>] exposition lines for that node.
  def node_samples(text, node_id)
    text.each_line
      .reject { |line| line.start_with?("#") }
      .select { |line| line.include?(%(node="#{node_id}")) }
      .map(&:chomp)
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
  end

  # ---------------------------------------------------------------------------
  # update_prometheus_metrics
  # ---------------------------------------------------------------------------
  describe "#update_prometheus_metrics" do
    # Re-include the real implementation so we can test it.
    let(:real_class) do
      Class.new do
        include PotatoMesh::App::Prometheus

        def prom_report_ids
          ["*"]
        end
      end
    end

    subject(:prom_obj) { real_class.new }

    it "is a no-op when ids list is empty" do
      allow(prom_obj).to receive(:prom_report_ids).and_return([])
      expect { prom_obj.update_prometheus_metrics("!aabb1234") }.not_to raise_error
    end

    it "is a no-op when node_id is nil" do
      expect { prom_obj.update_prometheus_metrics(nil) }.not_to raise_error
    end

    it "skips when node is not in the allowed id list" do
      allow(prom_obj).to receive(:prom_report_ids).and_return(["!other"])
      expect(PotatoMesh::App::Prometheus::NODE_GAUGE).not_to receive(:set)
      prom_obj.update_prometheus_metrics("!aabb1234")
    end

    it "sets NODE_GAUGE when user data and role are present" do
      allow(PotatoMesh::App::Prometheus::NODE_GAUGE).to receive(:set)
      prom_obj.update_prometheus_metrics(
        "!aabb1234",
        { "shortName" => "T", "longName" => "Test", "hwModel" => "TBEAM" },
        "CLIENT",
      )
      expect(PotatoMesh::App::Prometheus::NODE_GAUGE).to have_received(:set).once
    end

    it "sets battery level gauge when provided" do
      allow(PotatoMesh::App::Prometheus::NODE_BATTERY_LEVEL).to receive(:set)
      prom_obj.update_prometheus_metrics(
        "!aabb1234",
        nil,
        "",
        { "batteryLevel" => 75 },
      )
      expect(PotatoMesh::App::Prometheus::NODE_BATTERY_LEVEL).to have_received(:set).with(75, labels: { node: "!aabb1234" })
    end

    it "sets latitude/longitude when position is present" do
      allow(PotatoMesh::App::Prometheus::NODE_LATITUDE).to receive(:set)
      allow(PotatoMesh::App::Prometheus::NODE_LONGITUDE).to receive(:set)
      prom_obj.update_prometheus_metrics(
        "!aabb1234",
        nil,
        "",
        nil,
        { "latitude" => 52.0, "longitude" => 13.0 },
      )
      expect(PotatoMesh::App::Prometheus::NODE_LATITUDE).to have_received(:set).with(52.0, labels: { node: "!aabb1234" })
      expect(PotatoMesh::App::Prometheus::NODE_LONGITUDE).to have_received(:set).with(13.0, labels: { node: "!aabb1234" })
    end

    # Issue #782: a Meshtastic node without a GPS lock emits ``(0, 0)`` on
    # every nodeinfo.  The previous truthy-zero guard clobbered NODE_LATITUDE
    # and NODE_LONGITUDE to 0 on each update; after the fix the gauges retain
    # their last real value and the sentinel is silently ignored.
    it "skips the lat/lon gauges for the (0, 0) Null Island sentinel" do
      allow(PotatoMesh::App::Prometheus::NODE_LATITUDE).to receive(:set)
      allow(PotatoMesh::App::Prometheus::NODE_LONGITUDE).to receive(:set)
      prom_obj.update_prometheus_metrics(
        "!aabb1234",
        nil,
        "",
        nil,
        { "latitude" => 0.0, "longitude" => 0.0 },
      )
      expect(PotatoMesh::App::Prometheus::NODE_LATITUDE).not_to have_received(:set)
      expect(PotatoMesh::App::Prometheus::NODE_LONGITUDE).not_to have_received(:set)
    end

    it "preserves an equator fix (lat=0, lon!=0)" do
      allow(PotatoMesh::App::Prometheus::NODE_LATITUDE).to receive(:set)
      allow(PotatoMesh::App::Prometheus::NODE_LONGITUDE).to receive(:set)
      prom_obj.update_prometheus_metrics(
        "!aabb1234",
        nil,
        "",
        nil,
        { "latitude" => 0.0, "longitude" => 13.4 },
      )
      expect(PotatoMesh::App::Prometheus::NODE_LATITUDE).to have_received(:set).with(0.0, labels: { node: "!aabb1234" })
      expect(PotatoMesh::App::Prometheus::NODE_LONGITUDE).to have_received(:set).with(13.4, labels: { node: "!aabb1234" })
    end

    it "preserves a prime-meridian fix (lat!=0, lon=0)" do
      allow(PotatoMesh::App::Prometheus::NODE_LATITUDE).to receive(:set)
      allow(PotatoMesh::App::Prometheus::NODE_LONGITUDE).to receive(:set)
      prom_obj.update_prometheus_metrics(
        "!aabb1234",
        nil,
        "",
        nil,
        { "latitude" => 52.5, "longitude" => 0.0 },
      )
      expect(PotatoMesh::App::Prometheus::NODE_LATITUDE).to have_received(:set).with(52.5, labels: { node: "!aabb1234" })
      expect(PotatoMesh::App::Prometheus::NODE_LONGITUDE).to have_received(:set).with(0.0, labels: { node: "!aabb1234" })
    end
  end

  # ---------------------------------------------------------------------------
  # update_all_prometheus_metrics_from_nodes
  # ---------------------------------------------------------------------------
  describe "#update_all_prometheus_metrics_from_nodes" do
    it "sets NODES_GAUGE to the count of returned nodes" do
      nodes = [
        { "node_id" => "!aabb1234", "short_name" => "A", "long_name" => "Alpha", "hw_model" => "TBEAM", "role" => "CLIENT" },
      ]
      allow(prometheus).to receive(:query_nodes).and_return(nodes)
      allow(prometheus).to receive(:update_prometheus_metrics)
      allow(PotatoMesh::App::Prometheus::NODES_GAUGE).to receive(:set)

      prometheus.update_all_prometheus_metrics_from_nodes

      expect(PotatoMesh::App::Prometheus::NODES_GAUGE).to have_received(:set).with(1)
    end

    it "iterates over all nodes when prom_report_ids includes wildcard" do
      nodes = [
        { "node_id" => "!aabb1234", "short_name" => "A", "long_name" => "Alpha", "hw_model" => "TBEAM", "role" => "CLIENT" },
      ]
      allow(prometheus).to receive(:query_nodes).and_return(nodes)
      allow(prometheus).to receive(:update_prometheus_metrics)
      allow(PotatoMesh::App::Prometheus::NODES_GAUGE).to receive(:set)

      prometheus.update_all_prometheus_metrics_from_nodes

      expect(prometheus).to have_received(:update_prometheus_metrics).once
    end

    it "skips metric updates when prom_report_ids is empty" do
      # Override prom_report_ids to return empty list for this test.
      klass = Class.new do
        include PotatoMesh::App::Prometheus
        include PotatoMesh::App::Queries
        include PotatoMesh::App::Helpers
        include PotatoMesh::App::DataProcessing

        def prom_report_ids
          []
        end

        def private_mode?; false; end
        def debug_log(m, **); end
        def warn_log(m, **); end
        def open_database(**); SQLite3::Database.new(PotatoMesh::Config.db_path); end
        def normalize_node_id(*); nil; end
        def with_busy_retry; yield; end
        def update_prometheus_metrics(*); end
        def resolve_protocol(*); "meshtastic"; end
      end

      obj = klass.new
      allow(obj).to receive(:query_nodes).and_return([{ "node_id" => "!aabb1234" }])
      allow(obj).to receive(:update_prometheus_metrics)
      allow(PotatoMesh::App::Prometheus::NODES_GAUGE).to receive(:set)

      obj.update_all_prometheus_metrics_from_nodes

      expect(obj).not_to have_received(:update_prometheus_metrics)
    end
  end

  # ---------------------------------------------------------------------------
  # prometheus_visible_node_ids (SPEC PM1/PM2)
  # ---------------------------------------------------------------------------
  describe "#prometheus_visible_node_ids" do
    let(:marker) { PotatoMesh::Config.node_opt_out_marker }
    let(:now) { Time.now.to_i }

    it "returns every node without the marker, also one older than every API window" do
      insert_node_row("!0a2f0101", last_heard: now)
      insert_node_row("!0a2f0102", last_heard: now - 60 * 86_400)

      expect(prometheus.prometheus_visible_node_ids).to eq(Set["!0a2f0101", "!0a2f0102"])
    end

    it "leaves out a node whose long or short name carries the opt-out marker" do
      insert_node_row("!0a2f0103")
      insert_node_row("!0a2f0104", long_name: "Quiet #{marker} Station")
      insert_node_row("!0a2f0105", short_name: "Q#{marker}")

      expect(prometheus.prometheus_visible_node_ids).to eq(Set["!0a2f0103"])
    end

    it "leaves out a node whose row the retention purge deleted" do
      insert_node_row("!0a2f0106", last_heard: now)
      insert_node_row("!0a2f0107", last_heard: now - PotatoMesh::Config.year_seconds - 60)
      allow(PotatoMesh::Application).to receive(:info_log)
      PotatoMesh::Application.purge_old_data!(now: now)

      expect(prometheus.prometheus_visible_node_ids).to eq(Set["!0a2f0106"])
    end

    it "returns a node again once it removes the marker" do
      insert_node_row("!0a2f0108", long_name: "Quiet #{marker} Station")
      expect(prometheus.prometheus_visible_node_ids).to be_empty

      execute_sql("UPDATE nodes SET long_name = ? WHERE node_id = ?", ["Quiet Station", "!0a2f0108"])
      expect(prometheus.prometheus_visible_node_ids).to eq(Set["!0a2f0108"])
    end

    it "leaves out CLIENT_HIDDEN nodes under PRIVATE=1 only, keeping a NULL role" do
      insert_node_row("!0a2f0109", role: "CLIENT_HIDDEN")
      insert_node_row("!0a2f010a", role: nil)
      insert_node_row("!0a2f010b", role: "ROUTER")
      expect(prometheus.prometheus_visible_node_ids).to eq(Set["!0a2f0109", "!0a2f010a", "!0a2f010b"])

      allow(prometheus).to receive(:private_mode?).and_return(true)
      expect(prometheus.prometheus_visible_node_ids).to eq(Set["!0a2f010a", "!0a2f010b"])
    end
  end

  # ---------------------------------------------------------------------------
  # ExportRegistry: the view /metrics prints (SPEC PM1/PM2)
  # ---------------------------------------------------------------------------
  describe PotatoMesh::App::Prometheus::ExportRegistry do
    let(:marker) { PotatoMesh::Config.node_opt_out_marker }
    # A private registry keeps these series out of the global one.
    let(:registry) { ::Prometheus::Client::Registry.new }
    let!(:battery) { registry.gauge(:spec_node_battery_level, docstring: "Battery", labels: [:node]) }
    let!(:presence) { registry.gauge(:spec_node, docstring: "Presence", labels: %i[node long_name]) }
    let!(:requests) { registry.counter(:spec_requests_total, docstring: "Requests", labels: [:path]) }
    let!(:messages) { registry.counter(:spec_messages_total, docstring: "Messages") }

    subject(:export) { described_class.new(registry, prometheus) }

    # Print the view the way the Exporter middleware does.
    #
    # @return [String] text exposition of one scrape.
    def scrape
      ::Prometheus::Client::Formats::Text.marshal(export)
    end

    it "keeps visible nodes' series with their values and drops opted-out and deleted nodes" do
      insert_node_row("!0a2f0201")
      insert_node_row("!0a2f0202", long_name: "Quiet #{marker} Station")
      # !0a2f0203 has series but no row, as after a retention purge.
      %w[!0a2f0201 !0a2f0202 !0a2f0203].each_with_index do |node_id, index|
        battery.set(50 + index, labels: { node: node_id })
        presence.set(1, labels: { node: node_id, long_name: "Station #{index}" })
      end

      text = scrape

      expect(node_samples(text, "!0a2f0201")).to eq(
        [
          'spec_node_battery_level{node="!0a2f0201"} 50.0',
          'spec_node{node="!0a2f0201",long_name="Station 0"} 1.0',
        ],
      )
      expect(node_samples(text, "!0a2f0202")).to eq([])
      expect(node_samples(text, "!0a2f0203")).to eq([])
      # The registry itself keeps every series; only the view filters.
      expect(battery.values.keys.map { |label_set| label_set[:node] }).to eq(%w[!0a2f0201 !0a2f0202 !0a2f0203])
    end

    it "passes families without a node label through unchanged" do
      requests.increment(labels: { path: "/api/nodes/!0a2f0202" })
      messages.increment

      families = export.metrics

      expect(families.map(&:name)).to eq(%i[spec_node_battery_level spec_node spec_requests_total spec_messages_total])
      expect(families[2]).to be(requests)
      expect(families[3]).to be(messages)
      expect(scrape).to include(%(spec_requests_total{path="/api/nodes/!0a2f0202"} 1.0), "spec_messages_total 1.0")
    end

    it "wraps a per-node family without changing its name, type, help or labels" do
      family = export.metrics.first

      expect(family).to be_a(described_class::NodeFamily)
      expect([family.name, family.type, family.docstring, family.labels]).to eq([:spec_node_battery_level, :gauge, "Battery", [:node]])
    end

    it "runs one visibility lookup per scrape" do
      allow(prometheus).to receive(:prometheus_visible_node_ids).and_call_original

      scrape

      expect(prometheus).to have_received(:prometheus_visible_node_ids).once
    end

    it "withholds every per-node family and logs a warning when the lookup raises" do
      insert_node_row("!0a2f0204")
      battery.set(70, labels: { node: "!0a2f0204" })
      messages.increment
      # The visibility query cannot open the database.
      missing = File.join(File.dirname(PotatoMesh::Config.db_path), "missing", "mesh.db")
      allow(PotatoMesh::Config).to receive(:db_path).and_return(missing)
      allow(prometheus).to receive(:warn_log)

      text = scrape

      # No sample and no TYPE/HELP line of either per-node family.
      expect(text).not_to include("spec_node")
      expect(text).to include("# TYPE spec_requests_total counter", "spec_messages_total 1.0")
      expect(prometheus).to have_received(:warn_log).with(
        "Withheld per-node metrics: visible node lookup failed",
        context: "prometheus.export",
        error_class: "SQLite3::CantOpenException",
        error_message: "unable to open database file",
      ).once
    end

    it "exports a node in an explicit PROM_REPORT_IDS list only while /api/nodes lists it" do
      reporter = Class.new do
        include PotatoMesh::App::Prometheus

        def prom_report_ids
          ["!0a2f0205", "!0a2f0206"]
        end
      end.new
      insert_node_row("!0a2f0205")
      insert_node_row("!0a2f0206", long_name: "Quiet #{marker} Station")
      insert_node_row("!0a2f0207")
      %w[!0a2f0205 !0a2f0206 !0a2f0207].each do |node_id|
        reporter.update_prometheus_metrics(node_id, nil, "", { "batteryLevel" => 40 })
      end

      text = ::Prometheus::Client::Formats::Text.marshal(described_class.new(::Prometheus::Client.registry, prometheus))

      expect(node_samples(text, "!0a2f0205")).to eq(['meshtastic_node_battery_level{node="!0a2f0205"} 40.0'])
      expect(node_samples(text, "!0a2f0206")).to eq([])
      expect(node_samples(text, "!0a2f0207")).to eq([])
    end

    it "gives a node its series back, with their last values, once it removes the marker" do
      insert_node_row("!0a2f0208", long_name: "Quiet #{marker} Station")
      battery.set(33, labels: { node: "!0a2f0208" })
      expect(node_samples(scrape, "!0a2f0208")).to eq([])

      execute_sql("UPDATE nodes SET long_name = ? WHERE node_id = ?", ["Quiet Station", "!0a2f0208"])

      expect(node_samples(scrape, "!0a2f0208")).to eq(['spec_node_battery_level{node="!0a2f0208"} 33.0'])
    end
  end

  # ---------------------------------------------------------------------------
  # /metrics wiring: the Exporter and the route print one view (SPEC PM1)
  # ---------------------------------------------------------------------------
  describe "/metrics wiring" do
    let(:export) { PotatoMesh::Application.settings.prometheus_export_registry }

    it "hands the Exporter middleware the application's export registry" do
      exporter = PotatoMesh::Application.middleware.find { |klass, _args, _block| klass == ::Prometheus::Middleware::Exporter }

      expect(export).to be_a(PotatoMesh::App::Prometheus::ExportRegistry)
      expect(exporter[1].first[:registry]).to be(export)
    end

    it "prints the same view from the /metrics route" do
      marker = PotatoMesh::Config.node_opt_out_marker
      insert_node_row("!0a2f0301")
      insert_node_row("!0a2f0302", long_name: "Quiet #{marker} Station")
      %w[!0a2f0301 !0a2f0302].each do |node_id|
        PotatoMesh::App::Prometheus::NODE_BATTERY_LEVEL.set(61, labels: { node: node_id })
      end

      # The bare instance has no middleware, so the Sinatra route answers.
      response = Rack::MockRequest.new(PotatoMesh::Application.new!).get("/metrics")

      expect(response.status).to eq(200)
      expect(response.content_type).to start_with(::Prometheus::Client::Formats::Text::CONTENT_TYPE)
      expect(node_samples(response.body, "!0a2f0301")).to eq(['meshtastic_node_battery_level{node="!0a2f0301"} 61.0'])
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

    # Scrape +/metrics+ and keep the samples labelled with one node id.
    #
    # @param node_id [String] canonical node id.
    # @return [Array<String>] exposition lines for that node, comments excluded.
    def scraped_series(node_id)
      get "/metrics"
      expect(last_response.status).to eq(200)
      node_samples(last_response.body, node_id)
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
      expect(scraped_series(opted).length).to eq(per_node_families)

      post "/api/nodes", { opted => node_record("Quiet #{marker} Station", now - 30) }.to_json, auth_headers
      post "/api/telemetry", [{ id: 920_001, node_id: opted, rx_time: now - 20, battery_level: 55, voltage: 3.7 }].to_json, auth_headers
      post "/api/positions", [{ id: 920_002, node_id: opted, rx_time: now - 10, latitude: 48.1, longitude: 11.5, altitude: 520 }].to_json, auth_headers
      expect(listed_node_ids).to eq([visible])

      expect(scraped_series(opted)).to eq([])
      expect(scraped_series(visible).length).to eq(per_node_families)
    end

    it "serves no series of an opted-out node named in an explicit PROM_REPORT_IDS list" do
      visible = "!0a2f0003"
      opted = "!0a2f0004"
      ENV["PROM_REPORT_IDS"] = "#{visible},#{opted}"
      post "/api/nodes", { visible => node_record("Loud Station", now - 30), opted => node_record("Quiet #{marker} Station", now - 30) }.to_json, auth_headers
      expect(listed_node_ids).to eq([visible])

      expect(scraped_series(opted)).to eq([])
      expect(scraped_series(visible).length).to eq(per_node_families)
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
      expect(scraped_series(node_id)).not_to be_empty

      post "/api/nodes", announce.call("Quiet #{marker} Node", "nomadnetwork.node", "NODE", "11", now - 30).to_json, auth_headers
      # The PEER aspect announces again, without the marker. RE10 keeps the
      # NODE aspect's name as the headline, so the node stays opted out.
      post "/api/nodes", announce.call("Argos Station", "lxmf.delivery", "PEER", "22", now - 10).to_json, auth_headers
      expect(listed_node_ids).to eq([])

      expect(scraped_series(node_id)).to eq([])
    end

    it "serves no series of a CLIENT_HIDDEN node under PRIVATE=1 while a visible node keeps every family" do
      ENV["PRIVATE"] = "1"
      visible = "!0a2f0006"
      hidden = "!0a2f0007"
      post "/api/nodes", { visible => node_record("Loud Station", now - 30), hidden => node_record("Hidden Station", now - 30, role: "CLIENT_HIDDEN") }.to_json, auth_headers
      expect(last_response.status).to eq(201)
      expect(listed_node_ids).to eq([visible])

      expect(scraped_series(hidden)).to eq([])
      expect(scraped_series(visible).length).to eq(per_node_families)
    end
  end
end
