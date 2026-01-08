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

RSpec.describe "Ingestor endpoints" do
  let(:app) { Sinatra::Application }
  let(:api_token) { "secret-token" }
  let(:auth_headers) do
    {
      "CONTENT_TYPE" => "application/json",
      "HTTP_AUTHORIZATION" => "Bearer #{api_token}",
    }
  end

  before do
    @original_token = ENV["API_TOKEN"]
    ENV["API_TOKEN"] = api_token
    clear_ingestors_table
  end

  after do
    ENV["API_TOKEN"] = @original_token
    clear_ingestors_table
  end

  def clear_ingestors_table
    with_db do |db|
      db.execute("DELETE FROM ingestors")
      db.execute("VACUUM")
    end
  end

  def with_db(readonly: false)
    db = PotatoMesh::Application.open_database(readonly: readonly)
    db.busy_timeout = PotatoMesh::Config.db_busy_timeout_ms
    db.execute("PRAGMA foreign_keys = ON")
    yield db
  ensure
    db&.close
  end

  def ingestor_payload(overrides = {})
    now = Time.now.to_i
    {
      node_id: "!abc12345",
      start_time: now - 120,
      last_seen_time: now - 60,
      version: "0.5.10",
      lora_freq: 915,
      modem_preset: "LongFast",
    }.merge(overrides)
  end

  describe "POST /api/ingestors" do
    it "requires a bearer token" do
      post "/api/ingestors", ingestor_payload.to_json, { "CONTENT_TYPE" => "application/json" }

      expect(last_response.status).to eq(403)
    end

    it "upserts ingestor state without regressing start time" do
      payload = ingestor_payload
      post "/api/ingestors", payload.to_json, auth_headers

      expect(last_response.status).to eq(200)

      newer_last_seen = payload[:last_seen_time] + 3_600
      older_start = payload[:start_time] - 500
      post "/api/ingestors",
           payload.merge(last_seen_time: newer_last_seen, start_time: older_start).to_json,
           auth_headers

      expect(last_response.status).to eq(200)
      with_db(readonly: true) do |db|
        row = db.get_first_row(
          "SELECT node_id, start_time, last_seen_time, version, lora_freq, modem_preset FROM ingestors WHERE node_id = ?",
          [payload[:node_id]],
        )
        expect(row[0]).to eq(payload[:node_id])
        expect(row[1]).to eq(payload[:start_time])
        expect(row[2]).to be >= payload[:last_seen_time]
        expect(row[2]).to be <= Time.now.to_i
        expect(row[3]).to eq(payload[:version])
        expect(row[4]).to eq(payload[:lora_freq])
        expect(row[5]).to eq(payload[:modem_preset])
      end
    end

    it "rejects payloads missing required fields" do
      post "/api/ingestors", { node_id: "!abcd0001" }.to_json, auth_headers

      expect(last_response.status).to eq(400)
    end

    it "rejects invalid JSON" do
      post "/api/ingestors", "{", auth_headers

      expect(last_response.status).to eq(400)
    end

    it "rejects payloads missing version" do
      post "/api/ingestors", ingestor_payload(version: nil).to_json, auth_headers

      expect(last_response.status).to eq(400)
    end

    it "rejects non-object payloads" do
      post "/api/ingestors", [].to_json, auth_headers

      expect(last_response.status).to eq(400)
    end
  end

  describe "GET /api/ingestors" do
    it "returns recent ingestors and omits stale rows" do
      now = Time.now.to_i
      with_db do |db|
        db.execute(
          "INSERT INTO ingestors(node_id, start_time, last_seen_time, version) VALUES(?,?,?,?)",
          ["!fresh000", now - 100, now - 10, "0.5.10"],
        )
        db.execute(
          "INSERT INTO ingestors(node_id, start_time, last_seen_time, version) VALUES(?,?,?,?)",
          ["!stale000", now - (9 * 24 * 60 * 60), now - (9 * 24 * 60 * 60), "0.5.6"],
        )
        db.execute(
          "INSERT INTO ingestors(node_id, start_time, last_seen_time, version, lora_freq, modem_preset) VALUES(?,?,?,?,?,?)",
          ["!rich000", now - 200, now - 100, "0.5.10", 915, "MediumFast"],
        )
      end

      get "/api/ingestors"

      expect(last_response.status).to eq(200)
      payload = JSON.parse(last_response.body)
      expect(payload).to all(include("node_id", "start_time", "last_seen_time", "version"))
      node_ids = payload.map { |entry| entry["node_id"] }
      expect(node_ids).to include("!fresh000")
      expect(node_ids).not_to include("!stale000")
      rich = payload.find { |row| row["node_id"] == "!rich000" }
      expect(rich["lora_freq"]).to eq(915)
      expect(rich["modem_preset"]).to eq("MediumFast")
      expect(rich["start_time_iso"]).to be_a(String)
      expect(rich["last_seen_iso"]).to be_a(String)
    end

    it "filters ingestors using the since parameter" do
      frozen_time = Time.at(1_700_000_000)
      allow(Time).to receive(:now).and_return(frozen_time)
      now = frozen_time.to_i
      recent_cutoff = now - 120

      with_db do |db|
        db.execute(
          "INSERT INTO ingestors(node_id, start_time, last_seen_time, version) VALUES(?,?,?,?)",
          ["!old-ingestor", now - 600, now - 300, "0.5.5"],
        )
        db.execute(
          "INSERT INTO ingestors(node_id, start_time, last_seen_time, version) VALUES(?,?,?,?)",
          ["!new-ingestor", now - 60, now - 30, "0.5.10"],
        )
      end

      get "/api/ingestors?since=#{recent_cutoff}"

      expect(last_response).to be_ok
      payload = JSON.parse(last_response.body)
      expect(payload.map { |entry| entry["node_id"] }).to eq(["!new-ingestor"])
    end
  end

  describe "schema migrations" do
    it "creates the ingestors table with frequency and modem columns" do
      tmp_db = File.join(SPEC_TMPDIR, "ingestor-migrate.db")
      FileUtils.rm_f(tmp_db)
      original = PotatoMesh::Config.db_path
      allow(PotatoMesh::Config).to receive(:db_path).and_return(tmp_db)

      begin
        PotatoMesh::Application.init_db
        with_db(readonly: true) do |db|
          columns = db.execute("PRAGMA table_info(ingestors)").map { |row| row[1] }
          expect(columns).to include("lora_freq", "modem_preset", "version")
        end
      ensure
        allow(PotatoMesh::Config).to receive(:db_path).and_return(original)
      end
    end
  end
end
