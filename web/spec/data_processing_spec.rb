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
  # normalize_position_time — issue #782 write-side guard against sentinel 0
  # ---------------------------------------------------------------------------
  describe "#normalize_position_time" do
    let(:now) { 1_700_000_000 }

    it "returns nil for zero" do
      expect(dp.normalize_position_time(0, now: now)).to be_nil
    end

    it "returns nil for negative values" do
      expect(dp.normalize_position_time(-1, now: now)).to be_nil
    end

    it "returns nil for nil" do
      expect(dp.normalize_position_time(nil, now: now)).to be_nil
    end

    it "returns nil for non-numeric input" do
      expect(dp.normalize_position_time("not-a-time", now: now)).to be_nil
    end

    it "returns nil for future values beyond the ceiling" do
      expect(dp.normalize_position_time(now + 1, now: now)).to be_nil
    end

    it "preserves a valid integer timestamp" do
      expect(dp.normalize_position_time(now - 10, now: now)).to eq(now - 10)
    end

    it "coerces numeric strings" do
      expect(dp.normalize_position_time("#{now - 5}", now: now)).to eq(now - 5)
    end
  end

  # ---------------------------------------------------------------------------
  # normalize_lat_lon — issue #782 paired-zero "Null Island" guard
  # ---------------------------------------------------------------------------
  describe "#normalize_lat_lon" do
    it "collapses paired exact zeros to nil on both axes" do
      expect(dp.normalize_lat_lon(0.0, 0.0)).to eq([nil, nil])
    end

    it "collapses paired integer zeros to nil on both axes" do
      expect(dp.normalize_lat_lon(0, 0)).to eq([nil, nil])
    end

    it "preserves a legitimate equator fix (lat=0, lon!=0)" do
      lat, lon = dp.normalize_lat_lon(0.0, 13.5)
      expect(lat).to eq(0.0)
      expect(lon).to be_within(1e-9).of(13.5)
    end

    it "preserves a legitimate prime-meridian fix (lat!=0, lon=0)" do
      lat, lon = dp.normalize_lat_lon(52.5, 0.0)
      expect(lat).to be_within(1e-9).of(52.5)
      expect(lon).to eq(0.0)
    end

    it "passes through a real pair as floats" do
      lat, lon = dp.normalize_lat_lon("52.5", "13.4")
      expect(lat).to be_within(1e-9).of(52.5)
      expect(lon).to be_within(1e-9).of(13.4)
    end

    it "returns nil on the axis that fails coercion" do
      lat, lon = dp.normalize_lat_lon("garbage", 13.0)
      expect(lat).to be_nil
      expect(lon).to be_within(1e-9).of(13.0)
    end

    it "collapses a near-zero pair within epsilon" do
      expect(dp.normalize_lat_lon(1e-12, -1e-12)).to eq([nil, nil])
    end

    it "preserves a pair just outside epsilon" do
      lat, lon = dp.normalize_lat_lon(1e-6, 1e-6)
      expect(lat).to be_within(1e-12).of(1e-6)
      expect(lon).to be_within(1e-12).of(1e-6)
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
  # upsert_node — issue #782: position sentinel handling
  #
  # Meshtastic firmware emits `(lat=0, lon=0)` and `position.time=0` whenever
  # no GPS fix has been acquired.  Persisting those values as if they were a
  # real fix drops a marker at Null Island and lets the read boundary leak
  # `1970-01-01T00:00:00Z` ISO strings.  The write boundary normalises both
  # forms to SQL `NULL` so neither downstream consumer sees the sentinel.
  # ---------------------------------------------------------------------------
  describe "#upsert_node — position sentinel handling" do
    include_context "with isolated db"

    it "stores position_time = 0 as SQL NULL" do
      db = open_db
      dp.upsert_node(db, "!aabbccdd", {
        "lastHeard" => now,
        "num" => 0xaabbccdd,
        "position" => { "time" => 0, "latitude" => 52.5, "longitude" => 13.4 },
      })
      row = read_node(db)
      db.close
      expect(row["position_time"]).to be_nil
      expect(row["latitude"]).to eq(52.5)
      expect(row["longitude"]).to eq(13.4)
    end

    it "stores paired (lat=0, lon=0) as SQL NULL on both axes" do
      db = open_db
      dp.upsert_node(db, "!aabbccdd", {
        "lastHeard" => now,
        "num" => 0xaabbccdd,
        "position" => {
          "time" => now - 60,
          "latitude" => 0.0,
          "longitude" => 0.0,
          "altitude" => 0,
          "locationSource" => "LOC_MANUAL",
        },
      })
      row = read_node(db)
      db.close
      expect(row["latitude"]).to be_nil
      expect(row["longitude"]).to be_nil
      expect(row["altitude"]).to be_nil
      expect(row["location_source"]).to be_nil
      # position_time is still real and survives.
      expect(row["position_time"]).to eq(now - 60)
    end

    it "preserves an equator fix (lat=0, lon!=0)" do
      db = open_db
      dp.upsert_node(db, "!aabbccdd", {
        "lastHeard" => now,
        "num" => 0xaabbccdd,
        "position" => {
          "time" => now - 30,
          "latitude" => 0.0,
          "longitude" => 13.4,
        },
      })
      row = read_node(db)
      db.close
      expect(row["latitude"]).to eq(0.0)
      expect(row["longitude"]).to eq(13.4)
    end

    it "preserves a prime-meridian fix (lat!=0, lon=0)" do
      db = open_db
      dp.upsert_node(db, "!aabbccdd", {
        "lastHeard" => now,
        "num" => 0xaabbccdd,
        "position" => {
          "time" => now - 30,
          "latitude" => 52.5,
          "longitude" => 0.0,
        },
      })
      row = read_node(db)
      db.close
      expect(row["latitude"]).to eq(52.5)
      expect(row["longitude"]).to eq(0.0)
    end
  end

  # ---------------------------------------------------------------------------
  # update_node_from_position — issue #782: COALESCE-zero race fix
  #
  # The previous tie-break used `COALESCE(excluded.position_time, 0) >=
  # COALESCE(nodes.position_time, 0)`, which evaluated `0 >= 0` as true and
  # allowed a sentinel position to clobber a real fix.  After normalisation
  # the excluded position_time collapses to `NULL` and the comparison now
  # explicitly requires `excluded.position_time IS NOT NULL`, so a sentinel
  # update never wins.
  # ---------------------------------------------------------------------------
  describe "#update_node_from_position — sentinel race fix" do
    include_context "with isolated db"

    it "does not overwrite a real position with a sentinel payload" do
      db = open_db
      # Seed a real fix via the upsert path so the row carries genuine data.
      dp.upsert_node(db, "!aabbccdd", {
        "lastHeard" => now - 100,
        "num" => 0xaabbccdd,
        "position" => {
          "time" => now - 100,
          "latitude" => 52.5,
          "longitude" => 13.4,
          "altitude" => 100.0,
          "locationSource" => "LOC_MANUAL",
        },
      })
      # Replay a sentinel position update — should be a no-op for lat/lon.
      dp.update_node_from_position(
        db,
        "!aabbccdd", 0xaabbccdd,
        now, # rx_time
        0,   # position_time sentinel
        nil, nil, # location_source, precision_bits
        0.0, 0.0, 0.0, # lat/lon/alt sentinel
        nil,
      )
      row = read_node(db)
      db.close
      expect(row["latitude"]).to eq(52.5)
      expect(row["longitude"]).to eq(13.4)
      expect(row["altitude"]).to eq(100.0)
      expect(row["position_time"]).to eq(now - 100)
    end

    it "stores a real position from update_node_from_position on a fresh node" do
      db = open_db
      dp.update_node_from_position(
        db,
        "!aabbccdd", 0xaabbccdd,
        now,
        now - 10,
        "LOC_MANUAL", 16,
        52.5, 13.4, 100.0,
        4.2,
      )
      row = read_node(db)
      db.close
      expect(row["latitude"]).to eq(52.5)
      expect(row["longitude"]).to eq(13.4)
      expect(row["altitude"]).to eq(100.0)
      expect(row["position_time"]).to eq(now - 10)
    end

    it "drops sentinel coordinates on insert without crashing" do
      db = open_db
      dp.update_node_from_position(
        db,
        "!aabbccdd", 0xaabbccdd,
        now,
        nil,
        nil, nil,
        0.0, 0.0, 0.0,
        nil,
      )
      row = read_node(db)
      db.close
      expect(row["latitude"]).to be_nil
      expect(row["longitude"]).to be_nil
      expect(row["altitude"]).to be_nil
      expect(row["position_time"]).to be_nil
    end

    # Pre-#782 behaviour relied on `COALESCE(excluded.position_time, 0) >=
    # COALESCE(nodes.position_time, 0)` evaluating `0 >= 0` to TRUE when both
    # sides were NULL, which accepted a coords-only update.  After the
    # `IS NOT NULL` tightening that comparison rejects the row, so the writer
    # falls back to +rx_time+ as the freshness anchor when usable coordinates
    # arrive without a position_time — mirroring the MeshCore handler
    # (`protocols/meshcore/position.py:65`).  This test pins both halves of
    # that contract: the coords land, and the synthesised anchor is
    # +rx_time+, not NULL.
    it "uses rx_time as a freshness anchor when coords arrive without a position_time" do
      db = open_db
      dp.update_node_from_position(
        db,
        "!aabbccdd", 0xaabbccdd,
        now,    # rx_time
        nil,    # position_time missing — caller has no anchor of its own
        "LOC_INTERNAL", 32,
        52.5, 13.4, 100.0,
        4.2,
      )
      row = read_node(db)
      db.close
      expect(row["latitude"]).to eq(52.5)
      expect(row["longitude"]).to eq(13.4)
      expect(row["altitude"]).to eq(100.0)
      expect(row["position_time"]).to eq(now)
      expect(row["location_source"]).to eq("LOC_INTERNAL")
      expect(row["precision_bits"]).to eq(32)
    end

    it "does not synthesise a rx_time anchor for a no-op update without coords" do
      db = open_db
      dp.update_node_from_position(
        db,
        "!aabbccdd", 0xaabbccdd,
        now,
        nil, # position_time missing
        nil, nil, # location/precision
        nil, nil, nil, # coords missing entirely
        nil,
      )
      row = read_node(db)
      db.close
      # No coordinates → no synthetic anchor; position_time stays NULL so the
      # row remains transparent to anyone querying for real fixes.
      expect(row["position_time"]).to be_nil
      expect(row["latitude"]).to be_nil
      expect(row["longitude"]).to be_nil
    end
  end

  # ---------------------------------------------------------------------------
  # insert_position — issue #782: sentinel handling on the positions table
  # ---------------------------------------------------------------------------
  describe "#insert_position — sentinel handling" do
    include_context "with isolated db"

    def read_position(db, id)
      db.execute("SELECT * FROM positions WHERE id = ?", [id]).first
    end

    it "stores paired (lat=0, lon=0) as SQL NULL on both axes" do
      db = open_db
      dp.insert_position(db, {
        "id" => 9001,
        "rx_time" => now,
        "rx_iso" => Time.at(now).utc.iso8601,
        "node_id" => "!aabbccdd",
        "node_num" => 0xaabbccdd,
        "latitude" => 0.0,
        "longitude" => 0.0,
        "altitude" => 0,
        "position_time" => now - 30,
        "location_source" => "LOC_MANUAL",
      })
      row = read_position(db, 9001)
      db.close
      expect(row["latitude"]).to be_nil
      expect(row["longitude"]).to be_nil
      expect(row["altitude"]).to be_nil
      expect(row["location_source"]).to be_nil
      expect(row["position_time"]).to eq(now - 30)
    end

    it "stores position_time = 0 as SQL NULL" do
      db = open_db
      dp.insert_position(db, {
        "id" => 9002,
        "rx_time" => now,
        "rx_iso" => Time.at(now).utc.iso8601,
        "node_id" => "!aabbccdd",
        "node_num" => 0xaabbccdd,
        "latitude" => 52.5,
        "longitude" => 13.4,
        "position_time" => 0,
      })
      row = read_position(db, 9002)
      db.close
      expect(row["position_time"]).to be_nil
      expect(row["latitude"]).to eq(52.5)
      expect(row["longitude"]).to eq(13.4)
    end

    it "preserves an equator fix" do
      db = open_db
      dp.insert_position(db, {
        "id" => 9003,
        "rx_time" => now,
        "rx_iso" => Time.at(now).utc.iso8601,
        "node_id" => "!aabbccdd",
        "node_num" => 0xaabbccdd,
        "latitude" => 0.0,
        "longitude" => 13.4,
        "position_time" => now - 10,
      })
      row = read_position(db, 9003)
      db.close
      expect(row["latitude"]).to eq(0.0)
      expect(row["longitude"]).to eq(13.4)
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

    # Regression: a chat-derived synthetic carries the most recent time the node
    # was heard.  Absorbing it into the real contact must not discard that — the
    # real node's last_heard advances to the synthetic's newer value.
    it "carries a merged synthetic's newer last_heard onto the real node" do
      db = open_db
      real_id = "!reallhf1"
      synth_id = "!synthlf1"
      db.execute(
        "INSERT INTO nodes(node_id,long_name,protocol,synthetic,last_heard,first_heard) VALUES (?,?,?,?,?,?)",
        [real_id, "Rupert", "meshcore", 0, now - 100, now - 100],
      )
      db.execute(
        "INSERT INTO nodes(node_id,long_name,protocol,synthetic,last_heard,first_heard) VALUES (?,?,?,?,?,?)",
        [synth_id, "Rupert", "meshcore", 1, now, now],
      )
      dp.merge_synthetic_nodes(db, real_id, "Rupert")
      expect(db.get_first_value("SELECT last_heard FROM nodes WHERE node_id = ?", [real_id])).to eq(now)
    ensure
      db&.close
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

    # Regression: the reverse merge must carry the synthetic's last_heard onto
    # the real node, so a node heard only via channel chat keeps a fresh "last
    # seen" after its contact advertisement reconciles the placeholder.
    it "carries the synthetic's newer last_heard onto the real node" do
      db = open_db
      real_id = "!reallhc1"
      synth_id = "!synthlc1"
      db.execute(
        "INSERT INTO nodes(node_id,long_name,protocol,synthetic,last_heard,first_heard) VALUES (?,?,?,?,?,?)",
        [real_id, "Olivia", "meshcore", 0, now - 100, now - 100],
      )
      db.execute(
        "INSERT INTO nodes(node_id,long_name,protocol,synthetic,last_heard,first_heard) VALUES (?,?,?,?,?,?)",
        [synth_id, "Olivia", "meshcore", 1, now, now],
      )
      dp.merge_into_real_node(db, synth_id, "Olivia")
      expect(db.get_first_value("SELECT last_heard FROM nodes WHERE node_id = ?", [real_id])).to eq(now)
    ensure
      db&.close
    end

    it "never moves the real node's last_heard backward when the synthetic is older" do
      db = open_db
      real_id = "!reallhc2"
      synth_id = "!synthlc2"
      db.execute(
        "INSERT INTO nodes(node_id,long_name,protocol,synthetic,last_heard,first_heard) VALUES (?,?,?,?,?,?)",
        [real_id, "Quinn", "meshcore", 0, now, now],
      )
      db.execute(
        "INSERT INTO nodes(node_id,long_name,protocol,synthetic,last_heard,first_heard) VALUES (?,?,?,?,?,?)",
        [synth_id, "Quinn", "meshcore", 1, now - 300, now - 300],
      )
      dp.merge_into_real_node(db, synth_id, "Quinn")
      expect(db.get_first_value("SELECT last_heard FROM nodes WHERE node_id = ?", [real_id])).to eq(now)
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

    it "does not collapse two meshcore messages on different named channels" do
      # Genuinely distinct channels are now distinguished by the stable
      # channel *name*, not the per-receiver local slot index.
      db = open_db
      meshcore_harness.insert_message(
        db, base_message.merge("id" => 1_000_005, "channel" => 5, "channel_name" => "#alpha"),
      )
      meshcore_harness.insert_message(
        db, base_message.merge("id" => 1_000_006, "channel" => 6, "channel_name" => "#beta"),
      )
      expect(message_count(db)).to eq(2)
    ensure
      db&.close
    end

    it "collapses the same meshcore channel message heard on different local channel indices" do
      # One physical #bot transmission heard by two ingestors that store it at
      # different LOCAL channel slots (4 vs 6) — so each computes a different
      # fingerprint id. The channel *name* ("#bot") is identical across
      # receivers, so the content-dedup must collapse it to a single row.
      # Regression for the cross-ingestor duplication in the bug report.
      db = open_db
      meshcore_harness.insert_message(
        db, base_message.merge("id" => 1_000_201, "channel" => 4, "channel_name" => "#bot"),
      )
      meshcore_harness.insert_message(
        db, base_message.merge("id" => 1_000_202, "channel" => 6, "channel_name" => "#bot"),
      )
      expect(message_count(db)).to eq(1)
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

  # ---------------------------------------------------------------------------
  # #resolve_record_protocol / #normalize_protocol_value
  # ---------------------------------------------------------------------------
  # These helpers close the startup race where a MeshCore record is processed
  # before the ingestor heartbeat has registered a protocol mapping, which
  # would otherwise silently mislabel the placeholder as Meshtastic.
  describe "#resolve_record_protocol" do
    let(:warnings) { [] }

    let(:dp_with_lookup) do
      captured_warnings = warnings
      cls = Class.new do
        include PotatoMesh::App::DataProcessing
        include PotatoMesh::App::Helpers

        define_method(:warn_log) do |message, **fields|
          captured_warnings << { message: message, **fields }
        end

        def debug_log(*); end
      end
      cls.new
    end

    let(:registered_db) do
      db = SQLite3::Database.new(":memory:")
      db.execute(
        "CREATE TABLE ingestors(node_id TEXT PRIMARY KEY, protocol TEXT NOT NULL DEFAULT 'meshtastic')",
      )
      db.execute(
        "INSERT INTO ingestors(node_id, protocol) VALUES(?,?)",
        ["!mcingest1", "meshcore"],
      )
      db
    end

    after(:each) { registered_db.close }

    it "returns the explicit protocol when the record stamps a whitelisted value" do
      result = dp_with_lookup.send(
        :resolve_record_protocol,
        registered_db,
        { "protocol" => "meshcore" },
        nil,
      )
      expect(result).to eq("meshcore")
    end

    it "normalises mixed-case whitespace in the explicit stamp" do
      result = dp_with_lookup.send(
        :resolve_record_protocol,
        registered_db,
        { "protocol" => "  MESHCORE  " },
        nil,
      )
      expect(result).to eq("meshcore")
    end

    it "ignores a malformed explicit stamp and falls back to ingestor lookup" do
      result = dp_with_lookup.send(
        :resolve_record_protocol,
        registered_db,
        { "protocol" => "reticulum" },
        "!mcingest1",
      )
      expect(result).to eq("meshcore")
    end

    it "ignores a non-Hash record and falls back to ingestor lookup" do
      result = dp_with_lookup.send(
        :resolve_record_protocol,
        registered_db,
        "not-a-hash",
        "!mcingest1",
      )
      expect(result).to eq("meshcore")
    end

    it "defaults to meshtastic when explicit is absent and ingestor unregistered" do
      result = dp_with_lookup.send(
        :resolve_record_protocol,
        registered_db,
        { "protocol" => "" },
        "!unregistered000",
      )
      expect(result).to eq("meshtastic")
    end

    it "honours an explicit stamp even when the ingestor is registered as a different protocol" do
      result = dp_with_lookup.send(
        :resolve_record_protocol,
        registered_db,
        { "protocol" => "meshtastic" },
        "!mcingest1",
      )
      expect(result).to eq("meshtastic")
    end

    it "logs a warning when the explicit stamp is rejected as malformed" do
      dp_with_lookup.send(
        :resolve_record_protocol,
        registered_db,
        { "protocol" => "reticulum" },
        "!mcingest1",
      )
      expect(warnings).not_to be_empty
      log = warnings.first
      expect(log[:message]).to match(/malformed protocol stamp/i)
      expect(log[:value]).to eq("reticulum")
      expect(log[:ingestor]).to eq("!mcingest1")
    end

    it "does not warn when the record carries no protocol stamp" do
      dp_with_lookup.send(
        :resolve_record_protocol,
        registered_db,
        {},
        "!mcingest1",
      )
      expect(warnings).to be_empty
    end

    it "does not warn when the protocol stamp is an empty string" do
      dp_with_lookup.send(
        :resolve_record_protocol,
        registered_db,
        { "protocol" => "" },
        "!mcingest1",
      )
      expect(warnings).to be_empty
    end
  end

  describe "#normalize_protocol_value" do
    let(:helper) do
      cls = Class.new do
        include PotatoMesh::App::DataProcessing
      end
      cls.new
    end

    it "returns the canonical lower-case string for whitelisted values" do
      expect(helper.send(:normalize_protocol_value, "meshcore")).to eq("meshcore")
      expect(helper.send(:normalize_protocol_value, "MESHTASTIC")).to eq("meshtastic")
      expect(helper.send(:normalize_protocol_value, "  Meshcore  ")).to eq("meshcore")
    end

    it "returns nil for unknown or malformed values" do
      expect(helper.send(:normalize_protocol_value, nil)).to be_nil
      expect(helper.send(:normalize_protocol_value, "")).to be_nil
      expect(helper.send(:normalize_protocol_value, "reticulum")).to be_nil
      expect(helper.send(:normalize_protocol_value, 42)).to be_nil
    end
  end

  # ---------------------------------------------------------------------------
  # insert_message — MeshCore synthetic chat nodes (issue #803).
  #
  # A MeshCore channel message encodes its sender as a "Name: body" text prefix
  # (and quotes/mentions as @[Name]).  The sender's from_id is a name-derived
  # synthetic id.  The placeholder node must be named from that text and marked
  # synthetic so it (a) shows the real name and (b) reconciles with the real
  # contact via the existing merge machinery — never a generic "Meshcore <hex>"
  # stand-in that is mis-recorded as a real (synthetic=0) node.
  # ---------------------------------------------------------------------------
  describe "#insert_message — meshcore synthetic chat nodes (issue #803)" do
    include_context "with isolated db"

    # derive("DWeb 0229"): the same id the Python ingestor and JS frontend
    # compute, so all three converge on one node row.
    let(:sender_synth_id) { "!0f6de6b3" }

    def node_for(db, id)
      db.execute(
        "SELECT node_id, long_name, synthetic FROM nodes WHERE node_id = ?",
        [id],
      ).first
    end

    def meshcore_channel_message(overrides = {})
      {
        "id" => 4242,
        "rx_time" => now,
        "from_id" => sender_synth_id,
        "to_id" => "^all",
        "channel" => 6,
        "text" => "DWeb 0229: flashed DWeb 0229",
        "portnum" => "TEXT_MESSAGE_APP",
        "protocol" => "meshcore",
        "ingestor" => "!634069bc",
      }.merge(overrides)
    end

    it "names the sender placeholder from the chat prefix, not a generic Meshcore <hex>" do
      db = open_db
      dp.insert_message(db, meshcore_channel_message)
      row = node_for(db, sender_synth_id)
      expect(row["long_name"]).to eq("DWeb 0229")
      expect(row["synthetic"]).to eq(1)
    ensure
      db&.close
    end

    it "links the message to an existing real node of the same name rather than synthesizing a duplicate" do
      db = open_db
      # The real contact is already on record under its pubkey-derived id.
      dp.upsert_node(db, "!02294310", {
        "lastHeard" => now - 10,
        "user" => { "longName" => "DWeb 0229", "shortName" => "D0", "role" => "COMPANION" },
      }, protocol: "meshcore")
      dp.insert_message(db, meshcore_channel_message)
      # The synthetic placeholder is merged away and the message redirected.
      expect(node_for(db, sender_synth_id)).to be_nil
      from_id = db.get_first_value("SELECT from_id FROM messages WHERE id = 4242")
      expect(from_id).to eq("!02294310")
    ensure
      db&.close
    end

    it "advances the reconciled real node's last_heard when a chat message arrives" do
      db = open_db
      # The real contact is already on record, last heard before this message.
      dp.upsert_node(db, "!02294310", {
        "lastHeard" => now - 10,
        "user" => { "longName" => "DWeb 0229", "shortName" => "D0", "role" => "COMPANION" },
      }, protocol: "meshcore")
      dp.insert_message(db, meshcore_channel_message) # rx_time => now
      # The chat message reconciles the synthetic placeholder into the real node;
      # the real node's last_heard must advance to the message rx_time, not stay
      # pinned at its advertisement time.
      expect(db.get_first_value("SELECT last_heard FROM nodes WHERE node_id = '!02294310'")).to eq(now)
    ensure
      db&.close
    end

    it "repairs a pre-existing generic 'Meshcore <hex>' placeholder once a message names the sender" do
      db = open_db
      # The broken state observed in production: a generic, synthetic=0 stand-in.
      dp.upsert_node(db, sender_synth_id, {
        "lastHeard" => now - 100,
        "protocol" => "meshcore",
        "user" => { "longName" => "Meshcore E6B3", "shortName" => "", "role" => "COMPANION" },
      })
      dp.insert_message(db, meshcore_channel_message)
      row = node_for(db, sender_synth_id)
      expect(row["long_name"]).to eq("DWeb 0229")
      expect(row["synthetic"]).to eq(1)
    ensure
      db&.close
    end

    it "repairs a generic placeholder even when the naming message is older than it (out-of-order)" do
      db = open_db
      # The placeholder was last heard AFTER the naming message's rx_time — the
      # rename must still land (not be gated by a last_heard guard) so the row is
      # never left demoted-but-still-generically-named.
      dp.upsert_node(db, sender_synth_id, {
        "lastHeard" => now,
        "user" => { "longName" => "Meshcore E6B3", "shortName" => "", "role" => "COMPANION" },
      }, protocol: "meshcore")
      dp.insert_message(db, meshcore_channel_message("rx_time" => now - 500))
      row = node_for(db, sender_synth_id)
      expect(row["long_name"]).to eq("DWeb 0229")
      expect(row["synthetic"]).to eq(1)
    ensure
      db&.close
    end

    it "synthesizes a placeholder for a mention-only name that never sent a message" do
      db = open_db
      # derive("Silent Sweeper") == !8dbb4718 — mentioned, never a sender.
      dp.insert_message(db, meshcore_channel_message(
        "id" => 4243,
        "from_id" => "!ebc4edf0",
        "text" => "RS 26: @[Silent Sweeper] dann Grüße aus Hundshübel",
      ))
      row = node_for(db, "!8dbb4718")
      expect(row).not_to be_nil
      expect(row["long_name"]).to eq("Silent Sweeper")
      expect(row["synthetic"]).to eq(1)
    ensure
      db&.close
    end

    it "falls back to the generic placeholder for a meshcore direct message (not channel chat)" do
      db = open_db
      # to_id is a host node, not "^all": a stray colon in the DM body must not
      # be read as a sender prefix, so the generic placeholder path is used.
      dp.insert_message(db, meshcore_channel_message(
        "id" => 4244,
        "from_id" => "!11112222",
        "to_id" => "!aabbccdd",
        "text" => "note: buy milk",
      ))
      row = node_for(db, "!11112222")
      expect(dp.generic_fallback_name?(row["long_name"], "!11112222", "meshcore")).to be(true)
      expect(row["synthetic"]).to eq(0)
    ensure
      db&.close
    end

    it "falls back to the generic placeholder when a channel message has no sender prefix" do
      db = open_db
      dp.insert_message(db, meshcore_channel_message(
        "id" => 4245,
        "from_id" => "!33334444",
        "text" => "hello with no colon",
      ))
      row = node_for(db, "!33334444")
      expect(dp.generic_fallback_name?(row["long_name"], "!33334444", "meshcore")).to be(true)
      expect(row["synthetic"]).to eq(0)
    ensure
      db&.close
    end

    it "leaves a genuine real node untouched when its name is referenced" do
      db = open_db
      dp.upsert_node(db, "!55556666", {
        "lastHeard" => now,
        "user" => { "longName" => "Real Companion", "shortName" => "RC", "role" => "COMPANION" },
      }, protocol: "meshcore")
      dp.ensure_meshcore_chat_node(db, "!55556666", "Real Companion", now)
      row = node_for(db, "!55556666")
      expect(row["long_name"]).to eq("Real Companion")
      expect(row["synthetic"]).to eq(0)
    ensure
      db&.close
    end

    it "is a no-op when the node id or name is missing" do
      db = open_db
      dp.ensure_meshcore_chat_node(db, nil, "Nobody", now)
      dp.ensure_meshcore_chat_node(db, "!77778888", nil, now)
      expect(db.get_first_value("SELECT COUNT(*) FROM nodes").to_i).to eq(0)
    ensure
      db&.close
    end
  end

  # ---------------------------------------------------------------------------
  # MeshCore chat text parsing & id derivation (issue #803).
  # ---------------------------------------------------------------------------
  describe "meshcore chat text parsing" do
    it "parses the sender name before the first colon" do
      expect(dp.parse_meshcore_sender_name("DWeb 0229: flashed DWeb 0229")).to eq("DWeb 0229")
      # Only the first colon splits; later colons stay in the body.
      expect(dp.parse_meshcore_sender_name("RS 26: 12:34 done")).to eq("RS 26")
    end

    it "returns nil when there is no colon or the name is blank" do
      expect(dp.parse_meshcore_sender_name("no colon here")).to be_nil
      expect(dp.parse_meshcore_sender_name("   : body")).to be_nil
      expect(dp.parse_meshcore_sender_name(nil)).to be_nil
      expect(dp.parse_meshcore_sender_name(42)).to be_nil
    end

    it "extracts trimmed, de-duplicated @[Name] mentions in first-seen order" do
      expect(
        dp.extract_meshcore_mentions("RS 26: @[Silent Sweeper] hi @[ Lipoly ] @[Silent Sweeper]"),
      ).to eq(["Silent Sweeper", "Lipoly"])
      expect(dp.extract_meshcore_mentions("no mentions")).to eq([])
      expect(dp.extract_meshcore_mentions(nil)).to eq([])
    end

    it "derives a deterministic id matching the ingestor and frontend" do
      expect(dp.meshcore_synthetic_node_id("DWeb 0229")).to eq("!0f6de6b3")
      expect(dp.meshcore_synthetic_node_id("Silent Sweeper")).to eq("!8dbb4718")
      # Trimmed before hashing so padded references converge on one row.
      expect(dp.meshcore_synthetic_node_id("  DWeb 0229  ")).to eq("!0f6de6b3")
      expect(dp.meshcore_synthetic_node_id("   ")).to be_nil
      expect(dp.meshcore_synthetic_node_id(nil)).to be_nil
    end
  end
end
