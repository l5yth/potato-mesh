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
require "sqlite3"
require "json"

# RF-metrics ingest/read-side coverage (SPEC RF1-RF3, RF6; ACCEPTANCE RF-A1 -
# RF-A3): the additive `messages.hops` / `messages.path` / `nodes.rssi`
# columns round-trip through the authenticated POST ingest routes and surface
# on the GET collection responses, while legacy payloads without the fields
# keep storing NULL.
RSpec.describe "RF metrics (hops/path/rssi) ingest and read-side" do
  let(:app) { Sinatra::Application }
  let(:api_token) { "spec-token" }
  let(:auth_headers) do
    {
      "CONTENT_TYPE" => "application/json",
      "HTTP_AUTHORIZATION" => "Bearer #{api_token}",
    }
  end

  # Execute the provided block with a configured SQLite connection.
  #
  # @yieldparam db [SQLite3::Database] open database handle.
  # @return [void]
  def with_db
    db = SQLite3::Database.new(PotatoMesh::Config.db_path)
    db.busy_timeout = PotatoMesh::Config.db_busy_timeout_ms
    yield db
  ensure
    db&.close
  end

  # Remove the rows this spec writes so examples stay independent.
  #
  # @return [void]
  def clear_rf_tables
    with_db do |db|
      db.execute("DELETE FROM messages")
      db.execute("DELETE FROM nodes")
      db.execute("DELETE FROM positions")
    end
  end

  before do
    @original_token = ENV["API_TOKEN"]
    ENV["API_TOKEN"] = api_token
    clear_rf_tables
    PotatoMesh::App::ApiCache.invalidate_all
  end

  after do
    if @original_token.nil?
      ENV.delete("API_TOKEN")
    else
      ENV["API_TOKEN"] = @original_token
    end
  end

  # Build a minimal valid message payload the ingest route accepts.
  #
  # @param overrides [Hash] extra/overriding message fields.
  # @return [Hash] POST /api/messages payload.
  def message_payload(overrides = {})
    now = Time.now.to_i
    {
      "id" => 424_242,
      "rx_time" => now,
      "rx_iso" => Time.at(now).utc.iso8601,
      "from_id" => "!aabbccdd",
      "to_id" => "^all",
      "channel" => 0,
      "portnum" => "TEXT_MESSAGE_APP",
      "text" => "rf metrics probe",
      "snr" => 5.5,
      "rssi" => -80,
      "hop_limit" => 2,
    }.merge(overrides)
  end

  describe "message hops" do
    it "stores hops on POST /api/messages and serves it on GET /api/messages" do
      post "/api/messages", message_payload("hops" => 5).to_json, auth_headers
      expect(last_response.status).to eq(201)

      get "/api/messages"
      expect(last_response).to be_ok
      row = JSON.parse(last_response.body).find { |m| m["id"] == 424_242 }
      expect(row).not_to be_nil
      expect(row["hops"]).to eq(5)
      # hop_limit keeps its remaining-budget semantic untouched (RF1).
      expect(row["hop_limit"]).to eq(2)
    end

    it "stores NULL hops for legacy messages without the field" do
      post "/api/messages", message_payload.to_json, auth_headers
      expect(last_response.status).to eq(201)

      get "/api/messages"
      row = JSON.parse(last_response.body).find { |m| m["id"] == 424_242 }
      expect(row).not_to be_nil
      expect(row["hops"]).to be_nil
    end
  end

  describe "message path" do
    it "stores the meshcore hop-hash path and serves it on GET /api/messages" do
      payload = message_payload(
        "id" => 424_243,
        "protocol" => "meshcore",
        "hops" => 3,
        "path" => "f0bf44b53377",
      )
      post "/api/messages", payload.to_json, auth_headers
      expect(last_response.status).to eq(201)

      get "/api/messages"
      row = JSON.parse(last_response.body).find { |m| m["id"] == 424_243 }
      expect(row).not_to be_nil
      expect(row["path"]).to eq("f0bf44b53377")
      expect(row["hops"]).to eq(3)
    end

    it "stores NULL path when the field is absent (join miss / Meshtastic)" do
      post "/api/messages", message_payload("id" => 424_244).to_json, auth_headers
      expect(last_response.status).to eq(201)

      get "/api/messages"
      row = JSON.parse(last_response.body).find { |m| m["id"] == 424_244 }
      expect(row).not_to be_nil
      expect(row["path"]).to be_nil
    end
  end

  describe "node rssi" do
    # Build a minimal MeshCore advert-style node payload (RF3).
    #
    # @param overrides [Hash] extra/overriding node fields.
    # @return [Hash] node dict for POST /api/nodes.
    def node_payload(overrides = {})
      {
        "lastHeard" => Time.now.to_i,
        "protocol" => "meshcore",
        "snr" => 12.0,
        "rssi" => -69,
        "hopsAway" => 2,
        "user" => {
          "longName" => "BER Drachentoeter",
          "shortName" => "5116",
          "publicKey" => "511617e3" + "00" * 28,
          "role" => "REPEATER",
        },
      }.merge(overrides)
    end

    it "stores advert rssi and serves rssi and hops_away on GET /api/nodes" do
      post "/api/nodes", { "!511617e3" => node_payload }.to_json, auth_headers
      expect(last_response.status).to eq(201)

      get "/api/nodes"
      expect(last_response).to be_ok
      row = JSON.parse(last_response.body).find { |n| n["node_id"] == "!511617e3" }
      expect(row).not_to be_nil
      expect(row["rssi"]).to eq(-69)
      expect(row["hops_away"]).to eq(2)
      expect(row["snr"]).to eq(12.0)
    end

    it "preserves a stored rssi when a later upsert omits it (COALESCE)" do
      post "/api/nodes", { "!511617e3" => node_payload }.to_json, auth_headers
      expect(last_response.status).to eq(201)

      # A contact-roster refresh carries no rssi; the stored per-advert value
      # must survive (nodes.rssi COALESCE upsert, RF3/RF6).
      refresh = node_payload("rssi" => nil, "lastHeard" => Time.now.to_i + 60)
      refresh.delete("rssi")
      post "/api/nodes", { "!511617e3" => refresh }.to_json, auth_headers
      expect(last_response.status).to eq(201)

      get "/api/nodes"
      row = JSON.parse(last_response.body).find { |n| n["node_id"] == "!511617e3" }
      expect(row).not_to be_nil
      expect(row["rssi"]).to eq(-69)
    end

    it "leaves rssi NULL for meshtastic nodes (no source)" do
      payload = node_payload("protocol" => "meshtastic")
      payload.delete("rssi")
      post "/api/nodes", { "!511617e3" => payload }.to_json, auth_headers
      expect(last_response.status).to eq(201)

      get "/api/nodes"
      row = JSON.parse(last_response.body).find { |n| n["node_id"] == "!511617e3" }
      expect(row).not_to be_nil
      expect(row["rssi"]).to be_nil
    end
  end
end
