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
require "json"
require "base64"
require "cgi"

# The node read APIs serve each node's public key (SPEC PK1-PK5, ACCEPTANCE
# PK-A1 to PK-A4): the key the row is bound to (NI2), as stored, on the rows
# +GET /api/nodes+ and +GET /api/nodes/:id+ already serve.  A row without a
# key has no field, and no other read route carries a key.  Every row is
# stored through the real ingest routes, as an ingestor stores it, except the
# name-derived placeholder, which only the MeshCore chat path creates.
RSpec.describe "Node public keys on the read API" do
  let(:app) { Sinatra::Application }
  let(:api_token) { "node-public-key-spec-token" }
  let(:auth_headers) do
    { "CONTENT_TYPE" => "application/json", "HTTP_AUTHORIZATION" => "Bearer #{api_token}" }
  end
  let(:now) { Time.now.to_i }

  # Meshtastic keys arrive base64 (the protobuf JSON mapping), MeshCore keys
  # as 64 hex digits, Reticulum keys as 128.
  let(:k1) { Base64.strict_encode64("\x11".b * 32) }
  let(:k2) { Base64.strict_encode64("\x22".b * 32) }
  let(:meshtastic_id) { "!0c0de001" }
  let(:meshtastic_num) { 0x0c0de001 }
  let(:meshcore_id) { "!aabbccdd" }
  let(:meshcore_key) { "aabbccdd#{"11" * 28}" }
  let(:reticulum_id) { "!27716218" }
  let(:reticulum_key) { "ab" * 64 }
  let(:reticulum_identity) { "27716218762cfd2864141ef286c39940" }

  around do |example|
    saved = ENV.to_h.slice("API_TOKEN", "PRIVATE", "FEDERATION")
    ENV["API_TOKEN"] = api_token
    ENV.delete("PRIVATE")
    # Unset is the default and enables federation, so +/api/instances+ and
    # the well-known document answer like a stock deployment.
    ENV.delete("FEDERATION")
    clear_tables
    PotatoMesh::App::ApiCache.invalidate_all
    example.run
  ensure
    %w[API_TOKEN PRIVATE FEDERATION].each { |key| saved.key?(key) ? ENV[key] = saved[key] : ENV.delete(key) }
    clear_tables
    PotatoMesh::App::ApiCache.invalidate_all
  end

  # Remove the rows these examples write.
  #
  # @return [void]
  def clear_tables
    db = PotatoMesh::Application.open_database
    %w[trace_hops traces neighbors messages waypoints positions telemetry destinations ingestors nodes].each do |table|
      db.execute("DELETE FROM #{table}")
    end
  ensure
    db&.close
  end

  # ISO 8601 form of a unix time.
  #
  # @param time [Integer] unix seconds.
  # @return [String] UTC timestamp.
  def iso(time)
    Time.at(time).utc.iso8601
  end

  # POST one ingest body and expect it stored.
  #
  # @param path [String] ingest route.
  # @param body [Object] JSON-serialisable payload.
  # @return [void]
  def ingest(path, body)
    post path, body.to_json, auth_headers
    expect(last_response.status).to eq(201), "POST #{path}: #{last_response.status} #{last_response.body}"
  end

  # Store one node record through +POST /api/nodes+.
  #
  # @param node_id [String] canonical node id.
  # @param record [Hash] node record.
  # @return [void]
  def store_node(node_id, record)
    ingest("/api/nodes", { node_id => record })
  end

  # A Meshtastic NodeInfo-shaped record.
  #
  # @param num [Integer] node number.
  # @param key [String, nil] +user.publicKey+; nil leaves it out.
  # @param long_name [String] long name.
  # @param role [String] node role.
  # @param heard [Integer] unix seconds of the record.
  # @return [Hash] node record.
  def meshtastic_record(num:, key:, long_name: "Hill Router", role: "ROUTER", heard: now - 30)
    user = { "shortName" => "HILL", "longName" => long_name, "hwModel" => "RAK4631", "role" => role }
    user["publicKey"] = key if key
    { "num" => num, "lastHeard" => heard, "user" => user }
  end

  # A MeshCore contact record under +meshcore_key+.
  #
  # @return [Hash] node record.
  def meshcore_record
    {
      "lastHeard" => now - 30,
      "protocol" => "meshcore",
      "user" => { "shortName" => "aabb", "longName" => "Core Repeater", "role" => "REPEATER", "publicKey" => meshcore_key },
    }
  end

  # A Reticulum announce record under +reticulum_key+, with one destination.
  #
  # @return [Hash] node record.
  def reticulum_record
    {
      "lastHeard" => now - 30,
      "protocol" => "reticulum",
      "identityHash" => reticulum_identity,
      "interface" => "RNodeInterface[RNode Berlin]",
      "destination" => { "id" => "a1b2c3d4e5f60718293a4b5c6d7e8f90", "aspect" => "lxmf.delivery", "role" => "PEER" },
      "user" => { "shortName" => "2771", "longName" => "Argos Station", "role" => "PEER", "publicKey" => reticulum_key },
    }
  end

  # The entry +GET /api/nodes+ serves for a node.
  #
  # @param node_id [String] canonical node id.
  # @return [Hash, nil] the node's entry, or nil when the list omits it.
  def listed_node(node_id)
    get "/api/nodes"
    expect(last_response.status).to eq(200)
    JSON.parse(last_response.body).find { |node| node["node_id"] == node_id }
  end

  # The body +GET /api/nodes/:id+ serves for a node.
  #
  # @param node_id [String] canonical node id.
  # @return [Hash] the node's entry.
  def node_by_id(node_id)
    get "/api/nodes/#{node_id}"
    expect(last_response.status).to eq(200), "GET /api/nodes/#{node_id}: #{last_response.status}"
    JSON.parse(last_response.body)
  end

  # Both node reads' entries for a node, bulk first.
  #
  # @param node_id [String] canonical node id.
  # @return [Array(Hash, Hash)] the +GET /api/nodes+ and +GET /api/nodes/:id+ entries.
  def both_reads(node_id)
    listed = listed_node(node_id)
    expect(listed).not_to be_nil, "GET /api/nodes omits #{node_id}"
    [listed, node_by_id(node_id)]
  end

  describe "serves each protocol's key as stored" do
    it "serves a Meshtastic key, base64 as posted" do
      store_node(meshtastic_id, meshtastic_record(num: meshtastic_num, key: k1))

      both_reads(meshtastic_id).each { |entry| expect(entry["public_key"]).to eq(k1) }
    end

    it "serves a MeshCore key, 64 hex digits as posted" do
      store_node(meshcore_id, meshcore_record)

      both_reads(meshcore_id).each { |entry| expect(entry["public_key"]).to eq(meshcore_key) }
    end

    it "serves a Reticulum key, 128 hex digits as posted, without the identity hash" do
      store_node(reticulum_id, reticulum_record)

      both_reads(reticulum_id).each do |entry|
        expect(entry["public_key"]).to eq(reticulum_key)
        # The identity hash is served by GET /api/destinations alone (RE2).
        expect(entry).not_to have_key("identity_hash")
      end
    end
  end

  describe "leaves the field out without a key" do
    it "omits it for a node posted without a key" do
      store_node("!0c0de004", meshtastic_record(num: 0x0c0de004, key: nil))

      both_reads("!0c0de004").each { |entry| expect(entry).not_to have_key("public_key") }
    end

    it "omits it for a name-derived placeholder" do
      # Only the MeshCore chat path creates a placeholder, from a sender's name;
      # it never carries a key (SPEC MR4).
      db = PotatoMesh::Application.open_database
      db.execute(
        "INSERT INTO nodes(node_id, short_name, long_name, role, last_heard, first_heard, protocol, synthetic) " \
        "VALUES (?, ?, ?, ?, ?, ?, 'meshcore', 1)",
        ["!5e5e5e5e", "Chat", "Chatty Sender", "COMPANION", now - 30, now - 30],
      )
      db.close

      both_reads("!5e5e5e5e").each do |entry|
        expect(entry["synthetic"]).to be(true)
        expect(entry).not_to have_key("public_key")
      end
    end

    it "omits it for a key over its 512-byte cap" do
      store_node("!0c0de003", meshtastic_record(num: 0x0c0de003, key: "A" * 513))

      db = PotatoMesh::Application.open_database
      stored = db.get_first_value("SELECT public_key FROM nodes WHERE node_id = ?", ["!0c0de003"])
      db.close
      # A cut key would name another identity, so the cap stores none (SL4).
      expect(stored).to be_nil
      both_reads("!0c0de003").each { |entry| expect(entry).not_to have_key("public_key") }
    end
  end

  describe "hides the key with its row" do
    let(:marker) { PotatoMesh::Config.node_opt_out_marker }

    it "serves no key of an opted-out node" do
      store_node("!0c0de005", meshtastic_record(num: 0x0c0de005, key: k1, long_name: "Quiet #{marker} Router"))
      store_node("!0c0de007", meshtastic_record(num: 0x0c0de007, key: k2))

      get "/api/nodes"
      ids = JSON.parse(last_response.body).map { |node| node["node_id"] }
      expect(ids).to eq(["!0c0de007"])
      # The visible node's key shows the list carries keys at all.
      expect(last_response.body).to include(k2)
      expect(last_response.body).not_to include(k1)

      get "/api/nodes/!0c0de005"
      expect(last_response.status).to eq(404)
      expect(last_response.body).not_to include(k1)
    end

    it "serves no key of a CLIENT_HIDDEN node under PRIVATE=1, and serves it with PRIVATE unset" do
      store_node("!0c0de006", meshtastic_record(num: 0x0c0de006, key: k1, role: "CLIENT_HIDDEN"))
      store_node("!0c0de007", meshtastic_record(num: 0x0c0de007, key: k2, role: "CLIENT"))

      ENV["PRIVATE"] = "1"
      get "/api/nodes"
      expect(last_response.body).to include(k2)
      expect(last_response.body).not_to include(k1)
      get "/api/nodes/!0c0de006"
      expect(last_response.status).to eq(404)
      expect(last_response.body).not_to include(k1)

      ENV.delete("PRIVATE")
      both_reads("!0c0de006").each { |entry| expect(entry["public_key"]).to eq(k1) }
    end

    it "carries no key on any other read route" do
      store_node(meshtastic_id, meshtastic_record(num: meshtastic_num, key: k1))
      store_node(meshcore_id, meshcore_record)
      store_node(reticulum_id, reticulum_record)
      t = now - 20
      ingest("/api/positions", { id: 970_001, node_id: meshtastic_id, node_num: meshtastic_num, rx_time: t, rx_iso: iso(t), latitude: 52.52, longitude: 13.405 })
      # A MeshCore position carries its advert's key at ingest (NI3); the
      # positions table stores none.
      ingest("/api/positions", { id: 970_002, node_id: meshcore_id, rx_time: t, rx_iso: iso(t), latitude: 52.53, longitude: 13.41, protocol: "meshcore", public_key: meshcore_key })
      ingest("/api/positions", { id: 970_003, node_id: reticulum_id, rx_time: t, rx_iso: iso(t), latitude: 52.54, longitude: 13.42, protocol: "reticulum" })
      ingest("/api/telemetry", { id: 971_001, node_id: meshtastic_id, node_num: meshtastic_num, rx_time: t, rx_iso: iso(t), battery_level: 77, voltage: 3.9 })
      ingest("/api/neighbors", { node_id: meshtastic_id, node_num: meshtastic_num, rx_time: t, rx_iso: iso(t), neighbors: [{ neighbor_id: meshcore_id, snr: 5.5, rx_time: t, rx_iso: iso(t) }] })
      ingest("/api/traces", { id: 972_001, request_id: 1, src: meshtastic_num, dest: 0xaabbccdd, hops: [meshtastic_num, 0xaabbccdd], rx_time: t, rx_iso: iso(t) })
      ingest("/api/waypoints", { id: 973_001, node_id: meshtastic_id, node_num: meshtastic_num, from_id: meshtastic_id, name: "mast", latitude: 52.5, longitude: 13.4, rx_time: t, rx_iso: iso(t) })
      ingest("/api/messages", { id: 974_001, rx_time: t, rx_iso: iso(t), from_id: meshtastic_id, to_id: "^all", channel: 0, portnum: "TEXT_MESSAGE_APP", text: "hello" })
      ingest("/api/ingestors", { node_id: meshtastic_id, start_time: t, last_seen_time: t, version: "0.8.0" })

      routes = %w[
        /api/positions /api/telemetry /api/telemetry/aggregated /api/neighbors /api/traces
        /api/waypoints /api/messages /api/destinations /api/ingestors /api/stats
        /api/stats/activity /api/instances /version /.well-known/potato-mesh /metrics
        /sitemap.xml /
      ]
      [meshtastic_id, meshcore_id, reticulum_id].each do |id|
        routes.concat(%w[positions telemetry neighbors traces messages waypoints].map { |path| "/api/#{path}/#{id}" })
        routes << "/api/destinations?node_id=#{id}"
      end
      keys = [k1, meshcore_key, reticulum_key]
      routes.each do |route|
        get route
        expect(last_response.status).to eq(200), "GET #{route}: #{last_response.status}"
        keys.each { |key| expect(last_response.body).not_to include(key), "GET #{route} carries a node key" }
      end
    end

    it "embeds the key once, in the node page's reference" do
      store_node(meshtastic_id, meshtastic_record(num: meshtastic_num, key: k1))

      get "/nodes/#{meshtastic_id}"
      expect(last_response.status).to eq(200)
      attribute = last_response.body[/data-node-reference="([^"]*)"/, 1]
      expect(attribute).not_to be_nil
      # The page embeds the row GET /api/nodes/:id serves (SPEC RA5, PK2).
      expect(JSON.parse(CGI.unescapeHTML(attribute)).dig("fallback", "public_key")).to eq(k1)
      expect(last_response.body.scan(k1).length).to eq(1)
    end
  end

  describe "serves the bound key" do
    let(:bound_id) { "!0c0de002" }
    let(:bound_num) { 0x0c0de002 }

    before { store_node(bound_id, meshtastic_record(num: bound_num, key: k1, heard: now - 600)) }

    it "keeps K1 against a newer record under K2" do
      store_node(bound_id, meshtastic_record(num: bound_num, key: k2, long_name: "Other Router", heard: now))

      expect(node_by_id(bound_id)["public_key"]).to eq(k1)
    end

    it "keeps K1 against a newer record without a key" do
      store_node(bound_id, meshtastic_record(num: bound_num, key: nil, heard: now))

      expect(node_by_id(bound_id)["public_key"]).to eq(k1)
    end

    it "serves K2 once it takes a positively stale row over" do
      # Keyed evidence older than the evidence window, and no position, make
      # the row positively stale (SPEC MR2), so a newer key takes it (NI2).
      db = PotatoMesh::Application.open_database
      db.execute(
        "UPDATE nodes SET last_advert_heard = ?, position_time = NULL WHERE node_id = ?",
        [now - PotatoMesh::Config.four_weeks_seconds - 60, bound_id],
      )
      db.close
      store_node(bound_id, meshtastic_record(num: bound_num, key: k2, heard: now))

      expect(node_by_id(bound_id)["public_key"]).to eq(k2)
    end
  end
end
