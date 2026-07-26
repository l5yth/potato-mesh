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

# Web-side coverage for the per-heartbeat activity time-series (SPEC MA3) and
# the additive +packets+ delta on the ingestor heartbeat (MA2). A heartbeat
# carrying a non-negative integer +packets+ appends exactly one append-only
# +ingestor_activity+ row; anything else records nothing.
RSpec.describe "Ingestor activity time-series (MA3)" do
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
    clear_tables
  end

  after do
    ENV["API_TOKEN"] = @original_token
    clear_tables
  end

  def clear_tables
    with_db do |db|
      db.execute("DELETE FROM ingestor_activity")
      db.execute("DELETE FROM ingestors")
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

  def post_heartbeat(overrides = {})
    now = Time.now.to_i
    payload = {
      node_id: "!abc12345",
      start_time: now - 3600,
      last_seen_time: now - 60,
      version: "0.6.0",
      protocol: "meshtastic",
    }.merge(overrides)
    post "/api/ingestors", payload.to_json, auth_headers
  end

  def activity_rows
    with_db(readonly: true) do |db|
      db.execute(
        "SELECT ingestor_id, at, packets, protocol FROM ingestor_activity ORDER BY id",
      )
    end
  end

  describe "POST /api/ingestors" do
    it "records ingestor activity for a heartbeat carrying packets" do
      now = Time.now.to_i
      post_heartbeat(last_seen_time: now - 60, packets: 42, protocol: "meshcore")
      expect(last_response.status).to eq(201)

      rows = activity_rows
      expect(rows.length).to eq(1)
      ingestor_id, at, packets, protocol = rows.first
      expect(ingestor_id).to eq("!abc12345")
      expect(at).to eq(now - 60)
      expect(packets).to eq(42)
      expect(protocol).to eq("meshcore")
    end

    it "records ingestor activity of zero for an idle heartbeat" do
      post_heartbeat(packets: 0)
      expect(last_response.status).to eq(201)
      rows = activity_rows
      expect(rows.length).to eq(1)
      expect(rows.first[2]).to eq(0)
    end

    it "records ingestor activity independently per ingestor" do
      post_heartbeat(node_id: "!abc12345", packets: 10)
      post_heartbeat(node_id: "!def67890", packets: 25)
      expect(activity_rows.map { |r| [r[0], r[2]] }).to contain_exactly(
        ["!abc12345", 10],
        ["!def67890", 25],
      )
    end

    it "appends a fresh activity row on every heartbeat (append-only)" do
      post_heartbeat(node_id: "!abc12345", packets: 3)
      post_heartbeat(node_id: "!abc12345", packets: 4)
      expect(activity_rows.map { |r| r[2] }).to eq([3, 4])
    end

    it "records no activity when packets is absent (older ingestor)" do
      post_heartbeat
      expect(last_response.status).to eq(201)
      expect(activity_rows).to be_empty
    end

    it "records no activity when packets is negative or non-numeric" do
      post_heartbeat(node_id: "!abc12345", packets: -5)
      post_heartbeat(node_id: "!def67890", packets: "abc")
      expect(activity_rows).to be_empty
    end

    it "still records the heartbeat when the activity insert fails" do
      # Force the supplementary activity INSERT to raise by removing its table,
      # then prove the liveness heartbeat still returns 201 (graceful
      # degradation). The table is restored so the surrounding suite is
      # unaffected.
      with_db { |db| db.execute("ALTER TABLE ingestor_activity RENAME TO ingestor_activity_bak") }
      begin
        post_heartbeat(packets: 99)
        expect(last_response.status).to eq(201)
      ensure
        with_db do |db|
          db.execute("ALTER TABLE ingestor_activity_bak RENAME TO ingestor_activity")
        end
      end
      expect(activity_rows).to be_empty
    end
  end
end
