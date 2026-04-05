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

RSpec.describe PotatoMesh::App::DataProcessing do
  # Build a minimal host class so we can call the module methods in isolation.
  let(:harness_class) do
    Class.new do
      include PotatoMesh::App::DataProcessing
      include PotatoMesh::App::Helpers

      def debug_log(message, **); end

      def warn_log(message, **); end

      def with_busy_retry
        yield
      end

      def update_prometheus_metrics(*); end

      def prom_report_ids
        []
      end

      def private_mode?
        false
      end

      def normalize_node_id(_db, node_ref)
        parts = canonical_node_parts(node_ref)
        parts ? parts[0] : nil
      end

      def resolve_protocol(_db, _ingestor, cache: nil)
        "meshtastic"
      end
    end
  end

  subject(:dp) { harness_class.new }

  # ---------------------------------------------------------------------------
  # coerce_bool
  # ---------------------------------------------------------------------------
  describe "#coerce_bool" do
    it "converts true to 1" do
      expect(dp.coerce_bool(true)).to eq(1)
    end

    it "converts false to 0" do
      expect(dp.coerce_bool(false)).to eq(0)
    end

    it "passes through other values unchanged" do
      expect(dp.coerce_bool(nil)).to be_nil
      expect(dp.coerce_bool("yes")).to eq("yes")
      expect(dp.coerce_bool(42)).to eq(42)
    end
  end

  # ---------------------------------------------------------------------------
  # resolve_node_num
  # ---------------------------------------------------------------------------
  describe "#resolve_node_num" do
    it "returns an integer payload num directly" do
      expect(dp.resolve_node_num("!aabbccdd", { "num" => 0xaabbccdd })).to eq(0xaabbccdd)
    end

    it "handles a numeric (non-integer) payload num" do
      expect(dp.resolve_node_num("!aabbccdd", { "num" => 305_441_741.0 })).to eq(305_441_741)
    end

    it "parses a decimal string num" do
      expect(dp.resolve_node_num("!aabbccdd", { "num" => "12345" })).to eq(12345)
    end

    it "parses a hex-prefixed string num" do
      expect(dp.resolve_node_num("!aabbccdd", { "num" => "0xAABBCCDD" })).to eq(0xaabbccdd)
    end

    it "falls back to node_id hex when num is absent" do
      expect(dp.resolve_node_num("!aabbccdd", {})).to eq(0xaabbccdd)
    end

    it "returns nil for invalid inputs" do
      expect(dp.resolve_node_num(nil, {})).to be_nil
    end
  end

  # ---------------------------------------------------------------------------
  # canonical_node_parts
  # ---------------------------------------------------------------------------
  describe "#canonical_node_parts" do
    it "parses !hex notation" do
      parts = dp.canonical_node_parts("!aabbccdd")
      expect(parts).not_to be_nil
      expect(parts[0]).to eq("!aabbccdd")
      expect(parts[1]).to eq(0xaabbccdd)
    end

    it "parses a numeric node_ref" do
      parts = dp.canonical_node_parts(0xaabbccdd)
      expect(parts).not_to be_nil
      expect(parts[0]).to start_with("!")
      expect(parts[1]).to eq(0xaabbccdd)
    end

    it "returns nil for an invalid string" do
      expect(dp.canonical_node_parts("not_a_node")).to be_nil
    end

    it "returns nil for nil without a fallback" do
      expect(dp.canonical_node_parts(nil)).to be_nil
    end

    it "uses fallback_num when node_ref is nil" do
      parts = dp.canonical_node_parts(nil, 0xaabbccdd)
      expect(parts).not_to be_nil
      expect(parts[1]).to eq(0xaabbccdd)
    end
  end

  shared_context "with isolated db" do
    around do |example|
      Dir.mktmpdir("dp-spec-") do |dir|
        db_path = File.join(dir, "mesh.db")
        RSpec::Mocks.with_temporary_scope do
          allow(PotatoMesh::Config).to receive(:db_path).and_return(db_path)
          allow(PotatoMesh::Config).to receive(:db_busy_timeout_ms).and_return(5000)
          allow(PotatoMesh::Config).to receive(:week_seconds).and_return(604_800)
          allow(PotatoMesh::Config).to receive(:trace_neighbor_window_seconds).and_return(604_800)
          allow(PotatoMesh::Config).to receive(:debug?).and_return(false)
          db_helper = Object.new.extend(PotatoMesh::App::Database)
          db_helper.init_db
          db_helper.ensure_schema_upgrades
          example.run
        end
      end
    end

    def open_db
      db = SQLite3::Database.new(PotatoMesh::Config.db_path)
      db.results_as_hash = true
      db
    end

    let(:now) { Time.now.to_i }
  end

  # ---------------------------------------------------------------------------
  # insert_telemetry (telemetry_type validation path)
  # ---------------------------------------------------------------------------
  describe "#insert_telemetry" do
    include_context "with isolated db"

    let(:valid_payload) do
      {
        "id" => 42,
        "node_id" => "!aabbccdd",
        "rx_time" => now,
        "telemetry_type" => "device",
        "deviceMetrics" => { "batteryLevel" => 80 },
      }
    end

    it "inserts a telemetry row with a valid telemetry_type" do
      db = open_db
      dp.insert_telemetry(db, valid_payload)
      row = db.execute("SELECT telemetry_type FROM telemetry WHERE id = 42").first
      db.close
      expect(row["telemetry_type"]).to eq("device")
    end

    it "treats invalid telemetry_type values as nil (auto-inferred)" do
      db = open_db
      payload = valid_payload.merge("telemetry_type" => "bogus_type")
      dp.insert_telemetry(db, payload)
      row = db.execute("SELECT telemetry_type FROM telemetry WHERE id = 42").first
      db.close
      # "bogus_type" is not in VALID_TELEMETRY_TYPES; the value should be
      # replaced by the auto-inferred type ("device") since deviceMetrics is present.
      expect(%w[device nil]).to include(row["telemetry_type"].to_s)
    end

    it "returns nil for a non-hash payload" do
      db = open_db
      result = dp.insert_telemetry(db, "not a hash")
      db.close
      expect(result).to be_nil
    end

    it "returns nil when no telemetry id is present" do
      db = open_db
      result = dp.insert_telemetry(db, { "node_id" => "!aabbccdd" })
      db.close
      expect(result).to be_nil
    end
  end

  # ---------------------------------------------------------------------------
  # upsert_node — Bug 1: lastHeard = 0 must not be stored as 0
  # ---------------------------------------------------------------------------
  describe "#upsert_node — last_heard zero handling" do
    include_context "with isolated db"

    it "stores last_heard as approximately now when lastHeard is 0 and no position" do
      db = open_db
      dp.upsert_node(db, "!aabbccdd", { "lastHeard" => 0, "num" => 0xaabbccdd })
      row = db.execute("SELECT last_heard FROM nodes WHERE node_id = '!aabbccdd'").first
      db.close
      expect(row["last_heard"]).to be_within(5).of(now)
    end

    it "stores last_heard from position time when lastHeard is 0 and position is present" do
      pt = now - 300
      db = open_db
      dp.upsert_node(db, "!aabbccdd", {
        "lastHeard" => 0,
        "num" => 0xaabbccdd,
        "position" => { "time" => pt, "latitude" => 1.0, "longitude" => 2.0 },
      })
      row = db.execute("SELECT last_heard FROM nodes WHERE node_id = '!aabbccdd'").first
      db.close
      expect(row["last_heard"]).to eq(pt)
    end

    it "does not store 0 as last_heard regardless of the incoming value" do
      db = open_db
      dp.upsert_node(db, "!aabbccdd", { "lastHeard" => 0, "num" => 0xaabbccdd })
      row = db.execute("SELECT last_heard FROM nodes WHERE node_id = '!aabbccdd'").first
      db.close
      expect(row["last_heard"]).not_to eq(0)
    end

    it "stores a positive lastHeard value as-is" do
      lh = now - 120
      db = open_db
      dp.upsert_node(db, "!aabbccdd", { "lastHeard" => lh, "num" => 0xaabbccdd })
      row = db.execute("SELECT last_heard FROM nodes WHERE node_id = '!aabbccdd'").first
      db.close
      expect(row["last_heard"]).to eq(lh)
    end

    it "includes the node in query_nodes results after lastHeard=0 fix" do
      db = open_db
      dp.upsert_node(db, "!aabbccdd", { "lastHeard" => 0, "num" => 0xaabbccdd })
      db.close
      # query_nodes uses a 7-day floor; the node must appear
      node_ids = dp.query_nodes(100).map { |n| n["node_id"] }
      expect(node_ids).to include("!aabbccdd")
    end
  end

  # ---------------------------------------------------------------------------
  # upsert_node — Bug 2: role must not be reset by no-user packets
  # ---------------------------------------------------------------------------
  describe "#upsert_node — role preservation" do
    include_context "with isolated db"

    it "preserves an existing CLIENT_BASE role when a no-user packet arrives" do
      db = open_db
      # First insert: full user info with CLIENT_BASE role
      dp.upsert_node(db, "!aabbccdd", {
        "lastHeard" => now - 100,
        "num" => 0xaabbccdd,
        "user" => { "role" => "CLIENT_BASE", "longName" => "Test Node", "shortName" => "TN" },
      })
      # Second update: higher lastHeard but no user section (topology packet)
      dp.upsert_node(db, "!aabbccdd", { "lastHeard" => now, "num" => 0xaabbccdd })
      row = db.execute("SELECT role FROM nodes WHERE node_id = '!aabbccdd'").first
      db.close
      expect(row["role"]).to eq("CLIENT_BASE")
    end

    it "updates the role when an explicit role is supplied" do
      db = open_db
      dp.upsert_node(db, "!aabbccdd", {
        "lastHeard" => now - 100,
        "num" => 0xaabbccdd,
        "user" => { "role" => "CLIENT_BASE", "longName" => "Test Node", "shortName" => "TN" },
      })
      dp.upsert_node(db, "!aabbccdd", {
        "lastHeard" => now,
        "num" => 0xaabbccdd,
        "user" => { "role" => "CLIENT", "longName" => "Test Node", "shortName" => "TN" },
      })
      row = db.execute("SELECT role FROM nodes WHERE node_id = '!aabbccdd'").first
      db.close
      expect(row["role"]).to eq("CLIENT")
    end

    it "stores NULL role for new nodes without user info (display layer supplies CLIENT)" do
      db = open_db
      dp.upsert_node(db, "!aabbccdd", { "lastHeard" => now, "num" => 0xaabbccdd })
      row = db.execute("SELECT role FROM nodes WHERE node_id = '!aabbccdd'").first
      db.close
      # NULL is stored; query_nodes applies r["role"] ||= "CLIENT" for display
      expect(row["role"]).to be_nil
    end
  end

  # ---------------------------------------------------------------------------
  # upsert_node — Bug 3: identity fields must not be overwritten with NULL
  # ---------------------------------------------------------------------------
  describe "#upsert_node — identity field preservation" do
    include_context "with isolated db"

    def seed_node(db)
      dp.upsert_node(db, "!aabbccdd", {
        "lastHeard" => now - 100,
        "num" => 0xaabbccdd,
        "user" => {
          "role" => "CLIENT_BASE",
          "longName" => "Real Long Name",
          "shortName" => "RLN",
          "macaddr" => "aa:bb:cc:dd:ee:ff",
          "hwModel" => "TBEAM",
          "publicKey" => "abc123",
        },
      })
    end

    it "preserves short_name when a no-user packet arrives" do
      db = open_db
      seed_node(db)
      dp.upsert_node(db, "!aabbccdd", { "lastHeard" => now, "num" => 0xaabbccdd })
      row = db.execute("SELECT short_name FROM nodes WHERE node_id = '!aabbccdd'").first
      db.close
      expect(row["short_name"]).to eq("RLN")
    end

    it "updates short_name when a real value is supplied" do
      db = open_db
      seed_node(db)
      dp.upsert_node(db, "!aabbccdd", {
        "lastHeard" => now,
        "num" => 0xaabbccdd,
        "user" => { "shortName" => "NEW", "longName" => "New Long Name" },
      })
      row = db.execute("SELECT short_name FROM nodes WHERE node_id = '!aabbccdd'").first
      db.close
      expect(row["short_name"]).to eq("NEW")
    end

    it "preserves long_name when a no-user packet arrives" do
      db = open_db
      seed_node(db)
      dp.upsert_node(db, "!aabbccdd", { "lastHeard" => now, "num" => 0xaabbccdd })
      row = db.execute("SELECT long_name FROM nodes WHERE node_id = '!aabbccdd'").first
      db.close
      expect(row["long_name"]).to eq("Real Long Name")
    end

    it "does not overwrite a real long_name with a generic placeholder" do
      db = open_db
      seed_node(db)
      dp.upsert_node(db, "!aabbccdd", {
        "lastHeard" => now,
        "num" => 0xaabbccdd,
        "user" => { "longName" => "Meshtastic CCDD", "shortName" => "RLN" },
      })
      row = db.execute("SELECT long_name FROM nodes WHERE node_id = '!aabbccdd'").first
      db.close
      expect(row["long_name"]).to eq("Real Long Name")
    end

    it "overwrites a generic placeholder long_name with a real long_name" do
      db = open_db
      # Insert node with generic placeholder name first
      dp.upsert_node(db, "!aabbccdd", {
        "lastHeard" => now - 100,
        "num" => 0xaabbccdd,
        "user" => { "longName" => "Meshtastic CCDD", "shortName" => "CCDD" },
      })
      # Then update with a real name
      dp.upsert_node(db, "!aabbccdd", {
        "lastHeard" => now,
        "num" => 0xaabbccdd,
        "user" => { "longName" => "Real Long Name", "shortName" => "RLN" },
      })
      row = db.execute("SELECT long_name FROM nodes WHERE node_id = '!aabbccdd'").first
      db.close
      expect(row["long_name"]).to eq("Real Long Name")
    end

    it "preserves macaddr when a no-user packet arrives" do
      db = open_db
      seed_node(db)
      dp.upsert_node(db, "!aabbccdd", { "lastHeard" => now, "num" => 0xaabbccdd })
      row = db.execute("SELECT macaddr FROM nodes WHERE node_id = '!aabbccdd'").first
      db.close
      expect(row["macaddr"]).to eq("aa:bb:cc:dd:ee:ff")
    end

    it "preserves hw_model when a no-user packet arrives" do
      db = open_db
      seed_node(db)
      dp.upsert_node(db, "!aabbccdd", { "lastHeard" => now, "num" => 0xaabbccdd })
      row = db.execute("SELECT hw_model FROM nodes WHERE node_id = '!aabbccdd'").first
      db.close
      expect(row["hw_model"]).to eq("TBEAM")
    end

    it "preserves public_key when a no-user packet arrives" do
      db = open_db
      seed_node(db)
      dp.upsert_node(db, "!aabbccdd", { "lastHeard" => now, "num" => 0xaabbccdd })
      row = db.execute("SELECT public_key FROM nodes WHERE node_id = '!aabbccdd'").first
      db.close
      expect(row["public_key"]).to eq("abc123")
    end
  end
end
