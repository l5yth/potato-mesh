# Copyright (C) 2025 l5yth
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
require "sqlite3"
require "json"
require "time"
require "base64"

RSpec.describe "Potato Mesh Sinatra app" do
  let(:app) { Sinatra::Application }

  def fixture_path(name)
    File.expand_path("../../tests/#{name}", __dir__)
  end

  def with_db(readonly: false)
    db = SQLite3::Database.new(DB_PATH, readonly: readonly)
    yield db
  ensure
    db&.close
  end

  def clear_database
    with_db do |db|
      db.execute("DELETE FROM messages")
      db.execute("DELETE FROM nodes")
      db.execute("DELETE FROM positions")
    end
  end

  def reject_nil_values(hash)
    hash.reject { |_, value| value.nil? }
  end

  def build_node_payload(node)
    payload = {
      "user" => reject_nil_values(
        "shortName" => node["short_name"],
        "longName" => node["long_name"],
        "hwModel" => node["hw_model"],
        "role" => node["role"],
      ),
      "hwModel" => node["hw_model"],
      "lastHeard" => node["last_heard"],
      "snr" => node["snr"],
    }

    metrics = reject_nil_values(
      "batteryLevel" => node["battery_level"],
      "voltage" => node["voltage"],
      "channelUtilization" => node["channel_utilization"],
      "airUtilTx" => node["air_util_tx"],
      "uptimeSeconds" => node["uptime_seconds"],
    )
    payload["deviceMetrics"] = metrics unless metrics.empty?

    position = reject_nil_values(
      "time" => node["position_time"],
      "latitude" => node["latitude"],
      "longitude" => node["longitude"],
      "altitude" => node["altitude"],
    )
    payload["position"] = position unless position.empty?

    payload
  end

  def expected_last_heard(node)
    [node["last_heard"], node["position_time"]].compact.max
  end

  def expected_node_row(node)
    final_last = expected_last_heard(node)
    {
      "node_id" => node["node_id"],
      "short_name" => node["short_name"],
      "long_name" => node["long_name"],
      "hw_model" => node["hw_model"],
      "role" => node["role"] || "CLIENT",
      "snr" => node["snr"],
      "battery_level" => node["battery_level"],
      "voltage" => node["voltage"],
      "last_heard" => final_last,
      "first_heard" => final_last,
      "uptime_seconds" => node["uptime_seconds"],
      "channel_utilization" => node["channel_utilization"],
      "air_util_tx" => node["air_util_tx"],
      "position_time" => node["position_time"],
      "latitude" => node["latitude"],
      "longitude" => node["longitude"],
      "altitude" => node["altitude"],
    }
  end

  def expect_same_value(actual, expected, tolerance: 1e-6)
    if expected.nil?
      expect(actual).to be_nil
    elsif expected.is_a?(Float)
      expect(actual).to be_within(tolerance).of(expected)
    else
      expect(actual).to eq(expected)
    end
  end

  def import_nodes_fixture
    nodes_fixture.each do |node|
      payload = { node["node_id"] => build_node_payload(node) }
      post "/api/nodes", payload.to_json, auth_headers
      expect(last_response).to be_ok
      expect(JSON.parse(last_response.body)).to eq("status" => "ok")
    end
  end

  def import_messages_fixture
    messages_fixture.each do |message|
      payload = message.reject { |key, _| key == "node" }
      post "/api/messages", payload.to_json, auth_headers
      expect(last_response).to be_ok
      expect(JSON.parse(last_response.body)).to eq("status" => "ok")
    end
  end

  let(:api_token) { "spec-token" }
  let(:auth_headers) do
    {
      "CONTENT_TYPE" => "application/json",
      "HTTP_AUTHORIZATION" => "Bearer #{api_token}",
    }
  end
  let(:nodes_fixture) { JSON.parse(File.read(fixture_path("nodes.json"))) }
  let(:messages_fixture) { JSON.parse(File.read(fixture_path("messages.json"))) }
  let(:reference_time) do
    latest = nodes_fixture.map { |node| node["last_heard"] }.compact.max
    Time.at((latest || Time.now.to_i) + 1000)
  end

  before do
    @original_token = ENV["API_TOKEN"]
    ENV["API_TOKEN"] = api_token
    allow(Time).to receive(:now).and_return(reference_time)
    clear_database
  end

  after do
    ENV["API_TOKEN"] = @original_token
  end

  describe "logging configuration" do
    before do
      Sinatra::Application.apply_logger_level!
    end

    after do
      Sinatra::Application.apply_logger_level!
    end

    it "defaults to WARN when debug logging is disabled" do
      expect(Sinatra::Application.settings.logger.level).to eq(Logger::WARN)
    end

    it "switches to DEBUG when debug logging is enabled" do
      stub_const("DEBUG", true)
      Sinatra::Application.apply_logger_level!

      expect(Sinatra::Application.settings.logger.level).to eq(Logger::DEBUG)
    end
  end

  describe "GET /" do
    it "responds successfully" do
      get "/"
      expect(last_response).to be_ok
    end

    it "includes the application version in the footer" do
      get "/"
      expect(last_response.body).to include("#{APP_VERSION}")
    end

    it "includes SEO metadata from configuration" do
      stub_const("SITE_NAME", "Spec Mesh Title")
      stub_const("DEFAULT_CHANNEL", "#SpecChannel")
      stub_const("DEFAULT_FREQUENCY", "915MHz")
      stub_const("MAX_NODE_DISTANCE_KM", 120.5)
      stub_const("MATRIX_ROOM", " #spec-room:example.org ")

      expected_description = "Live Meshtastic mesh map for Spec Mesh Title on #SpecChannel (915MHz). Track nodes, messages, and coverage in real time. Shows nodes within roughly 120.5 km of the map center. Join the community in #spec-room:example.org on Matrix."

      get "/"

      expect(last_response.body).to include(%(meta name="description" content="#{expected_description}" />))
      expect(last_response.body).to include('<meta property="og:title" content="Spec Mesh Title" />')
      expect(last_response.body).to include('<meta property="og:site_name" content="Spec Mesh Title" />')
      expect(last_response.body).to include('<meta name="twitter:image" content="http://example.org/potatomesh-logo.svg" />')
    end
  end

  describe "database initialization" do
    it "creates the schema when booting" do
      expect(File).to exist(DB_PATH)

      db = SQLite3::Database.new(DB_PATH, readonly: true)
      tables = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('nodes','messages')").flatten

      expect(tables).to include("nodes")
      expect(tables).to include("messages")
    ensure
      db&.close
    end
  end

  describe "authentication" do
    it "rejects requests without a matching bearer token" do
      post "/api/nodes", {}.to_json, { "CONTENT_TYPE" => "application/json" }

      expect(last_response.status).to eq(403)
      expect(JSON.parse(last_response.body)).to eq("error" => "Forbidden")
    end

    it "rejects requests when the API token is not configured" do
      ENV["API_TOKEN"] = nil

      post "/api/messages", {}.to_json, { "CONTENT_TYPE" => "application/json" }

      expect(last_response.status).to eq(403)
      expect(JSON.parse(last_response.body)).to eq("error" => "Forbidden")
    ensure
      ENV["API_TOKEN"] = api_token
    end

    it "rejects requests with the wrong bearer token" do
      headers = auth_headers.merge("HTTP_AUTHORIZATION" => "Bearer wrong-token")

      post "/api/messages", {}.to_json, headers

      expect(last_response.status).to eq(403)
      expect(JSON.parse(last_response.body)).to eq("error" => "Forbidden")
    end

    it "does not accept alternate authorization schemes" do
      basic = Base64.strict_encode64("attacker:password")
      headers = auth_headers.merge("HTTP_AUTHORIZATION" => "Basic #{basic}")

      post "/api/nodes", {}.to_json, headers

      expect(last_response.status).to eq(403)
      expect(JSON.parse(last_response.body)).to eq("error" => "Forbidden")
    end

    it "rejects tokens with unexpected trailing characters" do
      headers = auth_headers.merge("HTTP_AUTHORIZATION" => "Bearer #{api_token} ")

      post "/api/messages", {}.to_json, headers

      expect(last_response.status).to eq(403)
      expect(JSON.parse(last_response.body)).to eq("error" => "Forbidden")
    end
  end

  describe "POST /api/nodes" do
    it "imports nodes from fixture data into the database" do
      import_nodes_fixture

      expected_nodes = nodes_fixture.map do |node|
        [node["node_id"], expected_node_row(node)]
      end.to_h

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        rows = db.execute(<<~SQL)
          SELECT node_id, short_name, long_name, hw_model, role, snr,
                 battery_level, voltage, last_heard, first_heard,
                 uptime_seconds, channel_utilization, air_util_tx,
                 position_time, latitude, longitude, altitude
          FROM nodes
          ORDER BY node_id
        SQL

        expect(rows.size).to eq(expected_nodes.size)

        rows.each do |row|
          expected = expected_nodes.fetch(row["node_id"])
          expect(row["short_name"]).to eq(expected["short_name"])
          expect(row["long_name"]).to eq(expected["long_name"])
          expect(row["hw_model"]).to eq(expected["hw_model"])
          expect(row["role"]).to eq(expected["role"])
          expect_same_value(row["snr"], expected["snr"])
          expect_same_value(row["battery_level"], expected["battery_level"])
          expect_same_value(row["voltage"], expected["voltage"])
          expect(row["last_heard"]).to eq(expected["last_heard"])
          expect(row["first_heard"]).to eq(expected["first_heard"])
          expect_same_value(row["uptime_seconds"], expected["uptime_seconds"])
          expect_same_value(row["channel_utilization"], expected["channel_utilization"])
          expect_same_value(row["air_util_tx"], expected["air_util_tx"])
          expect_same_value(row["position_time"], expected["position_time"])
          expect_same_value(row["latitude"], expected["latitude"])
          expect_same_value(row["longitude"], expected["longitude"])
          expect_same_value(row["altitude"], expected["altitude"])
        end
      end
    end

    it "returns 400 when the payload is not valid JSON" do
      post "/api/nodes", "{", auth_headers

      expect(last_response.status).to eq(400)
      expect(JSON.parse(last_response.body)).to eq("error" => "invalid JSON")
    end

    it "updates timestamps when the payload omits lastHeard" do
      node_id = "!spectime01"
      payload = {
        node_id => {
          "user" => { "shortName" => "Spec Time" },
        },
      }

      post "/api/nodes", payload.to_json, auth_headers

      expect(last_response).to be_ok

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        row = db.get_first_row(
          "SELECT last_heard, first_heard FROM nodes WHERE node_id = ?",
          [node_id],
        )

        expect(row["last_heard"]).to eq(reference_time.to_i)
        expect(row["first_heard"]).to eq(reference_time.to_i)
      end
    end

    it "preserves the original first_heard when updating nodes" do
      node_id = "!spectime02"
      initial_first = reference_time.to_i - 600
      initial_last = reference_time.to_i - 300

      with_db do |db|
        db.execute(
          "INSERT INTO nodes(node_id, last_heard, first_heard) VALUES (?,?,?)",
          [node_id, initial_last, initial_first],
        )
      end

      payload = {
        node_id => {
          "user" => { "shortName" => "Spec Update" },
          "lastHeard" => reference_time.to_i,
        },
      }

      post "/api/nodes", payload.to_json, auth_headers

      expect(last_response).to be_ok

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        row = db.get_first_row(
          "SELECT last_heard, first_heard FROM nodes WHERE node_id = ?",
          [node_id],
        )

        expect(row["last_heard"]).to eq(reference_time.to_i)
        expect(row["first_heard"]).to eq(initial_first)
      end
    end

    it "returns 400 when more than 1000 nodes are provided" do
      payload = (0..1000).each_with_object({}) do |i, acc|
        acc["node-#{i}"] = {}
      end

      post "/api/nodes", payload.to_json, auth_headers

      expect(last_response.status).to eq(400)
      expect(JSON.parse(last_response.body)).to eq("error" => "too many nodes")

      with_db(readonly: true) do |db|
        count = db.get_first_value("SELECT COUNT(*) FROM nodes")
        expect(count).to eq(0)
      end
    end

    it "returns 413 when the request body exceeds the configured byte limit" do
      limit = 64
      stub_const("MAX_JSON_BODY_BYTES", limit)
      payload = { "huge-node" => { "user" => { "shortName" => "A" * (limit + 50) } } }.to_json
      expect(payload.bytesize).to be > limit

      post "/api/nodes", payload, auth_headers

      expect(last_response.status).to eq(413)
      expect(JSON.parse(last_response.body)).to eq("error" => "payload too large")

      with_db(readonly: true) do |db|
        count = db.get_first_value("SELECT COUNT(*) FROM nodes")
        expect(count).to eq(0)
      end
    end

    it "treats SQL-looking node identifiers as plain data" do
      malicious_id = "spec-node'); DROP TABLE nodes;--"
      payload = {
        malicious_id => {
          "user" => { "shortName" => "Spec Attack" },
          "lastHeard" => reference_time.to_i,
        },
      }

      post "/api/nodes", payload.to_json, auth_headers

      expect(last_response).to be_ok
      expect(JSON.parse(last_response.body)).to eq("status" => "ok")

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        row = db.get_first_row(
          "SELECT node_id, short_name FROM nodes WHERE node_id = ?",
          [malicious_id],
        )

        expect(row["node_id"]).to eq(malicious_id)
        expect(row["short_name"]).to eq("Spec Attack")

        tables = db.get_first_value(
          "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='nodes'",
        )
        expect(tables).to eq(1)
      end
    end

    it "retries node upserts when the database reports it is locked" do
      node = nodes_fixture.first
      payload = { node["node_id"] => build_node_payload(node) }

      call_count = 0
      allow_any_instance_of(SQLite3::Database).to receive(:execute).and_wrap_original do |method, sql, *args|
        if sql.include?("INSERT INTO nodes")
          call_count += 1
          raise SQLite3::BusyException, "database is locked" if call_count == 1
        end
        method.call(sql, *args)
      end

      post "/api/nodes", payload.to_json, auth_headers

      expect(last_response).to be_ok
      expect(JSON.parse(last_response.body)).to eq("status" => "ok")
      expect(call_count).to be >= 2

      with_db(readonly: true) do |db|
        count = db.get_first_value("SELECT COUNT(*) FROM nodes WHERE node_id = ?", [node["node_id"]])
        expect(count).to eq(1)

        last_heard = db.get_first_value("SELECT last_heard FROM nodes WHERE node_id = ?", [node["node_id"]])
        expect(last_heard).to eq(expected_last_heard(node))
      end
    end
  end

  describe "#ensure_unknown_node" do
    it "creates a hidden placeholder with timestamps for chat notifications" do
      with_db do |db|
        created = ensure_unknown_node(db, "!1234abcd", nil, heard_time: reference_time.to_i)
        expect(created).to be_truthy
      end

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        row = db.get_first_row(
          <<~SQL,
          SELECT short_name, long_name, role, last_heard, first_heard
          FROM nodes
          WHERE node_id = ?
        SQL
          ["!1234abcd"],
        )

        expect(row["short_name"]).to eq("ABCD")
        expect(row["long_name"]).to eq("Meshtastic ABCD")
        expect(row["role"]).to eq("CLIENT_HIDDEN")
        expect(row["last_heard"]).to eq(reference_time.to_i)
        expect(row["first_heard"]).to eq(reference_time.to_i)
      end
    end

    it "leaves timestamps nil when no receive time is provided" do
      with_db do |db|
        created = ensure_unknown_node(db, "!1111beef", nil)
        expect(created).to be_truthy
      end

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        row = db.get_first_row(
          <<~SQL,
          SELECT last_heard, first_heard
          FROM nodes
          WHERE node_id = ?
        SQL
          ["!1111beef"],
        )

        expect(row["last_heard"]).to be_nil
        expect(row["first_heard"]).to be_nil
      end
    end

    it "returns false when the node already exists" do
      with_db do |db|
        expect(ensure_unknown_node(db, "!0000c0de", nil)).to be_truthy
        expect(ensure_unknown_node(db, "!0000c0de", nil)).to be_falsey
      end
    end
  end

  describe "POST /api/messages" do
    it "persists messages from fixture data" do
      import_nodes_fixture
      import_messages_fixture

      expected_messages = messages_fixture.map do |message|
        [message["id"], message.reject { |key, _| key == "node" }]
      end.to_h

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        rows = db.execute(<<~SQL)
          SELECT id, rx_time, rx_iso, from_id, to_id, channel,
                 portnum, text, snr, rssi, hop_limit
          FROM messages
          ORDER BY id
        SQL

        expect(rows.size).to eq(expected_messages.size)

        rows.each do |row|
          expected = expected_messages.fetch(row["id"])
          expect(row["rx_time"]).to eq(expected["rx_time"])
          expect(row["rx_iso"]).to eq(expected["rx_iso"])
          expect(row["from_id"]).to eq(expected["from_id"])
          expect(row["to_id"]).to eq(expected["to_id"])
          expect(row["channel"]).to eq(expected["channel"])
          expect(row["portnum"]).to eq(expected["portnum"])
          expect(row["text"]).to eq(expected["text"])
          expect_same_value(row["snr"], expected["snr"])
          expect(row["rssi"]).to eq(expected["rssi"])
          expect(row["hop_limit"]).to eq(expected["hop_limit"])
        end
      end
    end

    it "creates hidden nodes for unknown message senders" do
      payload = {
        "id" => 9_999,
        "rx_time" => reference_time.to_i,
        "rx_iso" => reference_time.iso8601,
        "from_id" => "!feedf00d",
        "to_id" => "^all",
        "channel" => 0,
        "portnum" => "TEXT_MESSAGE_APP",
        "text" => "Spec placeholder message",
      }

      post "/api/messages", payload.to_json, auth_headers

      expect(last_response).to be_ok
      expect(JSON.parse(last_response.body)).to eq("status" => "ok")

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        row = db.get_first_row(
          "SELECT node_id, num, short_name, long_name, role, last_heard, first_heard FROM nodes WHERE node_id = ?",
          ["!feedf00d"],
        )

        expect(row).not_to be_nil
        expect(row["node_id"]).to eq("!feedf00d")
        expect(row["num"]).to eq(0xfeedf00d)
        expect(row["short_name"]).to eq("F00D")
        expect(row["long_name"]).to eq("Meshtastic F00D")
        expect(row["role"]).to eq("CLIENT_HIDDEN")
        expect(row["last_heard"]).to eq(payload["rx_time"])
        expect(row["first_heard"]).to eq(payload["rx_time"])
      end
    end

    it "returns 400 when the payload is not valid JSON" do
      post "/api/messages", "{", auth_headers

      expect(last_response.status).to eq(400)
      expect(JSON.parse(last_response.body)).to eq("error" => "invalid JSON")
    end

    it "rejects message payloads that are larger than the configured byte limit" do
      limit = 64
      stub_const("MAX_JSON_BODY_BYTES", limit)
      payload = [{ "id" => "m1", "text" => "A" * (limit + 50) }].to_json
      expect(payload.bytesize).to be > limit

      post "/api/messages", payload, auth_headers

      expect(last_response.status).to eq(413)
      expect(JSON.parse(last_response.body)).to eq("error" => "payload too large")

      with_db(readonly: true) do |db|
        count = db.get_first_value("SELECT COUNT(*) FROM messages")
        expect(count).to eq(0)
      end
    end

    describe "POST /api/positions" do
      it "stores position packets and updates node metadata" do
        node_id = "!specpos01"
        node_num = 0x1234_5678
        initial_last_heard = reference_time.to_i - 600
        node_payload = {
          node_id => {
            "num" => node_num,
            "user" => { "shortName" => "SpecPos" },
            "lastHeard" => initial_last_heard,
            "position" => {
              "time" => initial_last_heard - 60,
              "latitude" => 52.0,
              "longitude" => 13.0,
            },
          },
        }

        post "/api/nodes", node_payload.to_json, auth_headers
        expect(last_response).to be_ok

        rx_time = reference_time.to_i - 120
        position_time = rx_time - 30
        raw_payload = { "time" => position_time, "latitude_i" => (52.5 * 1e7).to_i }
        position_payload = {
          "id" => 9_001,
          "node_id" => node_id,
          "node_num" => node_num,
          "rx_time" => rx_time,
          "rx_iso" => Time.at(rx_time).utc.iso8601,
          "to_id" => "^all",
          "latitude" => 52.5,
          "longitude" => 13.4,
          "altitude" => 42.0,
          "position_time" => position_time,
          "location_source" => "LOC_INTERNAL",
          "precision_bits" => 15,
          "sats_in_view" => 6,
          "pdop" => 2.5,
          "ground_speed" => 3.2,
          "ground_track" => 180.0,
          "snr" => -8.5,
          "rssi" => -90,
          "hop_limit" => 3,
          "bitfield" => 1,
          "payload_b64" => "AQI=",
          "raw" => raw_payload,
        }

        post "/api/positions", position_payload.to_json, auth_headers

        expect(last_response).to be_ok
        expect(JSON.parse(last_response.body)).to eq("status" => "ok")

        with_db(readonly: true) do |db|
          db.results_as_hash = true
          row = db.get_first_row("SELECT * FROM positions WHERE id = ?", [9_001])
          expect(row["node_id"]).to eq(node_id)
          expect(row["node_num"]).to eq(node_num)
          expect(row["rx_time"]).to eq(rx_time)
          expect(row["rx_iso"]).to eq(Time.at(rx_time).utc.iso8601)
          expect(row["position_time"]).to eq(position_time)
          expect_same_value(row["latitude"], 52.5)
          expect_same_value(row["longitude"], 13.4)
          expect_same_value(row["altitude"], 42.0)
          expect(row["location_source"]).to eq("LOC_INTERNAL")
          expect(row["precision_bits"]).to eq(15)
          expect(row["sats_in_view"]).to eq(6)
          expect_same_value(row["pdop"], 2.5)
          expect_same_value(row["ground_speed"], 3.2)
          expect_same_value(row["ground_track"], 180.0)
          expect_same_value(row["snr"], -8.5)
          expect(row["rssi"]).to eq(-90)
          expect(row["hop_limit"]).to eq(3)
          expect(row["bitfield"]).to eq(1)
          expect(row["payload_b64"]).to eq("AQI=")
        end

        with_db(readonly: true) do |db|
          db.results_as_hash = true
          node_row = db.get_first_row(
            "SELECT last_heard, position_time, latitude, longitude, altitude, location_source, snr FROM nodes WHERE node_id = ?",
            [node_id],
          )
          expect(node_row["last_heard"]).to eq(rx_time)
          expect(node_row["position_time"]).to eq(position_time)
          expect_same_value(node_row["latitude"], 52.5)
          expect_same_value(node_row["longitude"], 13.4)
          expect_same_value(node_row["altitude"], 42.0)
          expect(node_row["location_source"]).to eq("LOC_INTERNAL")
          expect_same_value(node_row["snr"], -8.5)
        end
      end

      it "creates node records when none exist" do
        node_id = "!specnew01"
        node_num = 0xfeed_cafe
        rx_time = reference_time.to_i - 60
        position_time = rx_time - 10
        payload = {
          "id" => 9_002,
          "node_id" => node_id,
          "node_num" => node_num,
          "rx_time" => rx_time,
          "rx_iso" => Time.at(rx_time).utc.iso8601,
          "latitude" => 52.1,
          "longitude" => 13.1,
          "altitude" => 33.0,
          "position_time" => position_time,
          "location_source" => "LOC_EXTERNAL",
        }

        post "/api/positions", payload.to_json, auth_headers

        expect(last_response).to be_ok

        with_db(readonly: true) do |db|
          db.results_as_hash = true
          node_row = db.get_first_row("SELECT * FROM nodes WHERE node_id = ?", [node_id])
          expect(node_row).not_to be_nil
          expect(node_row["num"]).to eq(node_num)
          expect(node_row["last_heard"]).to eq(rx_time)
          expect(node_row["first_heard"]).to eq(rx_time)
          expect(node_row["position_time"]).to eq(position_time)
          expect_same_value(node_row["latitude"], 52.1)
          expect_same_value(node_row["longitude"], 13.1)
          expect_same_value(node_row["altitude"], 33.0)
          expect(node_row["location_source"]).to eq("LOC_EXTERNAL")
        end
      end

      it "creates hidden nodes for unknown position senders" do
        payload = {
          "id" => 42,
          "node_id" => "!0badc0de",
          "rx_time" => reference_time.to_i,
          "rx_iso" => reference_time.iso8601,
          "latitude" => 52.1,
          "longitude" => 13.1,
        }

        post "/api/positions", payload.to_json, auth_headers

        expect(last_response).to be_ok
        expect(JSON.parse(last_response.body)).to eq("status" => "ok")

        with_db(readonly: true) do |db|
          db.results_as_hash = true
          row = db.get_first_row(
            "SELECT node_id, num, short_name, long_name, role FROM nodes WHERE node_id = ?",
            ["!0badc0de"],
          )

          expect(row).not_to be_nil
          expect(row["node_id"]).to eq("!0badc0de")
          expect(row["num"]).to eq(0x0badc0de)
          expect(row["short_name"]).to eq("C0DE")
          expect(row["long_name"]).to eq("Meshtastic C0DE")
          expect(row["role"]).to eq("CLIENT_HIDDEN")
        end
      end

      it "fills first_heard when updating an existing node without one" do
        node_id = "!specposfh"
        rx_time = reference_time.to_i - 90

        with_db do |db|
          db.execute(
            "INSERT INTO nodes(node_id, last_heard, first_heard) VALUES (?,?,?)",
            [node_id, nil, nil],
          )
        end

        payload = {
          "id" => 51,
          "node_id" => node_id,
          "rx_time" => rx_time,
          "latitude" => 51.5,
          "longitude" => -0.12,
        }

        post "/api/positions", payload.to_json, auth_headers

        expect(last_response).to be_ok

        with_db(readonly: true) do |db|
          db.results_as_hash = true
          row = db.get_first_row(
            "SELECT last_heard, first_heard FROM nodes WHERE node_id = ?",
            [node_id],
          )

          expect(row["last_heard"]).to eq(rx_time)
          expect(row["first_heard"]).to eq(rx_time)
        end
      end

      it "returns 400 when the payload is not valid JSON" do
        post "/api/positions", "{", auth_headers

        expect(last_response.status).to eq(400)
        expect(JSON.parse(last_response.body)).to eq("error" => "invalid JSON")
      end

      it "returns 400 when more than 1000 positions are provided" do
        payload = Array.new(1001) { |i| { "id" => i + 1, "rx_time" => reference_time.to_i - i } }

        post "/api/positions", payload.to_json, auth_headers

        expect(last_response.status).to eq(400)
        expect(JSON.parse(last_response.body)).to eq("error" => "too many positions")

        with_db(readonly: true) do |db|
          count = db.get_first_value("SELECT COUNT(*) FROM positions")
          expect(count).to eq(0)
        end
      end
    end

    it "returns 400 when more than 1000 messages are provided" do
      payload = Array.new(1001) { |i| { "packet_id" => i + 1 } }

      post "/api/messages", payload.to_json, auth_headers

      expect(last_response.status).to eq(400)
      expect(JSON.parse(last_response.body)).to eq("error" => "too many messages")

      with_db(readonly: true) do |db|
        count = db.get_first_value("SELECT COUNT(*) FROM messages")
        expect(count).to eq(0)
      end
    end

    it "accepts array payloads, normalizes node references, and skips messages without an id" do
      node_id = "!spec-normalized"
      node_payload = {
        node_id => {
          "num" => 123,
          "user" => { "shortName" => "Spec" },
          "lastHeard" => reference_time.to_i - 60,
          "position" => { "time" => reference_time.to_i - 120 },
        },
      }

      post "/api/nodes", node_payload.to_json, auth_headers
      expect(last_response).to be_ok

      messages_payload = [
        {
          "packet_id" => 101,
          "from_id" => "123",
          "text" => "normalized",
        },
        {
          "packet_id" => 102,
          "from_id" => " ",
          "text" => "blank",
        },
        {
          "text" => "missing id",
        },
      ]

      post "/api/messages", messages_payload.to_json, auth_headers

      expect(last_response).to be_ok
      expect(JSON.parse(last_response.body)).to eq("status" => "ok")

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        rows = db.execute(
          "SELECT id, from_id, to_id, rx_time, rx_iso, text, encrypted FROM messages ORDER BY id",
        )

        expect(rows.size).to eq(2)

        first, second = rows

        expect(first["id"]).to eq(101)
        expect(first["from_id"]).to eq(node_id)
        expect(first).not_to have_key("from_node_id")
        expect(first).not_to have_key("from_node_num")
        expect(first["rx_time"]).to eq(reference_time.to_i)
        expect(first["rx_iso"]).to eq(reference_time.utc.iso8601)
        expect(first["text"]).to eq("normalized")
        expect(first).not_to have_key("to_node_id")
        expect(first).not_to have_key("to_node_num")
        expect(first["encrypted"]).to be_nil

        expect(second["id"]).to eq(102)
        expect(second["from_id"]).to be_nil
        expect(second).not_to have_key("from_node_id")
        expect(second).not_to have_key("from_node_num")
        expect(second["rx_time"]).to eq(reference_time.to_i)
        expect(second["rx_iso"]).to eq(reference_time.utc.iso8601)
        expect(second["text"]).to eq("blank")
        expect(second).not_to have_key("to_node_id")
        expect(second).not_to have_key("to_node_num")
        expect(second["encrypted"]).to be_nil
      end
    end

    it "stores encrypted messages and resolves node references" do
      sender_id = "!feedc0de"
      sender_num = 0xfeedc0de
      receiver_id = "!c0ffee99"
      receiver_num = 0xc0ffee99

      sender_node = {
        "node_id" => sender_id,
        "short_name" => "EncS",
        "long_name" => "Encrypted Sender",
        "hw_model" => "TEST",
        "role" => "CLIENT",
        "snr" => 5.5,
        "battery_level" => 80.0,
        "voltage" => 3.9,
        "last_heard" => reference_time.to_i - 30,
        "position_time" => reference_time.to_i - 60,
        "latitude" => 52.1,
        "longitude" => 13.1,
        "altitude" => 42.0,
      }
      sender_payload = build_node_payload(sender_node)
      sender_payload["num"] = sender_num

      receiver_node = {
        "node_id" => receiver_id,
        "short_name" => "EncR",
        "long_name" => "Encrypted Receiver",
        "hw_model" => "TEST",
        "role" => "CLIENT",
        "snr" => 4.25,
        "battery_level" => 75.0,
        "voltage" => 3.8,
        "last_heard" => reference_time.to_i - 40,
        "position_time" => reference_time.to_i - 70,
        "latitude" => 52.2,
        "longitude" => 13.2,
        "altitude" => 35.0,
      }
      receiver_payload = build_node_payload(receiver_node)
      receiver_payload["num"] = receiver_num

      post "/api/nodes", { sender_id => sender_payload }.to_json, auth_headers
      expect(last_response).to be_ok
      post "/api/nodes", { receiver_id => receiver_payload }.to_json, auth_headers
      expect(last_response).to be_ok

      encrypted_b64 = Base64.strict_encode64("secret message")
      payload = {
        "packet_id" => 777_001,
        "rx_time" => reference_time.to_i,
        "rx_iso" => reference_time.utc.iso8601,
        "from_id" => sender_num.to_s,
        "to_id" => receiver_id,
        "channel" => 8,
        "portnum" => "TEXT_MESSAGE_APP",
        "encrypted" => encrypted_b64,
        "snr" => -12.5,
        "rssi" => -109,
        "hop_limit" => 3,
      }

      post "/api/messages", payload.to_json, auth_headers

      expect(last_response).to be_ok
      expect(JSON.parse(last_response.body)).to eq("status" => "ok")

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        row = db.get_first_row(
          "SELECT from_id, to_id, text, encrypted FROM messages WHERE id = ?",
          [777_001],
        )

        expect(row["from_id"]).to eq(sender_id)
        expect(row["to_id"]).to eq(receiver_id)
        expect(row["text"]).to be_nil
        expect(row["encrypted"]).to eq(encrypted_b64)
      end

      get "/api/messages"
      expect(last_response).to be_ok

      messages = JSON.parse(last_response.body)
      expect(messages).to be_an(Array)
      expect(messages).to be_empty
    end

    it "stores messages containing SQL control characters without executing them" do
      payload = {
        "packet_id" => 404,
        "from_id" => "attacker",
        "text" => "'); DROP TABLE nodes;--",
      }

      post "/api/messages", payload.to_json, auth_headers

      expect(last_response).to be_ok
      expect(JSON.parse(last_response.body)).to eq("status" => "ok")

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        row = db.get_first_row(
          "SELECT id, text FROM messages WHERE id = ?",
          [404],
        )

        expect(row["id"]).to eq(404)
        expect(row["text"]).to eq("'); DROP TABLE nodes;--")

        tables = db.get_first_value(
          "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='nodes'",
        )
        expect(tables).to eq(1)
      end
    end

    it "updates existing messages only when sender information is provided" do
      message_id = 9001
      initial_time = reference_time.to_i - 120
      initial_iso = Time.at(initial_time).utc.iso8601
      base_payload = {
        "packet_id" => message_id,
        "rx_time" => initial_time,
        "rx_iso" => initial_iso,
        "to_id" => "^all",
        "channel" => 1,
        "portnum" => "TEXT_MESSAGE_APP",
        "text" => "initial payload",
        "snr" => 7.25,
        "rssi" => -58,
        "hop_limit" => 2,
      }

      post "/api/messages", base_payload.merge("from_id" => nil).to_json, auth_headers

      expect(last_response).to be_ok
      expect(JSON.parse(last_response.body)).to eq("status" => "ok")

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        row = db.get_first_row("SELECT id, from_id, rx_time, rx_iso, text FROM messages WHERE id = ?", [message_id])

        expect(row["from_id"]).to be_nil
        expect(row["rx_time"]).to eq(initial_time)
        expect(row["rx_iso"]).to eq(initial_iso)
        expect(row["text"]).to eq("initial payload")
      end

      updated_time = initial_time + 60
      updated_iso = Time.at(updated_time).utc.iso8601
      post "/api/messages", base_payload.merge(
        "rx_time" => updated_time,
        "rx_iso" => updated_iso,
        "text" => "overwritten without sender",
        "from_id" => " ",
      ).to_json, auth_headers

      expect(last_response).to be_ok
      expect(JSON.parse(last_response.body)).to eq("status" => "ok")

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        row = db.get_first_row("SELECT id, from_id, rx_time, rx_iso, text FROM messages WHERE id = ?", [message_id])

        expect(row["from_id"]).to be_nil
        expect(row["rx_time"]).to eq(initial_time)
        expect(row["rx_iso"]).to eq(initial_iso)
        expect(row["text"]).to eq("initial payload")
      end

      final_time = updated_time + 30
      final_iso = Time.at(final_time).utc.iso8601
      post "/api/messages", base_payload.merge(
        "rx_time" => final_time,
        "rx_iso" => final_iso,
        "from" => "!spec-sender",
      ).to_json, auth_headers

      expect(last_response).to be_ok
      expect(JSON.parse(last_response.body)).to eq("status" => "ok")

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        row = db.get_first_row("SELECT id, from_id, rx_time, rx_iso, text FROM messages WHERE id = ?", [message_id])

        expect(row["from_id"]).to eq("!spec-sender")
        expect(row["rx_time"]).to eq(initial_time)
        expect(row["rx_iso"]).to eq(initial_iso)
        expect(row["text"]).to eq("initial payload")
      end
    end
  end

  describe "GET /api/nodes" do
    it "returns the stored nodes with derived timestamps" do
      import_nodes_fixture

      get "/api/nodes"
      expect(last_response).to be_ok

      actual = JSON.parse(last_response.body)
      expect(actual.size).to eq(nodes_fixture.size)

      actual_by_id = actual.each_with_object({}) do |row, acc|
        acc[row["node_id"]] = row
      end

      nodes_fixture.each do |node|
        expected = expected_node_row(node)
        actual_row = actual_by_id.fetch(node["node_id"])

        expect(actual_row["short_name"]).to eq(expected["short_name"])
        expect(actual_row["long_name"]).to eq(expected["long_name"])
        expect(actual_row["hw_model"]).to eq(expected["hw_model"])
        expect(actual_row["role"]).to eq(expected["role"])
        expect_same_value(actual_row["snr"], expected["snr"])
        expect_same_value(actual_row["battery_level"], expected["battery_level"])
        expect_same_value(actual_row["voltage"], expected["voltage"])
        expect(actual_row["last_heard"]).to eq(expected["last_heard"])
        expect(actual_row["first_heard"]).to eq(expected["first_heard"])
        expect_same_value(actual_row["uptime_seconds"], expected["uptime_seconds"])
        expect_same_value(actual_row["channel_utilization"], expected["channel_utilization"])
        expect_same_value(actual_row["air_util_tx"], expected["air_util_tx"])
        expect_same_value(actual_row["position_time"], expected["position_time"])
        expect_same_value(actual_row["latitude"], expected["latitude"])
        expect_same_value(actual_row["longitude"], expected["longitude"])
        expect_same_value(actual_row["altitude"], expected["altitude"])

        if expected["last_heard"]
          expected_last_seen_iso = Time.at(expected["last_heard"]).utc.iso8601
          expect(actual_row["last_seen_iso"]).to eq(expected_last_seen_iso)
        else
          expect(actual_row["last_seen_iso"]).to be_nil
        end

        if node["position_time"]
          expected_pos_iso = Time.at(node["position_time"]).utc.iso8601
          expect(actual_row["pos_time_iso"]).to eq(expected_pos_iso)
        else
          expect(actual_row).not_to have_key("pos_time_iso")
        end
      end
    end
  end

  describe "GET /api/messages" do
    it "returns the stored messages along with joined node data" do
      import_nodes_fixture
      import_messages_fixture

      get "/api/messages"
      expect(last_response).to be_ok

      actual = JSON.parse(last_response.body)
      expect(actual.size).to eq(messages_fixture.size)

      actual_by_id = actual.each_with_object({}) do |row, acc|
        acc[row["id"]] = row
      end

      nodes_by_id = {}
      node_aliases = {}

      nodes_fixture.each do |node|
        node_id = node["node_id"]
        expected_row = expected_node_row(node)
        nodes_by_id[node_id] = expected_row

        if (num = node["num"])
          node_aliases[num.to_s] = node_id
        end
      end

      messages_fixture.each do |message|
        node = message["node"]
        next unless node.is_a?(Hash)

        canonical = node["node_id"]
        num = node["num"]
        next unless canonical && num

        node_aliases[num.to_s] ||= canonical
      end

      messages_fixture.each do |message|
        expected = message.reject { |key, _| key == "node" }
        actual_row = actual_by_id.fetch(message["id"])

        expect(actual_row["rx_time"]).to eq(expected["rx_time"])
        expect(actual_row["rx_iso"]).to eq(expected["rx_iso"])

        expected_from_id = expected["from_id"]
        if expected_from_id.is_a?(String) && expected_from_id.match?(/\A[0-9]+\z/)
          expected_from_id = node_aliases[expected_from_id] || expected_from_id
        elsif expected_from_id.nil?
          expected_from_id = message.dig("node", "node_id")
        end
        expect(actual_row["from_id"]).to eq(expected_from_id)
        expect(actual_row).not_to have_key("from_node_id")
        expect(actual_row).not_to have_key("from_node_num")

        expected_to_id = expected["to_id"]
        if expected_to_id.is_a?(String) && expected_to_id.match?(/\A[0-9]+\z/)
          expected_to_id = node_aliases[expected_to_id] || expected_to_id
        end
        expect(actual_row["to_id"]).to eq(expected_to_id)
        expect(actual_row).not_to have_key("to_node_id")
        expect(actual_row).not_to have_key("to_node_num")
        expect(actual_row["channel"]).to eq(expected["channel"])
        expect(actual_row["portnum"]).to eq(expected["portnum"])
        expect(actual_row["text"]).to eq(expected["text"])
        expect(actual_row["encrypted"]).to eq(expected["encrypted"])
        expect_same_value(actual_row["snr"], expected["snr"])
        expect(actual_row["rssi"]).to eq(expected["rssi"])
        expect(actual_row["hop_limit"]).to eq(expected["hop_limit"])

        if expected["from_id"]
          lookup_id = expected["from_id"]
          node_expected = nodes_by_id[lookup_id]

          unless node_expected
            canonical_id = node_aliases[lookup_id.to_s]
            expect(canonical_id).not_to be_nil,
                                        "node fixture missing for from_id #{lookup_id.inspect}"
            node_expected = nodes_by_id.fetch(canonical_id)
          end

          node_actual = actual_row.fetch("node")

          expect(node_actual["node_id"]).to eq(node_expected["node_id"])
          expect(node_actual["short_name"]).to eq(node_expected["short_name"])
          expect(node_actual["long_name"]).to eq(node_expected["long_name"])
          expect(node_actual["role"]).to eq(node_expected["role"])
          expect_same_value(node_actual["snr"], node_expected["snr"])
          expect_same_value(node_actual["battery_level"], node_expected["battery_level"])
          expect_same_value(node_actual["voltage"], node_expected["voltage"])
          expect(node_actual["last_heard"]).to eq(node_expected["last_heard"])
          expect(node_actual["first_heard"]).to eq(node_expected["first_heard"])
          expect_same_value(node_actual["latitude"], node_expected["latitude"])
          expect_same_value(node_actual["longitude"], node_expected["longitude"])
          expect_same_value(node_actual["altitude"], node_expected["altitude"])
        else
          expect(actual_row["node"]).to be_a(Hash)
          expect(actual_row["node"]["node_id"]).to be_nil
        end
      end
    end

    context "when DEBUG logging is enabled" do
      it "logs diagnostics for messages missing a sender" do
        stub_const("DEBUG", true)
        allow(Kernel).to receive(:warn)

        message_id = 987_654
        payload = {
          "packet_id" => message_id,
          "from_id" => " ",
          "text" => "debug logging",
        }

        post "/api/messages", payload.to_json, auth_headers
        expect(last_response).to be_ok
        expect(JSON.parse(last_response.body)).to eq("status" => "ok")

        get "/api/messages"
        expect(last_response).to be_ok

        expect(Kernel).to have_received(:warn).with(
          a_string_matching(/\[debug\] messages row before join: .*"id"\s*=>\s*#{message_id}/),
        )
        expect(Kernel).to have_received(:warn).with(
          a_string_matching(/\[debug\] row after join: .*"id"\s*=>\s*#{message_id}/),
        )
        expect(Kernel).to have_received(:warn).with(
          a_string_matching(/\[debug\] row after processing: .*"id"\s*=>\s*#{message_id}/),
        )

        messages = JSON.parse(last_response.body)
        expect(messages.size).to eq(1)
        expect(messages.first["from_id"]).to be_nil
      end
    end
  end

  describe "GET /api/positions" do
    it "returns stored positions ordered by receive time" do
      node_id = "!specfetch"
      rx_times = [reference_time.to_i - 50, reference_time.to_i - 10]
      rx_times.each_with_index do |rx_time, idx|
        payload = {
          "id" => 20_000 + idx,
          "node_id" => node_id,
          "rx_time" => rx_time,
          "rx_iso" => Time.at(rx_time).utc.iso8601,
          "position_time" => rx_time - 5,
          "latitude" => 52.0 + idx,
          "longitude" => 13.0 + idx,
          "payload_b64" => "AQI=",
        }
        post "/api/positions", payload.to_json, auth_headers
        expect(last_response).to be_ok
      end

      get "/api/positions?limit=1"

      expect(last_response).to be_ok
      data = JSON.parse(last_response.body)
      expect(data.length).to eq(1)
      entry = data.first
      expect(entry["id"]).to eq(20_001)
      expect(entry["node_id"]).to eq(node_id)
      expect(entry["rx_time"]).to eq(rx_times.last)
      expect(entry["rx_iso"]).to eq(Time.at(rx_times.last).utc.iso8601)
      expect(entry["position_time"]).to eq(rx_times.last - 5)
      expect(entry["position_time_iso"]).to eq(Time.at(rx_times.last - 5).utc.iso8601)
      expect(entry["latitude"]).to eq(53.0)
      expect(entry["longitude"]).to eq(14.0)
      expect(entry["payload_b64"]).to eq("AQI=")
    end
  end
end
