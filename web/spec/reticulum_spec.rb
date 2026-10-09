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

  describe "placeholder names agree with the ingestor (SPEC RA10)" do
    # The ingestor builds "Reticulum <first four hex, upper>"; this guard is
    # what stops such a name overwriting a real one. If the two rules drift the
    # guard silently fails open, so assert the exact strings the ingestor emits
    # (tests/test_reticulum_unit.py holds the mirror of this list).
    {
      "!27716218" => "Reticulum 2771",
      "!0001beef" => "Reticulum 0001",
      "!c0ffee00" => "Reticulum C0FF",
      "!deadbeef" => "Reticulum DEAD",
      "!fee521eb" => "Reticulum FEE5",
    }.each do |node_id, placeholder|
      it "recognises #{placeholder} as generic for #{node_id}" do
        expect(generic_fallback_name?(placeholder, node_id, "reticulum")).to be(true)
      end
    end

    it "does not treat the tail-derived form as generic any more" do
      # The old rule named !27716218 "Reticulum 6218" while its badge read 2771.
      expect(generic_fallback_name?("Reticulum 6218", "!27716218", "reticulum")).to be(false)
    end

    it "leaves meshtastic on the tail-derived short id" do
      # A meshtastic node_id is a node num whose low bits are the conventional
      # short id, so only reticulum moves to the head of the hash.
      expect(generic_fallback_name?("Meshtastic C3D4", "!a1b2c3d4", "meshtastic")).to be(true)
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
      # a real announce, that must not overwrite the stored name: the
      # destination row would lose it, though the node keeps its stored
      # headline (RE10).
      row = post_two_aspects(
        { aspect: "nomadnetwork.node", dest: RETICULUM_DEST_HASH,
          role: "NODE", name: "Department of Decentralization" },
        { aspect: "nomadnetwork.node", dest: RETICULUM_DEST_HASH,
          role: "NODE", name: "Reticulum A1B2" },
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
          role: "NODE", name: "Reticulum A1B2" },
        { aspect: "lxmf.propagation", dest: RETICULUM_DEST_HASH2,
          role: "PROPAGATION", name: "Reticulum A1B2" },
      )
      with_db(readonly: true) do |db|
        names = db.execute(
          "SELECT name FROM destinations ORDER BY aspect",
        ).map { |r| r["name"] }
        expect(names).to eq(["Reticulum A1B2", "Reticulum A1B2"])
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

    it "does not let a placeholder on a higher aspect rename the node" do
      # The example above sends name: nil, which no ingestor path sends: a
      # nameless aspect arrives as a placeholder, built from its own hash
      # (Reticulum 00FF) or, by an older ingestor, from the node id
      # (Reticulum A1B2). Neither is a name (SPEC RE10 as amended).
      observed = ["Reticulum 00FF", "Reticulum A1B2"].to_h do |placeholder|
        clear_tables
        row = post_two_aspects(
          { aspect: "lxmf.delivery", dest: RETICULUM_DEST_HASH,
            role: "PEER", name: "Afri Nomad Orion" },
          { aspect: "nomadnetwork.node", dest: RETICULUM_DEST_HASH2,
            role: "NODE", name: placeholder },
        )
        [placeholder, [row["long_name"], row["role"]]]
      end
      expect(observed).to eq(
        "Reticulum 00FF" => ["Afri Nomad Orion", "NODE"],
        "Reticulum A1B2" => ["Afri Nomad Orion", "NODE"],
      )
    end

    it "names a node with no announced name from its own id, not a destination's" do
      # SPEC RA10(a): the node badges a1b2, so its headline reads Reticulum A1B2
      # while the destination row keeps its own Reticulum 00FF (RA10(b)). The
      # aspect is posted twice, as a later snapshot would repeat it.
      nameless = { aspect: "nomadnetwork.node", dest: RETICULUM_DEST_HASH2,
                   role: "NODE", name: "Reticulum 00FF" }
      row = post_two_aspects(nameless, nameless)
      with_db(readonly: true) do |db|
        destination = db.get_first_value(
          "SELECT name FROM destinations WHERE id = ?", [RETICULUM_DEST_HASH2]
        )
        expect([destination, row["long_name"]]).to eq(["Reticulum 00FF", "Reticulum A1B2"])
      end
    end
  end

  describe "headline name fallback (SPEC RE10, RA10)" do
    it "keeps a real name the node carries when a nameless destination arrives" do
      # A record with an unusable destination hash names the node but writes no
      # destination row; a later nameless destination must not erase that name.
      register_reticulum_ingestor
      named = reticulum_node_fixture(last_heard: now - 30).except("destination")
      nameless = reticulum_node_fixture(last_heard: now - 29, aspect: "nomadnetwork.node",
                                        dest_id: RETICULUM_DEST_HASH2, role: "NODE")
      nameless["user"]["longName"] = "Reticulum 00FF"
      [named, nameless].each do |record|
        payload = { RETICULUM_NODE_ID => record, "ingestor" => RETICULUM_INGESTOR_ID, "protocol" => "reticulum" }
        post "/api/nodes", payload.to_json, auth_headers
        expect(last_response.status).to eq(201)
      end
      with_db(readonly: true) do |db|
        expect(
          db.get_first_value("SELECT long_name FROM nodes WHERE node_id = ?", [RETICULUM_NODE_ID]),
        ).to eq("Argos Station")
      end
    end

    it "gives a node with no name at all its own placeholder" do
      expect(reticulum_headline_name(RETICULUM_NODE_ID, [], nil)).to eq("Reticulum A1B2")
    end

    it "leaves the name alone for an id it cannot read" do
      expect(reticulum_headline_name("not-a-node-id", [], nil)).to be_nil
    end

    it "reads destination rows from a hash-results handle" do
      register_reticulum_ingestor
      post_reticulum_nodes
      with_db do |db|
        db.execute("UPDATE nodes SET long_name = 'Reticulum A1B2' WHERE node_id = ?", [RETICULUM_NODE_ID])
        refresh_node_identity_from_destinations(db, RETICULUM_NODE_ID)
        expect(
          db.get_first_value("SELECT long_name FROM nodes WHERE node_id = ?", [RETICULUM_NODE_ID]),
        ).to eq("Argos Station")
      end
    end
  end

  describe "host destination placeholders (SPEC RA10)" do
    # The field host: node !27716218 (RETICULUM_IDENTITY_HASH) and two of the
    # destinations RNS derives from that identity, so neither shares the node's
    # head. The ingestor names a nameless destination from its own hash
    # (RA10): "Reticulum 4CF9" and "Reticulum 9C59", not the node's
    # "Reticulum 2771". tests/test_reticulum_unit.py pins the same string for
    # the same pair. RETICULUM_DEST_HASH starts like RETICULUM_NODE_ID and
    # cannot tell the two forms apart.
    RETICULUM_HOST_NODE_ID = "!27716218".freeze
    RETICULUM_HOST_LXMF = {
      "id" => "4cf985bf933c21b1aa8dabd407d4ef69", "aspect" => "lxmf.delivery", "role" => "PEER",
    }.freeze
    RETICULUM_HOST_NOMADNET = {
      "id" => "9c59da5e1516745d74cc908243e0ba2b", "aspect" => "nomadnetwork.node", "role" => "NODE",
    }.freeze

    # POST host-destination records one at a time, each shaped as
    # _host_destination_nodes builds it (no publicKey, no hopsAway), and read
    # back what they left behind.
    #
    # @param records [Array<Array(Hash, String)>] destination block and
    #   user.longName pairs, oldest first.
    # @return [Array(Hash{String => String}, String)] the stored destination
    #   names keyed by destination id, and the node's long_name.
    def post_host_destinations(*records)
      register_reticulum_ingestor
      records.each_with_index do |(destination, name), index|
        payload = {
          RETICULUM_HOST_NODE_ID => {
            "nodeId" => RETICULUM_HOST_NODE_ID,
            "lastHeard" => now - 30 + index,
            "protocol" => "reticulum",
            "identityHash" => RETICULUM_IDENTITY_HASH,
            "destination" => destination,
            "user" => { "shortName" => "2771", "longName" => name, "role" => destination["role"] },
          },
          "ingestor" => RETICULUM_INGESTOR_ID,
          "protocol" => "reticulum",
        }
        post "/api/nodes", payload.to_json, auth_headers
        expect(last_response.status).to eq(201)
      end
      with_db(readonly: true) do |db|
        names = db.execute("SELECT id, name FROM destinations").to_h { |r| [r["id"], r["name"]] }
        headline = db.get_first_value(
          "SELECT long_name FROM nodes WHERE node_id = ?", [RETICULUM_HOST_NODE_ID]
        )
        [names, headline]
      end
    end

    it "never lets a destination-derived placeholder replace a real name" do
      # The second record is a later snapshot whose stack remembers no app_data
      # for the destination.
      names, headline = post_host_destinations(
        [RETICULUM_HOST_LXMF, "Afri Nomad Orion"],
        [RETICULUM_HOST_LXMF, "Reticulum 4CF9"],
      )
      expect([names[RETICULUM_HOST_LXMF["id"]], headline]).to eq(["Afri Nomad Orion", "Afri Nomad Orion"])
    end

    it "keeps the ranked headline when its aspect falls back to the placeholder" do
      # NODE outranks PEER (RE10); without the guard a placeholder landing on
      # the NODE row erases its real name and the headline moves to PEER's.
      names, headline = post_host_destinations(
        [RETICULUM_HOST_NOMADNET, "Department of Decentralization"],
        [RETICULUM_HOST_LXMF, "Afri Nomad Orion"],
        [RETICULUM_HOST_NOMADNET, "Reticulum 9C59"],
      )
      expect([names[RETICULUM_HOST_NOMADNET["id"]], headline]).to eq(
        ["Department of Decentralization", "Department of Decentralization"],
      )
    end

    it "stores a destination-derived placeholder on a first sighting" do
      # The generic name is wanted where there is no real one to prefer, on the
      # destination row only: the node keeps its own placeholder, which its
      # badge 2771 matches (RA10(a), RE10).
      names, headline = post_host_destinations([RETICULUM_HOST_LXMF, "Reticulum 4CF9"])
      expect([names[RETICULUM_HOST_LXMF["id"]], headline]).to eq(["Reticulum 4CF9", "Reticulum 2771"])
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

    it "omits the destinations of an opted-out node (Invariant II)" do
      register_reticulum_ingestor
      post_reticulum_nodes
      marker = PotatoMesh::Config.node_opt_out_marker
      opted_identity = "0badcafe#{"00" * 12}"
      opted = reticulum_node_fixture(last_heard: now - 20, dest_id: RETICULUM_DEST_HASH2)
      opted["user"]["longName"] = "Quiet #{marker} Station"
      opted["identityHash"] = opted_identity
      payload = {
        RETICULUM_NODE_ID2 => opted,
        "ingestor" => RETICULUM_INGESTOR_ID,
        "protocol" => "reticulum",
      }
      post "/api/nodes", payload.to_json, auth_headers
      expect(last_response.status).to eq(201)

      # Preconditions: ingest is not refused, so the destination row is stored,
      # and the node row itself is already hidden (A2c). Only the destinations
      # read path is left to leak it.
      with_db(readonly: true) do |db|
        stored = db.execute("SELECT id FROM destinations WHERE node_id = ?", [RETICULUM_NODE_ID2])
        expect(stored.map { |r| r["id"] }).to eq([RETICULUM_DEST_HASH2])
      end
      get "/api/nodes"
      expect(JSON.parse(last_response.body).map { |n| n["node_id"] }).not_to include(RETICULUM_NODE_ID2)

      get "/api/destinations"
      expect(last_response.status).to eq(200)
      rows = JSON.parse(last_response.body)
      expect(rows.map { |r| r["id"] }).to eq([RETICULUM_DEST_HASH])
      expect(rows.map { |r| r["identity_hash"] }).not_to include(opted_identity)
      expect(rows.map { |r| r["name"] }).not_to include("Quiet #{marker} Station")

      get "/api/destinations?node_id=#{RETICULUM_NODE_ID2}"
      expect(last_response.status).to eq(200)
      expect(JSON.parse(last_response.body)).to eq([])
    end
  end

  describe "GET /api/destinations?node_id=" do
    it "filters to one node's destinations" do
      register_reticulum_ingestor
      post_reticulum_nodes
      # A second node's destination, which the filter must exclude.
      payload = {
        RETICULUM_NODE_ID2 => reticulum_node_fixture(
          last_heard: now - 20,
          aspect: "nomadnetwork.node",
          dest_id: RETICULUM_DEST_HASH2,
          role: "NODE",
        ),
        "ingestor" => RETICULUM_INGESTOR_ID,
        "protocol" => "reticulum",
      }
      post "/api/nodes", payload.to_json, auth_headers

      get "/api/destinations"
      expect(JSON.parse(last_response.body).length).to eq(2)

      get "/api/destinations?node_id=#{RETICULUM_NODE_ID2}"
      expect(last_response.status).to eq(200)
      filtered = JSON.parse(last_response.body)
      expect(filtered.length).to eq(1)
      expect(filtered.first).to include(
        "id" => RETICULUM_DEST_HASH2,
        "node_id" => RETICULUM_NODE_ID2,
      )
    end
  end

  describe "destinations pagination (SPEC RA8)" do
    # Three aspects of one identity at distinct last_heard values, newest first,
    # so a cursor walk has real page breaks to cross.
    ASPECT_TIMES = [
      { aspect: "nomadnetwork.node", dest: RETICULUM_DEST_HASH, role: "NODE", offset: 10 },
      { aspect: "lxmf.delivery", dest: RETICULUM_DEST_HASH2, role: "PEER", offset: 20 },
      {
        aspect: "lxmf.propagation",
        dest: "aa00bb11cc22dd33ee44ff5566778899",
        role: "PROPAGATION",
        offset: 30,
      },
    ].freeze

    def seed_destinations
      register_reticulum_ingestor
      ASPECT_TIMES.each do |a|
        payload = {
          RETICULUM_NODE_ID => reticulum_node_fixture(
            last_heard: now - a[:offset], aspect: a[:aspect],
            dest_id: a[:dest], role: a[:role],
          ),
          "ingestor" => RETICULUM_INGESTOR_ID,
          "protocol" => "reticulum",
        }
        post "/api/nodes", payload.to_json, auth_headers
      end
    end

    def destination_ids(query = "")
      get "/api/destinations#{query}"
      expect(last_response.status).to eq(200)
      JSON.parse(last_response.body).map { |r| r["id"] }
    end

    it "orders newest first and honours ?limit=" do
      seed_destinations
      all = destination_ids
      expect(all).to eq([RETICULUM_DEST_HASH, RETICULUM_DEST_HASH2, ASPECT_TIMES[2][:dest]])
      expect(destination_ids("?limit=2").length).to eq(2)
    end

    it "raises the lower bound with ?since= and lowers the upper with ?before=" do
      seed_destinations
      # since excludes the oldest; before excludes the newest.
      expect(destination_ids("?since=#{now - 25}")).to eq(
        [RETICULUM_DEST_HASH, RETICULUM_DEST_HASH2],
      )
      expect(destination_ids("?before=#{now - 15}")).to eq(
        [RETICULUM_DEST_HASH2, ASPECT_TIMES[2][:dest]],
      )
    end

    it "walks every row across page breaks with a one-row overlap" do
      # The BP1 contract a paging client depends on: the <= boundary repeats the
      # boundary row so none is skipped, and id-dedup collapses the overlap.
      seed_destinations
      seen = []
      cursor = nil
      4.times do
        query = cursor ? "?limit=2&before=#{cursor}" : "?limit=2"
        get "/api/destinations#{query}"
        page = JSON.parse(last_response.body)
        break if page.empty?

        seen.concat(page.map { |r| r["id"] })
        break if page.length < 2

        cursor = page.last["last_heard"]
      end
      expect(seen.length).to be > seen.uniq.length # the deliberate overlap
      expect(seen.uniq).to match_array(ASPECT_TIMES.map { |a| a[:dest] })
    end

    it "ignores a non-positive or non-integer before, and composes with node_id" do
      seed_destinations
      expect(destination_ids("?before=0")).to eq(destination_ids)
      expect(destination_ids("?before=abc")).to eq(destination_ids)
      expect(destination_ids("?before=-5")).to eq(destination_ids)
      filtered = destination_ids("?node_id=#{RETICULUM_NODE_ID}&before=#{now - 15}")
      expect(filtered).to eq([RETICULUM_DEST_HASH2, ASPECT_TIMES[2][:dest]])
    end
  end

  describe "destinations node window (SPEC RA8)" do
    # The destinations read serves a destination only while its node is inside
    # the window the node read applies: seven days in bulk, as /api/nodes, and
    # twenty-eight with ?node_id=, as /api/nodes/:id; and only while its own
    # last_heard is inside the 28-day API cap. It had no floor, so the bulk read
    # served the destinations of nodes /api/nodes had dropped, up to the
    # 365-day retention horizon, and the dashboard counted them (SPEC RA3).
    let(:outside_bulk) { now - PotatoMesh::Config.week_seconds - 3600 }
    let(:outside_per_node) { now - PotatoMesh::Config.four_weeks_seconds - 3600 }
    let(:inside_cap) { now - PotatoMesh::Config.four_weeks_seconds + 3600 }
    let(:stale_node_id) { "!5ca1ab1e" }
    let(:stale_dest) { "5ca1ab1e#{"00" * 12}" }
    let(:older_aspect_dest) { "0ddba110#{"00" * 12}" }
    let(:inside_cap_dest) { "c0ffee00#{"00" * 12}" }

    before { register_reticulum_ingestor }

    # POST one announce of +node_id+ on +dest_id+, heard at +heard+.
    #
    # @param node_id [String] canonical node id; it heads the identity hash.
    # @param heard [Integer] announce time, unix seconds.
    # @param dest_id [String] destination hash, hex.
    # @param long_name [String, nil] announced name; the fixture's when nil.
    # @return [void]
    def announce(node_id, heard, dest_id, long_name: nil)
      node = reticulum_node_fixture(last_heard: heard, dest_id: dest_id)
      node["identityHash"] = "#{node_id.delete_prefix("!")}#{"00" * 12}"
      node["user"]["longName"] = long_name if long_name
      payload = { node_id => node, "ingestor" => RETICULUM_INGESTOR_ID, "protocol" => "reticulum" }
      post "/api/nodes", payload.to_json, auth_headers
      expect(last_response.status).to eq(201)
    end

    # Destination ids the read serves, newest first.
    #
    # @param query [String] query string, including its leading "?".
    # @return [Array<String>] served destination ids.
    def served(query = "")
      get "/api/destinations#{query}"
      expect(last_response.status).to eq(200)
      JSON.parse(last_response.body).map { |r| r["id"] }
    end

    it "serves the destinations of a node inside the bulk window and none of a node outside it" do
      announce(RETICULUM_NODE_ID, now - 30, RETICULUM_DEST_HASH)
      announce(RETICULUM_NODE_ID2, outside_bulk, RETICULUM_DEST_HASH2)
      # Both rows are stored and /api/nodes lists only the fresh node, so the
      # destinations read is the one left to drop the other.
      with_db(readonly: true) do |db|
        expect(db.get_first_value("SELECT COUNT(*) FROM destinations")).to eq(2)
      end
      get "/api/nodes"
      listed = JSON.parse(last_response.body).map { |n| n["node_id"] }
      expect(listed).to include(RETICULUM_NODE_ID)
      expect(listed).not_to include(RETICULUM_NODE_ID2)

      expect(served).to eq([RETICULUM_DEST_HASH])
    end

    it "keys the floor on the node, so a node in the window keeps an aspect heard before it" do
      announce(RETICULUM_NODE_ID, outside_bulk, older_aspect_dest)
      announce(RETICULUM_NODE_ID, now - 30, RETICULUM_DEST_HASH)

      expect(served).to eq([RETICULUM_DEST_HASH, older_aspect_dest])
      expect(served("?node_id=#{RETICULUM_NODE_ID}")).to eq([RETICULUM_DEST_HASH, older_aspect_dest])
    end

    it "caps each destination's own last_heard at 28 days, in bulk and with ?node_id=" do
      # A fresh node, so only the cap can drop its aspect last heard 28 days
      # and an hour ago; the aspect an hour inside the cap stays, and a since
      # older than the cap cannot widen it.
      announce(RETICULUM_NODE_ID, outside_per_node, older_aspect_dest)
      announce(RETICULUM_NODE_ID, inside_cap, inside_cap_dest)
      announce(RETICULUM_NODE_ID, now - 30, RETICULUM_DEST_HASH)
      fresh = [RETICULUM_DEST_HASH, inside_cap_dest]

      expect(served).to eq(fresh)
      expect(served("?node_id=#{RETICULUM_NODE_ID}")).to eq(fresh)
      expect(served("?since=#{outside_per_node - 60}")).to eq(fresh)
    end

    it "applies the per-node window with ?node_id=, as /api/nodes/:id does" do
      announce(RETICULUM_NODE_ID2, outside_bulk, RETICULUM_DEST_HASH2)
      announce(stale_node_id, outside_per_node, stale_dest)
      # The stale node's destination is itself fresh, so only the node's
      # window can drop it, not the 28-day cap on the destination.
      with_db do |db|
        db.execute("UPDATE destinations SET last_heard = ? WHERE id = ?", [now - 60, stale_dest])
      end
      get "/api/nodes/#{RETICULUM_NODE_ID2}"
      expect(last_response.status).to eq(200)
      get "/api/nodes/#{stale_node_id}"
      expect(last_response.status).to eq(404)

      expect(served("?node_id=#{RETICULUM_NODE_ID2}")).to eq([RETICULUM_DEST_HASH2])
      expect(served("?node_id=#{stale_node_id}")).to eq([])
      expect(served).to eq([])
    end

    it "still omits an opted-out node's destinations inside the window (SPEC RE2)" do
      announce(RETICULUM_NODE_ID, now - 30, RETICULUM_DEST_HASH)
      announce(
        RETICULUM_NODE_ID2, now - 20, RETICULUM_DEST_HASH2,
        long_name: "Quiet #{PotatoMesh::Config.node_opt_out_marker} Station",
      )

      expect(served).to eq([RETICULUM_DEST_HASH])
      expect(served("?node_id=#{RETICULUM_NODE_ID2}")).to eq([])
    end

    it "serves no destination whose node has no row" do
      announce(RETICULUM_NODE_ID, now - 30, RETICULUM_DEST_HASH)
      with_db do |db|
        db.execute(
          "INSERT INTO destinations(id, node_id, aspect, role, first_heard, last_heard) " \
          "VALUES (?, ?, ?, ?, ?, ?)",
          [stale_dest, stale_node_id, "lxmf.delivery", "PEER", now - 60, now - 10],
        )
      end

      expect(served).to eq([RETICULUM_DEST_HASH])
      expect(served("?node_id=#{stale_node_id}")).to eq([])
    end

    it "filters ahead of ?limit=, so a backward walk pages only windowed rows" do
      # Newest first by the destination's own last_heard: the fresh node's
      # current aspect, the aged-out node's destination, the fresh node's older
      # aspect. Filtered after LIMIT, the aged-out row would take a page slot.
      announce(RETICULUM_NODE_ID, outside_bulk - 3600, older_aspect_dest)
      announce(RETICULUM_NODE_ID, now - 30, RETICULUM_DEST_HASH)
      announce(RETICULUM_NODE_ID2, outside_bulk, RETICULUM_DEST_HASH2)

      get "/api/destinations?limit=2"
      page = JSON.parse(last_response.body)
      expect(page.map { |r| r["id"] }).to eq([RETICULUM_DEST_HASH, older_aspect_dest])
      # A full page, so the walk continues from its oldest row: the inclusive
      # boundary repeats that row once and the short page ends the walk.
      expect(served("?limit=2&before=#{page.last["last_heard"]}")).to eq([older_aspect_dest])
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

    it "never exposes destination or identity hashes on the node read API" do
      register_reticulum_ingestor
      post_reticulum_nodes

      get "/api/nodes?protocol=reticulum"
      payload = JSON.parse(last_response.body)
      expect(payload.length).to eq(1)
      # The identity's public key is served as stored (SPEC PK1); the identity
      # hash is served by GET /api/destinations alone (RE2), and `dest_hash`
      # is an on-air identifier no node projection carries (Invariant II).
      expect(payload.first["public_key"]).to eq(RETICULUM_PUBLIC_KEY)
      expect(payload.first).not_to have_key("identity_hash")
      expect(payload.first).not_to have_key("dest_hash")
      expect(payload.first).not_to have_key("destHash")
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

  describe "a destination reference canonicalises to its identity page (SPEC RA5)" do
    it "resolves a full destination hash to the owning identity" do
      register_reticulum_ingestor
      post_reticulum_nodes

      get "/nodes/#{RETICULUM_DEST_HASH}"
      expect(last_response.status).to eq(200)
      expect(last_response.body).to include(RETICULUM_NODE_ID)
    end

    it "resolves the truncated !xxxxxxxx form of a destination" do
      # This is the form the Destinations table links to.
      register_reticulum_ingestor
      post_reticulum_nodes

      get "/nodes/!#{RETICULUM_DEST_HASH[0, 8]}"
      expect(last_response.status).to eq(200)
      expect(last_response.body).to include(RETICULUM_NODE_ID)
    end

    it "still 404s an unknown reference" do
      # The fallback must not turn every miss into a page.
      get "/nodes/!deadbeef"
      expect(last_response.status).to eq(404)
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
