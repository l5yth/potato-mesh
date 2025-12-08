# Copyright © 2025-26 l5yth, apo-mak & contributors
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

RSpec.describe PotatoMesh::App::Ingestors do
  let(:harness_class) do
    Class.new do
      extend PotatoMesh::App::Database
      extend PotatoMesh::App::Ingestors
      extend PotatoMesh::App::Helpers
    end
  end

  around do |example|
    Dir.mktmpdir("ingestors-spec-") do |dir|
      db_path = File.join(dir, "mesh.db")

      RSpec::Mocks.with_temporary_scope do
        allow(PotatoMesh::Config).to receive(:db_path).and_return(db_path)
        allow(PotatoMesh::Config).to receive(:default_db_path).and_return(db_path)
        allow(PotatoMesh::Config).to receive(:legacy_db_path).and_return(db_path)

        FileUtils.mkdir_p(File.dirname(db_path))
        harness_class.init_db

        example.run
      end
    end
  end

  def open_db(readonly: false)
    db = SQLite3::Database.new(PotatoMesh::Config.db_path, readonly: readonly)
    db.busy_timeout = PotatoMesh::Config.db_busy_timeout_ms
    db.execute("PRAGMA foreign_keys = ON")
    db
  end

  describe ".generate_ingestor_api_key" do
    it "generates a UUID format string" do
      key = harness_class.generate_ingestor_api_key
      expect(key).to match(/\A[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\z/)
    end

    it "generates unique keys" do
      keys = 10.times.map { harness_class.generate_ingestor_api_key }
      expect(keys.uniq.size).to eq(10)
    end
  end

  describe ".generate_ingestor_id" do
    it "generates a UUID format string" do
      id = harness_class.generate_ingestor_id
      expect(id).to match(/\A[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\z/)
    end
  end

  describe ".create_ingestor" do
    it "creates an ingestor with all provided fields" do
      db = open_db
      begin
        ingestor = harness_class.create_ingestor(
          db,
          name: "Test Ingestor",
          node_id: "!abc123",
          contact_email: "test@example.com",
          contact_matrix: "@test:matrix.org",
        )

        expect(ingestor["id"]).to be_a(String)
        expect(ingestor["api_key"]).to be_a(String)
        expect(ingestor["name"]).to eq("Test Ingestor")
        expect(ingestor["node_id"]).to eq("!abc123")
        expect(ingestor["contact_email"]).to eq("test@example.com")
        expect(ingestor["contact_matrix"]).to eq("@test:matrix.org")
        expect(ingestor["is_active"]).to be(true)
        expect(ingestor["created_at"]).to be_a(Integer)
        expect(ingestor["request_count"]).to eq(0)
      ensure
        db&.close
      end
    end

    it "creates an ingestor with minimal fields" do
      db = open_db
      begin
        ingestor = harness_class.create_ingestor(db)

        expect(ingestor["id"]).to be_a(String)
        expect(ingestor["api_key"]).to be_a(String)
        expect(ingestor["name"]).to be_nil
        expect(ingestor["node_id"]).to be_nil
        expect(ingestor["is_active"]).to be(true)
      ensure
        db&.close
      end
    end

    it "persists the ingestor to the database" do
      db = open_db
      begin
        ingestor = harness_class.create_ingestor(db, name: "Persisted")
        row = db.execute("SELECT name FROM ingestors WHERE id = ?", [ingestor["id"]]).first

        expect(row[0]).to eq("Persisted")
      ensure
        db&.close
      end
    end
  end

  describe ".find_ingestor_by_api_key" do
    it "returns the ingestor when found" do
      db = open_db
      begin
        created = harness_class.create_ingestor(db, name: "Find Test")
        found = harness_class.find_ingestor_by_api_key(db, created["api_key"])

        expect(found["id"]).to eq(created["id"])
        expect(found["name"]).to eq("Find Test")
      ensure
        db&.close
      end
    end

    it "returns nil for inactive ingestors" do
      db = open_db
      begin
        created = harness_class.create_ingestor(db, name: "Inactive Test")
        harness_class.deactivate_ingestor(db, created["id"])
        found = harness_class.find_ingestor_by_api_key(db, created["api_key"])

        expect(found).to be_nil
      ensure
        db&.close
      end
    end

    it "returns nil for unknown keys" do
      db = open_db
      begin
        found = harness_class.find_ingestor_by_api_key(db, "unknown-key")
        expect(found).to be_nil
      ensure
        db&.close
      end
    end

    it "returns nil for nil or empty keys" do
      db = open_db
      begin
        expect(harness_class.find_ingestor_by_api_key(db, nil)).to be_nil
        expect(harness_class.find_ingestor_by_api_key(db, "")).to be_nil
      ensure
        db&.close
      end
    end
  end

  describe ".find_ingestor_by_id" do
    it "returns the ingestor when found" do
      db = open_db
      begin
        created = harness_class.create_ingestor(db, name: "Find By ID")
        found = harness_class.find_ingestor_by_id(db, created["id"])

        expect(found["api_key"]).to eq(created["api_key"])
        expect(found["name"]).to eq("Find By ID")
      ensure
        db&.close
      end
    end

    it "returns inactive ingestors" do
      db = open_db
      begin
        created = harness_class.create_ingestor(db, name: "Inactive")
        harness_class.deactivate_ingestor(db, created["id"])
        found = harness_class.find_ingestor_by_id(db, created["id"])

        expect(found).not_to be_nil
        expect(found["is_active"]).to be(false)
      ensure
        db&.close
      end
    end

    it "returns nil for unknown IDs" do
      db = open_db
      begin
        found = harness_class.find_ingestor_by_id(db, "unknown-id")
        expect(found).to be_nil
      ensure
        db&.close
      end
    end

    it "returns nil for nil or empty ID" do
      db = open_db
      begin
        expect(harness_class.find_ingestor_by_id(db, nil)).to be_nil
        expect(harness_class.find_ingestor_by_id(db, "")).to be_nil
      ensure
        db&.close
      end
    end
  end

  describe ".list_ingestors" do
    it "returns all active ingestors" do
      db = open_db
      begin
        harness_class.create_ingestor(db, name: "Active 1")
        harness_class.create_ingestor(db, name: "Active 2")
        inactive = harness_class.create_ingestor(db, name: "Inactive")
        harness_class.deactivate_ingestor(db, inactive["id"])

        list = harness_class.list_ingestors(db)

        expect(list.size).to eq(2)
        expect(list.map { |i| i["name"] }).to contain_exactly("Active 1", "Active 2")
      ensure
        db&.close
      end
    end

    it "includes inactive when requested" do
      db = open_db
      begin
        harness_class.create_ingestor(db, name: "Active")
        inactive = harness_class.create_ingestor(db, name: "Inactive")
        harness_class.deactivate_ingestor(db, inactive["id"])

        list = harness_class.list_ingestors(db, include_inactive: true)

        expect(list.size).to eq(2)
      ensure
        db&.close
      end
    end

    it "returns ingestors ordered by created_at DESC" do
      db = open_db
      begin
        # Create first ingestor with an older timestamp
        first = harness_class.create_ingestor(db, name: "First")
        # Manually update created_at to ensure ordering (since integer seconds)
        db.execute(
          "UPDATE ingestors SET created_at = ? WHERE id = ?",
          [Time.now.to_i - 10, first["id"]],
        )
        second = harness_class.create_ingestor(db, name: "Second")

        list = harness_class.list_ingestors(db)

        expect(list.first["name"]).to eq("Second")
        expect(list.last["name"]).to eq("First")
      ensure
        db&.close
      end
    end
  end

  describe ".record_ingestor_request" do
    it "updates last_request_time and increments request_count" do
      db = open_db
      begin
        created = harness_class.create_ingestor(db, name: "Request Test")

        before_time = Time.now.to_i
        harness_class.record_ingestor_request(db, created["api_key"])
        after_time = Time.now.to_i

        updated = harness_class.find_ingestor_by_id(db, created["id"])

        expect(updated["last_request_time"]).to be >= before_time
        expect(updated["last_request_time"]).to be <= after_time
        expect(updated["request_count"]).to eq(1)
      ensure
        db&.close
      end
    end

    it "updates version when provided" do
      db = open_db
      begin
        created = harness_class.create_ingestor(db, name: "Version Test")
        harness_class.record_ingestor_request(db, created["api_key"], version: "1.2.3")

        updated = harness_class.find_ingestor_by_id(db, created["id"])

        expect(updated["version"]).to eq("1.2.3")
      ensure
        db&.close
      end
    end

    it "does nothing for nil or empty keys" do
      db = open_db
      begin
        expect { harness_class.record_ingestor_request(db, nil) }.not_to raise_error
        expect { harness_class.record_ingestor_request(db, "") }.not_to raise_error
      ensure
        db&.close
      end
    end
  end

  describe ".update_ingestor" do
    it "updates specified fields" do
      db = open_db
      begin
        created = harness_class.create_ingestor(db, name: "Original")
        success = harness_class.update_ingestor(
          db,
          created["id"],
          name: "Updated",
          node_id: "!newnode",
        )

        expect(success).to be(true)

        updated = harness_class.find_ingestor_by_id(db, created["id"])
        expect(updated["name"]).to eq("Updated")
        expect(updated["node_id"]).to eq("!newnode")
      ensure
        db&.close
      end
    end

    it "returns false when no fields provided" do
      db = open_db
      begin
        created = harness_class.create_ingestor(db, name: "Test")
        success = harness_class.update_ingestor(db, created["id"])

        expect(success).to be(false)
      ensure
        db&.close
      end
    end

    it "returns false for unknown IDs" do
      db = open_db
      begin
        success = harness_class.update_ingestor(db, "unknown", name: "Test")
        expect(success).to be(false)
      ensure
        db&.close
      end
    end

    it "returns false for nil or empty ID" do
      db = open_db
      begin
        expect(harness_class.update_ingestor(db, nil, name: "Test")).to be(false)
        expect(harness_class.update_ingestor(db, "", name: "Test")).to be(false)
      ensure
        db&.close
      end
    end
  end

  describe ".regenerate_ingestor_api_key" do
    it "generates a new API key" do
      db = open_db
      begin
        created = harness_class.create_ingestor(db, name: "Regen Test")
        original_key = created["api_key"]

        new_key = harness_class.regenerate_ingestor_api_key(db, created["id"])

        expect(new_key).not_to eq(original_key)
        expect(new_key).to match(/\A[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\z/)

        # Verify old key no longer works
        found_with_old = harness_class.find_ingestor_by_api_key(db, original_key)
        expect(found_with_old).to be_nil

        # Verify new key works
        found_with_new = harness_class.find_ingestor_by_api_key(db, new_key)
        expect(found_with_new["id"]).to eq(created["id"])
      ensure
        db&.close
      end
    end

    it "returns nil for unknown IDs" do
      db = open_db
      begin
        result = harness_class.regenerate_ingestor_api_key(db, "unknown")
        expect(result).to be_nil
      ensure
        db&.close
      end
    end

    it "returns nil for nil or empty ID" do
      db = open_db
      begin
        expect(harness_class.regenerate_ingestor_api_key(db, nil)).to be_nil
        expect(harness_class.regenerate_ingestor_api_key(db, "")).to be_nil
      ensure
        db&.close
      end
    end
  end

  describe ".deactivate_ingestor" do
    it "sets is_active to false" do
      db = open_db
      begin
        created = harness_class.create_ingestor(db, name: "Deactivate Test")
        success = harness_class.deactivate_ingestor(db, created["id"])

        expect(success).to be(true)

        updated = harness_class.find_ingestor_by_id(db, created["id"])
        expect(updated["is_active"]).to be(false)
      ensure
        db&.close
      end
    end

    it "returns false for unknown IDs" do
      db = open_db
      begin
        success = harness_class.deactivate_ingestor(db, "unknown")
        expect(success).to be(false)
      ensure
        db&.close
      end
    end

    it "returns false for nil or empty ID" do
      db = open_db
      begin
        expect(harness_class.deactivate_ingestor(db, nil)).to be(false)
        expect(harness_class.deactivate_ingestor(db, "")).to be(false)
      ensure
        db&.close
      end
    end
  end

  describe ".reactivate_ingestor" do
    it "sets is_active to true" do
      db = open_db
      begin
        created = harness_class.create_ingestor(db, name: "Reactivate Test")
        harness_class.deactivate_ingestor(db, created["id"])
        success = harness_class.reactivate_ingestor(db, created["id"])

        expect(success).to be(true)

        updated = harness_class.find_ingestor_by_id(db, created["id"])
        expect(updated["is_active"]).to be(true)
      ensure
        db&.close
      end
    end

    it "returns false for unknown IDs" do
      db = open_db
      begin
        success = harness_class.reactivate_ingestor(db, "unknown")
        expect(success).to be(false)
      ensure
        db&.close
      end
    end

    it "returns false for nil or empty ID" do
      db = open_db
      begin
        expect(harness_class.reactivate_ingestor(db, nil)).to be(false)
        expect(harness_class.reactivate_ingestor(db, "")).to be(false)
      ensure
        db&.close
      end
    end
  end

  describe ".delete_ingestor" do
    it "permanently removes the ingestor" do
      db = open_db
      begin
        created = harness_class.create_ingestor(db, name: "Delete Test")
        success = harness_class.delete_ingestor(db, created["id"])

        expect(success).to be(true)

        found = harness_class.find_ingestor_by_id(db, created["id"])
        expect(found).to be_nil
      ensure
        db&.close
      end
    end

    it "returns false for unknown IDs" do
      db = open_db
      begin
        success = harness_class.delete_ingestor(db, "unknown")
        expect(success).to be(false)
      ensure
        db&.close
      end
    end

    it "returns false for nil or empty ID" do
      db = open_db
      begin
        expect(harness_class.delete_ingestor(db, nil)).to be(false)
        expect(harness_class.delete_ingestor(db, "")).to be(false)
      ensure
        db&.close
      end
    end
  end

  describe ".validate_ingestor_token" do
    it "returns ingestor for valid active token" do
      db = open_db
      begin
        created = harness_class.create_ingestor(db, name: "Validate Test")
        result = harness_class.validate_ingestor_token(db, created["api_key"])

        expect(result).not_to be_nil
        expect(result["id"]).to eq(created["id"])
      ensure
        db&.close
      end
    end

    it "returns nil for inactive ingestor" do
      db = open_db
      begin
        created = harness_class.create_ingestor(db, name: "Inactive")
        harness_class.deactivate_ingestor(db, created["id"])
        result = harness_class.validate_ingestor_token(db, created["api_key"])

        expect(result).to be_nil
      ensure
        db&.close
      end
    end

    it "returns nil for invalid tokens" do
      db = open_db
      begin
        result = harness_class.validate_ingestor_token(db, "invalid-token")
        expect(result).to be_nil
      ensure
        db&.close
      end
    end

    it "returns nil for nil or empty token" do
      db = open_db
      begin
        expect(harness_class.validate_ingestor_token(db, nil)).to be_nil
        expect(harness_class.validate_ingestor_token(db, "")).to be_nil
      ensure
        db&.close
      end
    end
  end
end

RSpec.describe PotatoMesh::App::Helpers do
  describe ".mask_api_key" do
    let(:helper_class) do
      Class.new do
        extend PotatoMesh::App::Helpers
      end
    end

    it "masks the middle segments of a UUID key" do
      masked = helper_class.mask_api_key("a1b2c3d4-e5f6-7890-abcd-ef1234567890")
      expect(masked).to eq("a1b2c3d4-****-****-****-ef1234567890")
    end

    it "returns nil for nil input" do
      expect(helper_class.mask_api_key(nil)).to be_nil
    end

    it "returns nil for empty string" do
      expect(helper_class.mask_api_key("")).to be_nil
    end

    it "returns **** for keys without hyphens" do
      expect(helper_class.mask_api_key("simplekey")).to eq("****")
    end
  end
end

RSpec.describe PotatoMesh::Config do
  describe ".ingestor_management_enabled?" do
    around do |example|
      original = ENV["INGESTOR_MANAGEMENT"]
      begin
        example.run
      ensure
        if original
          ENV["INGESTOR_MANAGEMENT"] = original
        else
          ENV.delete("INGESTOR_MANAGEMENT")
        end
      end
    end

    it "returns false by default" do
      ENV.delete("INGESTOR_MANAGEMENT")
      expect(PotatoMesh::Config.ingestor_management_enabled?).to be(false)
    end

    it "returns true when set to 1" do
      ENV["INGESTOR_MANAGEMENT"] = "1"
      expect(PotatoMesh::Config.ingestor_management_enabled?).to be(true)
    end

    it "returns false for other values" do
      ENV["INGESTOR_MANAGEMENT"] = "0"
      expect(PotatoMesh::Config.ingestor_management_enabled?).to be(false)

      ENV["INGESTOR_MANAGEMENT"] = "true"
      expect(PotatoMesh::Config.ingestor_management_enabled?).to be(false)

      ENV["INGESTOR_MANAGEMENT"] = "yes"
      expect(PotatoMesh::Config.ingestor_management_enabled?).to be(false)
    end
  end

  describe ".admin_token" do
    around do |example|
      original = ENV["ADMIN_TOKEN"]
      begin
        example.run
      ensure
        if original
          ENV["ADMIN_TOKEN"] = original
        else
          ENV.delete("ADMIN_TOKEN")
        end
      end
    end

    it "returns nil when not set" do
      ENV.delete("ADMIN_TOKEN")
      expect(PotatoMesh::Config.admin_token).to be_nil
    end

    it "returns the token when set" do
      ENV["ADMIN_TOKEN"] = "my-secret-token"
      expect(PotatoMesh::Config.admin_token).to eq("my-secret-token")
    end

    it "returns nil for empty string" do
      ENV["ADMIN_TOKEN"] = ""
      expect(PotatoMesh::Config.admin_token).to be_nil
    end
  end
end

RSpec.describe "Admin Ingestor Routes" do
  include Rack::Test::Methods

  let(:app) { Sinatra::Application }
  let(:admin_token) { "test-admin-token" }
  let(:admin_headers) do
    {
      "CONTENT_TYPE" => "application/json",
      "HTTP_AUTHORIZATION" => "Bearer #{admin_token}",
    }
  end

  around do |example|
    Dir.mktmpdir("admin-routes-spec-") do |dir|
      db_path = File.join(dir, "mesh.db")

      RSpec::Mocks.with_temporary_scope do
        allow(PotatoMesh::Config).to receive(:db_path).and_return(db_path)
        allow(PotatoMesh::Config).to receive(:default_db_path).and_return(db_path)
        allow(PotatoMesh::Config).to receive(:legacy_db_path).and_return(db_path)
        allow(PotatoMesh::Config).to receive(:ingestor_management_enabled?).and_return(true)
        allow(PotatoMesh::Config).to receive(:admin_token).and_return(admin_token)

        FileUtils.mkdir_p(File.dirname(db_path))
        PotatoMesh::Application.init_db

        example.run
      end
    end
  end

  def open_db(readonly: false)
    db = SQLite3::Database.new(PotatoMesh::Config.db_path, readonly: readonly)
    db.busy_timeout = PotatoMesh::Config.db_busy_timeout_ms
    db.execute("PRAGMA foreign_keys = ON")
    db
  end

  describe "GET /admin/ingestors" do
    it "returns 404 when ingestor management is disabled" do
      allow(PotatoMesh::Config).to receive(:ingestor_management_enabled?).and_return(false)
      get "/admin/ingestors", {}, admin_headers
      expect(last_response.status).to eq(404)
    end

    it "returns 403 without admin token" do
      get "/admin/ingestors", {}, { "CONTENT_TYPE" => "application/json" }
      expect(last_response.status).to eq(403)
    end

    it "returns 403 with invalid admin token" do
      headers = admin_headers.merge("HTTP_AUTHORIZATION" => "Bearer wrong-token")
      get "/admin/ingestors", {}, headers
      expect(last_response.status).to eq(403)
    end

    it "returns empty list when no ingestors exist" do
      get "/admin/ingestors", {}, admin_headers
      expect(last_response).to be_ok
      body = JSON.parse(last_response.body)
      expect(body["ingestors"]).to eq([])
    end

    it "returns ingestors with masked API keys" do
      db = open_db
      begin
        PotatoMesh::Application.create_ingestor(db, name: "Test Ingestor")
      ensure
        db&.close
      end

      get "/admin/ingestors", {}, admin_headers
      expect(last_response).to be_ok
      body = JSON.parse(last_response.body)
      expect(body["ingestors"].length).to eq(1)
      expect(body["ingestors"][0]["name"]).to eq("Test Ingestor")
      expect(body["ingestors"][0]["api_key"]).to include("****")
    end

    it "excludes inactive ingestors by default" do
      db = open_db
      begin
        ingestor = PotatoMesh::Application.create_ingestor(db, name: "Active")
        inactive = PotatoMesh::Application.create_ingestor(db, name: "Inactive")
        PotatoMesh::Application.deactivate_ingestor(db, inactive["id"])
      ensure
        db&.close
      end

      get "/admin/ingestors", {}, admin_headers
      body = JSON.parse(last_response.body)
      expect(body["ingestors"].length).to eq(1)
      expect(body["ingestors"][0]["name"]).to eq("Active")
    end

    it "includes inactive ingestors when requested" do
      db = open_db
      begin
        PotatoMesh::Application.create_ingestor(db, name: "Active")
        inactive = PotatoMesh::Application.create_ingestor(db, name: "Inactive")
        PotatoMesh::Application.deactivate_ingestor(db, inactive["id"])
      ensure
        db&.close
      end

      get "/admin/ingestors?include_inactive=1", {}, admin_headers
      body = JSON.parse(last_response.body)
      expect(body["ingestors"].length).to eq(2)
    end
  end

  describe "GET /admin/ingestors/:id" do
    it "returns 404 for unknown ID" do
      get "/admin/ingestors/unknown-id", {}, admin_headers
      expect(last_response.status).to eq(404)
    end

    it "returns ingestor details with masked API key" do
      db = open_db
      ingestor = nil
      begin
        ingestor = PotatoMesh::Application.create_ingestor(
          db,
          name: "Detail Test",
          node_id: "!abc123",
          contact_email: "test@example.com",
        )
      ensure
        db&.close
      end

      get "/admin/ingestors/#{ingestor["id"]}", {}, admin_headers
      expect(last_response).to be_ok
      body = JSON.parse(last_response.body)
      expect(body["name"]).to eq("Detail Test")
      expect(body["node_id"]).to eq("!abc123")
      expect(body["contact_email"]).to eq("test@example.com")
      expect(body["api_key"]).to include("****")
    end
  end

  describe "POST /admin/ingestors" do
    it "creates a new ingestor" do
      payload = {
        name: "New Ingestor",
        node_id: "!newnode",
        contact_email: "new@example.com",
        contact_matrix: "@new:matrix.org",
      }

      post "/admin/ingestors", payload.to_json, admin_headers
      expect(last_response.status).to eq(201)
      body = JSON.parse(last_response.body)
      expect(body["name"]).to eq("New Ingestor")
      expect(body["node_id"]).to eq("!newnode")
      expect(body["api_key"]).to match(/\A[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\z/)
    end

    it "creates ingestor with minimal fields" do
      post "/admin/ingestors", {}.to_json, admin_headers
      expect(last_response.status).to eq(201)
      body = JSON.parse(last_response.body)
      expect(body["id"]).to be_a(String)
      expect(body["api_key"]).to be_a(String)
    end

    it "returns 400 for invalid JSON" do
      post "/admin/ingestors", "not json", admin_headers
      expect(last_response.status).to eq(400)
    end
  end

  describe "PATCH /admin/ingestors/:id" do
    it "updates ingestor fields" do
      db = open_db
      ingestor = nil
      begin
        ingestor = PotatoMesh::Application.create_ingestor(db, name: "Original")
      ensure
        db&.close
      end

      payload = { name: "Updated Name", node_id: "!updated" }
      patch "/admin/ingestors/#{ingestor["id"]}", payload.to_json, admin_headers
      expect(last_response).to be_ok
      body = JSON.parse(last_response.body)
      expect(body["name"]).to eq("Updated Name")
      expect(body["node_id"]).to eq("!updated")
    end

    it "returns 404 for unknown ID" do
      patch "/admin/ingestors/unknown", { name: "Test" }.to_json, admin_headers
      expect(last_response.status).to eq(404)
    end

    it "returns 400 when no fields provided" do
      db = open_db
      ingestor = nil
      begin
        ingestor = PotatoMesh::Application.create_ingestor(db, name: "Test")
      ensure
        db&.close
      end

      patch "/admin/ingestors/#{ingestor["id"]}", {}.to_json, admin_headers
      expect(last_response.status).to eq(400)
    end

    it "returns 400 for invalid JSON" do
      db = open_db
      ingestor = nil
      begin
        ingestor = PotatoMesh::Application.create_ingestor(db, name: "Test")
      ensure
        db&.close
      end

      patch "/admin/ingestors/#{ingestor["id"]}", "not json", admin_headers
      expect(last_response.status).to eq(400)
    end
  end

  describe "POST /admin/ingestors/:id/regenerate-key" do
    it "generates a new API key" do
      db = open_db
      ingestor = nil
      begin
        ingestor = PotatoMesh::Application.create_ingestor(db, name: "Regen Test")
      ensure
        db&.close
      end

      original_key = ingestor["api_key"]
      post "/admin/ingestors/#{ingestor["id"]}/regenerate-key", {}.to_json, admin_headers
      expect(last_response).to be_ok
      body = JSON.parse(last_response.body)
      expect(body["api_key"]).not_to eq(original_key)
      expect(body["api_key"]).to match(/\A[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\z/)
    end

    it "returns 404 for unknown ID" do
      post "/admin/ingestors/unknown/regenerate-key", {}.to_json, admin_headers
      expect(last_response.status).to eq(404)
    end
  end

  describe "POST /admin/ingestors/:id/deactivate" do
    it "deactivates an ingestor" do
      db = open_db
      ingestor = nil
      begin
        ingestor = PotatoMesh::Application.create_ingestor(db, name: "Deactivate Test")
      ensure
        db&.close
      end

      post "/admin/ingestors/#{ingestor["id"]}/deactivate", {}.to_json, admin_headers
      expect(last_response).to be_ok
      body = JSON.parse(last_response.body)
      expect(body["status"]).to eq("deactivated")

      # Verify ingestor is now inactive
      db = open_db(readonly: true)
      begin
        found = PotatoMesh::Application.find_ingestor_by_id(db, ingestor["id"])
        expect(found["is_active"]).to be(false)
      ensure
        db&.close
      end
    end

    it "returns 404 for unknown ID" do
      post "/admin/ingestors/unknown/deactivate", {}.to_json, admin_headers
      expect(last_response.status).to eq(404)
    end
  end

  describe "POST /admin/ingestors/:id/reactivate" do
    it "reactivates an ingestor" do
      db = open_db
      ingestor = nil
      begin
        ingestor = PotatoMesh::Application.create_ingestor(db, name: "Reactivate Test")
        PotatoMesh::Application.deactivate_ingestor(db, ingestor["id"])
      ensure
        db&.close
      end

      post "/admin/ingestors/#{ingestor["id"]}/reactivate", {}.to_json, admin_headers
      expect(last_response).to be_ok
      body = JSON.parse(last_response.body)
      expect(body["status"]).to eq("reactivated")

      # Verify ingestor is now active
      db = open_db(readonly: true)
      begin
        found = PotatoMesh::Application.find_ingestor_by_id(db, ingestor["id"])
        expect(found["is_active"]).to be(true)
      ensure
        db&.close
      end
    end

    it "returns 404 for unknown ID" do
      post "/admin/ingestors/unknown/reactivate", {}.to_json, admin_headers
      expect(last_response.status).to eq(404)
    end
  end

  describe "DELETE /admin/ingestors/:id" do
    it "permanently deletes an ingestor" do
      db = open_db
      ingestor = nil
      begin
        ingestor = PotatoMesh::Application.create_ingestor(db, name: "Delete Test")
      ensure
        db&.close
      end

      delete "/admin/ingestors/#{ingestor["id"]}", {}, admin_headers
      expect(last_response).to be_ok
      body = JSON.parse(last_response.body)
      expect(body["status"]).to eq("deleted")

      # Verify ingestor is gone
      db = open_db(readonly: true)
      begin
        found = PotatoMesh::Application.find_ingestor_by_id(db, ingestor["id"])
        expect(found).to be_nil
      ensure
        db&.close
      end
    end

    it "returns 404 for unknown ID" do
      delete "/admin/ingestors/unknown", {}, admin_headers
      expect(last_response.status).to eq(404)
    end
  end
end

RSpec.describe "Ingestor Token Authentication" do
  include Rack::Test::Methods

  let(:app) { Sinatra::Application }
  let(:api_token) { "main-api-token" }

  around do |example|
    Dir.mktmpdir("ingestor-auth-spec-") do |dir|
      db_path = File.join(dir, "mesh.db")

      RSpec::Mocks.with_temporary_scope do
        allow(PotatoMesh::Config).to receive(:db_path).and_return(db_path)
        allow(PotatoMesh::Config).to receive(:default_db_path).and_return(db_path)
        allow(PotatoMesh::Config).to receive(:legacy_db_path).and_return(db_path)
        allow(PotatoMesh::Config).to receive(:ingestor_management_enabled?).and_return(true)

        FileUtils.mkdir_p(File.dirname(db_path))
        PotatoMesh::Application.init_db

        example.run
      end
    end
  end

  def open_db(readonly: false)
    db = SQLite3::Database.new(PotatoMesh::Config.db_path, readonly: readonly)
    db.busy_timeout = PotatoMesh::Config.db_busy_timeout_ms
    db.execute("PRAGMA foreign_keys = ON")
    db
  end

  describe "require_token! with ingestor keys" do
    around do |example|
      original_token = ENV["API_TOKEN"]
      ENV["API_TOKEN"] = api_token
      begin
        example.run
      ensure
        if original_token
          ENV["API_TOKEN"] = original_token
        else
          ENV.delete("API_TOKEN")
        end
      end
    end

    it "accepts valid ingestor API key" do
      db = open_db
      ingestor = nil
      begin
        ingestor = PotatoMesh::Application.create_ingestor(db, name: "Auth Test")
      ensure
        db&.close
      end

      headers = {
        "CONTENT_TYPE" => "application/json",
        "HTTP_AUTHORIZATION" => "Bearer #{ingestor["api_key"]}",
      }
      payload = { "!test123" => { "id" => "!test123", "shortName" => "TEST" } }

      post "/api/nodes", payload.to_json, headers
      expect(last_response).to be_ok
    end

    it "rejects inactive ingestor API key" do
      db = open_db
      ingestor = nil
      begin
        ingestor = PotatoMesh::Application.create_ingestor(db, name: "Inactive Auth")
        PotatoMesh::Application.deactivate_ingestor(db, ingestor["id"])
      ensure
        db&.close
      end

      headers = {
        "CONTENT_TYPE" => "application/json",
        "HTTP_AUTHORIZATION" => "Bearer #{ingestor["api_key"]}",
      }
      payload = { "!test123" => { "id" => "!test123", "shortName" => "TEST" } }

      post "/api/nodes", payload.to_json, headers
      expect(last_response.status).to eq(403)
    end

    it "records ingestor request activity" do
      db = open_db
      ingestor = nil
      begin
        ingestor = PotatoMesh::Application.create_ingestor(db, name: "Activity Test")
      ensure
        db&.close
      end

      headers = {
        "CONTENT_TYPE" => "application/json",
        "HTTP_AUTHORIZATION" => "Bearer #{ingestor["api_key"]}",
        "HTTP_X_INGESTOR_VERSION" => "1.2.3",
      }
      payload = { "!test123" => { "id" => "!test123", "shortName" => "TEST" } }

      post "/api/nodes", payload.to_json, headers
      expect(last_response).to be_ok

      # Verify activity was recorded
      db = open_db(readonly: true)
      begin
        updated = PotatoMesh::Application.find_ingestor_by_id(db, ingestor["id"])
        expect(updated["last_request_time"]).to be > 0
        expect(updated["request_count"]).to eq(1)
        expect(updated["version"]).to eq("1.2.3")
      ensure
        db&.close
      end
    end

    it "still accepts main API_TOKEN" do
      headers = {
        "CONTENT_TYPE" => "application/json",
        "HTTP_AUTHORIZATION" => "Bearer #{api_token}",
      }
      payload = { "!test123" => { "id" => "!test123", "shortName" => "TEST" } }

      post "/api/nodes", payload.to_json, headers
      expect(last_response).to be_ok
    end
  end
end
