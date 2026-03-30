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
require "json"
require "time"

RSpec.describe "Multi-protocol support" do
  let(:app) { Sinatra::Application }
  let(:api_token) { "test-token" }
  let(:auth_headers) do
    {
      "CONTENT_TYPE" => "application/json",
      "HTTP_AUTHORIZATION" => "Bearer #{api_token}",
    }
  end
  let(:now) { Time.now.to_i }

  MESHCORE_INGESTOR_ID = "!11223344".freeze
  ALT_NODE_ID = "!aabbccdd".freeze
  ALT_NODE_ID2 = "!ccddee00".freeze
  MESH_NODE_ID = "!mesh0001".freeze
  CORE_NODE_ID = "!core0001".freeze
  MESH_INGESTOR_ID = "!mesh9999".freeze
  SELECT_INGESTOR_PROTOCOL_SQL = "SELECT protocol FROM ingestors WHERE node_id = ?".freeze

  before do
    @original_token = ENV.fetch("API_TOKEN", nil)
    ENV["API_TOKEN"] = api_token
    clear_tables
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
      db.execute("DELETE FROM trace_hops")
      db.execute("DELETE FROM traces")
      db.execute("DELETE FROM neighbors")
      db.execute("DELETE FROM messages")
      db.execute("DELETE FROM positions")
      db.execute("DELETE FROM telemetry")
      db.execute("DELETE FROM nodes")
      db.execute("DELETE FROM ingestors")
    end
  end

  # Register an ingestor via the API and return the response.
  #
  # @param node_id [String] canonical ingestor node identifier.
  # @param protocol [String, nil] mesh protocol string; omit to test default.
  # @return [Rack::MockResponse] the POST response.
  def register_ingestor(node_id, protocol: nil)
    payload = {
      node_id: node_id,
      start_time: now - 60,
      last_seen_time: now,
      version: "0.5.12",
    }
    payload[:protocol] = protocol if protocol
    post "/api/ingestors", payload.to_json, auth_headers
    last_response
  end

  describe "POST /api/ingestors" do
    it "stores protocol when provided" do
      register_ingestor(MESHCORE_INGESTOR_ID, protocol: "meshcore")

      expect(last_response.status).to eq(200)
      with_db(readonly: true) do |db|
        row = db.get_first_row(SELECT_INGESTOR_PROTOCOL_SQL, [MESHCORE_INGESTOR_ID])
        expect(row["protocol"]).to eq("meshcore")
      end
    end

    it "defaults protocol to meshtastic when field is absent" do
      register_ingestor("!aabbccdd")

      expect(last_response.status).to eq(200)
      with_db(readonly: true) do |db|
        row = db.get_first_row(SELECT_INGESTOR_PROTOCOL_SQL, ["!aabbccdd"])
        expect(row["protocol"]).to eq("meshtastic")
      end
    end

    it "updates protocol on re-registration" do
      register_ingestor(MESHCORE_INGESTOR_ID, protocol: "meshtastic")
      register_ingestor(MESHCORE_INGESTOR_ID, protocol: "meshcore")

      with_db(readonly: true) do |db|
        row = db.get_first_row(SELECT_INGESTOR_PROTOCOL_SQL, [MESHCORE_INGESTOR_ID])
        expect(row["protocol"]).to eq("meshcore")
      end
    end
  end

  describe "protocol propagation to event tables" do
    before do
      register_ingestor(MESHCORE_INGESTOR_ID, protocol: "meshcore")
    end

    it "writes meshcore protocol to messages that reference a meshcore ingestor" do
      msg = {
        id: 42,
        rx_time: now - 10,
        rx_iso: Time.at(now - 10).utc.iso8601,
        text: "hello from meshcore",
        ingestor: MESHCORE_INGESTOR_ID,
      }
      post "/api/messages", [msg].to_json, auth_headers
      expect(last_response.status).to eq(200)

      with_db(readonly: true) do |db|
        row = db.get_first_row("SELECT protocol FROM messages WHERE id = ?", [42])
        expect(row["protocol"]).to eq("meshcore")
      end
    end

    it "writes meshcore protocol to positions that reference a meshcore ingestor" do
      pos = {
        id: 100,
        rx_time: now - 5,
        rx_iso: Time.at(now - 5).utc.iso8601,
        node_id: ALT_NODE_ID,
        latitude: 1.0,
        longitude: 2.0,
        ingestor: MESHCORE_INGESTOR_ID,
      }
      post "/api/positions", [pos].to_json, auth_headers
      expect(last_response.status).to eq(200)

      with_db(readonly: true) do |db|
        row = db.get_first_row("SELECT protocol FROM positions WHERE id = ?", [100])
        expect(row["protocol"]).to eq("meshcore")
      end
    end

    it "writes meshcore protocol to telemetry that references a meshcore ingestor" do
      tel = {
        id: 200,
        rx_time: now - 5,
        rx_iso: Time.at(now - 5).utc.iso8601,
        node_id: ALT_NODE_ID,
        battery_level: 80,
        ingestor: MESHCORE_INGESTOR_ID,
      }
      post "/api/telemetry", [tel].to_json, auth_headers
      expect(last_response.status).to eq(200)

      with_db(readonly: true) do |db|
        row = db.get_first_row("SELECT protocol FROM telemetry WHERE id = ?", [200])
        expect(row["protocol"]).to eq("meshcore")
      end
    end

    it "writes meshcore protocol to traces that reference a meshcore ingestor" do
      trace = {
        id: 300,
        src: 0x11223344,
        dest: 0xaabbccdd,
        rx_time: now - 5,
        rx_iso: Time.at(now - 5).utc.iso8601,
        hops: [],
        ingestor: MESHCORE_INGESTOR_ID,
      }
      post "/api/traces", [trace].to_json, auth_headers
      expect(last_response.status).to eq(200)

      with_db(readonly: true) do |db|
        row = db.get_first_row("SELECT protocol FROM traces WHERE id = ?", [300])
        expect(row["protocol"]).to eq("meshcore")
      end
    end

    it "uses protocol-derived long_name for auto-created placeholder nodes" do
      msg = {
        id: 43,
        rx_time: now - 10,
        rx_iso: Time.at(now - 10).utc.iso8601,
        from_id: "!11223300",
        text: "unknown sender",
        ingestor: MESHCORE_INGESTOR_ID,
      }
      post "/api/messages", [msg].to_json, auth_headers
      expect(last_response.status).to eq(200)

      with_db(readonly: true) do |db|
        row = db.get_first_row("SELECT long_name FROM nodes WHERE node_id = ?", ["!11223300"])
        expect(row["long_name"]).to eq("Meshcore 3300")
      end
    end

    it "does not merge a message update from a different protocol" do
      msg = {
        id: 500,
        rx_time: now - 10,
        rx_iso: Time.at(now - 10).utc.iso8601,
        text: "meshcore original",
        ingestor: MESHCORE_INGESTOR_ID,
      }
      post "/api/messages", [msg].to_json, auth_headers
      expect(last_response.status).to eq(200)

      # Meshtastic ingestor posts same ID — should be ignored
      meshtastic_msg = {
        id: 500,
        rx_time: now - 5,
        rx_iso: Time.at(now - 5).utc.iso8601,
        text: "meshtastic impostor",
      }
      post "/api/messages", [meshtastic_msg].to_json, auth_headers
      expect(last_response.status).to eq(200)

      with_db(readonly: true) do |db|
        row = db.get_first_row("SELECT text, protocol FROM messages WHERE id = ?", [500])
        expect(row["text"]).to eq("meshcore original")
        expect(row["protocol"]).to eq("meshcore")
      end
    end

    it "does not overwrite a meshcore message via the constraint-fallback path" do
      # Seed the message directly in the DB so the first INSERT triggers a
      # constraint exception, exercising the rescue SQLite3::ConstraintException
      # fallback path rather than the primary update branch.
      with_db do |db|
        db.execute(
          "INSERT INTO messages(id, rx_time, rx_iso, text, protocol) VALUES(?,?,?,?,?)",
          [501, now - 20, Time.at(now - 20).utc.iso8601, "meshcore seeded", "meshcore"],
        )
      end

      # A Meshtastic payload arrives with the same packet ID and new text.
      # The fallback path must not overwrite the existing meshcore record.
      meshtastic_msg = {
        id: 501,
        rx_time: now - 5,
        rx_iso: Time.at(now - 5).utc.iso8601,
        text: "meshtastic fallback attempt",
      }
      post "/api/messages", [meshtastic_msg].to_json, auth_headers
      expect(last_response.status).to eq(200)

      with_db(readonly: true) do |db|
        row = db.get_first_row("SELECT text, protocol FROM messages WHERE id = ?", [501])
        expect(row["text"]).to eq("meshcore seeded")
        expect(row["protocol"]).to eq("meshcore")
      end
    end
  end

  describe "POST /api/nodes with ingestor key" do
    it "inherits protocol from registered ingestor" do
      register_ingestor(MESHCORE_INGESTOR_ID, protocol: "meshcore")
      with_db do |db|
        db.execute(
          "INSERT INTO nodes(node_id, num, last_heard, first_heard) VALUES(?,?,?,?)",
          [ALT_NODE_ID, 0xaabbccdd, now - 100, now - 200],
        )
      end

      payload = {
        ALT_NODE_ID => { "num" => 0xaabbccdd, "lastHeard" => now - 10 },
        "ingestor" => MESHCORE_INGESTOR_ID,
      }
      post "/api/nodes", payload.to_json, auth_headers
      expect(last_response.status).to eq(200)

      with_db(readonly: true) do |db|
        row = db.get_first_row("SELECT protocol FROM nodes WHERE node_id = ?", [ALT_NODE_ID])
        expect(row["protocol"]).to eq("meshcore")
      end
    end

    it "defaults to meshtastic when ingestor key is absent" do
      with_db do |db|
        db.execute(
          "INSERT INTO nodes(node_id, num, last_heard, first_heard) VALUES(?,?,?,?)",
          [ALT_NODE_ID2, 0xccddee00, now - 100, now - 200],
        )
      end

      payload = { ALT_NODE_ID2 => { "num" => 0xccddee00, "lastHeard" => now - 10 } }
      post "/api/nodes", payload.to_json, auth_headers
      expect(last_response.status).to eq(200)

      with_db(readonly: true) do |db|
        row = db.get_first_row("SELECT protocol FROM nodes WHERE node_id = ?", [ALT_NODE_ID2])
        expect(row["protocol"]).to eq("meshtastic")
      end
    end

    it "does not count the ingestor key against the node batch limit" do
      # Build exactly 1000 node entries plus the ingestor key — should succeed
      nodes = (1..1000).each_with_object({}) do |i, h|
        h[format("!%08x", i)] = { "num" => i, "lastHeard" => now - 1 }
      end
      nodes["ingestor"] = MESHCORE_INGESTOR_ID
      post "/api/nodes", nodes.to_json, auth_headers

      expect(last_response.status).to eq(200)
    end
  end

  describe "GET ?protocol= filter" do
    before do
      register_ingestor(MESHCORE_INGESTOR_ID, protocol: "meshcore")
      with_db do |db|
        db.execute(
          "INSERT INTO nodes(node_id, num, last_heard, first_heard, protocol) VALUES(?,?,?,?,?)",
          [MESH_NODE_ID, 1, now - 10, now - 20, "meshtastic"],
        )
        db.execute(
          "INSERT INTO nodes(node_id, num, last_heard, first_heard, protocol) VALUES(?,?,?,?,?)",
          [CORE_NODE_ID, 2, now - 10, now - 20, "meshcore"],
        )
        db.execute(
          "INSERT INTO messages(id, rx_time, rx_iso, text, protocol) VALUES(?,?,?,?,?)",
          [1001, now - 5, Time.at(now - 5).utc.iso8601, "meshtastic msg", "meshtastic"],
        )
        db.execute(
          "INSERT INTO messages(id, rx_time, rx_iso, text, protocol) VALUES(?,?,?,?,?)",
          [1002, now - 5, Time.at(now - 5).utc.iso8601, "meshcore msg", "meshcore"],
        )
        db.execute(
          "INSERT INTO positions(id, rx_time, rx_iso, node_id, protocol) VALUES(?,?,?,?,?)",
          [2001, now - 5, Time.at(now - 5).utc.iso8601, MESH_NODE_ID, "meshtastic"],
        )
        db.execute(
          "INSERT INTO positions(id, rx_time, rx_iso, node_id, protocol) VALUES(?,?,?,?,?)",
          [2002, now - 5, Time.at(now - 5).utc.iso8601, CORE_NODE_ID, "meshcore"],
        )
        db.execute(
          "INSERT INTO neighbors(node_id, neighbor_id, rx_time, protocol) VALUES(?,?,?,?)",
          [MESH_NODE_ID, CORE_NODE_ID, now - 5, "meshtastic"],
        )
        db.execute(
          "INSERT INTO neighbors(node_id, neighbor_id, rx_time, protocol) VALUES(?,?,?,?)",
          [CORE_NODE_ID, MESH_NODE_ID, now - 5, "meshcore"],
        )
        db.execute(
          "INSERT INTO telemetry(id, rx_time, rx_iso, node_id, protocol) VALUES(?,?,?,?,?)",
          [3001, now - 5, Time.at(now - 5).utc.iso8601, MESH_NODE_ID, "meshtastic"],
        )
        db.execute(
          "INSERT INTO telemetry(id, rx_time, rx_iso, node_id, protocol) VALUES(?,?,?,?,?)",
          [3002, now - 5, Time.at(now - 5).utc.iso8601, CORE_NODE_ID, "meshcore"],
        )
        db.execute(
          "INSERT INTO traces(id, rx_time, rx_iso, protocol) VALUES(?,?,?,?)",
          [4001, now - 5, Time.at(now - 5).utc.iso8601, "meshtastic"],
        )
        db.execute(
          "INSERT INTO traces(id, rx_time, rx_iso, protocol) VALUES(?,?,?,?)",
          [4002, now - 5, Time.at(now - 5).utc.iso8601, "meshcore"],
        )
      end
    end

    it "filters /api/nodes by protocol" do
      get "/api/nodes?protocol=meshcore", {}, auth_headers

      expect(last_response.status).to eq(200)
      ids = JSON.parse(last_response.body).map { |r| r["node_id"] }
      expect(ids).to include(CORE_NODE_ID)
      expect(ids).not_to include(MESH_NODE_ID)
    end

    it "filters /api/messages by protocol" do
      get "/api/messages?protocol=meshcore", {}, auth_headers

      expect(last_response.status).to eq(200)
      texts = JSON.parse(last_response.body).map { |r| r["text"] }
      expect(texts).to include("meshcore msg")
      expect(texts).not_to include("meshtastic msg")
    end

    it "filters /api/positions by protocol" do
      get "/api/positions?protocol=meshcore", {}, auth_headers

      expect(last_response.status).to eq(200)
      ids = JSON.parse(last_response.body).map { |r| r["id"] }
      expect(ids).to include(2002)
      expect(ids).not_to include(2001)
    end

    it "filters /api/neighbors by protocol" do
      get "/api/neighbors?protocol=meshcore", {}, auth_headers

      expect(last_response.status).to eq(200)
      rows = JSON.parse(last_response.body)
      expect(rows.any? { |r| r["node_id"] == CORE_NODE_ID }).to be(true)
      expect(rows.none? { |r| r["node_id"] == MESH_NODE_ID }).to be(true)
    end

    it "filters /api/telemetry by protocol" do
      get "/api/telemetry?protocol=meshcore", {}, auth_headers

      expect(last_response.status).to eq(200)
      ids = JSON.parse(last_response.body).map { |r| r["id"] }
      expect(ids).to include(3002)
      expect(ids).not_to include(3001)
    end

    it "filters /api/traces by protocol" do
      get "/api/traces?protocol=meshcore", {}, auth_headers

      expect(last_response.status).to eq(200)
      ids = JSON.parse(last_response.body).map { |r| r["id"] }
      expect(ids).to include(4002)
      expect(ids).not_to include(4001)
    end

    it "filters /api/ingestors by protocol" do
      with_db do |db|
        db.execute(
          "INSERT INTO ingestors(node_id, start_time, last_seen_time, version, protocol) VALUES(?,?,?,?,?)",
          [MESH_INGESTOR_ID, now - 60, now, "0.5.12", "meshtastic"],
        )
      end

      get "/api/ingestors?protocol=meshcore", {}, auth_headers

      expect(last_response.status).to eq(200)
      ids = JSON.parse(last_response.body).map { |r| r["node_id"] }
      expect(ids).to include(MESHCORE_INGESTOR_ID)
      expect(ids).not_to include(MESH_INGESTOR_ID)
    end

    it "returns all records when protocol param is absent" do
      get "/api/nodes", {}, auth_headers

      expect(last_response.status).to eq(200)
      ids = JSON.parse(last_response.body).map { |r| r["node_id"] }
      expect(ids).to include(MESH_NODE_ID)
      expect(ids).to include(CORE_NODE_ID)
    end

    it "includes protocol field in GET /api/messages responses" do
      get "/api/messages", {}, auth_headers

      expect(last_response.status).to eq(200)
      rows = JSON.parse(last_response.body)
      expect(rows.all? { |r| r.key?("protocol") }).to be(true)
    end

    it "includes protocol field in GET /api/nodes responses" do
      get "/api/nodes", {}, auth_headers

      expect(last_response.status).to eq(200)
      rows = JSON.parse(last_response.body)
      expect(rows.all? { |r| r.key?("protocol") }).to be(true)
    end
  end

  describe "backward compatibility" do
    it "existing payloads without protocol field default to meshtastic" do
      msg = {
        id: 999,
        rx_time: now - 10,
        rx_iso: Time.at(now - 10).utc.iso8601,
        text: "legacy message",
      }
      post "/api/messages", [msg].to_json, auth_headers
      expect(last_response.status).to eq(200)

      with_db(readonly: true) do |db|
        row = db.get_first_row("SELECT protocol FROM messages WHERE id = ?", [999])
        expect(row["protocol"]).to eq("meshtastic")
      end
    end

    it "existing ingestor registrations without protocol default to meshtastic in GET responses" do
      with_db do |db|
        db.execute(
          "INSERT INTO ingestors(node_id, start_time, last_seen_time, version, protocol) VALUES(?,?,?,?,?)",
          ["!legacy00", now - 120, now - 10, "0.5.0", "meshtastic"],
        )
      end

      get "/api/ingestors", {}, auth_headers
      expect(last_response.status).to eq(200)
      entry = JSON.parse(last_response.body).find { |r| r["node_id"] == "!legacy00" }
      expect(entry["protocol"]).to eq("meshtastic")
    end
  end
end
