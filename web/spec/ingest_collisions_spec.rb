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

# A packet id that another sender or node reuses (SPEC KC1-KC5; ACCEPTANCE
# KC-A1-KC-A6).  A message copy naming another sender than the stored row,
# by id or only by number, and a position, telemetry reading or trace from
# another node, leave the stored row as it is and log one warning, at most
# ten a minute per writer; a later copy of a message fills the recipient,
# text, reply, emoji and portnum the stored row lacks and never replaces
# them.  Copies of one packet still merge.
RSpec.describe "Ingest identity collisions" do
  let(:app) { Sinatra::Application }
  let(:api_token) { "ingest-collisions-token" }
  let(:auth_headers) do
    { "CONTENT_TYPE" => "application/json", "HTTP_AUTHORIZATION" => "Bearer #{api_token}" }
  end
  let(:now) { Time.now.to_i }
  # The warning a dropped message copy logs (SPEC KC1).
  let(:message_drop) { "Dropped a message copy naming another sender" }
  # The warning a dropped position, reading or trace logs (SPEC KC4).
  let(:record_drop) { "Dropped a record whose id another node holds" }

  # Yield a handle on the spec database, rows as hashes, and close it.
  #
  # @yieldparam db [SQLite3::Database] open database handle.
  # @return [Object] the block's result.
  def with_db
    db = SQLite3::Database.new(PotatoMesh::Config.db_path)
    db.results_as_hash = true
    db.busy_timeout = PotatoMesh::Config.db_busy_timeout_ms
    yield db
  ensure
    db&.close
  end

  # The first row +sql+ selects.
  #
  # @param sql [String] query.
  # @param params [Array] bind values.
  # @return [Hash, nil] the row, or nil without one.
  def stored(sql, params = [])
    with_db { |db| db.get_first_row(sql, params) }
  end

  # Every row +sql+ selects.
  #
  # @param sql [String] query.
  # @param params [Array] bind values.
  # @return [Array<Hash>] the rows.
  def stored_rows(sql, params = [])
    with_db { |db| db.execute(sql, params) }
  end

  # POST +body+ as JSON to +path+ and expect the route to accept it.
  #
  # @param path [String] ingest route.
  # @param body [Object] request body.
  # @return [void]
  def post_ok(path, body)
    post path, body.to_json, auth_headers
    expect(last_response.status).to eq(201), "#{path} answered #{last_response.status}: #{last_response.body}"
  end

  # A Meshtastic text message on the broadcast channel.
  #
  # @param fields [Hash] fields merged over the defaults.
  # @return [Hash] message record.
  def message(fields)
    { "rx_time" => now, "channel" => 0, "portnum" => "TEXT_MESSAGE_APP", "protocol" => "meshtastic", "to_id" => "^all" }.merge(fields)
  end

  # Record the app's warnings from here on.
  #
  # @return [Array<Array(String, Hash)>] each warning's text and metadata,
  #   appended as they are logged.
  def capture_warnings
    lines = []
    allow_any_instance_of(Sinatra::Application).to receive(:warn_log) { |_app, text, **metadata| lines << [text, metadata] }
    lines
  end

  before do
    @original_token = ENV["API_TOKEN"]
    ENV["API_TOKEN"] = api_token
    with_db do |db|
      %w[messages nodes positions telemetry neighbors traces trace_hops waypoints ingestors].each do |table|
        db.execute("DELETE FROM #{table}")
      end
    end
    PotatoMesh::App::ApiCache.invalidate_all
  end

  after do
    @original_token.nil? ? ENV.delete("API_TOKEN") : ENV["API_TOKEN"] = @original_token
    PotatoMesh::App::ApiCache.invalidate_all
  end

  describe "a message copy naming another sender (KC1)" do
    it "leaves the stored message alone and logs the id and both senders" do
      warnings = capture_warnings
      post_ok("/api/messages", message("id" => 1_111_111_111, "rx_time" => now - 600, "from_id" => "!aaaa0001", "text" => "original"))
      post_ok("/api/messages", message(
        "id" => 1_111_111_111, "from_id" => "!bbbb0002", "to_id" => "!cccc0003", "text" => "forged", "reply_id" => 7, "emoji" => "x",
      ))

      expect(stored("SELECT from_id, to_id, text, rx_time, reply_id, emoji FROM messages WHERE id = 1111111111")).to eq(
        "from_id" => "!aaaa0001", "to_id" => "^all", "text" => "original", "rx_time" => now - 600, "reply_id" => nil, "emoji" => nil,
      )
      expect(warnings.select { |text, _| text == message_drop }).to eq([[
        message_drop,
        { context: "data_processing.insert_message", message_id: 1_111_111_111, stored_from_id: "!aaaa0001", from_id: "!bbbb0002" },
      ]])
    end

    it "creates and refreshes no node for the dropped copy" do
      post_ok("/api/messages", message("id" => 1_111_111_112, "rx_time" => now - 600, "from_id" => "!aaaa0001", "text" => "original"))
      post_ok("/api/messages", message("id" => 1_111_111_112, "from_id" => "!bbbb0002", "to_id" => "!cccc0003", "text" => "forged"))

      expect(stored_rows("SELECT node_id, last_heard FROM nodes ORDER BY node_id")).to eq([{ "node_id" => "!aaaa0001", "last_heard" => now - 600 }])
    end

    it "keeps the first message of a natural collision and drops the later one" do
      eight_days_ago = now - (8 * 86_400)
      post_ok("/api/messages", message("id" => 2_222_222_222, "rx_time" => eight_days_ago, "from_id" => "!cccc0003", "text" => "C, eight days ago"))
      post_ok("/api/messages", message("id" => 2_222_222_222, "from_id" => "!dddd0004", "text" => "D, just now"))

      expect(stored("SELECT from_id, text, rx_time FROM messages WHERE id = 2222222222")).to eq(
        "from_id" => "!cccc0003", "text" => "C, eight days ago", "rx_time" => eight_days_ago,
      )
    end

    it "still completes a copy without a sender with a later copy naming one (guard, #108)" do
      post_ok("/api/messages", message("id" => 1_111_111_114, "from_id" => nil, "text" => "anon first"))
      post_ok("/api/messages", message("id" => 1_111_111_114, "from_id" => "!aaaa0001", "text" => "anon first"))

      expect(stored("SELECT from_id FROM messages WHERE id = 1111111114")).to eq("from_id" => "!aaaa0001")
    end

    it "still fills an encrypted copy from a decrypted copy of the same packet (guard)" do
      post_ok("/api/messages", message("id" => 1_111_111_115, "from_id" => "!eeee0005", "encrypted" => "AAECAwQ=", "portnum" => nil, "hops" => 2))
      post_ok("/api/messages", message("id" => 1_111_111_115, "from_id" => "!eeee0005", "text" => "decrypted", "hops" => 1))

      expect(stored("SELECT text, encrypted, portnum, hops FROM messages WHERE id = 1111111115")).to eq(
        "text" => "decrypted", "encrypted" => nil, "portnum" => "TEXT_MESSAGE_APP", "hops" => 1,
      )
    end
  end

  describe "a copy naming its sender only by number (KC1)" do
    it "drops a copy whose number names another sender than the stored row, and logs it" do
      warnings = capture_warnings
      post_ok("/api/messages", message("id" => 1_111_111_116, "rx_time" => now - 600, "from_id" => "!e0e00007", "encrypted" => "AAECAwQ=", "portnum" => nil))
      post_ok("/api/messages", message("id" => 1_111_111_116, "from_num" => 0xf0f00008, "text" => "forged by number"))

      expect(stored("SELECT from_id, text, encrypted, rx_time FROM messages WHERE id = 1111111116")).to eq(
        "from_id" => "!e0e00007", "text" => nil, "encrypted" => "AAECAwQ=", "rx_time" => now - 600,
      )
      expect(stored_rows("SELECT node_id, last_heard FROM nodes ORDER BY node_id")).to eq([{ "node_id" => "!e0e00007", "last_heard" => now - 600 }])
      expect(warnings.select { |text, _| text == message_drop }).to eq([[
        message_drop,
        { context: "data_processing.insert_message", message_id: 1_111_111_116, stored_from_id: "!e0e00007", from_id: "!f0f00008" },
      ]])
    end

    it "stores the id the number names and holds later copies to it" do
      post_ok("/api/messages", message("id" => 1_111_111_117, "from_num" => 0xf0f00008, "text" => "by number"))
      post_ok("/api/messages", message("id" => 1_111_111_117, "from_id" => "!e0e00007", "text" => "by number"))

      expect(stored("SELECT from_id FROM messages WHERE id = 1111111117")).to eq("from_id" => "!f0f00008")
    end

    it "still fills an encrypted copy from its decrypted copy (guard)" do
      post_ok("/api/messages", message("id" => 1_111_111_118, "from_id" => "!e0e00007", "encrypted" => "AAECAwQ=", "portnum" => nil))
      post_ok("/api/messages", message("id" => 1_111_111_118, "from_num" => 0xe0e00007, "text" => "decrypted"))

      expect(stored("SELECT from_id, text, encrypted FROM messages WHERE id = 1111111118")).to eq(
        "from_id" => "!e0e00007", "text" => "decrypted", "encrypted" => nil,
      )
    end

    it "checks a payload it decrypts against the sender the number names (NI1)" do
      warnings = capture_warnings
      allow_any_instance_of(Sinatra::Application).to receive(:decrypt_meshtastic_message).and_return(
        { text: nil, portnum: 4, payload: "decrypted".b, channel_name: nil },
      )
      allow(PotatoMesh::App::Meshtastic::PayloadDecoder).to receive(:decode).and_return(
        "type" => "NODEINFO_APP",
        "payload" => { "user" => { "id" => "!b2b2b2b2", "long_name" => "Mallory", "short_name" => "MLRY" } },
      )
      post_ok("/api/messages", message("id" => 1_111_111_119, "from_num" => 0xf0f00008, "encrypted" => "AAECAwQ=", "portnum" => nil))

      expect(warnings).to include([
        "Dropped decrypted payload naming another node",
        hash_including(message_id: 1_111_111_119, from_id: "!f0f00008", node_id: "!b2b2b2b2"),
      ])
      expect(stored_rows("SELECT node_id, long_name FROM nodes")).to eq([{ "node_id" => "!f0f00008", "long_name" => "Meshtastic 0008" }])
      expect(stored("SELECT from_id, encrypted FROM messages WHERE id = 1111111119")).to eq("from_id" => "!f0f00008", "encrypted" => "AAECAwQ=")
    end
  end

  describe "a later copy of a stored message (KC2)" do
    it "never replaces the stored recipient, text, reply, emoji or portnum" do
      post_ok("/api/messages", message(
        "id" => 1_111_111_121, "from_id" => "!aaaa0001", "text" => "original", "reply_id" => 100, "emoji" => "a",
      ))
      post_ok("/api/messages", message(
        "id" => 1_111_111_121, "from_id" => "!aaaa0001", "to_id" => "!cccc0003", "text" => "rewritten", "reply_id" => 200,
        "emoji" => "b", "portnum" => "REACTION_APP",
      ))

      expect(stored("SELECT to_id, text, reply_id, emoji, portnum FROM messages WHERE id = 1111111121")).to eq(
        "to_id" => "^all", "text" => "original", "reply_id" => 100, "emoji" => "a", "portnum" => "TEXT_MESSAGE_APP",
      )
    end

    it "fills the recipient, text, reply, emoji and portnum the stored copy lacks" do
      post_ok("/api/messages", message("id" => 1_111_111_122, "from_id" => "!aaaa0001", "to_id" => nil, "portnum" => nil))
      post_ok("/api/messages", message(
        "id" => 1_111_111_122, "from_id" => "!aaaa0001", "text" => "filled", "reply_id" => 5, "emoji" => "e",
      ))

      expect(stored("SELECT to_id, text, reply_id, emoji, portnum FROM messages WHERE id = 1111111122")).to eq(
        "to_id" => "^all", "text" => "filled", "reply_id" => 5, "emoji" => "e", "portnum" => "TEXT_MESSAGE_APP",
      )
    end

    it "never replaces the stored text of a MeshCore message" do
      meshcore = { "from_id" => "!aaaa0001", "protocol" => "meshcore", "channel" => 1, "channel_name" => "#test" }
      post_ok("/api/messages", message(meshcore.merge("id" => 1_111_111_123, "text" => "first words")))
      post_ok("/api/messages", message(meshcore.merge("id" => 1_111_111_123, "text" => "other words", "emoji" => "m")))

      expect(stored("SELECT text, emoji FROM messages WHERE id = 1111111123")).to eq("text" => "first words", "emoji" => "m")
    end
  end

  describe "the INSERT race (KC1, KC3)" do
    include_context "with isolated db"

    let(:dp) { DataProcessingHarness.build.new }

    it "leaves the stored row alone when the racing copy names another sender, and logs it" do
      db = open_db
      allow(dp).to receive(:warn_log)
      dp.insert_message(db, message("id" => 1_111_111_131, "from_id" => "!aaaa0001", "text" => "original"))
      hide_stored_message_once(db)

      dp.insert_message(db, message("id" => 1_111_111_131, "from_id" => "!bbbb0002", "to_id" => "!cccc0003", "text" => "forged"))

      expect(db.get_first_row("SELECT from_id, to_id, text FROM messages WHERE id = 1111111131")).to eq(
        "from_id" => "!aaaa0001", "to_id" => "^all", "text" => "original",
      )
      expect(dp).to have_received(:warn_log).with(
        message_drop,
        hash_including(message_id: 1_111_111_131, stored_from_id: "!aaaa0001", from_id: "!bbbb0002"),
      )
    ensure
      db&.close
    end

    it "applies the same rule over a connection that returns rows as arrays" do
      db = SQLite3::Database.new(PotatoMesh::Config.db_path)
      dp.insert_message(db, message("id" => 1_111_111_133, "from_id" => "!aaaa0001", "text" => "original"))
      hide_stored_message_once(db)

      dp.insert_message(db, message("id" => 1_111_111_133, "from_id" => "!bbbb0002", "text" => "forged"))

      expect(db.get_first_row("SELECT from_id, text FROM messages WHERE id = 1111111133")).to eq(["!aaaa0001", "original"])
    ensure
      db&.close
    end
  end

  describe "merge_message_copy, the one merge of every collapse path (KC3)" do
    include_context "with isolated db"

    let(:dp) { DataProcessingHarness.build.new }
    let(:row_id) { 1_111_111_141 }

    # Store one message row and read it back as the merge does.
    #
    # @param db [SQLite3::Database] open database handle.
    # @param columns [Hash] stored columns merged over the required ones.
    # @return [Hash] the row as +stored_message_for_merge+ returns it.
    def seed_row(db, columns)
      row = { "id" => row_id, "rx_time" => now - 60, "rx_iso" => Time.at(now - 60).utc.iso8601, "protocol" => "meshtastic" }.merge(columns)
      db.execute("INSERT INTO messages(#{row.keys.join(",")}) VALUES (#{Array.new(row.size, "?").join(",")})", row.values)
      dp.stored_message_for_merge(db, row_id)
    end

    # A later copy from +!aaaa0001+, every field absent unless given.
    #
    # @param fields [Hash{Symbol=>Object}] copy fields merged over the defaults.
    # @return [Hash{Symbol=>Object}] the copy as +insert_message+ builds it.
    def later_copy(fields = {})
      {
        from_id: "!aaaa0001", to_id: nil, text: nil, encrypted: nil, portnum: nil, lora_freq: nil, modem_preset: nil,
        channel_name: nil, reply_id: nil, emoji: nil, ingestor: nil, protocol: "meshtastic", scope: nil, hops: nil,
        path: nil, rx_time: now, rx_iso: Time.at(now).utc.iso8601, sender_present: true, message: {},
      }.merge(fields)
    end

    it "drops a copy of another protocol than the row's" do
      db = open_db
      stored = seed_row(db, "from_id" => "!aaaa0001", "text" => "meshcore row", "protocol" => "meshcore")

      expect(dp.merge_message_copy(db, row_id, stored, later_copy(text: "other row"))).to eq([false, nil])
      expect(db.get_first_row("SELECT text, protocol FROM messages WHERE id = ?", [row_id])).to eq("text" => "meshcore row", "protocol" => "meshcore")
    ensure
      db&.close
    end

    it "fills the ciphertext of a row that holds no text" do
      db = open_db
      stored = seed_row(db, "from_id" => "!aaaa0001")

      expect(dp.merge_message_copy(db, row_id, stored, later_copy(encrypted: "AAECAwQ="))).to eq([true, "!aaaa0001"])
      expect(db.get_first_value("SELECT encrypted FROM messages WHERE id = ?", [row_id])).to eq("AAECAwQ=")
    ensure
      db&.close
    end

    it "takes the route and receive time of a decrypted copy of an encrypted row" do
      db = open_db
      stored = seed_row(db, "from_id" => "!aaaa0001", "encrypted" => "AAECAwQ=", "hops" => 3, "path" => "f0bf44")

      dp.merge_message_copy(db, row_id, stored, later_copy(text: "decrypted", hops: 1, path: "a1b2", message: { "snr" => 4.5 }))

      expect(db.get_first_row("SELECT text, encrypted, hops, path, snr, rx_time FROM messages WHERE id = ?", [row_id])).to eq(
        "text" => "decrypted", "encrypted" => nil, "hops" => 1, "path" => "a1b2", "snr" => 4.5, "rx_time" => now,
      )
    ensure
      db&.close
    end

    it "moves a meshtastic row to the protocol of a MeshCore copy (#747)" do
      db = open_db
      stored = seed_row(db, "from_id" => "!aaaa0001", "text" => "default row")

      expect(dp.merge_message_copy(db, row_id, stored, later_copy(protocol: "meshcore"))).to eq([true, "!aaaa0001"])
      expect(db.get_first_value("SELECT protocol FROM messages WHERE id = ?", [row_id])).to eq("meshcore")
    ensure
      db&.close
    end
  end

  describe "positions, telemetry and traces from another node (KC4)" do
    it "leaves a stored position alone and logs the id and both nodes" do
      warnings = capture_warnings
      post_ok("/api/positions", { "id" => 4_444_444_444, "node_id" => "!aaaa0001", "rx_time" => now - 3600, "latitude" => 52.52, "longitude" => 13.4 })
      post_ok("/api/positions", { "id" => 4_444_444_444, "node_id" => "!bbbb0002", "rx_time" => now, "sats_in_view" => 3 })

      expect(stored("SELECT node_id, rx_time, latitude, longitude, sats_in_view FROM positions WHERE id = 4444444444")).to eq(
        "node_id" => "!aaaa0001", "rx_time" => now - 3600, "latitude" => 52.52, "longitude" => 13.4, "sats_in_view" => nil,
      )
      expect(warnings.select { |text, _| text == record_drop }).to eq([[
        record_drop,
        { context: "data_processing.insert_position", table: "positions", id: 4_444_444_444, stored_node_id: "!aaaa0001", node_id: "!bbbb0002" },
      ]])
      get "/api/positions/!aaaa0001?since=1"
      expect(JSON.parse(last_response.body).map { |row| row["id"] }).to eq([4_444_444_444])
    end

    it "leaves stored telemetry alone and logs the id and both nodes" do
      warnings = capture_warnings
      post_ok("/api/telemetry", { "id" => 5_555_555_555, "node_id" => "!aaaa0001", "rx_time" => now - 3600, "temperature" => 21.5 })
      post_ok("/api/telemetry", { "id" => 5_555_555_555, "node_id" => "!bbbb0002", "rx_time" => now, "battery_level" => 88 })

      expect(stored("SELECT node_id, from_id, rx_time, temperature, battery_level FROM telemetry WHERE id = 5555555555")).to eq(
        "node_id" => "!aaaa0001", "from_id" => "!aaaa0001", "rx_time" => now - 3600, "temperature" => 21.5, "battery_level" => nil,
      )
      expect(warnings.select { |text, _| text == record_drop }).to eq([[
        record_drop,
        { context: "data_processing.insert_telemetry", table: "telemetry", id: 5_555_555_555, stored_node_id: "!aaaa0001", node_id: "!bbbb0002" },
      ]])
    end

    it "leaves a stored trace and its hops alone and logs the id and both sources" do
      warnings = capture_warnings
      post_ok("/api/traces", { "id" => 6_666_666_666, "src" => 0xaaaa0001, "dest" => 0xcccc0003, "hops" => [0xdddd0004], "rx_time" => now - 3600 })
      post_ok("/api/traces", { "id" => 6_666_666_666, "src" => 0xbbbb0002, "hops" => [0xeeee0005, 0xffff0006], "rx_time" => now })

      expect(stored("SELECT src, dest, rx_time FROM traces WHERE id = 6666666666")).to eq(
        "src" => 0xaaaa0001, "dest" => 0xcccc0003, "rx_time" => now - 3600,
      )
      expect(stored_rows("SELECT node_id FROM trace_hops WHERE trace_id = 6666666666 ORDER BY hop_index").map { |row| row["node_id"] }).to eq([0xdddd0004])
      expect(warnings.select { |text, _| text == record_drop }).to eq([[
        record_drop,
        { context: "data_processing.insert_trace", table: "traces", id: 6_666_666_666, stored_src: "!aaaa0001", src: "!bbbb0002" },
      ]])
    end

    it "names a node number in the warning by the id it names, a negative one as sent" do
      dp = DataProcessingHarness.build.new

      expect([0xbbbb0002, -1, "!aaaa0001", nil].map { |ref| dp.collision_node_label(ref) }).to eq(["!bbbb0002", -1, "!aaaa0001", nil])
    end

    it "still merges copies from the same node (guard)" do
      warnings = capture_warnings
      post_ok("/api/positions", { "id" => 4_444_444_445, "node_id" => "!aaaa0001", "rx_time" => now - 5, "latitude" => 52.52, "longitude" => 13.4, "ingestor" => "!0000beef" })
      post_ok("/api/positions", { "id" => 4_444_444_445, "node_id" => "!aaaa0001", "rx_time" => now, "latitude" => 52.52, "longitude" => 13.4, "snr" => 4.5, "ingestor" => "!0000cafe" })
      post_ok("/api/telemetry", { "id" => 5_555_555_556, "node_id" => "!aaaa0001", "rx_time" => now - 5, "temperature" => 21.5 })
      post_ok("/api/telemetry", { "id" => 5_555_555_556, "node_id" => "!aaaa0001", "rx_time" => now, "relative_humidity" => 40.0 })
      post_ok("/api/traces", { "id" => 6_666_666_667, "src" => 0xaaaa0001, "hops" => [0xdddd0004], "rx_time" => now - 5 })
      post_ok("/api/traces", { "id" => 6_666_666_667, "src" => 0xaaaa0001, "hops" => [0xeeee0005], "rx_time" => now, "snr" => 3.25 })

      expect(stored("SELECT COUNT(*) AS n, MAX(snr) AS snr, MAX(rx_time) AS rx_time, MAX(ingestor) AS ingestor FROM positions WHERE id = 4444444445")).to eq(
        "n" => 1, "snr" => 4.5, "rx_time" => now, "ingestor" => "!0000beef",
      )
      expect(stored("SELECT temperature, relative_humidity, rx_time FROM telemetry WHERE id = 5555555556")).to eq(
        "temperature" => 21.5, "relative_humidity" => 40.0, "rx_time" => now,
      )
      expect(stored("SELECT snr, rx_time FROM traces WHERE id = 6666666667")).to eq("snr" => 3.25, "rx_time" => now)
      expect(stored_rows("SELECT node_id FROM trace_hops WHERE trace_id = 6666666667").map { |row| row["node_id"] }).to eq([0xeeee0005])
      expect(warnings.map(&:first)).not_to include(record_drop)
    end

    it "fills the node of a stored record that names none" do
      post_ok("/api/positions", { "id" => 4_444_444_446, "rx_time" => now - 60, "latitude" => 1.5, "longitude" => 2.5 })
      post_ok("/api/positions", { "id" => 4_444_444_446, "node_id" => "!aaaa0001", "rx_time" => now })
      post_ok("/api/telemetry", { "id" => 5_555_555_557, "rx_time" => now - 60, "temperature" => 20.0 })
      post_ok("/api/telemetry", { "id" => 5_555_555_557, "node_id" => "!aaaa0001", "rx_time" => now, "battery_level" => 50 })
      post_ok("/api/traces", { "id" => 6_666_666_668, "dest" => 0xcccc0003, "rx_time" => now - 60 })
      post_ok("/api/traces", { "id" => 6_666_666_668, "src" => 0xaaaa0001, "rx_time" => now })

      expect(stored("SELECT node_id, latitude FROM positions WHERE id = 4444444446")).to eq("node_id" => "!aaaa0001", "latitude" => 1.5)
      expect(stored("SELECT node_id, temperature, battery_level FROM telemetry WHERE id = 5555555557")).to eq(
        "node_id" => "!aaaa0001", "temperature" => 20.0, "battery_level" => 50.0,
      )
      expect(stored("SELECT src, dest FROM traces WHERE id = 6666666668")).to eq("src" => 0xaaaa0001, "dest" => 0xcccc0003)
    end
  end

  describe "collision warnings (KC5)" do
    include_context "with isolated db"

    let(:dp) { DataProcessingHarness.build.new }
    # A limiter on a clock the example sets, in whole seconds.
    let(:limiter) { PotatoMesh::App::DataProcessing::CollisionWarningLimiter.new(clock: -> { @clock }) }
    # The warning that reports a window's suppressed count.
    let(:suppressed) { "Suppressed collision warnings" }

    before { @clock = 1_000 }

    it "logs ten warnings of a context in 60 seconds and reports the rest once the window ends" do
      expect(Array.new(12) { limiter.admit("ctx") }).to eq([[true, 0]] * 10 + [[false, 0]] * 2)
      @clock += 59
      expect(limiter.admit("ctx")).to eq([false, 0])
      @clock += 1
      expect(limiter.admit("ctx")).to eq([true, 3])
      expect(limiter.admit("ctx")).to eq([true, 0])
    end

    it "limits each context on its own and reports nothing for a window that suppressed nothing" do
      10.times { limiter.admit("first") }

      expect([limiter.admit("first"), limiter.admit("second")]).to eq([[false, 0], [true, 0]])
      @clock += 60
      expect(limiter.admit("second")).to eq([true, 0])
    end

    it "forgets every window when reset" do
      11.times { limiter.admit("ctx") }
      limiter.reset!

      expect(limiter.admit("ctx")).to eq([true, 0])
    end

    it "is one limiter of 10 lines per 60 seconds for the whole process" do
      shared = PotatoMesh::App::DataProcessing.collision_warning_limiter

      expect([shared.limit, shared.window_seconds]).to eq([10, 60])
      expect([dp.collision_warning_limiter, DataProcessingHarness.build.new.collision_warning_limiter]).to all(be(shared))
    end

    it "passes the warnings of dropped message copies and records through it" do
      db = open_db
      lines = []
      allow(dp).to receive(:collision_warning_limiter).and_return(limiter)
      allow(dp).to receive(:warn_log) { |text, **fields| lines << [text, fields[:context], fields[:suppressed]] }
      dp.insert_message(db, message("id" => 1_111_111_151, "from_id" => "!aaaa0001", "text" => "original"))
      dp.insert_position(db, { "id" => 4_444_444_451, "node_id" => "!aaaa0001", "rx_time" => now, "latitude" => 52.52, "longitude" => 13.4 })
      12.times do |n|
        dp.insert_message(db, message("id" => 1_111_111_151, "from_id" => format("!bbbb%04x", n), "text" => "forged"))
        dp.insert_position(db, { "id" => 4_444_444_451, "node_id" => format("!bbbb%04x", n), "rx_time" => now })
      end
      @clock += 60
      dp.insert_message(db, message("id" => 1_111_111_151, "from_id" => "!cccc0003", "text" => "forged"))

      expect(lines.count { |text, context, _| text == message_drop && context == "data_processing.insert_message" }).to eq(11)
      expect(lines.count { |text, context, _| text == record_drop && context == "data_processing.insert_position" }).to eq(10)
      expect(lines.last(2)).to eq([
        [suppressed, "data_processing.insert_message", 2],
        [message_drop, "data_processing.insert_message", nil],
      ])
      expect(dp).to have_received(:warn_log).with(suppressed, context: "data_processing.insert_message", suppressed: 2, window_seconds: 60)
    ensure
      db&.close
    end
  end
end
