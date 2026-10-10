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
require "tmpdir"
require_relative "support/data_processing_harness"

# MeshCore message flood scope (SPEC SC4-SC6, SC8; ACCEPTANCE SC-A4/SC-A5):
# the additive `messages.scope` column round-trips through the authenticated
# POST ingest route and the GET collection, invalid values store NULL without
# failing the request, and a later copy of a message fills a NULL scope but
# never overwrites one while the first ingestor keeps hops/path/snr/rssi.
RSpec.describe "MeshCore message scope" do
  let(:app) { Sinatra::Application }
  let(:api_token) { "spec-token" }
  let(:auth_headers) do
    {
      "CONTENT_TYPE" => "application/json",
      "HTTP_AUTHORIZATION" => "Bearer #{api_token}",
    }
  end

  # Build a minimal MeshCore channel-message payload the ingest route accepts.
  #
  # @param overrides [Hash] extra/overriding message fields.
  # @return [Hash] POST /api/messages payload.
  def scope_message(overrides = {})
    now = Time.now.to_i
    {
      "id" => 765_001,
      "rx_time" => now,
      "rx_iso" => Time.at(now).utc.iso8601,
      "from_id" => "!aabbccdd",
      "to_id" => "^all",
      "channel" => 0,
      "channel_name" => "#test",
      "portnum" => "TEXT_MESSAGE_APP",
      "text" => "Alice: scope probe",
      "protocol" => "meshcore",
      "hops" => 3,
    }.merge(overrides)
  end

  describe "message scope over the API" do
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

    before do
      @original_token = ENV["API_TOKEN"]
      @original_private = ENV["PRIVATE"]
      ENV["API_TOKEN"] = api_token
      ENV.delete("PRIVATE")
      with_db do |db|
        db.execute("DELETE FROM messages")
        db.execute("DELETE FROM nodes")
      end
      PotatoMesh::App::ApiCache.invalidate_all
    end

    after do
      @original_token.nil? ? ENV.delete("API_TOKEN") : ENV["API_TOKEN"] = @original_token
      @original_private.nil? ? ENV.delete("PRIVATE") : ENV["PRIVATE"] = @original_private
      PotatoMesh::App::ApiCache.invalidate_all
    end

    # POST one message and return its row from GET /api/messages.
    #
    # @param payload [Hash] message payload.
    # @return [Hash, nil] the served row.
    def round_trip(payload)
      post "/api/messages", payload.to_json, auth_headers
      expect(last_response.status).to eq(201)
      get "/api/messages"
      expect(last_response).to be_ok
      JSON.parse(last_response.body).find { |m| m["id"] == payload["id"] }
    end

    it "stores a resolved region name and serves it with the route fields" do
      row = round_trip(scope_message("scope" => "de-be", "path" => "f0bf44", "rssi" => -96, "snr" => 10.0))
      expect(row).to include("scope" => "de-be", "path" => "f0bf44", "rssi" => -96, "hops" => 3)
    end

    # Distinct texts keep the MeshCore content dedup from folding the
    # messages of one example into a single row.
    it "stores the unscoped and the reserved unknown values" do
      expect(round_trip(scope_message("id" => 765_002, "text" => "Alice: plain", "scope" => "*"))["scope"]).to eq("*")
      expect(round_trip(scope_message("id" => 765_003, "text" => "Alice: scoped", "scope" => "?"))["scope"]).to eq("?")
    end

    it "accepts up to 30 bytes, multibyte characters included" do
      expect(round_trip(scope_message("id" => 765_004, "text" => "Alice: ascii", "scope" => "a" * 30))["scope"]).to eq("a" * 30)
      expect(round_trip(scope_message("id" => 765_005, "text" => "Alice: umlaut", "scope" => "ü" * 15))["scope"]).to eq("ü" * 15)
    end

    [
      ["an empty string", ""],
      ["31 bytes", "a" * 31],
      ["31 bytes of multibyte text", "#{"ü" * 15}a"],
      ["a control character", "de\nbe"],
      ["a NUL byte", "de\u0000"],
      ["a number", 42],
      ["a list", ["*"]],
      ["an object", { "name" => "de" }],
    ].each_with_index do |(label, value), index|
      it "stores NULL for #{label} and still answers 201" do
        row = round_trip(scope_message("id" => 765_100 + index, "scope" => value))
        expect(row).not_to be_nil
        expect(row).not_to have_key("scope")
        expect(row["text"]).to eq("Alice: scope probe")
      end
    end

    it "omits scope for a legacy message without the field" do
      row = round_trip(scope_message("id" => 765_006))
      expect(row).not_to have_key("scope")
    end

    it "keeps GET /api/messages at 404 in private mode" do
      post "/api/messages", scope_message("id" => 765_007, "scope" => "de-be").to_json, auth_headers
      ENV["PRIVATE"] = "1"
      get "/api/messages"
      expect(last_response.status).to eq(404)
    end
  end

  describe "merging copies of one message" do
    include_context "with isolated db"

    let(:dp) { DataProcessingHarness.build(protocol: "meshcore", stub_chat_nodes: true).new }

    # Read the stored route fields of one message.
    #
    # @param db [SQLite3::Database] open database handle.
    # @param id [Integer] message id.
    # @return [Hash] the stored values.
    def stored_route(db, id)
      db.get_first_row("SELECT hops, path, snr, rssi, scope, ingestor FROM messages WHERE id = ?", [id])
    end

    it "fills a NULL scope from a later copy" do
      db = open_db
      dp.insert_message(db, scope_message("ingestor" => "!11111111"))
      dp.insert_message(db, scope_message("ingestor" => "!22222222", "scope" => "de-be"))
      expect(stored_route(db, 765_001)["scope"]).to eq("de-be")
    ensure
      db&.close
    end

    it "never overwrites a stored unscoped value" do
      db = open_db
      dp.insert_message(db, scope_message("ingestor" => "!11111111", "scope" => "*"))
      dp.insert_message(db, scope_message("ingestor" => "!22222222", "scope" => "de-be"))
      expect(stored_route(db, 765_001)["scope"]).to eq("*")
    ensure
      db&.close
    end

    it "keeps hops, path, snr and rssi from the first ingestor" do
      db = open_db
      dp.insert_message(db, scope_message(
        "ingestor" => "!11111111", "hops" => 3, "path" => "f0bf44", "snr" => 10.0, "rssi" => -96,
      ))
      dp.insert_message(db, scope_message(
        "ingestor" => "!22222222", "hops" => 5, "path" => "a1b2c3d4e5", "snr" => 1.0, "rssi" => -120, "scope" => "*",
      ))
      expect(stored_route(db, 765_001)).to eq(
        "hops" => 3, "path" => "f0bf44", "snr" => 10.0, "rssi" => -96, "scope" => "*", "ingestor" => "!11111111",
      )
    ensure
      db&.close
    end

    it "fills the scope of a content-deduplicated copy carrying another id" do
      db = open_db
      dp.insert_message(db, scope_message("ingestor" => "!11111111"))
      dp.insert_message(db, scope_message("id" => 765_009, "ingestor" => "!22222222", "scope" => "de-be"))
      expect(db.get_first_value("SELECT COUNT(*) FROM messages")).to eq(1)
      expect(stored_route(db, 765_001)["scope"]).to eq("de-be")
    ensure
      db&.close
    end

    it "fills a NULL scope on the INSERT-race path" do
      db = open_db
      dp.insert_message(db, scope_message("ingestor" => "!11111111"))
      hide_stored_message_once(db)
      dp.insert_message(db, scope_message("ingestor" => "!22222222", "scope" => "de-be"))
      expect(db.get_first_value("SELECT scope FROM messages WHERE id = 765001")).to eq("de-be")
    ensure
      db&.close
    end

    it "merges the same way over a connection that returns rows as arrays" do
      db = SQLite3::Database.new(PotatoMesh::Config.db_path)
      dp.insert_message(db, scope_message("ingestor" => "!11111111"))
      dp.insert_message(db, scope_message("ingestor" => "!22222222", "scope" => "de-be"))
      dp.insert_message(db, scope_message("ingestor" => "!33333333", "scope" => "*"))
      expect(db.get_first_value("SELECT scope FROM messages WHERE id = 765001")).to eq("de-be")
    ensure
      db&.close
    end

    it "tolerates a row that vanished during the INSERT race" do
      db = open_db
      dp.insert_message(db, scope_message("ingestor" => "!11111111"))
      allow(db).to receive(:get_first_row).and_return(nil)
      expect { dp.insert_message(db, scope_message("ingestor" => "!22222222", "scope" => "de-be")) }.not_to raise_error
    ensure
      db&.close
    end

    it "never overwrites a stored name on the INSERT-race path" do
      db = open_db
      dp.insert_message(db, scope_message("ingestor" => "!11111111", "scope" => "de-be"))
      hide_stored_message_once(db)
      dp.insert_message(db, scope_message("ingestor" => "!22222222", "scope" => "eu"))
      expect(db.get_first_value("SELECT scope FROM messages WHERE id = 765001")).to eq("de-be")
    ensure
      db&.close
    end

    # Store copies of one message in arrival order, one ingestor each, and
    # return the scope that survives.
    #
    # @param db [SQLite3::Database] open database handle.
    # @param id [Integer] message id shared by the copies.
    # @param scopes [Array<String, nil>] scope of each copy.
    # @return [String, nil] the stored scope.
    def merged_scope(db, id, *scopes)
      scopes.each_with_index do |scope, index|
        dp.insert_message(db, scope_message(
          "id" => id, "text" => "Alice: merge #{id}", "ingestor" => format("!%08x", index + 1), "scope" => scope,
        ))
      end
      db.get_first_value("SELECT scope FROM messages WHERE id = ?", [id])
    end

    it "lets a later resolved name replace a stored ?, and nothing else replace a stored scope" do
      db = open_db
      expect(merged_scope(db, 765_201, "?", "de-be")).to eq("de-be")
      expect(merged_scope(db, 765_202, nil, "?", "de-be")).to eq("de-be")
      expect(merged_scope(db, 765_203, "?", "*", "?")).to eq("?")
      expect(merged_scope(db, 765_204, "*", "de-be", "?")).to eq("*")
      expect(merged_scope(db, 765_205, "de-be", "eu", "*", "?")).to eq("de-be")
    ensure
      db&.close
    end

    it "lets a later resolved name replace a stored ? on the INSERT-race path" do
      db = open_db
      dp.insert_message(db, scope_message("id" => 765_301, "text" => "Alice: race unknown", "scope" => "?"))
      dp.insert_message(db, scope_message("id" => 765_302, "text" => "Alice: race plain", "scope" => "*"))
      hide_stored_message_once(db)
      dp.insert_message(db, scope_message("id" => 765_301, "text" => "Alice: race unknown", "scope" => "de-be"))
      dp.insert_message(db, scope_message("id" => 765_302, "text" => "Alice: race plain", "scope" => "de-be"))
      expect(db.get_first_value("SELECT scope FROM messages WHERE id = 765301")).to eq("de-be")
      expect(db.get_first_value("SELECT scope FROM messages WHERE id = 765302")).to eq("*")
    ensure
      db&.close
    end

    [
      [nil, nil, false], [nil, "*", true], [nil, "?", true], [nil, "de-be", true],
      ["?", nil, false], ["?", "?", false], ["?", "*", false], ["?", "de-be", true],
      ["*", "?", false], ["*", "de-be", false],
      ["de-be", "?", false], ["de-be", "*", false], ["de-be", "eu", false],
    ].each do |stored, incoming, expected|
      it "#{expected ? "writes" : "keeps"} #{incoming.inspect} over a stored #{stored.inspect}" do
        expect(dp.message_scope_supersedes?(stored, incoming)).to be(expected)
      end
    end
  end

  describe "schema" do
    it "creates messages.scope on a fresh database" do
      schema = File.read(File.expand_path("../../data/messages.sql", __dir__))
      expect(schema).to match(/^\s+scope\s+TEXT,$/)
    end

    it "adds messages.scope to an existing database at boot" do
      Dir.mktmpdir("scope-upgrade-") do |dir|
        db_path = File.join(dir, "mesh.db")
        allow(PotatoMesh::Config).to receive(:db_path).and_return(db_path)
        SQLite3::Database.new(db_path) do |db|
          db.execute("CREATE TABLE nodes(node_id TEXT)")
          db.execute("CREATE TABLE messages(id INTEGER PRIMARY KEY, rx_time INTEGER, rx_iso TEXT, path TEXT)")
          db.execute("INSERT INTO messages(id, rx_time, rx_iso) VALUES (1, 0, 'x')")
        end

        helper = Object.new.extend(PotatoMesh::App::Database)
        helper.define_singleton_method(:warn_log) { |*_args, **_kwargs| nil }
        helper.define_singleton_method(:debug_log) { |*_args, **_kwargs| nil }
        helper.ensure_schema_upgrades

        SQLite3::Database.new(db_path) do |db|
          columns = db.execute("PRAGMA table_info(messages)").map { |row| row[1] }
          expect(columns).to include("scope")
          expect(db.get_first_value("SELECT scope FROM messages WHERE id = 1")).to be_nil
        end
      end
    end
  end
end
