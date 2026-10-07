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
require "base64"
require_relative "support/data_processing_harness"

# A node row is bound to the key that first named it (SPEC NI2, NI3): a
# record under another key, or under none, cannot change the row's names,
# role, hardware model, key, position, destinations or keyed evidence, and
# cannot merge a same-name chat placeholder into it; it still refreshes
# +last_heard+ and telemetry.  MeshCore rows bind on the full public key and
# Reticulum rows on the identity hash, so two identities sharing the 4-byte
# node id keep the first one's names.  A new key takes the row over once the
# stored key's row is positively stale (SPEC MR2).  A Meshtastic record that
# carries a user but no role is a CLIENT (SPEC NI5).
#
# The shared "with isolated db" context shortens +four_weeks_seconds+ to one
# week, so "positively stale" here means keyed evidence older than a week.
RSpec.describe "Node identity binding" do
  let(:harness_class) { DataProcessingHarness.build }

  subject(:dp) { harness_class.new }

  include_context "with isolated db"

  let(:marker) { PotatoMesh::Config.node_opt_out_marker }

  # Read one full node row.
  #
  # @param db [SQLite3::Database] open database handle.
  # @param node_id [String] canonical node id.
  # @return [Hash, nil] the +nodes+ row, or nil when absent.
  def node_row(db, node_id)
    db.execute("SELECT * FROM nodes WHERE node_id = ?", [node_id]).first
  end

  # Node ids the node list serves.
  #
  # @return [Array<String>] node ids returned by +query_nodes+.
  def listed_ids
    dp.query_nodes(100).map { |node| node["node_id"] }
  end

  # Unix seconds of keyed evidence old enough to count as positively stale.
  #
  # @return [Integer] a time just past the evidence window.
  def stale_time
    now - PotatoMesh::Config.four_weeks_seconds - 60
  end

  describe "key-bound identity" do
    let(:id) { "!b2b2b2b2" }
    let(:k1) { Base64.strict_encode64("\x11".b * 32) }
    let(:k2) { Base64.strict_encode64("\x22".b * 32) }

    # Store the row's own NodeInfo under key +k1+.
    #
    # @param db [SQLite3::Database] open database handle.
    # @param long_name [String] the owner's long name.
    # @param heard [Integer] unix seconds of the record.
    # @return [void]
    def seed_owner(db, long_name: "Owner", heard: now - 600)
      dp.upsert_node(db, id, {
        "num" => 0xb2b2b2b2,
        "lastHeard" => heard,
        "user" => { "id" => id, "longName" => long_name, "shortName" => "OWNR", "role" => "ROUTER",
                    "hwModel" => "RAK4631", "publicKey" => k1 },
        "position" => { "latitude" => 52.52, "longitude" => 13.405, "time" => heard },
      })
    end

    # Post a NodeInfo for the same id, under +key+ (nil: no key).
    #
    # @param db [SQLite3::Database] open database handle.
    # @param key [String, nil] public key the record carries.
    # @param long_name [String] long name the record carries.
    # @param heard [Integer] unix seconds of the record (default: now).
    # @return [void]
    def post_profile(db, key:, long_name: "Mallory", heard: now)
      user = { "id" => id, "longName" => long_name, "shortName" => "MLRY", "role" => "CLIENT", "hwModel" => "TBEAM" }
      user["publicKey"] = key if key
      dp.upsert_node(db, id, {
        "num" => 0xb2b2b2b2,
        "lastHeard" => heard,
        "user" => user,
        "deviceMetrics" => { "batteryLevel" => 42 },
        "position" => { "latitude" => 48.137, "longitude" => 11.575, "time" => heard },
      })
    end

    it "keeps names, role, hardware model, key and position against a record under another key" do
      allow(dp).to receive(:update_prometheus_metrics)
      db = open_db
      seed_owner(db)
      post_profile(db, key: k2)
      row = node_row(db, id)
      db.close
      # The record's profile and position reach no metric; its telemetry does.
      expect(dp).to have_received(:update_prometheus_metrics).with(id, nil, "CLIENT", { "batteryLevel" => 42 }, nil)
      expect(row.slice("long_name", "short_name", "role", "hw_model", "public_key", "latitude", "last_advert_heard")).to eq(
        "long_name" => "Owner", "short_name" => "OWNR", "role" => "ROUTER", "hw_model" => "RAK4631",
        "public_key" => k1, "latitude" => 52.52, "last_advert_heard" => now - 600,
      )
      # Liveness and telemetry still follow the newer record.
      expect(row.slice("last_heard", "battery_level")).to eq("last_heard" => now, "battery_level" => 42.0)
    end

    it "does not let a record under another key remove the opt-out marker" do
      db = open_db
      seed_owner(db, long_name: "Owner #{marker}")
      db.close
      expect(listed_ids).not_to include(id)
      db = open_db
      post_profile(db, key: k2, long_name: "Owner")
      db.close
      expect(listed_ids).not_to include(id)
    end

    it "does not let a record under another key add the opt-out marker" do
      db = open_db
      seed_owner(db)
      db.close
      expect(listed_ids).to include(id)
      db = open_db
      post_profile(db, key: k2, long_name: "Owner #{marker}")
      db.close
      expect(listed_ids).to include(id)
    end

    it "counts a record without a key as another key" do
      db = open_db
      seed_owner(db)
      post_profile(db, key: nil)
      row = node_row(db, id)
      db.close
      expect(row.slice("long_name", "role", "public_key", "latitude")).to eq(
        "long_name" => "Owner", "role" => "ROUTER", "public_key" => k1, "latitude" => 52.52,
      )
    end

    it "lets a new key take the row over once the stored key's row is positively stale" do
      db = open_db
      seed_owner(db, heard: stale_time)
      post_profile(db, key: k2)
      row = node_row(db, id)
      db.close
      expect(row.slice("long_name", "role", "public_key", "latitude", "last_advert_heard")).to eq(
        "long_name" => "Mallory", "role" => "CLIENT", "public_key" => k2, "latitude" => 48.137,
        "last_advert_heard" => now,
      )
    end

    it "still renames the node from a record under the stored key" do
      db = open_db
      seed_owner(db)
      post_profile(db, key: k1, long_name: "Owner Renamed")
      row = node_row(db, id)
      db.close
      expect(row.slice("long_name", "role", "latitude", "last_advert_heard")).to eq(
        "long_name" => "Owner Renamed", "role" => "CLIENT", "latitude" => 48.137, "last_advert_heard" => now,
      )
    end

    it "lets a takeover record older than the row's last_heard stamp no evidence, so a newer one takes over" do
      db = open_db
      seed_owner(db, heard: stale_time)
      # A message touch keeps the row's last_heard ahead of the next record.
      dp.touch_node_last_seen(db, id, nil, rx_time: now - 100, source: :message)
      post_profile(db, key: k2, heard: now - 200)
      after_older = node_row(db, id).slice("long_name", "public_key", "last_advert_heard")
      post_profile(db, key: k2)
      row = node_row(db, id)
      db.close
      expect(after_older).to eq("long_name" => "Owner", "public_key" => k1, "last_advert_heard" => stale_time)
      expect(row.slice("long_name", "public_key", "last_advert_heard")).to eq(
        "long_name" => "Mallory", "public_key" => k2, "last_advert_heard" => now,
      )
    end
  end

  describe "same prefix" do
    let(:id) { "!aabbccdd" }

    # A MeshCore record (contact or advert) under +key+.
    #
    # @param name [String] advertised name.
    # @param key [String] 64-hex public key.
    # @param heard [Integer] unix seconds of the record.
    # @param role [String] MeshCore role.
    # @param position [Hash, nil] advertised position.
    # @return [Hash] node record.
    def meshcore_record(name, key, heard, role: "COMPANION", position: nil)
      record = {
        "lastHeard" => heard,
        "protocol" => "meshcore",
        "user" => { "longName" => name, "shortName" => "aabb", "publicKey" => key, "role" => role },
      }
      record["position"] = position if position
      record
    end

    let(:k1) { "aabbccdd" + "11" * 28 }
    let(:k2) { "aabbccdd" + "22" * 28 }

    it "does not let a second MeshCore key with the same prefix rename, re-key or move the first" do
      berlin = { "latitude" => 52.52, "longitude" => 13.405, "time" => now - 600 }
      munich = { "latitude" => 48.137, "longitude" => 11.575, "time" => now }
      db = open_db
      dp.upsert_node(db, id, meshcore_record("Alice", k1, now - 600, position: berlin), protocol: "meshcore")
      dp.upsert_node(db, id, meshcore_record("Mallory", k2, now, role: "REPEATER", position: munich), protocol: "meshcore")
      row = node_row(db, id)
      db.close
      expect(row.slice("long_name", "role", "public_key", "last_advert_heard", "latitude")).to eq(
        "long_name" => "Alice", "role" => "COMPANION", "public_key" => k1,
        "last_advert_heard" => now - 600, "latitude" => 52.52,
      )
    end

    it "does not let the position row of an advert under a colliding key move the first identity's node" do
      berlin = { "latitude" => 52.52, "longitude" => 13.405, "time" => now - 600 }
      db = open_db
      dp.upsert_node(db, id, meshcore_record("Alice", k1, now - 600, position: berlin), protocol: "meshcore")
      # The rows _store_meshcore_position posts for an advert, under each key.
      position_row = lambda do |key, latitude, longitude, heard|
        { "id" => heard, "rx_time" => heard, "node_id" => id, "from_id" => id, "latitude" => latitude,
          "longitude" => longitude, "position_time" => heard, "protocol" => "meshcore", "public_key" => key }
      end
      dp.insert_position(db, position_row.call(k2, 48.137, 11.575, now - 60))
      collided = node_row(db, id).slice("latitude", "longitude", "last_heard")
      dp.insert_position(db, position_row.call(k1, 50.11, 8.682, now))
      moved = node_row(db, id).slice("latitude", "longitude")
      positions = db.get_first_value("SELECT COUNT(*) FROM positions WHERE node_id = ?", [id])
      db.close
      expect(collided).to eq("latitude" => 52.52, "longitude" => 13.405, "last_heard" => now - 60)
      expect(moved).to eq("latitude" => 50.11, "longitude" => 8.682)
      expect(positions).to eq(2)
    end

    it "does not let a colliding MeshCore key pull a same-name chat placeholder's messages onto the row" do
      placeholder = "!5e5e5e5e"
      db = open_db
      dp.upsert_node(db, id, meshcore_record("Alice", k1, now - 600), protocol: "meshcore")
      dp.upsert_node(db, placeholder, {
        "lastHeard" => now - 300,
        "protocol" => "meshcore",
        "user" => { "longName" => "Mallory", "shortName" => "", "synthetic" => true },
      }, protocol: "meshcore")
      db.execute(
        "INSERT INTO messages(id, rx_time, rx_iso, from_id, to_id, channel, text, protocol) VALUES (?,?,?,?,?,?,?,?)",
        [777, now - 300, Time.at(now - 300).utc.iso8601, placeholder, "^all", 0, "Mallory: send me your location", "meshcore"],
      )
      # A colliding advert named after the chat persona, then the row's own
      # advert under the first key.
      dp.upsert_node(db, id, meshcore_record("Mallory", k2, now - 60), protocol: "meshcore")
      dp.upsert_node(db, id, meshcore_record("Alice", k1, now), protocol: "meshcore")
      author = db.get_first_value("SELECT from_id FROM messages WHERE id = 777")
      placeholder_left = db.get_first_value("SELECT COUNT(*) FROM nodes WHERE node_id = ?", [placeholder])
      db.close
      expect([author, placeholder_left]).to eq([placeholder, 1])
    end

    it "does not let a second Reticulum identity with the same prefix take the display name or add a destination" do
      h1 = "aabbccdd" + "11" * 12
      h2 = "aabbccdd" + "22" * 12
      db = open_db
      dp.upsert_node(db, id, {
        "lastHeard" => now,
        "identityHash" => h1,
        "destination" => { "id" => "d1" * 16, "aspect" => "lxmf.delivery", "role" => "PEER" },
        "user" => { "longName" => "Alice Peer", "shortName" => "aabb", "publicKey" => "11" * 64, "role" => "PEER" },
      }, protocol: "reticulum")
      dp.upsert_node(db, id, {
        "lastHeard" => now - 3600,
        "identityHash" => h2,
        "destination" => { "id" => "d2" * 16, "aspect" => "nomadnetwork.node", "role" => "NODE" },
        "user" => { "longName" => "Mallory Node", "shortName" => "aabb", "publicKey" => "22" * 64, "role" => "NODE" },
      }, protocol: "reticulum")
      row = node_row(db, id)
      destinations = db.execute("SELECT id FROM destinations WHERE node_id = ? ORDER BY id", [id]).map { |d| d["id"] }
      db.close
      expect([row["long_name"], row["role"], row["identity_hash"], row["public_key"], destinations]).to eq(
        ["Alice Peer", "PEER", h1, "11" * 64, ["d1" * 16]],
      )
    end
  end

  describe "Reticulum identity binding" do
    let(:id) { "!aabbccdd" }

    it "keeps the bound identity's names and position against a record without an identity hash" do
      db = open_db
      dp.upsert_node(db, id, {
        "lastHeard" => now - 600,
        "identityHash" => "aabbccdd" + "11" * 12,
        "destination" => { "id" => "d1" * 16, "aspect" => "nomadnetwork.node", "role" => "NODE" },
        "user" => { "longName" => "Bound Node", "shortName" => "aabb", "publicKey" => "11" * 64, "role" => "NODE" },
        "position" => { "latitude" => 52.52, "longitude" => 13.405, "time" => now - 600 },
      }, protocol: "reticulum")
      dp.upsert_node(db, id, {
        "lastHeard" => now,
        "user" => { "longName" => "Other Name", "shortName" => "aabb", "role" => "PEER" },
        "position" => { "latitude" => 48.137, "longitude" => 11.575, "time" => now },
      }, protocol: "reticulum")
      row = node_row(db, id)
      db.close
      expect(row.slice("long_name", "role", "latitude", "last_heard")).to eq(
        "long_name" => "Bound Node", "role" => "NODE", "latitude" => 52.52, "last_heard" => now,
      )
    end

    it "names the node from the new identity's destinations once it takes a stale row over" do
      h1 = "aabbccdd" + "11" * 12
      h2 = "aabbccdd" + "22" * 12
      db = open_db
      dp.upsert_node(db, id, {
        "lastHeard" => stale_time,
        "identityHash" => h1,
        "destination" => { "id" => "d1" * 16, "aspect" => "nomadnetwork.node", "role" => "NODE" },
        "user" => { "longName" => "Retired Node", "shortName" => "aabb", "publicKey" => "11" * 64, "role" => "NODE" },
      }, protocol: "reticulum")
      dp.upsert_node(db, id, {
        "lastHeard" => now,
        "identityHash" => h2,
        "destination" => { "id" => "d2" * 16, "aspect" => "lxmf.delivery", "role" => "PEER" },
        "user" => { "longName" => "New Peer", "shortName" => "aabb", "publicKey" => "22" * 64, "role" => "PEER" },
      }, protocol: "reticulum")
      row = node_row(db, id)
      db.close
      # The retired identity's NODE destination outranks a PEER one, but it
      # is no longer this row's identity.
      expect(row.slice("long_name", "role", "identity_hash")).to eq(
        "long_name" => "New Peer", "role" => "PEER", "identity_hash" => h2,
      )
    end
  end

  describe "cross-protocol reclaim (#747)" do
    it "does not let a MeshCore record rename or reclaim a keyed Meshtastic row" do
      id = "!aabbccdd"
      db = open_db
      dp.upsert_node(db, id, {
        "num" => 0xaabbccdd,
        "lastHeard" => now - 600,
        "user" => { "id" => id, "longName" => "Meshtastic Owner", "shortName" => "MTO", "role" => "ROUTER",
                    "publicKey" => Base64.strict_encode64("\x11".b * 32) },
      })
      dp.upsert_node(db, id, {
        "lastHeard" => now,
        "protocol" => "meshcore",
        "user" => { "longName" => "Mallory", "shortName" => "aabb", "publicKey" => "aabbccdd" + "22" * 28 },
      }, protocol: "meshcore")
      row = node_row(db, id)
      db.close
      expect(row.slice("protocol", "long_name", "role")).to eq(
        "protocol" => "meshtastic", "long_name" => "Meshtastic Owner", "role" => "ROUTER",
      )
    end
  end

  describe "node number" do
    it "keeps a node's own number against a record whose num names another node" do
      db = open_db
      dp.upsert_node(db, "!b2b2b2b2", {
        "num" => 0xb2b2b2b2, "lastHeard" => now - 60,
        "user" => { "id" => "!b2b2b2b2", "longName" => "Bob", "shortName" => "BOB" },
      })
      dp.upsert_node(db, "!a1a1a1a1", {
        "num" => 0xb2b2b2b2, "lastHeard" => now,
        "user" => { "id" => "!a1a1a1a1", "longName" => "Sender", "shortName" => "SNDR" },
      })
      rows = db.execute("SELECT node_id, num FROM nodes ORDER BY node_id").map { |r| [r["node_id"], r["num"]] }
      db.close
      expect(rows).to eq([["!a1a1a1a1", 0xa1a1a1a1], ["!b2b2b2b2", 0xb2b2b2b2]])
    end
  end

  describe "decrypted records" do
    # Store a payload the web app decrypted from a message sent by +!a1a1a1a1+.
    #
    # @param db [SQLite3::Database] open database handle.
    # @param portnum [Integer] port number of the decrypted payload.
    # @param decoded [Hash] what the payload decoder returns for it.
    # @param from_id [String, nil] sender of the message; nil for none.
    # @return [Boolean] whether the payload was stored.
    def store_decrypted(db, portnum, decoded, from_id: "!a1a1a1a1")
      allow(PotatoMesh::App::Meshtastic::PayloadDecoder).to receive(:decode).and_return(decoded)
      message = from_id ? { "from_num" => 0xa1a1a1a1 } : {}
      dp.store_decrypted_payload(
        db, message, 777_001, { payload: "decrypted".b, portnum: portnum },
        rx_time: now, rx_iso: Time.at(now).utc.iso8601, from_id: from_id, to_id: "^all",
        channel: 0, portnum: portnum, hop_limit: 3, snr: 5.0, rssi: -80,
      )
    end

    it "drops a decrypted NodeInfo whose user.id names another node" do
      allow(dp).to receive(:warn_log)
      db = open_db
      stored = store_decrypted(db, 4, {
        "type" => "NODEINFO_APP",
        "payload" => { "user" => { "id" => "!b2b2b2b2", "long_name" => "Mallory", "short_name" => "MLRY" } },
      })
      count = db.get_first_value("SELECT COUNT(*) FROM nodes")
      db.close
      expect([stored, count]).to eq([false, 0])
      expect(dp).to have_received(:warn_log).with(
        "Dropped decrypted payload naming another node",
        hash_including(type: "NODEINFO_APP", from_id: "!a1a1a1a1", node_id: "!b2b2b2b2"),
      )
    end

    it "files a decrypted NodeInfo under its sender's own number" do
      db = open_db
      stored = store_decrypted(db, 4, {
        "type" => "NODEINFO_APP",
        "payload" => { "num" => 0xb2b2b2b2, "user" => { "id" => "!a1a1a1a1", "long_name" => "Sender", "short_name" => "SNDR" } },
      })
      rows = db.execute("SELECT node_id, num, long_name FROM nodes").map { |r| r.values_at("node_id", "num", "long_name") }
      db.close
      expect([stored, rows]).to eq([true, [["!a1a1a1a1", 0xa1a1a1a1, "Sender"]]])
    end

    it "files a decrypted NodeInfo that names no id under its sender" do
      db = open_db
      stored = store_decrypted(db, 4, {
        "type" => "NODEINFO_APP",
        "payload" => { "num" => 0xb2b2b2b2, "user" => { "long_name" => "No Id", "short_name" => "NOID" } },
      })
      rows = db.execute("SELECT node_id, num, long_name FROM nodes").map { |r| r.values_at("node_id", "num", "long_name") }
      db.close
      expect([stored, rows]).to eq([true, [["!a1a1a1a1", 0xa1a1a1a1, "No Id"]]])
    end

    it "files a decrypted NodeInfo with no sender under the id it names" do
      db = open_db
      stored = store_decrypted(db, 4, {
        "type" => "NODEINFO_APP",
        "payload" => { "id" => "!b2b2b2b2", "num" => 0xb2b2b2b2, "user" => { "id" => "!b2b2b2b2", "long_name" => "Unsent", "short_name" => "UNST" } },
      }, from_id: nil)
      rows = db.execute("SELECT node_id, num, long_name FROM nodes").map { |r| r.values_at("node_id", "num", "long_name") }
      db.close
      expect([stored, rows]).to eq([true, [["!b2b2b2b2", 0xb2b2b2b2, "Unsent"]]])
    end

    it "drops a decrypted NodeInfo whose own id or user.id is not the sender's canonical id" do
      allow(dp).to receive(:warn_log)
      db = open_db
      stored = [
        { "id" => "!Decrypted", "user" => { "long_name" => "Decoded" } },
        { "user" => { "id" => "!Decrypted", "long_name" => "Decoded" } },
        { "user" => { "id" => "!A1A1A1A1", "long_name" => "Decoded" } },
      ].map { |payload| store_decrypted(db, 4, { "type" => "NODEINFO_APP", "payload" => payload }) }
      count = db.get_first_value("SELECT COUNT(*) FROM nodes")
      db.close
      expect([stored, count]).to eq([[false, false, false], 0])
      %w[!Decrypted !A1A1A1A1].each do |claimed|
        expect(dp).to have_received(:warn_log).with(
          "Dropped decrypted payload naming another node",
          hash_including(type: "NODEINFO_APP", from_id: "!a1a1a1a1", node_id: claimed),
        ).at_least(:once)
      end
    end

    it "drops a decrypted NeighborInfo naming another node" do
      allow(dp).to receive(:warn_log)
      db = open_db
      stored = store_decrypted(db, 71, {
        "type" => "NEIGHBORINFO_APP",
        "payload" => { "node_id" => 0xb2b2b2b2, "neighbors" => [{ "node_id" => 0xc3c3c3c3, "snr" => 5.0 }] },
      })
      count = db.get_first_value("SELECT COUNT(*) FROM neighbors")
      db.close
      expect([stored, count]).to eq([false, 0])
      expect(dp).to have_received(:warn_log).with(
        "Dropped decrypted payload naming another node",
        hash_including(type: "NEIGHBORINFO_APP", from_id: "!a1a1a1a1", node_id: "!b2b2b2b2"),
      )
    end

    it "drops a decrypted NeighborInfo whose node_id is not the sender's canonical id" do
      allow(dp).to receive(:warn_log)
      db = open_db
      stored = ["!Decrypted", "!A1A1A1A1", -1].map do |claimed|
        store_decrypted(db, 71, {
          "type" => "NEIGHBORINFO_APP",
          "payload" => { "node_id" => claimed, "neighbors" => [{ "node_id" => 0xc3c3c3c3, "snr" => 5.0 }] },
        })
      end
      own = store_decrypted(db, 71, {
        "type" => "NEIGHBORINFO_APP",
        "payload" => { "node_id" => 0xa1a1a1a1, "neighbors" => [{ "node_id" => 0xc3c3c3c3, "snr" => 5.0 }] },
      })
      rows = db.execute("SELECT node_id, neighbor_id FROM neighbors").map { |r| r.values_at("node_id", "neighbor_id") }
      db.close
      expect([stored, own, rows]).to eq([[false, false, false], true, [["!a1a1a1a1", "!c3c3c3c3"]]])
      expect(dp).to have_received(:warn_log).with(
        "Dropped decrypted payload naming another node",
        hash_including(type: "NEIGHBORINFO_APP", from_id: "!a1a1a1a1", node_id: -1),
      )
    end
  end

  describe "placeholder role" do
    let(:id) { "!0b6f0004" }

    # Store a position from an unknown node, which creates its placeholder
    # row (CLIENT_HIDDEN for Meshtastic, the base role for other protocols).
    #
    # @param db [SQLite3::Database] open database handle.
    # @param protocol [String] protocol stamped on the position.
    # @return [void]
    def hear_position(db, protocol: "meshtastic")
      dp.insert_position(db, {
        "id" => 965_001, "rx_time" => now - 20, "node_id" => id, "latitude" => 52.5, "longitude" => 13.4,
        "protocol" => protocol,
      })
    end

    # Read the stored role.
    #
    # @param db [SQLite3::Database] open database handle.
    # @return [String, nil] the node's role.
    def stored_role(db)
      db.get_first_value("SELECT role FROM nodes WHERE node_id = ?", [id])
    end

    it "replaces the CLIENT_HIDDEN placeholder when a Meshtastic record carries a user but no role" do
      db = open_db
      hear_position(db)
      placeholder_role = stored_role(db)
      dp.upsert_node(db, id, {
        "num" => 0x0b6f0004, "lastHeard" => now - 10,
        "user" => { "id" => id, "shortName" => "PLC", "longName" => "Plain Client", "hwModel" => "TBEAM" },
      })
      role = stored_role(db)
      db.close
      expect([placeholder_role, role]).to eq(%w[CLIENT_HIDDEN CLIENT])
    end

    it "keeps a CLIENT_HIDDEN role the record states" do
      db = open_db
      hear_position(db)
      dp.upsert_node(db, id, {
        "num" => 0x0b6f0004, "lastHeard" => now - 10,
        "user" => { "id" => id, "shortName" => "HID", "longName" => "Hidden Client", "role" => "CLIENT_HIDDEN" },
      })
      role = stored_role(db)
      db.close
      expect(role).to eq("CLIENT_HIDDEN")
    end

    it "keeps the placeholder role against the meshtastic library's stand-in for a node it has no NodeInfo for" do
      db = open_db
      hear_position(db)
      # What the library's +_getOrCreateByNum+ files for such a node, and the
      # node-list snapshot then posts.
      dp.upsert_node(db, id, {
        "num" => 0x0b6f0004, "lastHeard" => now - 10,
        "user" => { "id" => id, "longName" => "Meshtastic 0004", "shortName" => "0004", "hwModel" => "UNSET" },
      })
      role = stored_role(db)
      db.close
      expect(role).to eq("CLIENT_HIDDEN")
    end

    it "keeps the stored role when a record carries no user" do
      db = open_db
      hear_position(db)
      dp.upsert_node(db, id, { "num" => 0x0b6f0004, "lastHeard" => now - 10 })
      role = stored_role(db)
      db.close
      expect(role).to eq("CLIENT_HIDDEN")
    end

    it "keeps another protocol's base role when its record names no role" do
      db = open_db
      hear_position(db, protocol: "meshcore")
      dp.upsert_node(db, id, {
        "lastHeard" => now - 10,
        "user" => { "shortName" => "0b6f", "longName" => "Core Node", "publicKey" => "0b6f0004" + "44" * 28 },
      }, protocol: "meshcore")
      role = stored_role(db)
      db.close
      expect(role).to eq("COMPANION")
    end
  end
end
