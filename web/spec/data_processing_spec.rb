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

    # Return the full node row for the canonical test node ID.
    def read_node(db)
      db.execute("SELECT * FROM nodes WHERE node_id = '!aabbccdd'").first
    end

    # Insert the canonical test node with full user info and CLIENT_BASE role.
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

    it "treats lastHeard=0 as absent, storing approximately now instead" do
      db = open_db
      dp.upsert_node(db, "!aabbccdd", { "lastHeard" => 0, "num" => 0xaabbccdd })
      lh = read_node(db)["last_heard"]
      db.close
      expect(lh).not_to eq(0)
      expect(lh).to be_within(5).of(now)
    end

    it "uses position time as last_heard fallback when lastHeard is 0" do
      pt = now - 300
      db = open_db
      dp.upsert_node(db, "!aabbccdd", {
        "lastHeard" => 0,
        "num" => 0xaabbccdd,
        "position" => { "time" => pt, "latitude" => 1.0, "longitude" => 2.0 },
      })
      expect(read_node(db)["last_heard"]).to eq(pt)
      db.close
    end

    it "stores a positive lastHeard value as-is" do
      lh = now - 120
      db = open_db
      dp.upsert_node(db, "!aabbccdd", { "lastHeard" => lh, "num" => 0xaabbccdd })
      expect(read_node(db)["last_heard"]).to eq(lh)
      db.close
    end

    it "includes the node in query_nodes results after lastHeard=0 fix" do
      db = open_db
      dp.upsert_node(db, "!aabbccdd", { "lastHeard" => 0, "num" => 0xaabbccdd })
      db.close
      # query_nodes applies a 7-day floor; the node must appear
      expect(dp.query_nodes(100).map { |n| n["node_id"] }).to include("!aabbccdd")
    end
  end

  # ---------------------------------------------------------------------------
  # upsert_node — Bug 2: role must not be reset by no-user packets
  # ---------------------------------------------------------------------------
  describe "#upsert_node — role preservation" do
    include_context "with isolated db"

    it "preserves CLIENT_BASE role when a no-user packet arrives" do
      db = open_db
      seed_node(db)
      dp.upsert_node(db, "!aabbccdd", { "lastHeard" => now, "num" => 0xaabbccdd })
      expect(read_node(db)["role"]).to eq("CLIENT_BASE")
      db.close
    end

    it "updates role when an explicit role is supplied" do
      db = open_db
      seed_node(db)
      dp.upsert_node(db, "!aabbccdd", {
        "lastHeard" => now,
        "num" => 0xaabbccdd,
        "user" => { "role" => "CLIENT", "longName" => "Real Long Name", "shortName" => "RLN" },
      })
      expect(read_node(db)["role"]).to eq("CLIENT")
      db.close
    end

    it "stores NULL role for new nodes without user info (display layer supplies CLIENT)" do
      db = open_db
      dp.upsert_node(db, "!aabbccdd", { "lastHeard" => now, "num" => 0xaabbccdd })
      # NULL is stored; query_nodes applies r["role"] ||= "CLIENT" for display
      expect(read_node(db)["role"]).to be_nil
      db.close
    end
  end

  # ---------------------------------------------------------------------------
  # upsert_node — Bug 3: identity fields must not be overwritten with NULL
  # ---------------------------------------------------------------------------
  describe "#upsert_node — identity field preservation" do
    include_context "with isolated db"

    it "preserves all identity fields when a no-user packet arrives" do
      db = open_db
      seed_node(db)
      dp.upsert_node(db, "!aabbccdd", { "lastHeard" => now, "num" => 0xaabbccdd })
      row = read_node(db)
      db.close
      expect(row["short_name"]).to eq("RLN")
      expect(row["long_name"]).to eq("Real Long Name")
      expect(row["macaddr"]).to eq("aa:bb:cc:dd:ee:ff")
      expect(row["hw_model"]).to eq("TBEAM")
      expect(row["public_key"]).to eq("abc123")
    end

    it "updates short_name when a real value is supplied" do
      db = open_db
      seed_node(db)
      dp.upsert_node(db, "!aabbccdd", {
        "lastHeard" => now,
        "num" => 0xaabbccdd,
        "user" => { "shortName" => "NEW", "longName" => "New Long Name" },
      })
      expect(read_node(db)["short_name"]).to eq("NEW")
      db.close
    end

    it "does not overwrite a real long_name with a generic placeholder" do
      db = open_db
      seed_node(db)
      dp.upsert_node(db, "!aabbccdd", {
        "lastHeard" => now,
        "num" => 0xaabbccdd,
        "user" => { "longName" => "Meshtastic CCDD", "shortName" => "RLN" },
      })
      expect(read_node(db)["long_name"]).to eq("Real Long Name")
      db.close
    end

    it "overwrites a generic placeholder long_name with a real long_name" do
      db = open_db
      dp.upsert_node(db, "!aabbccdd", {
        "lastHeard" => now - 100,
        "num" => 0xaabbccdd,
        "user" => { "longName" => "Meshtastic CCDD", "shortName" => "CCDD" },
      })
      dp.upsert_node(db, "!aabbccdd", {
        "lastHeard" => now,
        "num" => 0xaabbccdd,
        "user" => { "longName" => "Real Long Name", "shortName" => "RLN" },
      })
      expect(read_node(db)["long_name"]).to eq("Real Long Name")
      db.close
    end
  end
end
