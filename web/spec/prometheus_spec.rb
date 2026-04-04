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
        allow(PotatoMesh::Config).to receive(:trace_neighbor_window_seconds).and_return(604_800)
        allow(PotatoMesh::Config).to receive(:debug?).and_return(false)
        db_helper = Object.new.extend(PotatoMesh::App::Database)
        db_helper.init_db
        db_helper.ensure_schema_upgrades
        example.run
      end
    end
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
end
