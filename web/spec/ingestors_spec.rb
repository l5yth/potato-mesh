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
        first = harness_class.create_ingestor(db, name: "First")
        sleep 0.01
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
