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

# What +/metrics+ prints, driven through the API with the app's full
# middleware stack (SPEC PG1-PG4, ACCEPTANCE PG-A1-PG-A4; review items M1,
# L-PROMLABELS, IB-G1 and M5). Every example reads only what an unfixed tree
# also has, so the file loads and fails there on its assertions.
RSpec.describe "/metrics request labels, node series and node count" do
  include MetricsSpecHelpers

  let(:app) { Sinatra::Application }
  let(:api_token) { "metrics-routes-token" }
  let(:auth_headers) do
    { "CONTENT_TYPE" => "application/json", "HTTP_AUTHORIZATION" => "Bearer #{api_token}" }
  end
  let(:now) { Time.now.to_i }
  let(:marker) { PotatoMesh::Config.node_opt_out_marker }

  around do |example|
    saved = ENV.to_h.slice("API_TOKEN", "PROM_REPORT_IDS", "PRIVATE")
    ENV["API_TOKEN"] = api_token
    ENV["PROM_REPORT_IDS"] = "*"
    ENV.delete("PRIVATE")
    Dir.mktmpdir("metrics-routes-spec-") do |dir|
      RSpec::Mocks.with_temporary_scope do
        allow(PotatoMesh::Config).to receive(:db_path).and_return(File.join(dir, "mesh.db"))
        db_helper = Object.new.extend(PotatoMesh::App::Database)
        db_helper.init_db
        db_helper.ensure_schema_upgrades
        PotatoMesh::App::ApiCache.invalidate_all
        example.run
      end
    end
  ensure
    %w[API_TOKEN PROM_REPORT_IDS PRIVATE].each do |key|
      saved.key?(key) ? ENV[key] = saved[key] : ENV.delete(key)
    end
  end

  # Run statements against the spec database in one transaction.
  #
  # @yieldparam db [SQLite3::Database] open database handle.
  # @return [void]
  def with_spec_db
    db = SQLite3::Database.new(PotatoMesh::Config.db_path)
    db.transaction { yield db }
  ensure
    db&.close
  end

  # Store a node row directly, as one written before this process started.
  #
  # @param db [SQLite3::Database] open database handle.
  # @param node_id [String] canonical node id.
  # @param heard [Integer] last-heard time.
  # @param columns [Hash{Symbol => Object}] further columns and their values.
  # @return [void]
  def store_node(db, node_id, heard:, **columns)
    row = { "node_id" => node_id, "long_name" => "Stored #{node_id}", "short_name" => "ST", "role" => "CLIENT",
            "last_heard" => heard, "first_heard" => heard }.merge(columns.transform_keys(&:to_s))
    db.execute("INSERT INTO nodes(#{row.keys.join(", ")}) VALUES (#{(["?"] * row.size).join(", ")})", row.values)
  end

  # One node entry of a +POST /api/nodes+ body.
  #
  # @param long_name [String] display name.
  # @param heard [Integer] lastHeard, so a later entry wins the upsert guard.
  # @param position [Hash, nil] position section.
  # @return [Hash] node entry.
  def node_entry(long_name, heard, position: nil)
    entry = {
      "user" => { "longName" => long_name, "shortName" => "PG", "hwModel" => "TBEAM", "role" => "CLIENT" },
      "deviceMetrics" => { "batteryLevel" => 80, "voltage" => 4.0 },
      "lastHeard" => heard,
    }
    entry["position"] = position.merge("time" => heard) if position
    entry
  end

  # POST nodes and expect the route to accept them.
  #
  # @param entries [Hash{String => Hash}] node id to node entry.
  # @return [void]
  def post_nodes(entries)
    post "/api/nodes", entries.to_json, auth_headers
    expect(last_response.status).to eq(201), "POST /api/nodes answered #{last_response.status}: #{last_response.body}"
  end

  # The HTTP request counter the request-metrics middleware registered.
  #
  # @return [Prometheus::Client::Counter] +http_server_requests_total+.
  def request_counter
    ::Prometheus::Client.registry.get(:http_server_requests_total)
  end

  # Distinct +path+ values of the request counter and duration histogram.
  #
  # @return [Array<String>] path label values recorded so far.
  def request_paths
    %i[http_server_requests_total http_server_request_duration_seconds].flat_map do |name|
      ::Prometheus::Client.registry.get(name).values.keys.map { |labels| labels[:path] }
    end.uniq
  end

  # Every label the collector can give a request: one per route of
  # Sinatra's table, and the three fixed labels.
  #
  # @return [Array<String>] the route labels, then +static+, +metrics+ and
  #   +unmatched+.
  def path_labels
    routes = PotatoMesh::Application.routes.flat_map do |verb, table|
      table.map { |pattern, _conditions, _block| PotatoMesh::App::Prometheus::RouteCollector.route_label("#{verb} #{pattern}") }
    end
    routes + %w[static metrics unmatched]
  end

  describe "HTTP request metrics (SPEC PG1)" do
    it "labels a per-node read with its route, never with the node id from the URL" do
      get "/api/nodes/!0b0b0001"
      expect(last_response.status).to eq(404)

      expect(request_paths).to include("GET /api/nodes/:id")
      expect(request_paths.grep(/0b0b0001/)).to eq([])
      expect(request_counter.get(labels: { code: "404", method: "get", path: "GET /api/nodes/:id" })).to be >= 1
    end

    it "keeps 1000 distinct 404 paths to one series, every label a route's or a fixed one" do
      get "/version"
      before = request_counter.get(labels: { code: "404", method: "get", path: "unmatched" })

      # Letters keep each segment from the gem's all-digit rewrite.
      1000.times { |index| get "/pg-missing/n#{index}" }

      expect(last_response.status).to eq(404)
      paths = request_paths
      expect(paths.grep(%r{/pg-missing/})).to eq([])
      expect(paths - path_labels).to eq([])
      expect(request_counter.get(labels: { code: "404", method: "get", path: "unmatched" }) - before).to eq(1000)
    end

    it "labels a static file static and the Exporter's own /metrics answer metrics" do
      get "/version"
      counts = lambda do
        %w[static metrics unmatched].to_h { |path| [path, request_counter.get(labels: { code: "200", method: "get", path: path })] }
      end
      before = counts.call

      get "/potatomesh-logo.svg"
      expect(last_response.status).to eq(200)
      get "/metrics"
      expect(last_response.status).to eq(200)

      expect(counts.call.to_h { |path, count| [path, count - before[path]] }).to eq("static" => 1.0, "metrics" => 1.0, "unmatched" => 0.0)
      expect(request_paths).not_to include("/potatomesh-logo.svg", "/metrics")
    end

    it "labels a regular-expression route readably, with or without its trailing slash" do
      get "/map"
      get "/map/"
      expect(last_response.status).to eq(200)

      expect(request_counter.get(labels: { code: "200", method: "get", path: "GET /map" })).to be >= 2
      expect(request_paths.grep(/\\/)).to eq([])
    end
  end

  describe "per-node series built from the node rows (SPEC PG2)" do
    it "replaces a renamed node's presence series instead of adding one" do
      node = "!0b0b0002"
      post_nodes(node => node_entry("First Name", now - 60))
      post_nodes(node => node_entry("Second Name", now - 30))

      expect(scraped_samples("meshtastic_node", node)).to eq(
        [%(meshtastic_node{node="#{node}",short_name="PG",long_name="Second Name",hw_model="TBEAM",role="CLIENT"} 1.0)],
      )
    end

    it "exports a reported node from its stored row, also one this process never ingested" do
      node = "!0b0b0003"
      with_spec_db do |db|
        store_node(db, node, heard: now - 40 * 86_400, battery_level: 77, voltage: 3.9, uptime_seconds: 600,
                             channel_utilization: 12.5, air_util_tx: 0.75, latitude: 48.1, longitude: 11.5, altitude: 520)
      end

      expect(scraped_samples("meshtastic_node_battery_level", node)).to eq([%(meshtastic_node_battery_level{node="#{node}"} 77.0)])
      expect(scraped_samples("meshtastic_node_uptime_seconds", node)).to eq([%(meshtastic_node_uptime_seconds{node="#{node}"} 600.0)])
      expect(scraped_samples("meshtastic_node_altitude", node)).to eq([%(meshtastic_node_altitude{node="#{node}"} 520.0)])
      expect(scraped_samples("meshtastic_node", node).length).to eq(1)
    end

    it "follows the row when a telemetry or position packet updates it" do
      node = "!0b0b0004"
      post_nodes(node => node_entry("Mover", now - 60, position: { "latitude" => 52.5, "longitude" => 13.4 }))
      post "/api/telemetry", [{ id: 940_001, node_id: node, rx_time: now - 20, battery_level: 55, voltage: 3.7 }].to_json, auth_headers
      post "/api/positions", [{ id: 940_002, node_id: node, rx_time: now - 10, latitude: 48.1, longitude: 11.5, altitude: 520 }].to_json, auth_headers

      expect(scraped_samples("meshtastic_node_battery_level", node)).to eq([%(meshtastic_node_battery_level{node="#{node}"} 55.0)])
      expect(scraped_samples("meshtastic_node_latitude", node)).to eq([%(meshtastic_node_latitude{node="#{node}"} 48.1)])
      expect(scraped_samples("meshtastic_node_longitude", node)).to eq([%(meshtastic_node_longitude{node="#{node}"} 11.5)])
    end
  end

  describe "coordinate gauges (SPEC PG3)" do
    it "exports no coordinate gauge for a posted off-globe position" do
      far = "!0b0b0005"
      near = "!0b0b0006"
      post_nodes(
        far => node_entry("Far", now - 30, position: { "latitude" => 95.0, "longitude" => 190.0, "altitude" => 40 }),
        near => node_entry("Near", now - 30, position: { "latitude" => 52.5, "longitude" => 13.4, "altitude" => 40 }),
      )

      %w[latitude longitude altitude].each do |axis|
        expect(scraped_samples("meshtastic_node_#{axis}", far)).to eq([]), "#{axis} of the off-globe node was exported"
      end
      expect(scraped_samples("meshtastic_node_latitude", near)).to eq([%(meshtastic_node_latitude{node="#{near}"} 52.5)])
      expect(scraped_samples("meshtastic_node_altitude", near)).to eq([%(meshtastic_node_altitude{node="#{near}"} 40.0)])
    end

    it "exports no coordinate gauge for a stored off-globe row or the (0, 0) sentinel, and keeps the globe's edges" do
      with_spec_db do |db|
        store_node(db, "!0b0b0007", heard: now, latitude: 398.761944, longitude: 332.909167, altitude: 10)
        store_node(db, "!0b0b0008", heard: now, latitude: 0.0, longitude: 0.0, altitude: 10)
        store_node(db, "!0b0b0009", heard: now, latitude: 52.5, longitude: 200.0, altitude: 10)
        store_node(db, "!0b0b000a", heard: now, latitude: -90.0, longitude: 180.0, altitude: 10)
      end

      %w[!0b0b0007 !0b0b0008 !0b0b0009].each do |node|
        %w[latitude longitude altitude].each do |axis|
          expect(scraped_samples("meshtastic_node_#{axis}", node)).to eq([]), "#{axis} of #{node} was exported"
        end
        expect(scraped_samples("meshtastic_node", node).length).to eq(1)
      end
      expect(scraped_samples("meshtastic_node_latitude", "!0b0b000a")).to eq([%(meshtastic_node_latitude{node="!0b0b000a"} -90.0)])
      expect(scraped_samples("meshtastic_node_longitude", "!0b0b000a")).to eq([%(meshtastic_node_longitude{node="!0b0b000a"} 180.0)])
      expect(scraped_samples("meshtastic_node_altitude", "!0b0b000a")).to eq([%(meshtastic_node_altitude{node="!0b0b000a"} 10.0)])
    end
  end

  describe "node count gauge (SPEC PG4)" do
    it "counts every node GET /api/nodes lists, past its 1000-row cap" do
      with_spec_db do |db|
        3000.times { |index| store_node(db, format("!0c%06x", index), heard: now - 60 - index) }
      end

      post_nodes("!0b0b0fff" => node_entry("Trigger", now))

      expect(scraped_samples("meshtastic_nodes")).to eq(["meshtastic_nodes 3001.0"])
    end

    it "counts with the filters of GET /api/nodes and seeds the gauge at boot" do
      with_spec_db do |db|
        store_node(db, "!0b0b1001", heard: now - 60)
        store_node(db, "!0b0b1002", heard: now - 60, long_name: "Quiet #{marker} Station")
        store_node(db, "!0b0b1003", heard: now - 60, short_name: "Q#{marker}")
        store_node(db, "!0b0b1004", heard: now - 8 * 86_400)
        store_node(db, "!0b0b1005", heard: now - 60, role: "CLIENT_HIDDEN")
      end

      PotatoMesh::Application.update_all_prometheus_metrics_from_nodes
      expect(scraped_samples("meshtastic_nodes")).to eq(["meshtastic_nodes 2.0"])
      get "/api/nodes?limit=1000"
      expect(JSON.parse(last_response.body).length).to eq(2)

      ENV["PRIVATE"] = "1"
      PotatoMesh::App::ApiCache.invalidate_all
      post_nodes("!0b0b1006" => node_entry("Private Trigger", now))
      expect(scraped_samples("meshtastic_nodes")).to eq(["meshtastic_nodes 2.0"])
      get "/api/nodes?limit=1000"
      expect(JSON.parse(last_response.body).length).to eq(2)
    end
  end
end
