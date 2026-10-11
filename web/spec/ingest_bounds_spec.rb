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
require "sqlite3"
require_relative "support/data_processing_harness"
require_relative "support/ingest_spec_helpers"

# Ingest input bounds (SPEC IB1-IB4; ACCEPTANCE IB-A1-IB-A4).  A position or
# telemetry section that is no mapping is ignored and its record stored
# without it, so the batch goes on; a coordinate pair off the globe is
# dropped and the rest of its record kept; a neighbour snapshot and a trace
# keep their first 16 entries; a heartbeat's packet count above the cap
# records no activity row, so the activity sums stay in range.
RSpec.describe "Ingest input bounds" do
  include IngestSpecHelpers

  let(:app) { Sinatra::Application }
  let(:api_token) { "ingest-bounds-token" }
  let(:auth_headers) do
    { "CONTENT_TYPE" => "application/json", "HTTP_AUTHORIZATION" => "Bearer #{api_token}" }
  end
  let(:now) { Time.now.to_i }
  # A host for the module methods the unit examples call directly.
  let(:dp) { DataProcessingHarness.build.new }

  before do
    @original_token = ENV["API_TOKEN"]
    ENV["API_TOKEN"] = api_token
    with_db do |db|
      %w[messages nodes positions telemetry neighbors traces trace_hops waypoints ingestors ingestor_activity].each do |table|
        db.execute("DELETE FROM #{table}")
      end
    end
    PotatoMesh::App::ApiCache.invalidate_all
  end

  after do
    @original_token.nil? ? ENV.delete("API_TOKEN") : ENV["API_TOKEN"] = @original_token
    PotatoMesh::App::ApiCache.invalidate_all
  end

  describe "sections that are no mapping (IB1)" do
    it "stores a telemetry record whose section is a string, and the rest of its batch" do
      post_ok("/api/telemetry", [
        { "id" => 9_710_001, "node_id" => "!9a710001", "rx_time" => now, "battery_level" => 50 },
        { "id" => 9_710_002, "node_id" => "!9a710002", "rx_time" => now, "voltage" => 3.9, "telemetry" => "oops" },
        { "id" => 9_710_003, "node_id" => "!9a710003", "rx_time" => now, "battery_level" => 70 },
      ])

      rows = db_rows("SELECT id, battery_level, voltage, telemetry_time FROM telemetry ORDER BY id")
      expect(rows).to eq([
        { "id" => 9_710_001, "battery_level" => 50.0, "voltage" => nil, "telemetry_time" => nil },
        { "id" => 9_710_002, "battery_level" => nil, "voltage" => 3.9, "telemetry_time" => nil },
        { "id" => 9_710_003, "battery_level" => 70.0, "voltage" => nil, "telemetry_time" => nil },
      ])
    end

    it "reads the time and the metrics of a JSON-encoded telemetry section" do
      section = { "time" => now - 120, "deviceMetrics" => { "batteryLevel" => 42 } }.to_json
      post_ok("/api/telemetry", { "id" => 9_710_004, "node_id" => "!9a710004", "rx_time" => now, "telemetry" => section })

      expect(db_row("SELECT battery_level, telemetry_time FROM telemetry WHERE id = 9710004")).to eq(
        "battery_level" => 42.0, "telemetry_time" => now - 120,
      )
    end

    it "ignores a telemetry section that is a list or a JSON-encoded list" do
      post_ok("/api/telemetry", [
        { "id" => 9_710_005, "node_id" => "!9a710005", "rx_time" => now, "battery_level" => 10, "telemetry" => [1, 2] },
        { "id" => 9_710_006, "node_id" => "!9a710006", "rx_time" => now, "battery_level" => 20, "telemetry" => "[1, 2]" },
      ])

      expect(db_rows("SELECT id, battery_level FROM telemetry ORDER BY id")).to eq([
        { "id" => 9_710_005, "battery_level" => 10.0 },
        { "id" => 9_710_006, "battery_level" => 20.0 },
      ])
    end

    it "still reads the time of a telemetry section mapping" do
      post_ok("/api/telemetry", { "id" => 9_710_007, "node_id" => "!9a710007", "rx_time" => now, "telemetry" => { "time" => now - 60, "deviceMetrics" => { "voltage" => 4.1 } } })

      expect(db_row("SELECT voltage, telemetry_time FROM telemetry WHERE id = 9710007")).to eq("voltage" => 4.1, "telemetry_time" => now - 60)
    end

    it "stores a position record whose position.raw is a string, and the rest of its batch" do
      post_ok("/api/positions", [
        { "id" => 9_720_001, "node_id" => "!9a720001", "rx_time" => now, "latitude" => 1.5, "longitude" => 2.5 },
        { "id" => 9_720_002, "node_id" => "!9a720002", "rx_time" => now, "latitude" => 3.5, "longitude" => 4.5, "position" => { "raw" => "oops", "time" => now - 60 } },
        { "id" => 9_720_003, "node_id" => "!9a720003", "rx_time" => now, "latitude" => 5.5, "longitude" => 6.5 },
      ])

      rows = db_rows("SELECT id, latitude, longitude, position_time FROM positions ORDER BY id")
      expect(rows).to eq([
        { "id" => 9_720_001, "latitude" => 1.5, "longitude" => 2.5, "position_time" => nil },
        { "id" => 9_720_002, "latitude" => 3.5, "longitude" => 4.5, "position_time" => now - 60 },
        { "id" => 9_720_003, "latitude" => 5.5, "longitude" => 6.5, "position_time" => nil },
      ])
    end

    it "ignores a position.raw list and a position.payload string and keeps the record" do
      post_ok("/api/positions", [
        { "id" => 9_720_004, "node_id" => "!9a720004", "rx_time" => now, "position" => { "latitude" => 52.5, "longitude" => 13.4, "raw" => [1, 2] } },
        { "id" => 9_720_005, "node_id" => "!9a720005", "rx_time" => now, "latitude" => 52.6, "longitude" => 13.5, "position" => { "payload" => "oops" } },
        { "id" => 9_720_006, "node_id" => "!9a720006", "rx_time" => now, "latitude" => 52.7, "longitude" => 13.6, "position" => "oops" },
      ])

      rows = db_rows("SELECT id, latitude, longitude, payload_b64 FROM positions ORDER BY id")
      expect(rows).to eq([
        { "id" => 9_720_004, "latitude" => 52.5, "longitude" => 13.4, "payload_b64" => nil },
        { "id" => 9_720_005, "latitude" => 52.6, "longitude" => 13.5, "payload_b64" => nil },
        { "id" => 9_720_006, "latitude" => 52.7, "longitude" => 13.6, "payload_b64" => nil },
      ])
    end

    it "still reads position.raw and position.payload mappings" do
      position = {
        "raw" => { "latitude_i" => 525_000_000, "longitude_i" => 134_000_000, "precision_bits" => 13 },
        "payload" => { "__bytes_b64__" => "AQID" },
      }
      post_ok("/api/positions", { "id" => 9_720_007, "node_id" => "!9a720007", "rx_time" => now, "position" => position })

      expect(db_row("SELECT latitude, longitude, precision_bits, payload_b64 FROM positions WHERE id = 9720007")).to eq(
        "latitude" => 52.5, "longitude" => 13.4, "precision_bits" => 13, "payload_b64" => "AQID",
      )
    end

    it "returns a position whose sections are mappings as the same object" do
      record = { "id" => 9_720_008, "node_id" => "!9a720008", "position" => { "raw" => {}, "payload" => {} } }

      expect(dp.bound_position_payload(record)).to equal(record)
    end
  end

  describe "coordinates off the globe (IB2)" do
    it "stores a position off the globe without coordinates and keeps the rest of the record" do
      post_ok("/api/positions", {
        "id" => 9_730_001, "node_id" => "!9a730001", "rx_time" => now,
        "latitude" => 398.761944, "longitude" => 332.909167, "altitude" => 120.0,
        "location_source" => "LOC_INTERNAL", "snr" => 5.5, "sats_in_view" => 7,
      })

      expect(db_row("SELECT latitude, longitude, altitude, location_source, snr, sats_in_view FROM positions WHERE id = 9730001")).to eq(
        "latitude" => nil, "longitude" => nil, "altitude" => nil, "location_source" => nil, "snr" => 5.5, "sats_in_view" => 7,
      )
      expect(db_row("SELECT latitude, longitude FROM nodes WHERE node_id = '!9a730001'")).to eq("latitude" => nil, "longitude" => nil)
    end

    it "drops int32 latitudeI and longitudeI forms off the globe, one axis out being enough" do
      post_ok("/api/positions", [
        { "id" => 9_730_002, "node_id" => "!9a730002", "rx_time" => now, "position" => { "latitudeI" => 2_147_483_647, "longitudeI" => -2_147_483_648 } },
        { "id" => 9_730_003, "node_id" => "!9a730003", "rx_time" => now, "position" => { "latitudeI" => 450_000_000, "longitudeI" => 1_900_000_000 } },
      ])

      expect(db_rows("SELECT id, latitude, longitude FROM positions ORDER BY id")).to eq([
        { "id" => 9_730_002, "latitude" => nil, "longitude" => nil },
        { "id" => 9_730_003, "latitude" => nil, "longitude" => nil },
      ])
    end

    it "keeps coordinates on the poles and the antimeridian" do
      post_ok("/api/positions", [
        { "id" => 9_730_004, "node_id" => "!9a730004", "rx_time" => now, "latitude" => 90.0, "longitude" => 180.0 },
        { "id" => 9_730_005, "node_id" => "!9a730005", "rx_time" => now, "position" => { "latitudeI" => -900_000_000, "longitudeI" => -1_800_000_000 } },
      ])

      expect(db_rows("SELECT id, latitude, longitude FROM positions ORDER BY id")).to eq([
        { "id" => 9_730_004, "latitude" => 90.0, "longitude" => 180.0 },
        { "id" => 9_730_005, "latitude" => -90.0, "longitude" => -180.0 },
      ])
    end

    it "drops a node entry's position off the globe with its altitude and location source" do
      post_ok("/api/nodes", {
        "!9a730006" => {
          "lastHeard" => now,
          "user" => { "longName" => "Far Away", "shortName" => "FA" },
          "position" => { "latitude" => 1000.0, "longitude" => -2000.0, "altitude" => 50.0, "locationSource" => "LOC_MANUAL", "time" => now },
        },
      })

      expect(db_row("SELECT long_name, latitude, longitude, altitude, location_source FROM nodes WHERE node_id = '!9a730006'")).to eq(
        "long_name" => "Far Away", "latitude" => nil, "longitude" => nil, "altitude" => nil, "location_source" => nil,
      )
    end

    it "stores a waypoint off the globe without coordinates" do
      post_ok("/api/waypoints", [
        { "id" => 9_730_007, "node_id" => "!9a730001", "rx_time" => now, "name" => "wp", "latitude" => 95.0, "longitude" => 190.0 },
        { "id" => 9_730_008, "node_id" => "!9a730001", "rx_time" => now, "name" => "wp int", "latitude_i" => 950_000_000, "longitude_i" => 100_000_000 },
      ])

      expect(db_rows("SELECT id, name, latitude, longitude FROM waypoints ORDER BY id")).to eq([
        { "id" => 9_730_007, "name" => "wp", "latitude" => nil, "longitude" => nil },
        { "id" => 9_730_008, "name" => "wp int", "latitude" => nil, "longitude" => nil },
      ])
    end

    it "normalize_lat_lon keeps the globe's edges and drops a pair with either axis beyond them" do
      aggregate_failures do
        expect(dp.normalize_lat_lon(90, 180)).to eq([90.0, 180.0])
        expect(dp.normalize_lat_lon(-90.0, -180.0)).to eq([-90.0, -180.0])
        expect(dp.normalize_lat_lon(90.000001, 13.4)).to eq([nil, nil])
        expect(dp.normalize_lat_lon(52.5, -180.000001)).to eq([nil, nil])
        expect(dp.normalize_lat_lon(45.0, 200.0)).to eq([nil, nil])
        expect(dp.normalize_lat_lon(398.76, nil)).to eq([nil, nil])
        expect(dp.normalize_lat_lon(nil, "200")).to eq([nil, nil])
        expect(dp.normalize_lat_lon(52.5, nil)).to eq([52.5, nil])
      end
    end

    describe "update_node_from_position" do
      include_context "with isolated db"

      it "stores no pair off the globe on the node row" do
        db = open_db
        dp.update_node_from_position(db, "!aabbccdd", 0xaabbccdd, now, now - 10, "LOC_MANUAL", 16, 91.0, 13.4, 100.0, 4.2)
        row = read_node(db)
        db.close

        expect(row.slice("latitude", "longitude", "altitude", "location_source")).to eq(
          "latitude" => nil, "longitude" => nil, "altitude" => nil, "location_source" => nil,
        )
      end
    end
  end

  describe "neighbour and hop lists (IB3)" do
    it "keeps the first 16 entries of a neighbour snapshot" do
      entries = Array.new(500) { |i| { "neighbor_id" => format("!%08x", 0x9b000001 + i), "snr" => 1.0 } }
      post_ok("/api/neighbors", { "node_id" => "!9b000000", "rx_time" => now, "neighbors" => entries })

      kept = db_rows("SELECT neighbor_id FROM neighbors WHERE node_id = '!9b000000' ORDER BY neighbor_id").map { |row| row["neighbor_id"] }
      expect(kept).to eq(entries.first(16).map { |entry| entry["neighbor_id"] })
      expect(db_value("SELECT COUNT(*) FROM nodes")).to eq(17)
    end

    it "counts only entries with legitimate ids toward the 16" do
      entries = [{ "neighbor_id" => "!ZZZ" }] * 4 + Array.new(20) { |i| { "neighbor_id" => format("!%08x", 0x9b100001 + i) } }
      post_ok("/api/neighbors", { "node_id" => "!9b100000", "rx_time" => now, "neighbors" => entries })

      kept = db_rows("SELECT neighbor_id FROM neighbors ORDER BY neighbor_id").map { |row| row["neighbor_id"] }
      expect(kept).to eq(Array.new(16) { |i| format("!%08x", 0x9b100001 + i) })
    end

    it "counts only mappings that name a neighbour toward the 16" do
      # None of these is stored: no mapping, or a mapping whose first
      # reference is blank and that carries no node number (a blank
      # +neighbor_id+ hides the +node_id+ behind it from the write).
      junk = [
        "!9b300001", 42, nil, {}, { "snr" => 1.0 }, { "neighbor_id" => "  " },
        { "neighbor_num" => "abc" }, { "neighbor_id" => "", "node_id" => "!9b3000ff" },
      ]
      entries = junk + Array.new(20) { |i| { "neighbor_id" => format("!%08x", 0x9b300001 + i) } }
      post_ok("/api/neighbors", { "node_id" => "!9b300000", "rx_time" => now, "neighbors" => entries })

      kept = db_rows("SELECT neighbor_id FROM neighbors WHERE node_id = '!9b300000' ORDER BY neighbor_id").map { |row| row["neighbor_id"] }
      expect(kept).to eq(Array.new(16) { |i| format("!%08x", 0x9b300001 + i) })
      expect(db_value("SELECT COUNT(*) FROM nodes")).to eq(17)
    end

    it "gives an entry named by a negative node number no place" do
      # A number below 0 names no node, so the write stores none of the
      # sixteen and all four neighbours behind them.
      entries = [{ "neighbor_num" => -1 }] * 16 + Array.new(4) { |i| { "neighbor_id" => format("!%08x", 0x9b400001 + i) } }
      post_ok("/api/neighbors", { "node_id" => "!9b400000", "rx_time" => now, "neighbors" => entries })

      kept = db_rows("SELECT neighbor_id FROM neighbors WHERE node_id = '!9b400000' ORDER BY neighbor_id").map { |row| row["neighbor_id"] }
      expect(kept).to eq(Array.new(4) { |i| format("!%08x", 0x9b400001 + i) })
    end

    it "looks a neighbour up by its number for at most 16 entries" do
      # A blank reference beside a node number resolves only through a lookup:
      # sixteen numbers no node has use the lookups up, so the seventeenth,
      # whose node is stored, is not looked up; the four neighbours behind
      # them need none and are stored.
      with_db { |db| db.execute("INSERT INTO nodes(node_id, num, last_heard, first_heard) VALUES ('!9b5000aa', ?, ?, ?)", [0x9b5000aa, now, now]) }
      unknown = Array.new(16) { |i| { "neighbor_id" => "", "neighbor_num" => 0x9b510000 + i } }
      known = { "neighbor_id" => "", "neighbor_num" => 0x9b5000aa }
      named = Array.new(4) { |i| { "neighbor_id" => format("!%08x", 0x9b500001 + i) } }
      post_ok("/api/neighbors", { "node_id" => "!9b500000", "rx_time" => now, "neighbors" => unknown + [known] + named })

      kept = db_rows("SELECT neighbor_id FROM neighbors WHERE node_id = '!9b500000' ORDER BY neighbor_id").map { |row| row["neighbor_id"] }
      expect(kept).to eq(named.map { |entry| entry["neighbor_id"] })
    end

    it "keeps the first 16 hops of a trace" do
      hops = Array.new(500) { |i| 0x9c000001 + i }
      post_ok("/api/traces", { "id" => 9_740_001, "src" => 0x9c000000, "dest" => 0x9cffffff, "rx_time" => now, "hops" => hops })

      stored = db_rows("SELECT node_id FROM trace_hops WHERE trace_id = 9740001 ORDER BY hop_index").map { |row| row["node_id"] }
      expect(stored).to eq(hops.first(16))
      expect(db_value("SELECT COUNT(*) FROM nodes")).to eq(18)
    end

    it "keeps the first 16 hops of a path that name a node" do
      path = ["", "x", nil] + Array.new(30) { |i| format("!%08x", 0x9c100001 + i) }
      post_ok("/api/traces", { "id" => 9_740_002, "src" => 0x9c100000, "rx_time" => now, "path" => path })

      stored = db_rows("SELECT node_id FROM trace_hops WHERE trace_id = 9740002 ORDER BY hop_index").map { |row| row["node_id"] }
      expect(stored).to eq(Array.new(16) { |i| 0x9c100001 + i })
    end

    it "keeps a snapshot and a trace of the protocols' own sizes whole" do
      entries = Array.new(10) { |i| { "neighbor_id" => format("!%08x", 0x9b200001 + i) } }
      post_ok("/api/neighbors", { "node_id" => "!9b200000", "rx_time" => now, "neighbors" => entries })
      post_ok("/api/traces", { "id" => 9_740_003, "src" => 0x9c200000, "rx_time" => now, "hops" => Array.new(8) { |i| 0x9c200001 + i } })

      expect(db_value("SELECT COUNT(*) FROM neighbors WHERE node_id = '!9b200000'")).to eq(10)
      expect(db_value("SELECT COUNT(*) FROM trace_hops WHERE trace_id = 9740003")).to eq(8)
    end

    it "normalize_trace_hops keeps the first 16 usable hops" do
      aggregate_failures do
        expect(dp.normalize_trace_hops(Array.new(40) { |i| i + 1 })).to eq((1..16).to_a)
        expect(dp.normalize_trace_hops(["", nil, "x"] + (1..20).to_a)).to eq((1..16).to_a)
        expect(dp.normalize_trace_hops(7)).to eq([7])
      end
    end
  end

  describe "heartbeat packet counts (IB4)" do
    # A heartbeat of ingestor +!9d000001+ sent at +at+ carrying +packets+.
    #
    # @param packets [Object] the +packets+ value.
    # @param at [Integer] the heartbeat's +last_seen_time+.
    # @return [Hash] request body.
    def heartbeat(packets, at)
      {
        "node_id" => "!9d000001", "start_time" => now - 3600, "last_seen_time" => at,
        "version" => "1.0.0", "protocol" => "meshtastic", "packets" => packets,
      }
    end

    it "records no activity row for a count above 1,000,000,000 and still registers the heartbeat" do
      post_ok("/api/ingestors", heartbeat(1_000_000_001, now - 20))
      post_ok("/api/ingestors", heartbeat(1_000_000_000, now - 10))

      expect(db_value("SELECT node_id FROM ingestors")).to eq("!9d000001")
      expect(db_rows("SELECT at, packets FROM ingestor_activity")).to eq([{ "at" => now - 10, "packets" => 1_000_000_000 }])
    end

    it "keeps /api/stats and /api/stats/activity answering after counts near the 64-bit limit" do
      post_ok("/api/ingestors", heartbeat((2 ** 63) - 1, now - 20))
      post_ok("/api/ingestors", heartbeat((2 ** 63) - 1, now - 10))

      get "/api/stats"
      expect(last_response.status).to eq(200)
      expect(JSON.parse(last_response.body).dig("total", "packets", "hour")).to eq(0)

      get "/api/stats/activity"
      expect(last_response.status).to eq(200)
      expect(JSON.parse(last_response.body)).to be_an(Array)
    end

    describe "rows stored before the cap" do
      # The time of the two stored rows.
      let(:at) { now - 10 }

      # Store two rows near the 64-bit limit directly, as a database written
      # before the ingest cap may hold them.
      before do
        with_db do |db|
          2.times do
            db.execute("INSERT INTO ingestor_activity(ingestor_id, at, packets, protocol) VALUES (?, ?, ?, 'meshtastic')", ["!9d000002", at, (2 ** 63) - 1])
          end
        end
      end

      it "are read at most at the cap by /api/stats" do
        get "/api/stats"

        expect(last_response.status).to eq(200)
        # Two rows read as 1,000,000,000 each, over the 24-hour divisor.
        expect(JSON.parse(last_response.body).dig("meshtastic", "packets", "hour")).to eq(83_333_333)
      end

      it "are read at most at the cap by /api/stats/activity" do
        get "/api/stats/activity"

        expect(last_response.status).to eq(200)
        bucket = JSON.parse(last_response.body).find { |entry| entry["bucket_start"] == (at / 3600) * 3600 }
        expect(bucket["meshtastic"]).to eq(2_000_000_000)
      end
    end
  end
end
