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

require_relative "spec_helper"

# Reticulum protocol support (#888).  Mirrors the MeshCore coverage in
# protocol_spec.rb with fixtures shaped like the Python Reticulum ingestor's
# announce-derived node payloads: id = "!" + first 4 bytes of the destination
# hash, user.publicKey = the full 32-hex destination hash, no SNR/RSSI, no
# user.role, no position, no deviceMetrics, hopsAway omitted when unknown.
RSpec.describe "Reticulum protocol support" do
  let(:app) { Sinatra::Application }
  let(:api_token) { "test-token" }
  let(:auth_headers) do
    {
      "CONTENT_TYPE" => "application/json",
      "HTTP_AUTHORIZATION" => "Bearer #{api_token}",
    }
  end
  let(:now) { Time.now.to_i }

  RETICULUM_INGESTOR_ID = "!feedf00d".freeze
  RETICULUM_NODE_ID = "!a1b2c3d4".freeze
  RETICULUM_DEST_HASH = "a1b2c3d4e5f60718293a4b5c6d7e8f90".freeze
  RETICULUM_NODE_ID2 = "!0badcafe".freeze
  MESHTASTIC_PEER_ID = "!12ab34cd".freeze

  # Announce-derived node fixture, exactly the shape the Reticulum ingestor
  # POSTs (no snr/rssi/position/deviceMetrics/user.role).
  def reticulum_node_fixture(last_heard:, hops_away: 2)
    node = {
      "user" => {
        "longName" => "Argos Station",
        "shortName" => "a1b2",
        "publicKey" => RETICULUM_DEST_HASH,
      },
      "lastHeard" => last_heard,
      "protocol" => "reticulum",
    }
    node["hopsAway"] = hops_away if hops_away
    node
  end

  before do
    @original_token = ENV.fetch("API_TOKEN", nil)
    ENV["API_TOKEN"] = api_token
    clear_tables
    PotatoMesh::App::ApiCache.invalidate_all
  end

  after do
    ENV["API_TOKEN"] = @original_token
    clear_tables
  end

  # Open a database connection for direct inspection.
  #
  # @param readonly [Boolean] whether to open in read-only mode.
  # @yieldparam db [SQLite3::Database] open database handle.
  # @return [void]
  def with_db(readonly: false)
    db = PotatoMesh::Application.open_database(readonly: readonly)
    db.results_as_hash = true
    yield db
  ensure
    db&.close
  end

  # Remove all rows from tables exercised by these tests.
  #
  # @return [void]
  def clear_tables
    with_db do |db|
      db.execute("DELETE FROM messages")
      db.execute("DELETE FROM positions")
      db.execute("DELETE FROM telemetry")
      db.execute("DELETE FROM nodes")
      db.execute("DELETE FROM ingestors")
      db.execute("DELETE FROM ingestor_activity")
    end
  end

  # Register the Reticulum ingestor heartbeat via the API.
  #
  # @return [Rack::MockResponse] the POST response.
  def register_reticulum_ingestor
    payload = {
      node_id: RETICULUM_INGESTOR_ID,
      start_time: now - 60,
      last_seen_time: now,
      version: "0.7.4",
      protocol: "reticulum",
    }
    post "/api/ingestors", payload.to_json, auth_headers
    last_response
  end

  # POST the fixture node batch the way the ingestor does (wrapper-level
  # protocol stamp plus ingestor id).
  #
  # @return [Rack::MockResponse] the POST response.
  def post_reticulum_nodes
    payload = {
      RETICULUM_NODE_ID => reticulum_node_fixture(last_heard: now - 30),
      "ingestor" => RETICULUM_INGESTOR_ID,
      "protocol" => "reticulum",
    }
    post "/api/nodes", payload.to_json, auth_headers
    last_response
  end

  describe "POST /api/ingestors" do
    it "stores the reticulum protocol" do
      expect(register_reticulum_ingestor.status).to eq(201)

      with_db(readonly: true) do |db|
        row = db.get_first_row("SELECT protocol FROM ingestors WHERE node_id = ?", [RETICULUM_INGESTOR_ID])
        expect(row["protocol"]).to eq("reticulum")
      end
    end

    it "filters /api/ingestors by protocol=reticulum" do
      register_reticulum_ingestor
      get "/api/ingestors?protocol=reticulum", {}, auth_headers

      expect(last_response.status).to eq(200)
      rows = JSON.parse(last_response.body)
      expect(rows.map { |r| r["node_id"] }).to eq([RETICULUM_INGESTOR_ID])
      expect(rows.first["protocol"]).to eq("reticulum")
    end
  end

  describe "POST /api/nodes" do
    it "stores reticulum nodes under their own protocol via the wrapper stamp" do
      register_reticulum_ingestor
      expect(post_reticulum_nodes.status).to eq(201)

      with_db(readonly: true) do |db|
        row = db.get_first_row("SELECT * FROM nodes WHERE node_id = ?", [RETICULUM_NODE_ID])
        expect(row["protocol"]).to eq("reticulum")
        expect(row["long_name"]).to eq("Argos Station")
        expect(row["short_name"]).to eq("a1b2")
        expect(row["public_key"]).to eq(RETICULUM_DEST_HASH)
        expect(row["hops_away"]).to eq(2)
      end
    end

    it "stores no fabricated radio/telemetry/position values" do
      register_reticulum_ingestor
      post_reticulum_nodes

      with_db(readonly: true) do |db|
        row = db.get_first_row("SELECT * FROM nodes WHERE node_id = ?", [RETICULUM_NODE_ID])
        expect(row["snr"]).to be_nil
        expect(row["rssi"]).to be_nil
        expect(row["battery_level"]).to be_nil
        expect(row["voltage"]).to be_nil
        expect(row["latitude"]).to be_nil
        expect(row["longitude"]).to be_nil
        expect(row["position_time"]).to be_nil
        expect(row["role"]).to be_nil
        expect(row["lora_freq"]).to be_nil
        expect(row["modem_preset"]).to be_nil
      end
    end

    it "classifies reticulum before the ingestor heartbeat registers (startup race)" do
      # No register_reticulum_ingestor call: the wrapper stamp alone must win.
      expect(post_reticulum_nodes.status).to eq(201)

      with_db(readonly: true) do |db|
        row = db.get_first_row("SELECT protocol FROM nodes WHERE node_id = ?", [RETICULUM_NODE_ID])
        expect(row["protocol"]).to eq("reticulum")
      end
    end

    it "honours a per-node reticulum stamp inside a foreign batch" do
      payload = {
        RETICULUM_NODE_ID2 => {
          "user" => { "shortName" => "0bad", "publicKey" => "0badcafe0badcafe0badcafe0badcafe" },
          "lastHeard" => now - 5,
          "protocol" => "reticulum",
        },
        MESHTASTIC_PEER_ID => { "num" => 0x12ab34cd, "lastHeard" => now - 5 },
      }
      post "/api/nodes", payload.to_json, auth_headers
      expect(last_response.status).to eq(201)

      with_db(readonly: true) do |db|
        expect(db.get_first_value("SELECT protocol FROM nodes WHERE node_id = ?", [RETICULUM_NODE_ID2])).to eq("reticulum")
        expect(db.get_first_value("SELECT protocol FROM nodes WHERE node_id = ?", [MESHTASTIC_PEER_ID])).to eq("meshtastic")
      end
    end

    it "accepts a hopsAway-less announce (unknown hop count stays absent)" do
      payload = {
        RETICULUM_NODE_ID => reticulum_node_fixture(last_heard: now - 30, hops_away: nil),
        "protocol" => "reticulum",
      }
      post "/api/nodes", payload.to_json, auth_headers
      expect(last_response.status).to eq(201)

      with_db(readonly: true) do |db|
        expect(db.get_first_value("SELECT hops_away FROM nodes WHERE node_id = ?", [RETICULUM_NODE_ID])).to be_nil
      end
    end
  end

  describe "GET /api/nodes rendering payload" do
    before do
      register_reticulum_ingestor
      post_reticulum_nodes
    end

    it "serves the reticulum node with its protocol and hop count" do
      get "/api/nodes", {}, auth_headers

      expect(last_response.status).to eq(200)
      node = JSON.parse(last_response.body).find { |r| r["node_id"] == RETICULUM_NODE_ID }
      expect(node).not_to be_nil
      expect(node["protocol"]).to eq("reticulum")
      expect(node["hops_away"]).to eq(2)
      expect(node["long_name"]).to eq("Argos Station")
      expect(node["short_name"]).to eq("a1b2")
    end

    it "omits absent metrics instead of fabricating zeros" do
      get "/api/nodes", {}, auth_headers

      node = JSON.parse(last_response.body).find { |r| r["node_id"] == RETICULUM_NODE_ID }
      %w[snr rssi battery_level voltage latitude longitude position_time lora_freq modem_preset].each do |key|
        expect(node).not_to have_key(key), "expected #{key} to be omitted for a reticulum node"
      end
    end

    it "filters ?protocol=reticulum to reticulum nodes only" do
      with_db do |db|
        db.execute(
          "INSERT INTO nodes(node_id, num, last_heard, first_heard, protocol) VALUES(?,?,?,?,?)",
          [MESHTASTIC_PEER_ID, 0x12ab34cd, now - 10, now - 20, "meshtastic"],
        )
      end

      get "/api/nodes?protocol=reticulum", {}, auth_headers
      ids = JSON.parse(last_response.body).map { |r| r["node_id"] }
      expect(ids).to eq([RETICULUM_NODE_ID])

      get "/api/nodes?protocol=meshtastic", {}, auth_headers
      ids = JSON.parse(last_response.body).map { |r| r["node_id"] }
      expect(ids).to include(MESHTASTIC_PEER_ID)
      expect(ids).not_to include(RETICULUM_NODE_ID)
    end
  end

  describe "GET /api/stats" do
    it "counts reticulum nodes under the live reticulum scope" do
      register_reticulum_ingestor
      post_reticulum_nodes

      get "/api/stats"

      expect(last_response.status).to eq(200)
      payload = JSON.parse(last_response.body)
      expect(payload["reticulum"]["nodes"]["day"]).to eq(1)
      expect(payload["reticulum"]["nodes"]["week"]).to eq(1)
      expect(payload["total"]["nodes"]["day"]).to be >= 1
      # No packet activity was seeded, so the rate metric stays zero.
      expect(payload["reticulum"]["packets"]).to eq("hour" => 0)
    end

    it "reports live reticulum packets/hour from ingestor activity" do
      register_reticulum_ingestor
      with_db do |db|
        db.execute(
          "INSERT INTO ingestor_activity(ingestor_id, at, packets, protocol) VALUES (?,?,?,?)",
          [RETICULUM_INGESTOR_ID, now - 100, 720, "reticulum"],
        )
      end

      get "/api/stats"

      payload = JSON.parse(last_response.body)
      expect(payload["reticulum"]["packets"]).to eq("hour" => 30) # 720 / 24
      expect(payload["total"]["packets"]).to eq("hour" => 30)
    end
  end

  describe "GET /nodes/:id detail page" do
    it "renders the reticulum node detail shell" do
      register_reticulum_ingestor
      post_reticulum_nodes

      get "/nodes/#{RETICULUM_NODE_ID}"

      expect(last_response.status).to eq(200)
      expect(last_response.body).to include("Argos Station")
      expect(last_response.body).to include("a1b2")
    end
  end
end
