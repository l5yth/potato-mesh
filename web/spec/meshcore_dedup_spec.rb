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
require "digest"
require_relative "support/data_processing_harness"

# MeshCore cross-ingestor message dedup (issue #880; SPEC MX1/MX2/MX6,
# ACCEPTANCE MX-A1/MX-A2/MX-A4).  Two ingestors that hold one channel at
# different local slots derive two v1 ids for one transmission (the `c<N>`
# fingerprint discriminator is the receiver's slot index), and each resolves
# the "Name:" sender against its own roster: the pubkey id on one, the
# name-derived synthetic id on the other.  The insert guard must collapse such
# copies on the broadcast's text rather than on `from_id`, apply the late copy
# to the earliest matching row exactly as an id hit would (MR3 ranking,
# filling columns the stored copy lacks, liveness credited to the resolved
# winner), and stay an index search as the table grows.
RSpec.describe "MeshCore cross-ingestor message dedup" do
  include_context "with isolated db"

  # One #bot transmission ("Alice: dedup me", sender_timestamp 1_790_000_000)
  # as the ingestor derives its v1 id on local slot 4 and on local slot 6
  # (+_derive_message_id("alice", 1_790_000_000, "c4" / "c6", text)+).
  let(:text) { "Alice: dedup me" }
  let(:slot_ids) { { 4 => 5_007_131_281_259_980, 6 => 7_405_791_464_985_531 } }
  let(:real_id) { "!a1a2a3a4" }
  let(:synthetic_id) { "!#{Digest::SHA256.hexdigest("Alice")[0, 8]}" }
  let(:stale_id) { "!a9a9a9a9" }
  # rx_time sits in the past so later copies can be shifted forward without
  # tripping the +rx_time > now+ clamp in +insert_message+.
  let(:base_rx) { now - 1_000 }
  # The content-dedup lookups and both purge statements must search this
  # partial index on (text, rx_time) (SPEC MX6).
  let(:text_index_search) { /\ASEARCH \w+ USING (COVERING )?INDEX idx_messages_meshcore_text \(text=\? AND rx_time>\? AND rx_time<\?\)\z/ }

  # Read every stored message, oldest first.
  #
  # @return [Array<Hash>] message rows with the columns these examples assert.
  def stored_messages
    db = open_db
    db.execute("SELECT id, from_id, channel, channel_name, lora_freq, modem_preset FROM messages ORDER BY rx_time, id")
  ensure
    db&.close
  end

  # Read one node's +last_heard+.
  #
  # @param node_id [String] canonical node id.
  # @return [Integer, nil] stored last-heard timestamp.
  def last_heard_of(node_id)
    db = open_db
    db.get_first_value("SELECT last_heard FROM nodes WHERE node_id = ?", [node_id])
  ensure
    db&.close
  end

  # Build the POST /api/messages payload one ingestor emits for the #bot
  # transmission heard on its local +slot+.
  #
  # @param slot [Integer] receiver-local channel slot (4 or 6).
  # @param from_id [String] sender id as that ingestor resolved it.
  # @param dt [Integer] receive-time offset from +base_rx+ in seconds.
  # @param overrides [Hash] extra or replacing payload fields.
  # @return [Hash] message payload.
  def channel_copy(slot:, from_id:, dt: 0, **overrides)
    rx_time = base_rx + dt
    {
      "id" => slot_ids.fetch(slot),
      "rx_time" => rx_time,
      "rx_iso" => Time.at(rx_time).utc.iso8601,
      "from_id" => from_id,
      "to_id" => "^all",
      "channel" => slot,
      "channel_name" => "#bot",
      "portnum" => "TEXT_MESSAGE_APP",
      "text" => text,
      "protocol" => "meshcore",
      "ingestor" => "!0000000#{slot}",
    }.merge(overrides.transform_keys(&:to_s))
  end

  # The direct-message shape of +channel_copy+: addressed to an ingestor host
  # on channel 0, no channel name, a colon in the body but no sender prefix
  # semantics.
  #
  # @return [Hash] overrides for +channel_copy+.
  def direct_message
    { to_id: "!0000aaaa", channel: 0, channel_name: nil, text: "re: meet at five" }
  end

  # EXPLAIN QUERY PLAN detail lines for one statement.
  #
  # @param sql [String] statement text.
  # @param binds [Array] bind values.
  # @return [Array<String>] plan detail column, in plan order.
  def plan_of(sql, binds)
    db = open_db
    db.execute("EXPLAIN QUERY PLAN #{sql}", binds).map { |row| row["detail"] }
  ensure
    db&.close
  end

  describe "insert guard" do
    # The synthetic->real merge machinery behind process_meshcore_chat_nodes
    # has its own specs; stubbing it keeps these examples on the guard and the
    # id-hit path alone.
    let(:harness) { DataProcessingHarness.build(protocol: "meshcore", stub_chat_nodes: true).new }

    # Seed one "Alice" node row directly, bypassing +upsert_node+ so no
    # synthetic/real merge runs.
    #
    # @param node_id [String] canonical node id.
    # @param synthetic [Boolean] whether the row is a name-derived placeholder.
    # @param heard [Integer] last-heard time; doubles as the keyed evidence
    #   (+last_advert_heard+) of a real row.
    # @return [void]
    def seed_alice(node_id, synthetic:, heard:)
      db = open_db
      db.execute(
        "INSERT INTO nodes(node_id,long_name,protocol,synthetic,last_heard,first_heard,last_advert_heard) VALUES (?,?,?,?,?,?,?)",
        [node_id, "Alice", "meshcore", synthetic ? 1 : 0, heard, heard, synthetic ? nil : heard],
      )
    ensure
      db&.close
    end

    # Store message rows directly, bypassing the insert guard, so an example
    # can start from copies the guard would have collapsed.
    #
    # @param messages [Array<Hash>] message payloads from +channel_copy+.
    # @return [void]
    def store_directly(*messages)
      db = open_db
      columns = %w[id rx_time rx_iso from_id to_id channel channel_name portnum text protocol]
      messages.each do |message|
        db.execute(
          "INSERT INTO messages(#{columns.join(",")}) VALUES (#{Array.new(columns.length, "?").join(",")})",
          message.values_at(*columns),
        )
      end
    ensure
      db&.close
    end

    # Run each payload through +insert_message+, in order.
    #
    # @param messages [Array<Hash>] message payloads.
    # @return [void]
    def insert(*messages)
      db = open_db
      messages.each { |message| harness.insert_message(db, message) }
    ensure
      db&.close
    end

    # Capture the content-dedup lookup +insert_message+ runs for +message+.
    #
    # @param message [Hash] message payload.
    # @return [Array(String, Array)] the lookup's SQL and bind values.
    def captured_lookup(message)
      db = open_db
      captured = nil
      lookup = db.method(:get_first_value)
      db.define_singleton_method(:get_first_value) do |sql, *args|
        captured ||= [sql, args.first] if sql.include?("FROM messages") && sql.include?("text = ?")
        lookup.call(sql, *args)
      end
      harness.insert_message(db, message)
      captured
    ensure
      db&.close
    end

    it "collapses cross-slot copies whose sender resolved to the pubkey id on one ingestor and the synthetic id on the other" do
      seed_alice(real_id, synthetic: false, heard: base_rx - 500)
      seed_alice(synthetic_id, synthetic: true, heard: base_rx - 500)

      insert(
        channel_copy(slot: 4, from_id: real_id),
        channel_copy(slot: 6, from_id: synthetic_id, dt: 2),
      )

      expect(stored_messages.map { |row| [row["id"], row["from_id"]] }).to eq([[slot_ids[4], real_id]])
    end

    it "upgrades a synthetic-attributed survivor when the pubkey copy arrives later (MR3 rank)" do
      seed_alice(real_id, synthetic: false, heard: base_rx - 500)
      seed_alice(synthetic_id, synthetic: true, heard: base_rx - 500)

      insert(
        channel_copy(slot: 6, from_id: synthetic_id),
        channel_copy(slot: 4, from_id: real_id, dt: 2),
      )

      # The survivor keeps its own id; only the attribution moves.
      expect(stored_messages.map { |row| [row["id"], row["from_id"]] }).to eq([[slot_ids[6], real_id]])
    end

    it "credits the reception to the survivor's sender, not to a positively-stale copy" do
      seed_alice(real_id, synthetic: false, heard: base_rx - 500)
      stale_heard = now - 40 * 86_400
      seed_alice(stale_id, synthetic: false, heard: stale_heard)

      insert(
        channel_copy(slot: 4, from_id: real_id),
        channel_copy(slot: 6, from_id: stale_id, dt: 2),
      )

      expect(stored_messages.map { |row| row["from_id"] }).to eq([real_id])
      expect(last_heard_of(stale_id)).to eq(stale_heard)
      expect(last_heard_of(real_id)).to eq(base_rx + 2)
    end

    it "fills radio metadata the stored copy lacks from the later copy" do
      insert(
        channel_copy(slot: 4, from_id: synthetic_id),
        channel_copy(slot: 6, from_id: synthetic_id, dt: 2, lora_freq: 869, modem_preset: "SF8/BW62/CR8"),
      )

      metadata = stored_messages.map { |row| [row["id"], row["lora_freq"], row["modem_preset"]] }
      expect(metadata).to eq([[slot_ids[4], 869, "SF8/BW62/CR8"]])
    end

    it "applies a channel copy to the earliest of two stored matching rows" do
      # The earlier copy carries the larger id, so neither id order nor
      # insertion order can stand in for receive-time order.
      store_directly(
        channel_copy(slot: 4, from_id: real_id, dt: 5, id: 2_000_001),
        channel_copy(slot: 6, from_id: synthetic_id, id: 2_000_009),
      )

      insert(channel_copy(slot: 4, from_id: real_id, dt: 10, lora_freq: 869))

      expect(stored_messages.map { |row| [row["id"], row["lora_freq"]] }).to eq([[2_000_009, 869], [2_000_001, nil]])
    end

    it "applies a direct-message copy to the earliest of two stored matching rows" do
      store_directly(
        channel_copy(slot: 4, from_id: real_id, dt: 5, id: 3_000_001, **direct_message),
        channel_copy(slot: 6, from_id: real_id, id: 3_000_009, **direct_message),
      )

      insert(channel_copy(slot: 4, from_id: real_id, dt: 10, lora_freq: 869, **direct_message))

      expect(stored_messages.map { |row| [row["id"], row["lora_freq"]] }).to eq([[3_000_009, 869], [3_000_001, nil]])
    end

    it "re-derives the survivor from the copy's own id when a busy database forces a retry" do
      # The real retrying +with_busy_retry+ replaces the harness's single pass
      # (the harness class already includes Database, so +extend+ would not).
      harness.define_singleton_method(:with_busy_retry, PotatoMesh::App::Database.instance_method(:with_busy_retry))
      store_directly(
        channel_copy(slot: 6, from_id: synthetic_id, id: 4_000_009),
        channel_copy(slot: 6, from_id: synthetic_id, dt: 5, id: 4_000_001),
      )
      db = open_db
      busy = true
      row_lookup = db.method(:get_first_row)
      # Fail the first stored-row lookup, after the guard has picked the
      # survivor, so the whole attempt re-runs.
      db.define_singleton_method(:get_first_row) do |sql, *args|
        if busy && sql.start_with?("SELECT from_id, to_id, text, encrypted")
          busy = false
          raise SQLite3::BusyException, "database is locked"
        end
        row_lookup.call(sql, *args)
      end

      harness.insert_message(db, channel_copy(slot: 4, from_id: real_id, dt: 10, lora_freq: 869))
      db.close

      expect(busy).to be(false)
      expect(stored_messages.map { |row| [row["id"], row["lora_freq"]] }).to eq([[4_000_009, 869], [4_000_001, nil]])
    end

    it "does not let a stored channel copy without a sender absorb an attributed copy" do
      store_directly(channel_copy(slot: 6, from_id: nil, id: 5_000_001))

      insert(channel_copy(slot: 4, from_id: real_id, dt: 2))

      expect(stored_messages.map { |row| [row["id"], row["from_id"]] }).to eq([[5_000_001, nil], [slot_ids[4], real_id]])
    end

    it "does not let a stored direct message absorb a channel copy with the same text" do
      # Neither row knows its channel name, so only the recipient tells the
      # direct message apart from the broadcast.
      store_directly(channel_copy(slot: 4, from_id: stale_id, id: 6_000_001, **direct_message.merge(text: text)))

      insert(channel_copy(slot: 4, from_id: real_id, dt: 2, channel_name: nil))

      expect(stored_messages.map { |row| row["id"] }).to eq([6_000_001, slot_ids[4]])
    end

    it "keeps identical text on two differently named channels apart when the senders resolved differently" do
      insert(
        channel_copy(slot: 4, from_id: real_id),
        channel_copy(slot: 6, from_id: synthetic_id, dt: 2, channel_name: "#other"),
      )

      expect(stored_messages.length).to eq(2)
    end

    it "keeps the from_id leg for direct messages, even when the text has a colon" do
      insert(
        channel_copy(slot: 4, from_id: real_id, **direct_message),
        channel_copy(slot: 6, from_id: stale_id, dt: 2, **direct_message),
      )

      expect(stored_messages.map { |row| row["from_id"] }).to eq([real_id, stale_id])
    end

    it "keeps the from_id leg for a broadcast without a sender prefix" do
      insert(
        channel_copy(slot: 4, from_id: real_id, text: "no sender prefix"),
        channel_copy(slot: 6, from_id: synthetic_id, dt: 2, text: "no sender prefix"),
      )

      expect(stored_messages.length).to eq(2)
    end

    it "searches the channel-broadcast lookup on idx_messages_meshcore_text without a scan or sort" do
      plan = plan_of(*captured_lookup(channel_copy(slot: 4, from_id: real_id)))

      expect(plan).to match([text_index_search])
    end

    it "searches the sender-keyed lookup on idx_messages_meshcore_text without a scan or sort" do
      plan = plan_of(*captured_lookup(channel_copy(slot: 4, from_id: real_id, **direct_message)))

      expect(plan).to match([text_index_search])
    end
  end

  describe "one-time purge" do
    it "searches every purge statement's earlier copies on idx_messages_meshcore_text" do
      helper = Object.new.extend(PotatoMesh::App::Database)
      purges = []
      # Record each DELETE the upgrade issues, with its bind values.
      allow(helper).to receive(:open_database).and_wrap_original do |original, *args, **kwargs|
        original.call(*args, **kwargs).tap do |db|
          statement = db.method(:execute)
          db.define_singleton_method(:execute) do |sql, *rest, &block|
            purges << [sql, rest.first || []] if sql.include?("DELETE FROM messages")
            statement.call(sql, *rest, &block)
          end
        end
      end
      db = open_db
      db.execute("PRAGMA user_version = 2")
      db.close

      helper.ensure_schema_upgrades

      expect(purges).not_to be_empty
      purges.each do |sql, binds|
        plan = plan_of(sql, binds)
        expect(plan.grep(/\ASCAN /)).to be_empty
        expect(plan.grep(/\A(SCAN|SEARCH) earlier /)).to match([text_index_search])
      end
    end
  end

  describe "two ingestors through the POST routes" do
    let(:app) { Sinatra::Application }
    let(:auth_headers) do
      { "CONTENT_TYPE" => "application/json", "HTTP_AUTHORIZATION" => "Bearer meshcore-dedup-token" }
    end

    before do
      @original_token = ENV["API_TOKEN"]
      ENV["API_TOKEN"] = "meshcore-dedup-token"
      PotatoMesh::App::ApiCache.invalidate_all
    end

    after do
      if @original_token.nil?
        ENV.delete("API_TOKEN")
      else
        ENV["API_TOKEN"] = @original_token
      end
    end

    # POST one JSON body and require the ingest route to accept it.
    #
    # @param path [String] ingest route.
    # @param body [Hash] JSON payload.
    # @return [void]
    def ingest(path, body)
      post path, body.to_json, auth_headers
      expect(last_response.status).to eq(201)
    end

    # Ingestor A has Alice in its contact roster: it posts her pubkey-derived
    # node, then its slot-4 copy attributed to that id.
    #
    # @param dt [Integer] receive-time offset of the copy.
    # @return [void]
    def roster_ingestor_posts(dt: 0)
      ingest("/api/nodes", {
        real_id => {
          "lastHeard" => now - 2_000,
          "protocol" => "meshcore",
          "user" => { "longName" => "Alice", "shortName" => "a1a2", "role" => "COMPANION", "publicKey" => "a1a2a3a4" + "00" * 28 },
        },
        "ingestor" => "!00000004",
        "protocol" => "meshcore",
      })
      ingest("/api/messages", channel_copy(slot: 4, from_id: real_id, dt: dt))
    end

    # Ingestor B has no roster entry for Alice: it posts the synthetic
    # placeholder, then its slot-6 copy attributed to the synthetic id.
    #
    # @param dt [Integer] receive-time offset of the copy.
    # @return [void]
    def placeholder_ingestor_posts(dt: 0)
      ingest("/api/nodes", {
        synthetic_id => {
          "lastHeard" => base_rx + dt,
          "protocol" => "meshcore",
          "user" => { "longName" => "Alice", "shortName" => "", "role" => "COMPANION", "synthetic" => true },
        },
        "ingestor" => "!00000006",
        "protocol" => "meshcore",
      })
      ingest("/api/messages", channel_copy(slot: 6, from_id: synthetic_id, dt: dt))
    end

    # The chat feed every reader (dashboard, Matrix bridge, mobile app) sees.
    #
    # @return [Array<Hash>] GET /api/messages rows for MeshCore.
    def served_messages
      get "/api/messages?protocol=meshcore"
      JSON.parse(last_response.body)
    end

    it "stores and serves one row when the pubkey-attributed copy arrives first" do
      roster_ingestor_posts
      placeholder_ingestor_posts(dt: 2)

      expect(stored_messages.map { |row| [row["from_id"], row["channel_name"]] }).to eq([[real_id, "#bot"]])
      expect(served_messages.map { |row| row["text"] }).to eq([text])
    end

    it "stores and serves one row when the synthetic-attributed copy arrives first" do
      placeholder_ingestor_posts
      roster_ingestor_posts(dt: 2)

      expect(stored_messages.map { |row| row["from_id"] }).to eq([real_id])
      expect(served_messages.map { |row| row["text"] }).to eq([text])
    end
  end
end
