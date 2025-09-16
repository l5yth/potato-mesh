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
    File.expand_path("../../test/#{name}", __dir__)
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

    it "returns 400 when the payload is not valid JSON" do
      post "/api/messages", "{", auth_headers

      expect(last_response.status).to eq(400)
      expect(JSON.parse(last_response.body)).to eq("error" => "invalid JSON")
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
        rows = db.execute("SELECT id, from_id, rx_time, rx_iso, text FROM messages ORDER BY id")

        expect(rows.size).to eq(2)

        first, second = rows

        expect(first["id"]).to eq(101)
        expect(first["from_id"]).to eq(node_id)
        expect(first["rx_time"]).to eq(reference_time.to_i)
        expect(first["rx_iso"]).to eq(reference_time.utc.iso8601)
        expect(first["text"]).to eq("normalized")

        expect(second["id"]).to eq(102)
        expect(second["from_id"]).to be_nil
        expect(second["rx_time"]).to eq(reference_time.to_i)
        expect(second["rx_iso"]).to eq(reference_time.utc.iso8601)
        expect(second["text"]).to eq("blank")
      end
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

      nodes_by_id = nodes_fixture.each_with_object({}) do |node, acc|
        acc[node["node_id"]] = expected_node_row(node)
      end

      messages_fixture.each do |message|
        expected = message.reject { |key, _| key == "node" }
        actual_row = actual_by_id.fetch(message["id"])

        expect(actual_row["rx_time"]).to eq(expected["rx_time"])
        expect(actual_row["rx_iso"]).to eq(expected["rx_iso"])
        expect(actual_row["from_id"]).to eq(expected["from_id"])
        expect(actual_row["to_id"]).to eq(expected["to_id"])
        expect(actual_row["channel"]).to eq(expected["channel"])
        expect(actual_row["portnum"]).to eq(expected["portnum"])
        expect(actual_row["text"]).to eq(expected["text"])
        expect_same_value(actual_row["snr"], expected["snr"])
        expect(actual_row["rssi"]).to eq(expected["rssi"])
        expect(actual_row["hop_limit"]).to eq(expected["hop_limit"])

        if expected["from_id"]
          node_expected = nodes_by_id.fetch(expected["from_id"])
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
end
