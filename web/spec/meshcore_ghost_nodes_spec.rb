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

# MeshCore ghost nodes from chat text (issue #883; SPEC GN1-GN4, ACCEPTANCE
# GN-A1 - GN-A5).  A MeshCore channel message names its sender only in a
# "Name: body" prefix and may mention peers as @[Name]; neither is proof that a
# particular key was heard.  These examples pin that chat text never mints,
# refreshes, or revives a node it did not hear: a mention is not a reception
# (GN1), a key-resolved sender never merges into a same-name sibling (GN2), a
# sole copy name-resolved to a retired key credits the live key (GN3), and a
# POSTed name-derived placeholder records nothing (GN4).
RSpec.describe "MeshCore ghost nodes from chat text (issue #883)" do
  # Minimal host mixing in the data-processing pipeline, stubbed like the
  # harness in data_processing_spec.rb.
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

  let(:now) { Time.now.to_i }
  let(:day) { 86_400 }
  # An unrostered sender: the ingestor posts her name-derived id.
  let(:erin) { derived_id("Erin") }

  # Fresh database per example.  The production windows are kept (7-day node
  # list, 28-day keyed-evidence horizon), so "positively stale" means what it
  # means in the field.  The Rack routes open the same stubbed path.
  around do |example|
    Dir.mktmpdir("ghost-nodes-spec-") do |dir|
      RSpec::Mocks.with_temporary_scope do
        allow(PotatoMesh::Config).to receive(:db_path).and_return(File.join(dir, "mesh.db"))
        allow(PotatoMesh::Config).to receive(:db_busy_timeout_ms).and_return(5000)
        allow(PotatoMesh::Config).to receive(:debug?).and_return(false)
        db_helper = Object.new.extend(PotatoMesh::App::Database)
        db_helper.init_db
        db_helper.ensure_schema_upgrades
        example.run
      end
    end
  end

  # Open a hash-row handle on the example database.
  #
  # @return [SQLite3::Database] open database handle.
  def open_db
    db = SQLite3::Database.new(PotatoMesh::Config.db_path)
    db.results_as_hash = true
    db
  end

  # Name-derived placeholder id, as the ingestor's +_derive_synthetic_node_id+
  # computes it for an unrostered sender.
  #
  # @param name [String] display name.
  # @return [String] canonical +!xxxxxxxx+ id.
  def derived_id(name)
    "!" + Digest::SHA256.hexdigest(name)[0, 8]
  end

  # Store a keyed MeshCore contact (roster or advert record) last heard at
  # +heard+; its keyed evidence (+last_advert_heard+) is +heard+ as well.
  #
  # @param db [SQLite3::Database] open database handle.
  # @param node_id [String] canonical node id.
  # @param name [String] advertised long name.
  # @param key_byte [String] two hex digits repeated into the public key.
  # @param heard [Integer] unix seconds of the record.
  # @return [void]
  def seed_keyed_node(db, node_id, name, key_byte, heard)
    dp.upsert_node(db, node_id, {
      "lastHeard" => heard,
      "protocol" => "meshcore",
      "user" => { "longName" => name, "shortName" => key_byte, "role" => "COMPANION", "publicKey" => key_byte * 32 },
    }, protocol: "meshcore")
  end

  # Store a MeshCore row with no keyed evidence and no position: a legacy real
  # row (MR2 "unknown") or, with +synthetic: 1+, a chat placeholder.
  #
  # @param db [SQLite3::Database] open database handle.
  # @param node_id [String] canonical node id.
  # @param name [String] long name.
  # @param heard [Integer] unix seconds stored as last and first heard.
  # @param synthetic [Integer] 1 for a placeholder row, 0 for a real one.
  # @return [void]
  def seed_unkeyed_node(db, node_id, name, heard, synthetic: 0)
    db.execute(
      "INSERT INTO nodes(node_id,long_name,role,protocol,synthetic,last_heard,first_heard) VALUES (?,?,?,?,?,?,?)",
      [node_id, name, "COMPANION", "meshcore", synthetic, heard, heard],
    )
  end

  # Store a message row directly, bypassing ingest, attributed to +from_id+.
  #
  # @param db [SQLite3::Database] open database handle.
  # @param id [Integer] message id.
  # @param from_id [String] sender node id.
  # @param text [String] message text.
  # @param rx_time [Integer] unix seconds of reception.
  # @return [void]
  def seed_message(db, id, from_id, text, rx_time)
    db.execute(
      "INSERT INTO messages(id,rx_time,rx_iso,from_id,to_id,channel,text,protocol) VALUES (?,?,?,?,?,?,?,?)",
      [id, rx_time, Time.at(rx_time).utc.iso8601, from_id, "^all", 0, text, "meshcore"],
    )
  end

  # MeshCore channel message as the ingestor posts it.
  #
  # @param id [Integer] message id.
  # @param from_id [String] sender id the ingestor resolved.
  # @param text [String] "Name: body" text.
  # @param rx_time [Integer] unix seconds of reception.
  # @return [Hash] +POST /api/messages+ payload.
  def channel_message(id, from_id, text, rx_time)
    {
      "id" => id, "rx_time" => rx_time, "from_id" => from_id, "to_id" => "^all",
      "channel" => 0, "channel_name" => "Public", "text" => text,
      "portnum" => "TEXT_MESSAGE_APP", "protocol" => "meshcore", "ingestor" => "!634069bc",
    }
  end

  # @param db [SQLite3::Database] open database handle.
  # @param node_id [String] canonical node id.
  # @return [Integer, nil] the row's +last_heard+, nil when there is no row.
  def last_heard(db, node_id)
    db.get_first_value("SELECT last_heard FROM nodes WHERE node_id = ?", [node_id])
  end

  # @param db [SQLite3::Database] open database handle.
  # @return [Array<Array(Integer, String)>] +[id, from_id]+ per message, by id.
  def attributions(db)
    db.execute("SELECT id, from_id FROM messages ORDER BY id").map { |row| [row["id"], row["from_id"]] }
  end

  describe "mentions (GN1)" do
    it "does not advance a mentioned real node's last_heard" do
      db = open_db
      seed_keyed_node(db, "!dddd0002", "Dave", "d2", now - 3 * day)
      dp.insert_message(db, channel_message(10, erin, "Erin: ping @[Dave]", now))
      expect(last_heard(db, "!dddd0002")).to eq(now - 3 * day)
    ensure
      db&.close
    end

    it "does not pull a node last heard 20 days ago back into the 7-day window" do
      db = open_db
      seed_keyed_node(db, "!dddd0003", "Zed", "d3", now - 20 * day)
      dp.insert_message(db, channel_message(11, erin, "Erin: @[Zed] still around?", now))
      expect(last_heard(db, "!dddd0003")).to eq(now - 20 * day)
    ensure
      db&.close
    end

    it "creates no row for a name that is only mentioned, and still names the sender" do
      db = open_db
      dp.insert_message(db, channel_message(12, erin, "Erin: hi @[Ghosty] and @[ Ghosty ]", now))
      aggregate_failures do
        expect(last_heard(db, derived_id("Ghosty"))).to be_nil
        expect(db.get_first_value("SELECT COUNT(*) FROM nodes WHERE long_name = 'Ghosty'")).to eq(0)
        # The sender was heard: her placeholder is named from the prefix.
        row = db.execute("SELECT long_name, synthetic, last_heard FROM nodes WHERE node_id = ?", [erin]).first
        expect(row.values_at("long_name", "synthetic", "last_heard")).to eq(["Erin", 1, now])
      end
    ensure
      db&.close
    end

    it "does not refresh an aged-out placeholder" do
      db = open_db
      seed_unkeyed_node(db, derived_id("Ghosty"), "Ghosty", now - 10 * day, synthetic: 1)
      dp.insert_message(db, channel_message(13, erin, "Erin: @[Ghosty] thanks", now))
      expect(last_heard(db, derived_id("Ghosty"))).to eq(now - 10 * day)
    ensure
      db&.close
    end

    it "does not hand a mention time to a later roster contact" do
      db = open_db
      dp.insert_message(db, channel_message(14, erin, "Erin: anyone seen @[Dave]?", now))
      # Dave's roster contact arrives afterwards, last advertised 3 days ago.
      seed_keyed_node(db, "!dddd0002", "Dave", "d2", now - 3 * day)
      expect(last_heard(db, "!dddd0002")).to eq(now - 3 * day)
    ensure
      db&.close
    end
  end

  describe "same-name real nodes (GN2)" do
    let(:name) { "Carol" }
    let(:sender) { "!cccc0001" }
    let(:retired) { "!dddd0001" }

    it "leaves a genuine real sender's messages on its own id when a same-name real exists" do
      db = open_db
      seed_keyed_node(db, sender, name, "cc", now - 120)
      seed_keyed_node(db, "!eeee0001", name, "ee", now - 600) # fresh same-name real
      seed_keyed_node(db, retired, name, "dd", now - 60 * day) # positively stale
      dp.insert_message(db, channel_message(20, sender, "#{name}: hello", now))
      aggregate_failures do
        expect(attributions(db)).to eq([[20, sender]])
        expect(last_heard(db, sender)).to eq(now)
        expect(last_heard(db, "!eeee0001")).to eq(now - 600)
        expect(last_heard(db, retired)).to eq(now - 60 * day)
      end
    ensure
      db&.close
    end

    it "keeps the sender's messages and freezes a positively stale same-name node" do
      db = open_db
      seed_keyed_node(db, retired, name, "dd", now - 60 * day)
      seed_keyed_node(db, sender, name, "cc", now - 120)
      dp.insert_message(db, channel_message(21, sender, "#{name}: earlier", now - 3600))
      dp.insert_message(db, channel_message(22, sender, "#{name}: hello", now))
      aggregate_failures do
        expect(attributions(db)).to eq([[21, sender], [22, sender]])
        expect(last_heard(db, retired)).to eq(now - 60 * day)
        expect(last_heard(db, sender)).to eq(now)
      end
    ensure
      db&.close
    end

    it "keeps the sender's messages beside a same-name node with no keyed evidence" do
      db = open_db
      seed_unkeyed_node(db, retired, name, now - 40 * day)
      seed_keyed_node(db, sender, name, "cc", now - 120)
      dp.insert_message(db, channel_message(23, sender, "#{name}: hello", now))
      aggregate_failures do
        expect(attributions(db)).to eq([[23, sender]])
        expect(last_heard(db, retired)).to eq(now - 40 * day)
      end
    ensure
      db&.close
    end

    it "keeps each of two live same-name devices on its own messages" do
      db = open_db
      seed_keyed_node(db, "!aaaa0001", "Twin", "aa", now - 30)
      seed_keyed_node(db, "!bbbb0001", "Twin", "bb", now - 600)
      dp.insert_message(db, channel_message(24, "!aaaa0001", "Twin: from device A", now))
      aggregate_failures do
        expect(attributions(db)).to eq([[24, "!aaaa0001"]])
        expect(last_heard(db, "!bbbb0001")).to eq(now - 600)
      end
    ensure
      db&.close
    end

    it "does not move the sender's earlier messages" do
      db = open_db
      seed_keyed_node(db, retired, name, "dd", now - 60 * day)
      seed_keyed_node(db, sender, name, "cc", now - 120)
      seed_message(db, 25, sender, "#{name}: old one", now - 7200)
      seed_message(db, 26, sender, "#{name}: old two", now - 7100)
      dp.insert_message(db, channel_message(27, sender, "#{name}: new", now))
      expect(attributions(db)).to eq([[25, sender], [26, sender], [27, sender]])
    ensure
      db&.close
    end

    it "makes merge_into_real_node a no-op when given a real node id" do
      db = open_db
      seed_keyed_node(db, retired, name, "dd", now - 60 * day)
      seed_keyed_node(db, sender, name, "cc", now - 120)
      seed_message(db, 28, sender, "#{name}: mine", now - 60)
      dp.merge_into_real_node(db, sender, name)
      aggregate_failures do
        expect(attributions(db)).to eq([[28, sender]])
        expect(last_heard(db, retired)).to eq(now - 60 * day)
        expect(last_heard(db, sender)).to eq(now - 120)
      end
    ensure
      db&.close
    end
  end

  describe "sole copy naming a positively stale key (GN3)" do
    let(:name) { "Carol" }
    let(:live) { "!cccc0001" }
    let(:retired) { "!dddd0001" }

    it "credits the one live same-name node and leaves the stale one frozen" do
      db = open_db
      seed_keyed_node(db, retired, name, "dd", now - 60 * day)
      seed_keyed_node(db, live, name, "cc", now - 120)
      dp.insert_message(db, channel_message(30, retired, "#{name}: via a stale roster", now))
      aggregate_failures do
        expect(attributions(db)).to eq([[30, live]])
        expect(last_heard(db, live)).to eq(now)
        expect(last_heard(db, retired)).to eq(now - 60 * day)
      end
    ensure
      db&.close
    end

    it "keeps the stale sender when no same-name node is live" do
      db = open_db
      seed_keyed_node(db, retired, name, "dd", now - 60 * day)
      dp.insert_message(db, channel_message(31, retired, "#{name}: still me", now))
      aggregate_failures do
        expect(attributions(db)).to eq([[31, retired]])
        expect(last_heard(db, retired)).to eq(now)
      end
    ensure
      db&.close
    end

    it "keeps the stale sender when two same-name nodes are live" do
      db = open_db
      seed_keyed_node(db, retired, name, "dd", now - 60 * day)
      seed_keyed_node(db, live, name, "cc", now - 120)
      seed_keyed_node(db, "!eeee0001", name, "ee", now - 600)
      dp.insert_message(db, channel_message(32, retired, "#{name}: ambiguous", now))
      expect(attributions(db)).to eq([[32, retired]])
    ensure
      db&.close
    end

    it "keeps a sender with no keyed evidence on its own id" do
      db = open_db
      seed_unkeyed_node(db, retired, name, now - 40 * day)
      seed_keyed_node(db, live, name, "cc", now - 120)
      dp.insert_message(db, channel_message(33, retired, "#{name}: unproven", now))
      expect(attributions(db)).to eq([[33, retired]])
    ensure
      db&.close
    end
  end

  describe "ingest API (GN1, GN4)" do
    let(:app) { Sinatra::Application }
    let(:auth_headers) do
      { "CONTENT_TYPE" => "application/json", "HTTP_AUTHORIZATION" => "Bearer ghost-spec-token" }
    end

    before do
      @original_token = ENV["API_TOKEN"]
      ENV["API_TOKEN"] = "ghost-spec-token"
      PotatoMesh::App::ApiCache.invalidate_all
    end

    after do
      if @original_token.nil?
        ENV.delete("API_TOKEN")
      else
        ENV["API_TOKEN"] = @original_token
      end
    end

    # @param path [String] GET route.
    # @return [Object] the parsed JSON body.
    def get_json(path)
      get path
      JSON.parse(last_response.body)
    end

    it "neither lists nor counts a mention-only name" do
      post "/api/messages", [channel_message(40, erin, "Erin: hi @[Ghosty]", now)].to_json, auth_headers
      expect(last_response.status).to eq(201)
      names = get_json("/api/nodes").map { |node| node["long_name"] }
      hour_nodes = get_json("/api/stats").dig("total", "nodes", "hour")
      aggregate_failures do
        expect(names).to eq(["Erin"])
        expect(hour_nodes).to eq(1)
      end
    end

    it "answers 201 to user.synthetic entries and writes nothing" do
      db = open_db
      seed_keyed_node(db, "!dddd0002", "Dave", "d2", now - 3 * day)
      db.close
      # What older ingestors queue for an unrostered sender or mention.
      placeholder = lambda do |long_name|
        {
          "lastHeard" => now, "protocol" => "meshcore",
          "user" => { "longName" => long_name, "shortName" => "", "role" => "COMPANION", "synthetic" => true },
        }
      end
      payload = {
        derived_id("Dave") => placeholder.call("Dave"),
        derived_id("Ghosty") => placeholder.call("Ghosty"),
        "ingestor" => "!634069bc",
        "protocol" => "meshcore",
      }
      post "/api/nodes", payload.to_json, auth_headers
      db = open_db
      aggregate_failures do
        expect(last_response.status).to eq(201)
        expect(last_heard(db, "!dddd0002")).to eq(now - 3 * day)
        expect(db.get_first_value("SELECT COUNT(*) FROM nodes WHERE synthetic = 1")).to eq(0)
      end
    ensure
      db&.close
    end

    it "keeps a live same-name sender's messages and leaves the quiet node unlisted" do
      db = open_db
      seed_keyed_node(db, "!dddd0001", "Carol", "dd", now - 8 * day)
      seed_keyed_node(db, "!cccc0001", "Carol", "cc", now - 120)
      db.close
      post "/api/messages", [channel_message(41, "!cccc0001", "Carol: hello", now)].to_json, auth_headers
      ids = get_json("/api/nodes").map { |node| node["node_id"] }
      senders = get_json("/api/messages").map { |message| message["from_id"] }
      aggregate_failures do
        # Last advertised 8 days ago: outside the 7-day list unless revived.
        expect(ids).to eq(["!cccc0001"])
        expect(senders).to eq(["!cccc0001"])
      end
    ensure
      db&.close
    end
  end
end
