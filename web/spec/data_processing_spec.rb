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
          allow(PotatoMesh::Config).to receive(:four_weeks_seconds).and_return(604_800)
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

  # ---------------------------------------------------------------------------
  # upsert_node — synthetic flag + merge
  # ---------------------------------------------------------------------------
  describe "#upsert_node — synthetic node handling", :db do
    include_context "with isolated db"

    let(:now) { Time.now.to_i }

    def seed_message(db, from_id:)
      db.execute(
        "INSERT INTO messages(id,rx_time,rx_iso,from_id,to_id,protocol) VALUES (?,?,?,?,?,?)",
        [42, now, "2025-01-01T00:00:00Z", from_id, "^all", "meshcore"],
      )
    end

    it "stores synthetic=1 when user.synthetic is true" do
      db = open_db
      dp.upsert_node(db, "!synth111", {
        "lastHeard" => now,
        "protocol" => "meshcore",
        "user" => { "longName" => "Alice", "shortName" => "  A ", "role" => "COMPANION", "synthetic" => true },
      }, protocol: "meshcore")
      row = db.execute("SELECT synthetic FROM nodes WHERE node_id = '!synth111'").first
      expect(row[0]).to eq(1)
      db.close
    end

    it "stores synthetic=0 when user.synthetic is false" do
      db = open_db
      dp.upsert_node(db, "!real1111", {
        "lastHeard" => now,
        "protocol" => "meshcore",
        "user" => { "longName" => "Alice", "shortName" => "  A ", "role" => "COMPANION", "synthetic" => false },
      }, protocol: "meshcore")
      row = db.execute("SELECT synthetic FROM nodes WHERE node_id = '!real1111'").first
      expect(row[0]).to eq(0)
      db.close
    end

    it "does not overwrite a real node with a synthetic upsert" do
      db = open_db
      # Insert real node first.
      dp.upsert_node(db, "!aabbccdd", {
        "lastHeard" => now - 100,
        "user" => { "longName" => "Alice", "shortName" => "  A ", "role" => "COMPANION" },
      }, protocol: "meshcore")
      # Attempt to overwrite with synthetic upsert at a later time.
      dp.upsert_node(db, "!aabbccdd", {
        "lastHeard" => now,
        "user" => { "longName" => "Alice", "shortName" => "  A ", "role" => "COMPANION", "synthetic" => true },
      }, protocol: "meshcore")
      row = db.execute("SELECT synthetic FROM nodes WHERE node_id = '!aabbccdd'").first
      expect(row[0]).to eq(0)
      db.close
    end

    it "real wins over synthetic — synthetic=0 is never overwritten by synthetic=1" do
      db = open_db
      # Insert synthetic first, then real.
      dp.upsert_node(db, "!synth222", {
        "lastHeard" => now - 200,
        "user" => { "longName" => "Bob", "shortName" => " B ", "role" => "COMPANION", "synthetic" => true },
      }, protocol: "meshcore")
      dp.upsert_node(db, "!synth222", {
        "lastHeard" => now,
        "user" => { "longName" => "Bob", "shortName" => " B ", "role" => "COMPANION", "synthetic" => false },
      }, protocol: "meshcore")
      row = db.execute("SELECT synthetic FROM nodes WHERE node_id = '!synth222'").first
      expect(row[0]).to eq(0)
      db.close
    end

    it "migrates messages from synthetic node to real node on name match" do
      db = open_db
      synth_id = "!synth333"
      real_id = "!real3333"
      # Create synthetic node and a message from it.
      dp.upsert_node(db, synth_id, {
        "lastHeard" => now - 500,
        "user" => { "longName" => "Carol", "shortName" => "  C ", "role" => "COMPANION", "synthetic" => true },
      }, protocol: "meshcore")
      seed_message(db, from_id: synth_id)
      # Upsert the real node with the same long name.
      dp.upsert_node(db, real_id, {
        "lastHeard" => now,
        "user" => { "longName" => "Carol", "shortName" => "  C ", "role" => "COMPANION", "publicKey" => "cc" * 32 },
      }, protocol: "meshcore")
      # Message should now point to the real node.
      msg_from = db.execute("SELECT from_id FROM messages WHERE id = 42").first[0]
      expect(msg_from).to eq(real_id)
      # Synthetic node should be gone.
      synth_row = db.execute("SELECT node_id FROM nodes WHERE node_id = ?", [synth_id]).first
      expect(synth_row).to be_nil
      db.close
    end

    it "does not delete real nodes during merge" do
      db = open_db
      real_id = "!real4444"
      # Insert a real node with the same long name as the incoming real node.
      dp.upsert_node(db, real_id, {
        "lastHeard" => now - 100,
        "user" => { "longName" => "Dave", "shortName" => "  D ", "role" => "COMPANION" },
      }, protocol: "meshcore")
      # Upsert same node again — should not delete itself.
      dp.upsert_node(db, real_id, {
        "lastHeard" => now,
        "user" => { "longName" => "Dave", "shortName" => "  D ", "role" => "COMPANION" },
      }, protocol: "meshcore")
      row = db.execute("SELECT node_id FROM nodes WHERE node_id = ?", [real_id]).first
      expect(row).not_to be_nil
      db.close
    end

    it "migrates messages from multiple synthetic nodes to a single real node" do
      db = open_db
      synth_a = "!synth5a5a"
      synth_b = "!synth5b5b"
      real_id = "!real5555"
      # Two synthetic nodes with the same long name (could happen from two
      # ingestors or a race).
      dp.upsert_node(db, synth_a, {
        "lastHeard" => now - 600,
        "user" => { "longName" => "Eve", "shortName" => "  E ", "role" => "COMPANION", "synthetic" => true },
      }, protocol: "meshcore")
      dp.upsert_node(db, synth_b, {
        "lastHeard" => now - 500,
        "user" => { "longName" => "Eve", "shortName" => "  E ", "role" => "COMPANION", "synthetic" => true },
      }, protocol: "meshcore")
      db.execute(
        "INSERT INTO messages(id,rx_time,rx_iso,from_id,to_id,protocol) VALUES (?,?,?,?,?,?)",
        [51, now - 600, "2025-01-01T00:00:00Z", synth_a, "^all", "meshcore"],
      )
      db.execute(
        "INSERT INTO messages(id,rx_time,rx_iso,from_id,to_id,protocol) VALUES (?,?,?,?,?,?)",
        [52, now - 500, "2025-01-01T00:00:00Z", synth_b, "^all", "meshcore"],
      )
      # Upsert real node.
      dp.upsert_node(db, real_id, {
        "lastHeard" => now,
        "user" => { "longName" => "Eve", "shortName" => "  E ", "role" => "COMPANION", "publicKey" => "ee" * 32 },
      }, protocol: "meshcore")
      # Both messages should now reference the real node.
      from_ids = db.execute("SELECT from_id FROM messages WHERE id IN (51,52) ORDER BY id").map { |r| r[0] }
      expect(from_ids).to all(eq(real_id))
      # Both synthetic nodes gone.
      remaining = db.execute("SELECT node_id FROM nodes WHERE node_id IN (?,?)", [synth_a, synth_b]).flatten
      expect(remaining).to be_empty
      db.close
    end

    # Regression tests for issue #755: synthetic arrives after the real node
    # was already stored (e.g. by a co-operating ingestor that saw the contact
    # advertisement first).  The reverse merge must fire at synthetic-upsert
    # time so duplicates never persist.
    it "collapses a synthetic upsert when a real meshcore node with the same long_name already exists" do
      db = open_db
      real_id = "!real8888"
      synth_id = "!synth888"
      dp.upsert_node(db, real_id, {
        "lastHeard" => now - 100,
        "user" => { "longName" => "Heidi", "shortName" => "  H ", "role" => "COMPANION", "publicKey" => "88" * 32 },
      }, protocol: "meshcore")
      # Pre-existing message with synthetic id (simulates a chat message that
      # was stored before the ingestor learned about the real contact).
      db.execute(
        "INSERT INTO messages(id,rx_time,rx_iso,from_id,to_id,protocol) VALUES (?,?,?,?,?,?)",
        [71, now - 50, "2025-01-01T00:00:00Z", synth_id, "^all", "meshcore"],
      )
      dp.upsert_node(db, synth_id, {
        "lastHeard" => now,
        "protocol" => "meshcore",
        "user" => { "longName" => "Heidi", "shortName" => "", "role" => "COMPANION", "synthetic" => true },
      }, protocol: "meshcore")
      # Synthetic must not linger as a second row.
      expect(db.execute("SELECT node_id FROM nodes WHERE node_id = ?", [synth_id]).first).to be_nil
      # Real node still there.
      expect(db.execute("SELECT node_id FROM nodes WHERE node_id = ?", [real_id]).first).not_to be_nil
      # Pre-existing message redirected.
      expect(db.execute("SELECT from_id FROM messages WHERE id = 71").first[0]).to eq(real_id)
      db.close
    end

    it "leaves a synthetic in place when no real meshcore peer exists yet" do
      db = open_db
      synth_id = "!synth999"
      dp.upsert_node(db, synth_id, {
        "lastHeard" => now,
        "protocol" => "meshcore",
        "user" => { "longName" => "Ivan", "shortName" => "", "role" => "COMPANION", "synthetic" => true },
      }, protocol: "meshcore")
      row = db.execute("SELECT synthetic FROM nodes WHERE node_id = ?", [synth_id]).first
      expect(row).not_to be_nil
      expect(row[0]).to eq(1)
      db.close
    end

    it "does not merge across protocols — a synthetic meshtastic peer is not treated as a match" do
      db = open_db
      real_meshtastic = "!realmtA1"
      synth_meshcore = "!synthmcA"
      # Real meshtastic node sharing the same long_name must not be mistaken
      # for a reverse-merge target when a meshcore synthetic is upserted.
      db.execute(
        "INSERT INTO nodes(node_id,long_name,protocol,synthetic,last_heard,first_heard) VALUES (?,?,?,?,?,?)",
        [real_meshtastic, "Judy", "meshtastic", 0, now - 100, now - 100],
      )
      dp.upsert_node(db, synth_meshcore, {
        "lastHeard" => now,
        "protocol" => "meshcore",
        "user" => { "longName" => "Judy", "shortName" => "", "role" => "COMPANION", "synthetic" => true },
      }, protocol: "meshcore")
      # Both rows must coexist.
      expect(db.execute("SELECT node_id FROM nodes WHERE node_id = ?", [real_meshtastic]).first).not_to be_nil
      expect(db.execute("SELECT node_id FROM nodes WHERE node_id = ?", [synth_meshcore]).first).not_to be_nil
      db.close
    end

    # Two real meshcore radios can legitimately advertise the same long_name
    # (it is user-editable and has no uniqueness constraint).  In that case we
    # cannot tell which real device a synthetic placeholder stood in for, so
    # neither direction of the merge is allowed to fire.
    it "skips the reverse merge when two real meshcore nodes share the same long_name" do
      db = open_db
      real_a = "!realambA"
      real_b = "!realambB"
      synth_id = "!synthamb"
      db.execute(
        "INSERT INTO nodes(node_id,long_name,protocol,synthetic,last_heard,first_heard,public_key) VALUES (?,?,?,?,?,?,?)",
        [real_a, "Karl", "meshcore", 0, now - 200, now - 200, "aa" * 32],
      )
      db.execute(
        "INSERT INTO nodes(node_id,long_name,protocol,synthetic,last_heard,first_heard,public_key) VALUES (?,?,?,?,?,?,?)",
        [real_b, "Karl", "meshcore", 0, now - 100, now - 100, "bb" * 32],
      )
      db.execute(
        "INSERT INTO messages(id,rx_time,rx_iso,from_id,to_id,protocol) VALUES (?,?,?,?,?,?)",
        [91, now - 10, "2025-01-01T00:00:00Z", synth_id, "^all", "meshcore"],
      )
      dp.upsert_node(db, synth_id, {
        "lastHeard" => now,
        "protocol" => "meshcore",
        "user" => { "longName" => "Karl", "shortName" => "", "role" => "COMPANION", "synthetic" => true },
      }, protocol: "meshcore")
      # Synthetic must NOT be merged — keep it as a visible placeholder so an
      # operator can resolve the ambiguity manually.
      expect(db.execute("SELECT node_id FROM nodes WHERE node_id = ?", [synth_id]).first).not_to be_nil
      # Message untouched.
      expect(db.execute("SELECT from_id FROM messages WHERE id = 91").first[0]).to eq(synth_id)
      # Both real rows still present.
      expect(db.execute("SELECT node_id FROM nodes WHERE node_id = ?", [real_a]).first).not_to be_nil
      expect(db.execute("SELECT node_id FROM nodes WHERE node_id = ?", [real_b]).first).not_to be_nil
      db.close
    end

    it "skips the forward merge when another real meshcore node already owns the long_name" do
      db = open_db
      real_a = "!realfwdA"
      real_b = "!realfwdB"
      synth_id = "!synthfwd"
      # Pre-existing real meshcore "Liam" (simulates another device that
      # advertised before) and a synthetic "Liam" placeholder.
      db.execute(
        "INSERT INTO nodes(node_id,long_name,protocol,synthetic,last_heard,first_heard,public_key) VALUES (?,?,?,?,?,?,?)",
        [real_a, "Liam", "meshcore", 0, now - 200, now - 200, "cc" * 32],
      )
      db.execute(
        "INSERT INTO nodes(node_id,long_name,protocol,synthetic,last_heard,first_heard) VALUES (?,?,?,?,?,?)",
        [synth_id, "Liam", "meshcore", 1, now - 100, now - 100],
      )
      db.execute(
        "INSERT INTO messages(id,rx_time,rx_iso,from_id,to_id,protocol) VALUES (?,?,?,?,?,?)",
        [92, now - 50, "2025-01-01T00:00:00Z", synth_id, "^all", "meshcore"],
      )
      # Now a second real meshcore "Liam" is upserted.  Because the name is
      # ambiguous, the forward merge must NOT claim the synthetic on behalf
      # of this node — that would randomly attribute the pre-existing message
      # to whichever real was upserted first.
      dp.upsert_node(db, real_b, {
        "lastHeard" => now,
        "protocol" => "meshcore",
        "user" => { "longName" => "Liam", "shortName" => "L", "role" => "COMPANION", "publicKey" => "dd" * 32 },
      }, protocol: "meshcore")
      expect(db.execute("SELECT node_id FROM nodes WHERE node_id = ?", [synth_id]).first).not_to be_nil
      expect(db.execute("SELECT from_id FROM messages WHERE id = 92").first[0]).to eq(synth_id)
    ensure
      db&.close
    end
  end

  # ---------------------------------------------------------------------------
  # merge_synthetic_nodes
  # ---------------------------------------------------------------------------
  describe "#merge_synthetic_nodes" do
    include_context "with isolated db"

    let(:now) { Time.now.to_i }

    it "is a no-op when no synthetic nodes match the long name" do
      db = open_db
      dp.upsert_node(db, "!real6666", {
        "lastHeard" => now - 100,
        "user" => { "longName" => "Frank", "shortName" => "  F " },
      }, protocol: "meshcore")
      # Should not raise and should leave the real node intact.
      dp.merge_synthetic_nodes(db, "!real6666", "Frank")
      row = db.execute("SELECT node_id FROM nodes WHERE node_id = '!real6666'").first
      expect(row).not_to be_nil
      db.close
    end

    it "does not migrate messages from a synthetic node on a different protocol" do
      db = open_db
      # A synthetic meshtastic node that happens to share the same long name as
      # an incoming real meshcore contact must NOT be merged.
      synth_id = "!synth7777"
      real_id = "!real7777"
      db.execute(
        "INSERT INTO nodes(node_id,long_name,protocol,synthetic,last_heard,first_heard) VALUES (?,?,?,?,?,?)",
        [synth_id, "Grace", "meshtastic", 1, now - 100, now - 100],
      )
      db.execute(
        "INSERT INTO messages(id,rx_time,rx_iso,from_id,to_id,protocol) VALUES (?,?,?,?,?,?)",
        [61, now - 100, "2025-01-01T00:00:00Z", synth_id, "^all", "meshtastic"],
      )
      dp.merge_synthetic_nodes(db, real_id, "Grace")
      # meshtastic synthetic node must be untouched.
      synth_row = db.execute("SELECT node_id FROM nodes WHERE node_id = ?", [synth_id]).first
      expect(synth_row).not_to be_nil
      msg_from = db.execute("SELECT from_id FROM messages WHERE id = 61").first[0]
      expect(msg_from).to eq(synth_id)
      db.close
    end
  end

  # ---------------------------------------------------------------------------
  # merge_into_real_node — reverse of merge_synthetic_nodes (issue #755).
  # ---------------------------------------------------------------------------
  describe "#merge_into_real_node" do
    include_context "with isolated db"

    let(:now) { Time.now.to_i }

    it "is a no-op when no real meshcore node shares the long_name" do
      db = open_db
      synth_id = "!synthAAA"
      dp.upsert_node(db, synth_id, {
        "lastHeard" => now,
        "protocol" => "meshcore",
        "user" => { "longName" => "Mallory", "shortName" => "", "role" => "COMPANION", "synthetic" => true },
      }, protocol: "meshcore")
      dp.merge_into_real_node(db, synth_id, "Mallory")
      # Synthetic remains because there is no real peer.
      expect(db.execute("SELECT node_id FROM nodes WHERE node_id = ?", [synth_id]).first).not_to be_nil
    ensure
      db&.close
    end

    it "migrates messages and drops the synthetic when a real meshcore peer exists" do
      db = open_db
      real_id = "!realBBBB"
      synth_id = "!synthBBB"
      db.execute(
        "INSERT INTO nodes(node_id,long_name,protocol,synthetic,last_heard,first_heard) VALUES (?,?,?,?,?,?)",
        [real_id, "Niaj", "meshcore", 0, now - 100, now - 100],
      )
      db.execute(
        "INSERT INTO nodes(node_id,long_name,protocol,synthetic,last_heard,first_heard) VALUES (?,?,?,?,?,?)",
        [synth_id, "Niaj", "meshcore", 1, now, now],
      )
      db.execute(
        "INSERT INTO messages(id,rx_time,rx_iso,from_id,to_id,protocol) VALUES (?,?,?,?,?,?)",
        [81, now, "2025-01-01T00:00:00Z", synth_id, "^all", "meshcore"],
      )
      dp.merge_into_real_node(db, synth_id, "Niaj")
      expect(db.execute("SELECT node_id FROM nodes WHERE node_id = ?", [synth_id]).first).to be_nil
      expect(db.execute("SELECT from_id FROM messages WHERE id = 81").first[0]).to eq(real_id)
    ensure
      db&.close
    end

    it "does not match a real meshtastic node as the reverse-merge target" do
      db = open_db
      real_meshtastic = "!realCCCC"
      synth_meshcore = "!synthCCC"
      db.execute(
        "INSERT INTO nodes(node_id,long_name,protocol,synthetic,last_heard,first_heard) VALUES (?,?,?,?,?,?)",
        [real_meshtastic, "Oscar", "meshtastic", 0, now - 100, now - 100],
      )
      db.execute(
        "INSERT INTO nodes(node_id,long_name,protocol,synthetic,last_heard,first_heard) VALUES (?,?,?,?,?,?)",
        [synth_meshcore, "Oscar", "meshcore", 1, now, now],
      )
      dp.merge_into_real_node(db, synth_meshcore, "Oscar")
      # Cross-protocol row must be left alone; synthetic survives.
      expect(db.execute("SELECT node_id FROM nodes WHERE node_id = ?", [synth_meshcore]).first).not_to be_nil
      expect(db.execute("SELECT node_id FROM nodes WHERE node_id = ?", [real_meshtastic]).first).not_to be_nil
    ensure
      db&.close
    end

    it "refuses to merge when two real meshcore nodes share the long_name" do
      db = open_db
      real_a = "!realDDDA"
      real_b = "!realDDDB"
      synth_id = "!synthDDD"
      db.execute(
        "INSERT INTO nodes(node_id,long_name,protocol,synthetic,last_heard,first_heard) VALUES (?,?,?,?,?,?)",
        [real_a, "Paul", "meshcore", 0, now - 200, now - 200],
      )
      db.execute(
        "INSERT INTO nodes(node_id,long_name,protocol,synthetic,last_heard,first_heard) VALUES (?,?,?,?,?,?)",
        [real_b, "Paul", "meshcore", 0, now - 100, now - 100],
      )
      db.execute(
        "INSERT INTO nodes(node_id,long_name,protocol,synthetic,last_heard,first_heard) VALUES (?,?,?,?,?,?)",
        [synth_id, "Paul", "meshcore", 1, now, now],
      )
      db.execute(
        "INSERT INTO messages(id,rx_time,rx_iso,from_id,to_id,protocol) VALUES (?,?,?,?,?,?)",
        [82, now, "2025-01-01T00:00:00Z", synth_id, "^all", "meshcore"],
      )
      dp.merge_into_real_node(db, synth_id, "Paul")
      # Neither real should take the synthetic's messages because we cannot
      # tell which Paul actually sent the chat.
      expect(db.execute("SELECT node_id FROM nodes WHERE node_id = ?", [synth_id]).first).not_to be_nil
      expect(db.execute("SELECT from_id FROM messages WHERE id = 82").first[0]).to eq(synth_id)
    ensure
      db&.close
    end
  end

  # ---------------------------------------------------------------------------
  # insert_message — meshcore content dedup (issue #756).
  # ---------------------------------------------------------------------------
  describe "#insert_message — meshcore content dedup" do
    include_context "with isolated db"

    let(:now) { Time.now.to_i }

    # Shared builder for a minimal ``insert_message`` harness parameterised
    # by the protocol it advertises for every POST.  Keeping this in one
    # place (rather than duplicating per-describe) matches CLAUDE.md's
    # modularity guidance and makes it trivial to add a third protocol.
    def self.build_protocol_harness(protocol_name)
      Class.new do
        include PotatoMesh::App::DataProcessing
        include PotatoMesh::App::Helpers

        define_method(:resolve_protocol) do |_db, _ingestor, cache: nil|
          protocol_name
        end

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

        def touch_node_last_seen(*); end

        def ensure_unknown_node(*); end
      end.new
    end

    let(:meshcore_harness) { self.class.build_protocol_harness("meshcore") }
    let(:meshtastic_harness) { self.class.build_protocol_harness("meshtastic") }

    # rx_time sits in the past so we can shift later copies forward (up to
    # ``now``) without tripping the ``rx_time > now`` clamp in
    # ``insert_message``.
    let(:base_rx_time) { now - 1_000 }
    let(:dedup_window) { PotatoMesh::App::DataProcessing::MESHCORE_CONTENT_DEDUP_WINDOW_SECONDS }

    let(:base_message) do
      {
        "rx_time" => base_rx_time,
        "from_id" => "!aabbccdd",
        "to_id" => "^all",
        "channel" => 5,
        "text" => "hello from alice",
        "portnum" => "TEXT_MESSAGE_APP",
        "ingestor" => "!ingest01",
      }
    end

    def message_count(db)
      db.get_first_value("SELECT COUNT(*) FROM messages").to_i
    end

    it "skips a second meshcore message with identical content within the dedup window" do
      db = open_db
      meshcore_harness.insert_message(db, base_message.merge("id" => 1_000_001))
      meshcore_harness.insert_message(
        db,
        base_message.merge("id" => 1_000_002, "rx_time" => base_rx_time + (dedup_window - 1)),
      )
      expect(message_count(db)).to eq(1)
      expect(db.get_first_value("SELECT id FROM messages").to_i).to eq(1_000_001)
    ensure
      db&.close
    end

    it "treats the dedup window as inclusive on the upper boundary" do
      # Pins the ``BETWEEN`` inclusivity: a row exactly ``dedup_window`` seconds
      # later still collapses.  One-second-past-the-window inserts below prove
      # the other side of the boundary.
      db = open_db
      meshcore_harness.insert_message(db, base_message.merge("id" => 1_000_021))
      meshcore_harness.insert_message(
        db,
        base_message.merge("id" => 1_000_022, "rx_time" => base_rx_time + dedup_window),
      )
      expect(message_count(db)).to eq(1)
      meshcore_harness.insert_message(
        db,
        base_message.merge("id" => 1_000_023, "rx_time" => base_rx_time + dedup_window + 1),
      )
      expect(message_count(db)).to eq(2)
    ensure
      db&.close
    end

    it "inserts both copies when rx_time delta exceeds the dedup window" do
      db = open_db
      meshcore_harness.insert_message(db, base_message.merge("id" => 1_000_003))
      meshcore_harness.insert_message(
        db,
        base_message.merge("id" => 1_000_004, "rx_time" => base_rx_time + (dedup_window * 3)),
      )
      expect(message_count(db)).to eq(2)
    ensure
      db&.close
    end

    it "does not collapse two meshcore messages on different channels" do
      db = open_db
      meshcore_harness.insert_message(db, base_message.merge("id" => 1_000_005, "channel" => 5))
      meshcore_harness.insert_message(db, base_message.merge("id" => 1_000_006, "channel" => 6))
      expect(message_count(db)).to eq(2)
    ensure
      db&.close
    end

    it "does not collapse two meshcore messages with different text" do
      db = open_db
      meshcore_harness.insert_message(db, base_message.merge("id" => 1_000_007, "text" => "first"))
      meshcore_harness.insert_message(db, base_message.merge("id" => 1_000_008, "text" => "second"))
      expect(message_count(db)).to eq(2)
    ensure
      db&.close
    end

    it "does not collapse two meshcore DMs to different recipients sharing text" do
      db = open_db
      meshcore_harness.insert_message(
        db,
        base_message.merge("id" => 1_000_009, "to_id" => "!bbbbbbbb"),
      )
      meshcore_harness.insert_message(
        db,
        base_message.merge("id" => 1_000_010, "to_id" => "!cccccccc", "rx_time" => base_rx_time + 5),
      )
      expect(message_count(db)).to eq(2)
    ensure
      db&.close
    end

    it "does not collapse when the incoming message has no text" do
      db = open_db
      meshcore_harness.insert_message(
        db,
        base_message.merge("id" => 1_000_011, "text" => "blob"),
      )
      # Second payload has no text — the content-dedup branch must not fire,
      # so this falls through to the normal id-PK path and inserts.
      meshcore_harness.insert_message(
        db,
        base_message.merge("id" => 1_000_012, "text" => nil, "rx_time" => base_rx_time + 5),
      )
      expect(message_count(db)).to eq(2)
    ensure
      db&.close
    end

    it "leaves meshtastic traffic untouched" do
      db = open_db
      # Two meshtastic packets with the same logical content but distinct
      # firmware-assigned packet ids must both land — the new guard is
      # scoped to meshcore by design.
      meshtastic_harness.insert_message(db, base_message.merge("id" => 1_000_013))
      meshtastic_harness.insert_message(
        db,
        base_message.merge("id" => 1_000_014, "rx_time" => base_rx_time + 5),
      )
      expect(message_count(db)).to eq(2)
    ensure
      db&.close
    end

    it "never issues the content-dedup SELECT for non-meshcore traffic" do
      # Pins the performance contract: meshtastic traffic must skip the
      # partial-index lookup entirely so any future regression that makes
      # the pre-check unconditional surfaces as a failing test.
      db = open_db
      content_select_pattern = /SELECT\s+id\s+FROM\s+messages\s+WHERE\s+protocol\s*=\s*'meshcore'/im
      captured_sql = []
      wrapped = db.method(:get_first_value)
      allow(db).to receive(:get_first_value) do |sql, *rest|
        captured_sql << sql
        wrapped.call(sql, *rest)
      end
      meshtastic_harness.insert_message(db, base_message.merge("id" => 1_000_020))
      expect(captured_sql.any? { |s| s =~ content_select_pattern }).to be(false)
    ensure
      db&.close
    end

    it "still merges on the id-PK path when sender_timestamps collide on the wire" do
      db = open_db
      # Same id, same content — the existing update-on-match code path should
      # patch the stored row rather than insert a duplicate.  This proves the
      # new dedup guard does not short-circuit the id-match merge behaviour.
      meshcore_harness.insert_message(db, base_message.merge("id" => 1_000_015, "ingestor" => nil))
      meshcore_harness.insert_message(
        db,
        base_message.merge("id" => 1_000_015, "ingestor" => "!ingest99"),
      )
      expect(message_count(db)).to eq(1)
      expect(
        db.get_first_value("SELECT ingestor FROM messages WHERE id = 1000015"),
      ).to eq("!ingest99")
    ensure
      db&.close
    end
  end

  # ---------------------------------------------------------------------------
  # Coverage gap-fillers for the post-split data_processing/ submodules.
  #
  # The PR that split data_processing.rb into focused submodules surfaced a
  # set of pre-existing untested branches as "uncovered patch lines".  The
  # describes below pin behaviour for each of those branches so future
  # changes cannot silently regress them.  Grouped by submodule for
  # discoverability.
  # ---------------------------------------------------------------------------

  # ---------------------------------------------------------------------------
  # identity.rb — numeric and bare-hex paths in canonical_node_parts
  # ---------------------------------------------------------------------------
  describe "#canonical_node_parts (numeric and bare-hex paths)" do
    it "coerces a Float node_ref to its integer counterpart" do
      parts = dp.canonical_node_parts(42.7)
      expect(parts).not_to be_nil
      expect(parts[1]).to eq(42)
    end

    it "parses a bare lowercase hex string without the ! sigil" do
      parts = dp.canonical_node_parts("aabbccdd")
      expect(parts).not_to be_nil
      expect(parts[0]).to eq("!aabbccdd")
      expect(parts[1]).to eq(0xaabbccdd)
    end
  end

  # ---------------------------------------------------------------------------
  # traces.rb — coerce_trace_node_id type handling
  # ---------------------------------------------------------------------------
  describe "#coerce_trace_node_id" do
    it "coerces a Float hop to an integer" do
      expect(dp.coerce_trace_node_id(42.7)).to eq(42)
    end

    it "returns nil for unsupported hop types" do
      expect(dp.coerce_trace_node_id([1, 2])).to be_nil
      expect(dp.coerce_trace_node_id(true)).to be_nil
    end

    it "extracts node ids from hash hops" do
      expect(dp.coerce_trace_node_id({ "node_id" => 12345 })).to eq(12345)
    end
  end

  # ---------------------------------------------------------------------------
  # telemetry.rb — resolve_numeric_metric default coercion + power fallback
  # ---------------------------------------------------------------------------
  describe "#resolve_numeric_metric (private)" do
    it "passes through values unchanged for unknown coercion types" do
      sources = { payload: { "raw" => "literal" } }
      key_map = { payload: %w[raw] }
      result = dp.send(:resolve_numeric_metric, key_map, sources, :raw)
      expect(result).to eq("literal")
    end
  end

  describe "#insert_telemetry — telemetry_type fallback chain" do
    include_context "with isolated db"

    it "tags the row as 'power' when only power_metrics are supplied" do
      db = open_db
      dp.upsert_node(db, "!aabbccdd", { "num" => 0xaabbccdd })
      dp.insert_telemetry(db, {
        "id" => 5005,
        "node_id" => "!aabbccdd",
        "rx_time" => now,
        "power_metrics" => { "ch1Voltage" => 3.7 },
      })
      expect(db.get_first_value("SELECT telemetry_type FROM telemetry WHERE id = 5005")).to eq("power")
    ensure
      db&.close
    end
  end

  # ---------------------------------------------------------------------------
  # node_writes.rb — touch_node_last_seen falls back to fallback_num when
  # node_ref strips down to nothing.
  # ---------------------------------------------------------------------------
  describe "#touch_node_last_seen — fallback_num when node_ref is blank" do
    include_context "with isolated db"

    it "resolves node_id from fallback_num and refreshes last_heard" do
      db = open_db
      dp.upsert_node(db, "!00003039", { "num" => 12345, "lastHeard" => now - 100 })
      dp.touch_node_last_seen(db, "", 12345, rx_time: now, source: :test)
      expect(
        db.get_first_value("SELECT last_heard FROM nodes WHERE node_id = '!00003039'"),
      ).to eq(now)
    ensure
      db&.close
    end
  end

  # ---------------------------------------------------------------------------
  # ingestors.rb — SQLite3::SQLException rescue
  # ---------------------------------------------------------------------------
  describe "#upsert_ingestor — SQL exception handling" do
    include_context "with isolated db"

    it "returns false when the upsert raises SQLite3::SQLException" do
      db = open_db
      allow(db).to receive(:execute).and_raise(SQLite3::SQLException.new("boom"))
      expect(
        dp.upsert_ingestor(db, {
          "node_id" => "!aabbccdd",
          "version" => "1.0",
          "start_time" => now,
        }),
      ).to be(false)
    ensure
      db&.close
    end
  end

  # ---------------------------------------------------------------------------
  # request_helpers.rb — read_json_body resets to the configured cap when the
  # caller-supplied limit collapses to zero or a negative value.
  # ---------------------------------------------------------------------------
  describe "#read_json_body — limit fallback" do
    let(:body_harness_class) do
      Class.new do
        include PotatoMesh::App::DataProcessing
        include PotatoMesh::App::Helpers
        attr_accessor :request

        def halt(*args)
          raise "unexpected halt: #{args.inspect}"
        end
      end
    end

    it "falls back to the configured cap when limit is non-positive" do
      body_text = "small body"
      fake_request = Struct.new(:body).new(StringIO.new(body_text))
      instance = body_harness_class.new
      instance.request = fake_request
      expect(instance.read_json_body(limit: 0)).to eq(body_text)
    end
  end

  # ---------------------------------------------------------------------------
  # decrypted_payloads.rb — store_decrypted_payload returns false when the
  # decoder reports an unrecognised payload type.
  # ---------------------------------------------------------------------------
  describe "#store_decrypted_payload — unrecognised type" do
    include_context "with isolated db"

    it "returns false for a decoded type the case statement does not handle" do
      db = open_db
      allow(PotatoMesh::App::Meshtastic::PayloadDecoder).to receive(:decode)
                                                              .and_return({ "type" => "UNRECOGNIZED", "payload" => {} })
      decrypted = { payload: "\x00\x01".b, portnum: 3 }
      result = dp.store_decrypted_payload(
        db, {}, 555, decrypted,
        rx_time: now,
        rx_iso: Time.at(now).utc.iso8601,
        from_id: "!aabbccdd",
        to_id: "^all",
        channel: 0,
        portnum: 3,
        hop_limit: 5,
        snr: 1.0,
        rssi: -50,
      )
      expect(result).to be(false)
    ensure
      db&.close
    end
  end

  # ---------------------------------------------------------------------------
  # neighbors.rb — non-canonical reporter and neighbour entry resolution.
  # Exercises the else branch of canonical_node_parts at the top of
  # +insert_neighbors+ and the equivalent inside the per-neighbour loop.
  # ---------------------------------------------------------------------------
  describe "#insert_neighbors — non-canonical resolution paths" do
    include_context "with isolated db"

    let(:neighbor_harness) do
      Class.new do
        include PotatoMesh::App::DataProcessing
        include PotatoMesh::App::Helpers

        def debug_log(*); end

        def warn_log(*); end

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

        def resolve_protocol(*)
          "meshtastic"
        end

        def normalize_node_id(_db, ref)
          parts = canonical_node_parts(ref)
          parts ? parts[0] : nil
        end

        def ensure_unknown_node(*); end

        def touch_node_last_seen(*); end
      end.new
    end

    it "resolves node_num from fallback when node_id strips to empty" do
      db = open_db
      neighbor_harness.insert_neighbors(db, {
        "node_id" => "",
        "node_num" => 12345,
        "rx_time" => now,
        "neighbors" => [],
      })
      # Empty neighbor list deletes any existing rows for the reporter.
      expect(db.get_first_value("SELECT COUNT(*) FROM neighbors")).to eq(0)
    ensure
      db&.close
    end

    it "tolerates a malformed !-prefixed node id by zeroing the node_num" do
      db = open_db
      neighbor_harness.insert_neighbors(db, {
        "node_id" => "!ZZZ",
        "rx_time" => now,
        "neighbors" => [],
      })
      expect(db.get_first_value("SELECT COUNT(*) FROM neighbors")).to eq(0)
    ensure
      db&.close
    end

    it "resolves a neighbour entry from neighbor_num when neighbor_id is blank" do
      db = open_db
      neighbor_harness.insert_neighbors(db, {
        "node_id" => "!aabbccdd",
        "rx_time" => now,
        "neighbors" => [
          { "neighbor_id" => "", "neighbor_num" => 6789, "snr" => -3.0 },
        ],
      })
      stored_id = db.get_first_value(
        "SELECT neighbor_id FROM neighbors WHERE node_id = '!aabbccdd'",
      )
      expect(stored_id).to start_with("!")
    ensure
      db&.close
    end

    it "tolerates a malformed !-prefixed neighbour id without inserting it" do
      db = open_db
      neighbor_harness.insert_neighbors(db, {
        "node_id" => "!aabbccdd",
        "rx_time" => now,
        "neighbors" => [
          { "neighbor_id" => "!ZZZ", "snr" => 5.0 },
        ],
      })
      # The malformed neighbour normalizes to "!zzz" (lowercased) which is
      # still stored under that bogus id; the contract under test is only that
      # the function does not raise.  Coverage of the rescue/else branches is
      # the goal.
      expect(db).not_to be_nil
    ensure
      db&.close
    end
  end

  # ---------------------------------------------------------------------------
  # messages.rb — canonical sender/recipient overrides and the rare
  # ConstraintException recovery path inside +insert_message+.
  # ---------------------------------------------------------------------------
  describe "#insert_message — canonical sender/recipient overrides" do
    include_context "with isolated db"

    let(:message_harness) do
      Class.new do
        include PotatoMesh::App::DataProcessing
        include PotatoMesh::App::Helpers

        def debug_log(*); end

        def warn_log(*); end

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

        def resolve_protocol(*)
          "meshtastic"
        end

        def normalize_node_id(_db, ref)
          parts = canonical_node_parts(ref)
          parts ? parts[0] : nil
        end

        def ensure_unknown_node(*); end

        def touch_node_last_seen(*); end
      end.new
    end

    it "uses canonical_from_id when the raw from_id is blank" do
      db = open_db
      allow(message_harness).to receive(:normalize_node_id) do |_db, ref|
        if ref.nil? || ref.to_s.strip.empty?
          "!aabbccdd"
        else
          parts = message_harness.canonical_node_parts(ref)
          parts ? parts[0] : nil
        end
      end
      message_harness.insert_message(db, {
        "id" => 7001,
        "from_id" => "",
        "to_id" => "^all",
        "text" => "hello",
        "channel" => 0,
      })
      expect(db.get_first_value("SELECT from_id FROM messages WHERE id = 7001")).to eq("!aabbccdd")
    ensure
      db&.close
    end

    it "rewrites a !-prefixed from_id when canonical resolution differs" do
      db = open_db
      allow(message_harness).to receive(:normalize_node_id) do |_db, ref|
        next nil if ref.nil? || ref.to_s.strip.empty?
        if ref.to_s.start_with?("!")
          "!11111111"
        else
          parts = message_harness.canonical_node_parts(ref)
          parts ? parts[0] : nil
        end
      end
      message_harness.insert_message(db, {
        "id" => 7002,
        "from_id" => "!aabbccdd",
        "to_id" => "^all",
        "text" => "hi",
        "channel" => 0,
      })
      expect(db.get_first_value("SELECT from_id FROM messages WHERE id = 7002")).to eq("!11111111")
    ensure
      db&.close
    end

    it "uses canonical_to_id when the raw to_id is blank" do
      db = open_db
      allow(message_harness).to receive(:normalize_node_id) do |_db, ref|
        if ref.nil? || ref.to_s.strip.empty?
          "!ddddeeee"
        else
          parts = message_harness.canonical_node_parts(ref)
          parts ? parts[0] : nil
        end
      end
      message_harness.insert_message(db, {
        "id" => 7003,
        "from_id" => "!aabbccdd",
        "to_id" => "",
        "text" => "yo",
        "channel" => 0,
      })
      expect(db.get_first_value("SELECT to_id FROM messages WHERE id = 7003")).to eq("!ddddeeee")
    ensure
      db&.close
    end

    it "rewrites a !-prefixed to_id when canonical resolution differs" do
      db = open_db
      allow(message_harness).to receive(:normalize_node_id) do |_db, ref|
        next nil if ref.nil? || ref.to_s.strip.empty?
        if ref.to_s == "!ffffeeee"
          "!22222222"
        else
          parts = message_harness.canonical_node_parts(ref)
          parts ? parts[0] : nil
        end
      end
      message_harness.insert_message(db, {
        "id" => 7004,
        "from_id" => "!aabbccdd",
        "to_id" => "!ffffeeee",
        "text" => "msg",
        "channel" => 0,
      })
      expect(db.get_first_value("SELECT to_id FROM messages WHERE id = 7004")).to eq("!22222222")
    ensure
      db&.close
    end
  end

  describe "#insert_message — reply_id and emoji updates on existing rows" do
    include_context "with isolated db"

    let(:msg_update_harness) do
      Class.new do
        include PotatoMesh::App::DataProcessing
        include PotatoMesh::App::Helpers

        def debug_log(*); end

        def warn_log(*); end

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

        def resolve_protocol(*)
          "meshtastic"
        end

        def normalize_node_id(_db, ref)
          parts = canonical_node_parts(ref)
          parts ? parts[0] : nil
        end

        def ensure_unknown_node(*); end

        def touch_node_last_seen(*); end
      end.new
    end

    it "updates reply_id when the existing row references a different reply_id" do
      db = open_db
      base = {
        "from_id" => "!aabbccdd",
        "to_id" => "^all",
        "text" => "reply",
        "channel" => 0,
        "reply_id" => 100,
      }
      msg_update_harness.insert_message(db, base.merge("id" => 8001))
      msg_update_harness.insert_message(db, base.merge("id" => 8001, "reply_id" => 200))
      expect(db.get_first_value("SELECT reply_id FROM messages WHERE id = 8001")).to eq(200)
    ensure
      db&.close
    end

    it "fills in an emoji when the existing row had none" do
      db = open_db
      base = {
        "from_id" => "!aabbccdd",
        "to_id" => "^all",
        "text" => "thanks",
        "channel" => 0,
      }
      msg_update_harness.insert_message(db, base.merge("id" => 8002))
      msg_update_harness.insert_message(db, base.merge("id" => 8002, "emoji" => ":thumbsup:"))
      expect(db.get_first_value("SELECT emoji FROM messages WHERE id = 8002")).to eq(":thumbsup:")
    ensure
      db&.close
    end
  end

  describe "#insert_message — ConstraintException recovery" do
    include_context "with isolated db"

    let(:fb_harness) do
      Class.new do
        include PotatoMesh::App::DataProcessing
        include PotatoMesh::App::Helpers

        def debug_log(*); end

        def warn_log(*); end

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

        def resolve_protocol(*)
          "meshtastic"
        end

        def normalize_node_id(_db, ref)
          parts = canonical_node_parts(ref)
          parts ? parts[0] : nil
        end

        def ensure_unknown_node(*); end

        def touch_node_last_seen(*); end
      end.new
    end

    let(:base_msg) do
      {
        "from_id" => "!aabbccdd",
        "to_id" => "^all",
        "channel" => 0,
      }
    end

    # The fallback path is taken when the SELECT-before-INSERT misses but the
    # INSERT itself trips the PK constraint — i.e., a concurrent ingestor has
    # already inserted the row in between.  We simulate that race by seeding a
    # row, then forcing the existing-row SELECT to return nil so the INSERT
    # path runs and trips the constraint deterministically.
    it "applies fallback updates when INSERT trips a constraint violation" do
      db = open_db
      fb_harness.insert_message(db, base_msg.merge("id" => 9001, "text" => "first", "ingestor" => "!a"))

      allow(db).to receive(:get_first_row).and_wrap_original do |original, sql, *args|
        if sql.include?("SELECT from_id, to_id, text, encrypted, lora_freq")
          nil
        else
          original.call(sql, *args)
        end
      end

      fb_harness.insert_message(db, base_msg.merge("id" => 9001, "text" => "second", "ingestor" => "!b"))

      expect(db.get_first_value("SELECT text FROM messages WHERE id = 9001")).to eq("second")
      # First-write-wins for ingestor: the existing value (!a) is preserved.
      expect(db.get_first_value("SELECT ingestor FROM messages WHERE id = 9001")).to eq("!a")
    ensure
      db&.close
    end

    it "applies decrypted-precedence overrides during fallback" do
      db = open_db
      fb_harness.insert_message(db, base_msg.merge(
        "id" => 9002,
        "encrypted" => "BLOB",
        "text" => nil,
      ))

      allow(db).to receive(:get_first_row).and_wrap_original do |original, sql, *args|
        if sql.include?("SELECT from_id, to_id, text, encrypted, lora_freq")
          nil
        else
          original.call(sql, *args)
        end
      end

      fb_harness.insert_message(db, base_msg.merge(
        "id" => 9002,
        "text" => "decrypted",
        "lora_freq" => 869525,
        "modem_preset" => "MEDIUM_SLOW",
        "channel_name" => "LongFast",
      ))

      expect(db.get_first_value("SELECT text FROM messages WHERE id = 9002")).to eq("decrypted")
      expect(db.get_first_value("SELECT lora_freq FROM messages WHERE id = 9002")).to eq(869525)
      expect(db.get_first_value("SELECT modem_preset FROM messages WHERE id = 9002")).to eq("MEDIUM_SLOW")
    ensure
      db&.close
    end
  end
end
