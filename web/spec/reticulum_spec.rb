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

require_relative "spec_helper"

# Reticulum protocol support (#888).  Mirrors the MeshCore coverage in
# protocol_spec.rb with fixtures shaped like the Python Reticulum ingestor's
# announce-derived node payloads: id = "!" + first 4 bytes of the *identity*
# hash, user.publicKey = the identity's real public key, destHash = the list of
# destination hashes that resolve to that identity, no SNR/RSSI, no user.role,
# no position, no deviceMetrics, hopsAway omitted when unknown.
RSpec.describe "Reticulum protocol support" do
  let(:app) { Sinatra::Application }
  let(:api_token) { "test-token" }
  let(:auth_headers) do
    {
      "CONTENT_TYPE" => "application/json",
      "HTTP_AUTHORIZATION" => "Bearer #{api_token}",
    }
  end
  let(:now) { Time.now.to_i }

  RETICULUM_INGESTOR_ID = "!feedf00d".freeze
  RETICULUM_NODE_ID = "!a1b2c3d4".freeze
  RETICULUM_DEST_HASH = "a1b2c3d4e5f60718293a4b5c6d7e8f90".freeze
  # A second destination (the peer's other announce aspect) resolving to the
  # same identity, and therefore to the same node row.
  RETICULUM_DEST_HASH2 = "00ff11ee22dd33cc44bb55aa66997788".freeze
  RETICULUM_PUBLIC_KEY = ("ab" * 64).freeze
  RETICULUM_IDENTITY_HASH = "27716218762cfd2864141ef286c39940".freeze
  RETICULUM_NODE_ID2 = "!0badcafe".freeze
  MESHTASTIC_PEER_ID = "!12ab34cd".freeze

  # Announce-derived node fixture, exactly the shape the Reticulum ingestor
  # POSTs (no snr/rssi/position/deviceMetrics/user.role).
  def reticulum_node_fixture(last_heard:, hops_away: 2, aspect: "lxmf.delivery",
                             dest_id: RETICULUM_DEST_HASH, role: "PEER")
    node = {
      "user" => {
        "longName" => "Argos Station",
        "shortName" => "a1b2",
        "publicKey" => RETICULUM_PUBLIC_KEY,
        "role" => role,
      },
      "lastHeard" => last_heard,
      "protocol" => "reticulum",
      "identityHash" => RETICULUM_IDENTITY_HASH,
      "interface" => "RNodeInterface[RNode Reticulum Berlin]",
      "destination" => { "id" => dest_id, "aspect" => aspect, "role" => role },
    }
    node["hopsAway"] = hops_away if hops_away
    node
  end

  before do
    @original_token = ENV.fetch("API_TOKEN", nil)
    ENV["API_TOKEN"] = api_token
    clear_tables
    PotatoMesh::App::ApiCache.invalidate_all
  end

  after do
    ENV["API_TOKEN"] = @original_token
    clear_tables
  end

  # Open a database connection for direct inspection.
  #
  # @param readonly [Boolean] whether to open in read-only mode.
  # @yieldparam db [SQLite3::Database] open database handle.
  # @return [void]
  def with_db(readonly: false)
    db = PotatoMesh::Application.open_database(readonly: readonly)
    db.results_as_hash = true
    yield db
  ensure
    db&.close
  end

  # Remove all rows from tables exercised by these tests.
  #
  # @return [void]
  def clear_tables
    with_db do |db|
      db.execute("DELETE FROM messages")
      db.execute("DELETE FROM positions")
      db.execute("DELETE FROM telemetry")
      db.execute("DELETE FROM nodes")
      # Destinations outlive nodes otherwise: they are keyed on the destination
      # hash, so a test using a different aspect accumulates rows rather than
      # overwriting the previous one.
      db.execute("DELETE FROM destinations")
      db.execute("DELETE FROM ingestors")
      db.execute("DELETE FROM ingestor_activity")
    end
  end

  # Register the Reticulum ingestor heartbeat via the API.
  #
  # @return [Rack::MockResponse] the POST response.
  def register_reticulum_ingestor
    payload = {
      node_id: RETICULUM_INGESTOR_ID,
      start_time: now - 60,
      last_seen_time: now,
      version: "0.7.4",
      protocol: "reticulum",
    }
    post "/api/ingestors", payload.to_json, auth_headers
    last_response
  end

  # POST the fixture node batch the way the ingestor does (wrapper-level
  # protocol stamp plus ingestor id).
  #
  # @return [Rack::MockResponse] the POST response.
  def post_reticulum_nodes
    payload = {
      RETICULUM_NODE_ID => reticulum_node_fixture(last_heard: now - 30),
      "ingestor" => RETICULUM_INGESTOR_ID,
      "protocol" => "reticulum",
    }
    post "/api/nodes", payload.to_json, auth_headers
    last_response
  end

  describe "POST /api/ingestors" do
    it "stores the reticulum protocol" do
      expect(register_reticulum_ingestor.status).to eq(201)

      with_db(readonly: true) do |db|
        row = db.get_first_row("SELECT protocol FROM ingestors WHERE node_id = ?", [RETICULUM_INGESTOR_ID])
        expect(row["protocol"]).to eq("reticulum")
      end
    end

    it "filters /api/ingestors by protocol=reticulum" do
      register_reticulum_ingestor
      get "/api/ingestors?protocol=reticulum", {}, auth_headers

      expect(last_response.status).to eq(200)
      rows = JSON.parse(last_response.body)
      expect(rows.map { |r| r["node_id"] }).to eq([RETICULUM_INGESTOR_ID])
      expect(rows.first["protocol"]).to eq("reticulum")
    end
  end

  describe "destinations schema (T-E)" do
    it "stores one destination row per announced aspect, linked by identity" do
      register_reticulum_ingestor
      post_reticulum_nodes

      with_db(readonly: true) do |db|
        rows = db.execute(
          "SELECT id, node_id, name, aspect, role FROM destinations ORDER BY aspect",
        )
        expect(rows.length).to eq(1)
        expect(rows[0]["id"]).to eq(RETICULUM_DEST_HASH)
        expect(rows[0]["node_id"]).to eq(RETICULUM_NODE_ID)
        expect(rows[0]["aspect"]).to eq("lxmf.delivery")
      end
    end

    it "replaces the nodes.dest_hash column" do
      # A JSON array column and a table modelling the same thing would drift.
      with_db(readonly: true) do |db|
        columns = db.execute("PRAGMA table_info(nodes)").map { |r| r["name"] }
        expect(columns).not_to include("dest_hash")
        expect(columns).to include("identity_hash")
      end
    end
  end

  describe "headline aspect preference (SPEC RE10)" do
    # Post two aspects of ONE identity, in a given order, and read back the
    # node's headline fields. Both land on the same node row (SPEC RE7).
    def post_two_aspects(first, second)
      register_reticulum_ingestor
      [first, second].each_with_index do |aspect, index|
        payload = {
          RETICULUM_NODE_ID => reticulum_node_fixture(
            last_heard: now - 30 + index,
            aspect: aspect[:aspect],
            dest_id: aspect[:dest],
            role: aspect[:role],
          ).merge("user" => {
                    "longName" => aspect[:name],
                    "shortName" => "a1b2",
                    "publicKey" => RETICULUM_PUBLIC_KEY,
                  }),
          "ingestor" => RETICULUM_INGESTOR_ID,
          "protocol" => "reticulum",
        }
        post "/api/nodes", payload.to_json, auth_headers
      end
      with_db(readonly: true) do |db|
        db.execute(
          "SELECT long_name, role FROM nodes WHERE node_id = ?", [RETICULUM_NODE_ID]
        ).first
      end
    end

    NODE_ASPECT = {
      aspect: "nomadnetwork.node", dest: RETICULUM_DEST_HASH,
      role: "NODE", name: "Department of Decentralization",
    }.freeze
    PEER_ASPECT = {
      aspect: "lxmf.delivery", dest: RETICULUM_DEST_HASH2,
      role: "PEER", name: "Afri Nomad Orion",
    }.freeze

    it "prefers NODE over PEER whichever announce arrives last" do
      # The whole point: the headline must not depend on arrival order, which
      # is what made a multi-aspect peer's name alternate on every announce.
      node_last = post_two_aspects(PEER_ASPECT, NODE_ASPECT)
      expect(node_last["long_name"]).to eq("Department of Decentralization")
      expect(node_last["role"]).to eq("NODE")

      clear_tables
      peer_last = post_two_aspects(NODE_ASPECT, PEER_ASPECT)
      expect(peer_last["long_name"]).to eq("Department of Decentralization")
      expect(peer_last["role"]).to eq("NODE")
    end

    it "ranks PROPAGATION above TRANSPORT" do
      row = post_two_aspects(
        { aspect: "rns.transport", dest: RETICULUM_DEST_HASH,
          role: "TRANSPORT", name: "Transport Instance" },
        { aspect: "lxmf.propagation", dest: RETICULUM_DEST_HASH2,
          role: "PROPAGATION", name: "Propagation Store" },
      )
      expect(row["long_name"]).to eq("Propagation Store")
      expect(row["role"]).to eq("PROPAGATION")
    end

    it "keeps a real destination name when a placeholder arrives later" do
      # Discovery re-emits the host's aspects on every snapshot, falling back to
      # "Reticulum <SHORT>" when the stack remembers no app_data. Arriving after
      # a real announce, that must not overwrite the stored name -- which would
      # rename the node too, since RE10 derives the headline from these rows.
      row = post_two_aspects(
        { aspect: "nomadnetwork.node", dest: RETICULUM_DEST_HASH,
          role: "NODE", name: "Department of Decentralization" },
        { aspect: "nomadnetwork.node", dest: RETICULUM_DEST_HASH,
          role: "NODE", name: "Reticulum C3D4" },
      )
      expect(row["long_name"]).to eq("Department of Decentralization")
      with_db(readonly: true) do |db|
        stored = db.execute(
          "SELECT name FROM destinations WHERE id = ?", [RETICULUM_DEST_HASH]
        ).first
        expect(stored["name"]).to eq("Department of Decentralization")
      end
    end

    it "stores a placeholder on a first sighting" do
      # The generic name is wanted where there is no real one to prefer.
      post_two_aspects(
        { aspect: "nomadnetwork.node", dest: RETICULUM_DEST_HASH,
          role: "NODE", name: "Reticulum C3D4" },
        { aspect: "lxmf.propagation", dest: RETICULUM_DEST_HASH2,
          role: "PROPAGATION", name: "Reticulum C3D4" },
      )
      with_db(readonly: true) do |db|
        names = db.execute(
          "SELECT name FROM destinations ORDER BY aspect",
        ).map { |r| r["name"] }
        expect(names).to eq(["Reticulum C3D4", "Reticulum C3D4"])
      end
    end

    it "does not let a nameless higher aspect blank the headline" do
      # Name and role resolve independently: an aspect can carry a role while
      # announcing no display name.
      row = post_two_aspects(
        { aspect: "lxmf.delivery", dest: RETICULUM_DEST_HASH2,
          role: "PEER", name: "Afri Nomad Orion" },
        { aspect: "nomadnetwork.node", dest: RETICULUM_DEST_HASH,
          role: "NODE", name: nil },
      )
      expect(row["role"]).to eq("NODE")
      expect(row["long_name"]).to eq("Afri Nomad Orion")
    end
  end

  describe "GET /api/destinations" do
    it "serves the destinations for a node" do
      register_reticulum_ingestor
      post_reticulum_nodes

      get "/api/destinations"
      expect(last_response.status).to eq(200)
      payload = JSON.parse(last_response.body)
      expect(payload.length).to eq(1)
      expect(payload.first).to include(
        "id" => RETICULUM_DEST_HASH,
        "node_id" => RETICULUM_NODE_ID,
        "aspect" => "lxmf.delivery",
      )
    end
  end

  describe "POST /api/nodes" do
    it "stores reticulum nodes under their own protocol via the wrapper stamp" do
      register_reticulum_ingestor
      expect(post_reticulum_nodes.status).to eq(201)

      with_db(readonly: true) do |db|
        row = db.get_first_row("SELECT * FROM nodes WHERE node_id = ?", [RETICULUM_NODE_ID])
        expect(row["protocol"]).to eq("reticulum")
        expect(row["long_name"]).to eq("Argos Station")
        expect(row["short_name"]).to eq("a1b2")
        # publicKey carries the identity's real key, never a destination hash
        # (a destination hash is a truncated hash over the identity and name
        # hashes, not a key) — #888.
        expect(row["public_key"]).to eq(RETICULUM_PUBLIC_KEY)
        expect(row["identity_hash"]).to eq(RETICULUM_IDENTITY_HASH)
        expect(row["hops_away"]).to eq(2)
      end
    end

    it "never exposes destination hashes or public keys on the read API" do
      register_reticulum_ingestor
      post_reticulum_nodes

      get "/api/nodes?protocol=reticulum"
      payload = JSON.parse(last_response.body)
      expect(payload.length).to eq(1)
      # `public_key` has never been in a node projection; `dest_hash` is an
      # on-air identifier and follows the same rule (Invariant II).
      expect(payload.first).not_to have_key("dest_hash")
      expect(payload.first).not_to have_key("destHash")
      expect(payload.first).not_to have_key("public_key")
    end

    it "stores no fabricated radio/telemetry/position values" do
      register_reticulum_ingestor
      post_reticulum_nodes

      with_db(readonly: true) do |db|
        row = db.get_first_row("SELECT * FROM nodes WHERE node_id = ?", [RETICULUM_NODE_ID])
        expect(row["snr"]).to be_nil
        expect(row["rssi"]).to be_nil
        expect(row["battery_level"]).to be_nil
        expect(row["voltage"]).to be_nil
        expect(row["latitude"]).to be_nil
        expect(row["longitude"]).to be_nil
        expect(row["position_time"]).to be_nil
        # A role *is* stored now — derived from the announce aspect, which is
        # the only signal Reticulum gives about what a destination is (RE-A5).
        expect(row["role"]).to eq("PEER")
        expect(row["lora_freq"]).to be_nil
        expect(row["modem_preset"]).to be_nil
      end
    end

    it "classifies reticulum before the ingestor heartbeat registers (startup race)" do
      # No register_reticulum_ingestor call: the wrapper stamp alone must win.
      expect(post_reticulum_nodes.status).to eq(201)

      with_db(readonly: true) do |db|
        row = db.get_first_row("SELECT protocol FROM nodes WHERE node_id = ?", [RETICULUM_NODE_ID])
        expect(row["protocol"]).to eq("reticulum")
      end
    end

    it "honours a per-node reticulum stamp inside a foreign batch" do
      payload = {
        RETICULUM_NODE_ID2 => {
          "user" => { "shortName" => "0bad", "publicKey" => "0badcafe0badcafe0badcafe0badcafe" },
          "lastHeard" => now - 5,
          "protocol" => "reticulum",
        },
        MESHTASTIC_PEER_ID => { "num" => 0x12ab34cd, "lastHeard" => now - 5 },
      }
      post "/api/nodes", payload.to_json, auth_headers
      expect(last_response.status).to eq(201)

      with_db(readonly: true) do |db|
        expect(db.get_first_value("SELECT protocol FROM nodes WHERE node_id = ?", [RETICULUM_NODE_ID2])).to eq("reticulum")
        expect(db.get_first_value("SELECT protocol FROM nodes WHERE node_id = ?", [MESHTASTIC_PEER_ID])).to eq("meshtastic")
      end
    end

    it "accepts a hopsAway-less announce (unknown hop count stays absent)" do
      payload = {
        RETICULUM_NODE_ID => reticulum_node_fixture(last_heard: now - 30, hops_away: nil),
        "protocol" => "reticulum",
      }
      post "/api/nodes", payload.to_json, auth_headers
      expect(last_response.status).to eq(201)

      with_db(readonly: true) do |db|
        expect(db.get_first_value("SELECT hops_away FROM nodes WHERE node_id = ?", [RETICULUM_NODE_ID])).to be_nil
      end
    end
  end

  describe "GET /api/nodes rendering payload" do
    before do
      register_reticulum_ingestor
      post_reticulum_nodes
    end

    it "serves the reticulum node with its protocol and hop count" do
      get "/api/nodes", {}, auth_headers

      expect(last_response.status).to eq(200)
      node = JSON.parse(last_response.body).find { |r| r["node_id"] == RETICULUM_NODE_ID }
      expect(node).not_to be_nil
      expect(node["protocol"]).to eq("reticulum")
      expect(node["hops_away"]).to eq(2)
      expect(node["long_name"]).to eq("Argos Station")
      expect(node["short_name"]).to eq("a1b2")
    end

    it "omits absent metrics instead of fabricating zeros" do
      get "/api/nodes", {}, auth_headers

      node = JSON.parse(last_response.body).find { |r| r["node_id"] == RETICULUM_NODE_ID }
      %w[snr rssi battery_level voltage latitude longitude position_time lora_freq modem_preset].each do |key|
        expect(node).not_to have_key(key), "expected #{key} to be omitted for a reticulum node"
      end
    end

    it "filters ?protocol=reticulum to reticulum nodes only" do
      with_db do |db|
        db.execute(
          "INSERT INTO nodes(node_id, num, last_heard, first_heard, protocol) VALUES(?,?,?,?,?)",
          [MESHTASTIC_PEER_ID, 0x12ab34cd, now - 10, now - 20, "meshtastic"],
        )
      end

      get "/api/nodes?protocol=reticulum", {}, auth_headers
      ids = JSON.parse(last_response.body).map { |r| r["node_id"] }
      expect(ids).to eq([RETICULUM_NODE_ID])

      get "/api/nodes?protocol=meshtastic", {}, auth_headers
      ids = JSON.parse(last_response.body).map { |r| r["node_id"] }
      expect(ids).to include(MESHTASTIC_PEER_ID)
      expect(ids).not_to include(RETICULUM_NODE_ID)
    end
  end

  describe "GET /api/stats" do
    it "counts reticulum nodes under the live reticulum scope" do
      register_reticulum_ingestor
      post_reticulum_nodes

      get "/api/stats"

      expect(last_response.status).to eq(200)
      payload = JSON.parse(last_response.body)
      expect(payload["reticulum"]["nodes"]["day"]).to eq(1)
      expect(payload["reticulum"]["nodes"]["week"]).to eq(1)
      expect(payload["total"]["nodes"]["day"]).to be >= 1
      # No packet activity was seeded, so the rate metric stays zero.
      expect(payload["reticulum"]["packets"]).to eq("hour" => 0)
    end

    it "reports live reticulum packets/hour from ingestor activity" do
      register_reticulum_ingestor
      with_db do |db|
        db.execute(
          "INSERT INTO ingestor_activity(ingestor_id, at, packets, protocol) VALUES (?,?,?,?)",
          [RETICULUM_INGESTOR_ID, now - 100, 720, "reticulum"],
        )
      end

      get "/api/stats"

      payload = JSON.parse(last_response.body)
      expect(payload["reticulum"]["packets"]).to eq("hour" => 30) # 720 / 24
      expect(payload["total"]["packets"]).to eq("hour" => 30)
    end
  end

  describe "GET /nodes/:id detail page" do
    it "renders the reticulum node detail shell" do
      register_reticulum_ingestor
      post_reticulum_nodes

      get "/nodes/#{RETICULUM_NODE_ID}"

      expect(last_response.status).to eq(200)
      expect(last_response.body).to include("Argos Station")
      expect(last_response.body).to include("a1b2")
    end
  end
end
