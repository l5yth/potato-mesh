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

# Under PRIVATE=1 a CLIENT_HIDDEN node has no row on any read surface, and an
# opted-out node has none in either mode (SPEC HC1-HC5, HC7, ACCEPTANCE
# HC-A1). Every row is stored through the real ingest routes with PRIVATE
# unset, as an ingestor stores it; the examples then read the API, the node
# page and the preview image with PRIVATE=1, and with PRIVATE unset, which
# serves the hidden node's rows as before.
RSpec.describe "Private mode and CLIENT_HIDDEN nodes" do
  let(:app) { Sinatra::Application }
  let(:api_token) { "hidden-client-spec-token" }
  let(:auth_headers) do
    { "CONTENT_TYPE" => "application/json", "HTTP_AUTHORIZATION" => "Bearer #{api_token}" }
  end
  let(:now) { Time.now.to_i }
  # The hidden node, a visible node and a visible peer. Every role is set
  # explicitly: a node stored only as an ingest placeholder is CLIENT_HIDDEN
  # too, until its own node record replaces the role (SPEC HC5).
  let(:hidden) { "!0b6f0001" }
  let(:hidden_num) { 0x0b6f0001 }
  let(:visible) { "!0b6f0002" }
  let(:visible_num) { 0x0b6f0002 }
  let(:peer) { "!0b6f0003" }
  let(:peer_num) { 0x0b6f0003 }
  # A Reticulum node stored with the placeholder role older releases wrote.
  let(:reticulum_hidden) { "!0b6f00a1" }
  # An opted-out node, hidden in either mode (see +seed_opted_out!+).
  let(:opted) { "!0b6f0004" }
  let(:opted_num) { 0x0b6f0004 }

  around do |example|
    saved = ENV.to_h.slice("API_TOKEN", "PRIVATE")
    ENV["API_TOKEN"] = api_token
    ENV.delete("PRIVATE")
    clear_tables
    PotatoMesh::App::ApiCache.invalidate_all
    example.run
  ensure
    %w[API_TOKEN PRIVATE].each { |key| saved.key?(key) ? ENV[key] = saved[key] : ENV.delete(key) }
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

  # One entry of a +POST /api/nodes+ body.
  #
  # @param short_name [String] short name.
  # @param long_name [String] long name.
  # @param num [Integer] node number.
  # @param role [String] node role.
  # @return [Hash] node record.
  def node_record(short_name, long_name, num, role)
    {
      "num" => num,
      "lastHeard" => now - 30,
      "user" => { "shortName" => short_name, "longName" => long_name, "hwModel" => "TBEAM", "role" => role },
    }
  end

  # Store the three nodes and every row the examples read. The hidden node
  # has a position, a reading, a waypoint, a message, a neighbour link at each
  # end, a trace at each end and an ingestor, and relays the visible node's
  # trace to the peer; the visible node has a position, a reading, a link to
  # the peer and an ingestor. Runs with PRIVATE unset, since
  # +POST /api/messages+ 404s under PRIVATE=1.
  #
  # @return [void]
  def seed!
    ingest("/api/nodes", {
      hidden => node_record("HID", "Hidden Station", hidden_num, "CLIENT_HIDDEN"),
      visible => node_record("VIS", "Visible Station", visible_num, "CLIENT"),
      peer => node_record("PER", "Peer Station", peer_num, "CLIENT"),
    })
    t = now - 20
    [[hidden, hidden_num, 1], [visible, visible_num, 2]].each do |id, num, k|
      ingest("/api/positions", { id: 960_000 + k, node_id: id, node_num: num, rx_time: t, rx_iso: iso(t), latitude: 52.52, longitude: 13.405 })
      ingest("/api/telemetry", { id: 961_000 + k, node_id: id, node_num: num, rx_time: t, rx_iso: iso(t), battery_level: 77, voltage: 3.9 })
    end
    [[hidden, hidden_num, visible, visible_num], [peer, peer_num, hidden, hidden_num], [visible, visible_num, peer, peer_num]].each do |id, num, neighbor, neighbor_num|
      link = { neighbor_id: neighbor, neighbor_num: neighbor_num, snr: 5.5, rx_time: t, rx_iso: iso(t) }
      ingest("/api/neighbors", { node_id: id, node_num: num, rx_time: t, rx_iso: iso(t), neighbors: [link] })
    end
    [[1, hidden_num, visible_num, [hidden_num, visible_num]], [2, visible_num, hidden_num, [visible_num, hidden_num]], [3, visible_num, peer_num, [visible_num, hidden_num, peer_num]]].each do |k, src, dest, hops|
      ingest("/api/traces", { id: 962_000 + k, request_id: k, src: src, dest: dest, hops: hops, rx_time: t, rx_iso: iso(t) })
    end
    ingest("/api/waypoints", { id: 963_001, node_id: hidden, node_num: hidden_num, from_id: hidden, name: "camp", latitude: 52.5, longitude: 13.4, rx_time: t, rx_iso: iso(t) })
    ingest("/api/messages", { id: 964_001, rx_time: t, rx_iso: iso(t), from_id: hidden, to_id: "^all", channel: 0, portnum: "TEXT_MESSAGE_APP", text: "hello" })
    [hidden, visible].each { |id| ingest("/api/ingestors", { node_id: id, start_time: t, last_seen_time: t, version: "0.8.0" }) }
  end

  # Store an opted-out node (the marker in its long name) that runs an
  # ingestor and relays a second trace of the visible node to the peer.
  #
  # @return [void]
  def seed_opted_out!
    marker = PotatoMesh::Config.node_opt_out_marker
    ingest("/api/nodes", { opted => node_record("OPT", "Quiet #{marker} Station", opted_num, "CLIENT") })
    t = now - 20
    ingest("/api/traces", { id: 962_004, request_id: 4, src: visible_num, dest: peer_num, hops: [visible_num, opted_num, peer_num], rx_time: t, rx_iso: iso(t) })
    ingest("/api/ingestors", { node_id: opted, start_time: t, last_seen_time: t, version: "0.8.0" })
  end

  # Set nodes' +last_heard+ directly, so the freshest node is known.
  #
  # @param heard [Hash{String => Integer}] node id => unix seconds.
  # @return [void]
  def set_last_heard(heard)
    db = PotatoMesh::Application.open_database
    heard.each { |id, time| db.execute("UPDATE nodes SET last_heard = ? WHERE node_id = ?", [time, id]) }
  ensure
    db&.close
  end

  # The freshness hints +GET /version+ and the well-known document serve.
  #
  # @return [Array(Integer, Integer)] +last_node_update+ and +last_update+.
  def freshness_hints
    [get_json("/version")["last_node_update"], get_json("/.well-known/potato-mesh")["last_update"]]
  end

  # Node ids +GET /api/ingestors+ serves.
  #
  # @return [Array<String>] sorted ingestor node ids.
  def ingestor_ids
    get_json("/api/ingestors").map { |row| row["node_id"] }.sort
  end

  # Set or unset PRIVATE=1 without touching the API cache.
  #
  # @param on [Boolean] whether private mode is on.
  # @return [void]
  def set_private_flag(on)
    if on
      ENV["PRIVATE"] = "1"
    else
      ENV.delete("PRIVATE")
    end
  end

  # Reset the preview-image state and remove the cached capture of both
  # modes.
  #
  # @return [void]
  def clear_og_captures
    saved = ENV["PRIVATE"]
    [false, true].each do |on|
      set_private_flag(on)
      PotatoMesh::OgImage.reset_for_tests!
    end
  ensure
    set_private_flag(saved == "1")
  end

  # Store a Reticulum node with the CLIENT_HIDDEN role older releases gave a
  # placeholder, and one destination for it. No current ingest path writes
  # that role for Reticulum (SPEC RA9), so the rows go in directly.
  #
  # @return [void]
  def seed_reticulum_placeholder!
    db = PotatoMesh::Application.open_database
    t = now - 20
    db.execute(
      "INSERT INTO nodes(node_id, num, short_name, long_name, role, last_heard, first_heard, protocol) VALUES (?,?,?,?,?,?,?,?)",
      [reticulum_hidden, 0x0b6f00a1, "00a1", "Reticulum 00A1", "CLIENT_HIDDEN", t, t, "reticulum"],
    )
    db.execute(
      "INSERT INTO destinations(id, node_id, aspect, role, first_heard, last_heard) VALUES (?,?,?,?,?,?)",
      ["0b6f00a1#{"00" * 12}", reticulum_hidden, "lxmf.delivery", "PEER", t, t],
    )
  ensure
    db&.close
  end

  # Switch private mode on, as a restart with PRIVATE=1 does.
  #
  # @return [void]
  def go_private!
    ENV["PRIVATE"] = "1"
    PotatoMesh::App::ApiCache.invalidate_all
  end

  # GET a route that answers 200 and parse its JSON body.
  #
  # @param path [String] route, query string included.
  # @return [Object] parsed body.
  def get_json(path)
    get path
    expect(last_response.status).to eq(200), "GET #{path}: #{last_response.status}"
    JSON.parse(last_response.body)
  end

  # The key each collection row is compared by: its id, or the link of a
  # neighbour row, which has none.
  #
  # @param rows [Array<Hash>] parsed collection rows.
  # @return [Array] sorted row keys.
  def row_keys(rows)
    rows.map { |row| row["id"] || [row["node_id"], row["neighbor_id"]] }.sort
  end

  # Rows that name the hidden node in a node column or carry it as a hop.
  #
  # @param rows [Array<Hash>] parsed collection rows.
  # @return [Array<Hash>] rows referencing the hidden node.
  def hidden_references(rows)
    rows.select do |row|
      [row["node_id"], row["neighbor_id"], row["from_id"]].include?(hidden) ||
        [row["node_num"], row["src"], row["dest"]].include?(hidden_num) ||
        Array(row["hops"]).include?(hidden_num)
    end
  end

  # Samples the telemetry rollup counted in the last hour.
  #
  # @return [Integer] summed +sample_count+.
  def aggregated_samples
    get_json("/api/telemetry/aggregated?windowSeconds=3600&bucketSeconds=3600").sum { |bucket| bucket["sample_count"].to_i }
  end

  describe "with PRIVATE=1" do
    before do
      seed!
      go_private!
    end

    it "serves no position of the hidden node in GET /api/positions" do
      expect(row_keys(get_json("/api/positions"))).to eq([960_002])
    end

    it "answers [] for GET /api/positions/:id of the hidden node" do
      expect(get_json("/api/positions/#{hidden}")).to eq([])
    end

    it "serves no reading of the hidden node in GET /api/telemetry" do
      expect(row_keys(get_json("/api/telemetry"))).to eq([961_002])
    end

    it "answers [] for GET /api/telemetry/:id of the hidden node" do
      expect(get_json("/api/telemetry/#{hidden}")).to eq([])
    end

    it "serves no neighbour link with the hidden node at either end in GET /api/neighbors" do
      expect(row_keys(get_json("/api/neighbors"))).to eq([[visible, peer]])
    end

    it "answers [] for GET /api/neighbors/:id of the hidden node" do
      expect(get_json("/api/neighbors/#{hidden}")).to eq([])
    end

    it "serves no trace from or to the hidden node in GET /api/traces and drops its hop from the visible node's trace" do
      traces = get_json("/api/traces")
      expect(row_keys(traces)).to eq([962_003])
      expect(traces.first["hops"]).to eq([visible_num, peer_num])
    end

    it "answers [] for GET /api/traces/:id of the hidden node, while the visible node's lookup keeps the relayed trace" do
      expect(get_json("/api/traces/#{hidden}")).to eq([])
      traces = get_json("/api/traces/#{visible}")
      expect(row_keys(traces)).to eq([962_003])
      expect(traces.first["hops"]).to eq([visible_num, peer_num])
    end

    it "leaves the hidden node's ingestor out of GET /api/ingestors" do
      expect(ingestor_ids).to eq([visible])
    end

    it "leaves the hidden node out of /version last_node_update and the well-known last_update" do
      set_last_heard(hidden => now - 5, visible => now - 20, peer => now - 20)
      expect(freshness_hints).to eq([now - 20, now - 20])
    end

    it "leaves the hidden node's reading out of GET /api/telemetry/aggregated" do
      expect(aggregated_samples).to eq(1)
    end

    it "leaves the hidden node's rows out of every GET /api/stats count" do
      stats = get_json("/api/stats")
      %w[total meshtastic].each do |scope|
        expect(stats[scope]["nodes"]["day"]).to eq(2)
        expect(stats[scope]["messages"]["day"]).to eq(0)
        # One position, one reading, the visible link and the relayed trace;
        # the hidden node's waypoint counts no more than its other rows.
        expect(stats[scope]["telemetry"]["day"]).to eq(4)
      end
    end

    it "answers 404 for the hidden node's page and node record and serves the visible node's page" do
      get "/nodes/#{hidden}"
      expect(last_response.status).to eq(404)
      get "/api/nodes/#{hidden}"
      expect(last_response.status).to eq(404)
      get "/nodes/#{visible}"
      expect(last_response.status).to eq(200)
    end

    it "still answers 404 for messages and waypoints, bulk and per id" do
      ["/api/messages", "/api/messages/#{hidden}", "/api/waypoints", "/api/waypoints/#{hidden}"].each do |path|
        get path
        expect(last_response.status).to eq(404), "GET #{path}: #{last_response.status}"
      end
    end

    it "serves no destination of a Reticulum node stored as CLIENT_HIDDEN" do
      seed_reticulum_placeholder!
      expect(get_json("/api/destinations").map { |row| row["node_id"] }).not_to include(reticulum_hidden)
      expect(get_json("/api/destinations?node_id=#{reticulum_hidden}")).to eq([])
      get "/nodes/#{reticulum_hidden}"
      expect(last_response.status).to eq(404)
    end
  end

  describe "when PRIVATE=1 is set after public requests filled the caches" do
    it "serves no cached row of the hidden node from the six bulk caches" do
      seed!
      collections = ["/api/positions", "/api/telemetry", "/api/neighbors", "/api/traces", "/api/ingestors"]
      collections.each { |path| expect(hidden_references(get_json(path))).not_to be_empty }
      expect(aggregated_samples).to eq(2)
      # No cache flush: the private flag is part of each cache key (SPEC HC4, HC7).
      ENV["PRIVATE"] = "1"
      aggregate_failures do
        collections.each do |path|
          expect(hidden_references(get_json(path))).to eq([]), "GET #{path} served a cached row of the hidden node"
        end
        expect(aggregated_samples).to eq(1), "GET /api/telemetry/aggregated counted the hidden node's cached reading"
      end
    end
  end

  describe "with PRIVATE unset" do
    before { seed! }

    it "serves every row of the hidden node, bulk and per id, and keeps its hop" do
      expect(row_keys(get_json("/api/positions"))).to eq([960_001, 960_002])
      expect(row_keys(get_json("/api/positions/#{hidden}"))).to eq([960_001])
      expect(row_keys(get_json("/api/telemetry"))).to eq([961_001, 961_002])
      expect(row_keys(get_json("/api/telemetry/#{hidden}"))).to eq([961_001])
      expect(row_keys(get_json("/api/neighbors"))).to eq([[hidden, visible], [peer, hidden], [visible, peer]].sort)
      expect(row_keys(get_json("/api/neighbors/#{hidden}"))).to eq([[hidden, visible], [peer, hidden]].sort)
      traces = get_json("/api/traces")
      expect(row_keys(traces)).to eq([962_001, 962_002, 962_003])
      expect(traces.find { |row| row["id"] == 962_003 }["hops"]).to eq([visible_num, hidden_num, peer_num])
      expect(row_keys(get_json("/api/traces/#{hidden}"))).to eq([962_001, 962_002, 962_003])
    end

    it "counts the hidden node's rows in the rollup and the stats" do
      expect(aggregated_samples).to eq(2)
      stats = get_json("/api/stats")
      expect(stats["total"]["nodes"]["day"]).to eq(3)
      expect(stats["total"]["messages"]["day"]).to eq(1)
      # Two positions, two readings, three links, three traces, one waypoint.
      expect(stats["total"]["telemetry"]["day"]).to eq(11)
    end

    it "serves the hidden node's page, node record and destinations" do
      seed_reticulum_placeholder!
      get "/nodes/#{hidden}"
      expect(last_response.status).to eq(200)
      expect(get_json("/api/nodes/#{hidden}")["node_id"]).to eq(hidden)
      expect(get_json("/api/destinations?node_id=#{reticulum_hidden}").map { |row| row["node_id"] }).to eq([reticulum_hidden])
    end

    it "lists the hidden node's ingestor and counts it in the freshness hints" do
      expect(ingestor_ids).to eq([hidden, visible].sort)
      set_last_heard(hidden => now - 5, visible => now - 20, peer => now - 20)
      expect(freshness_hints).to eq([now - 5, now - 5])
    end
  end

  # The opt-out applies with PRIVATE unset, and so do these examples.
  describe "with PRIVATE unset, an opted-out node" do
    before do
      seed!
      seed_opted_out!
    end

    it "answers [] for GET /api/traces/:id of the opted-out node, while the trace it relayed keeps its other hops" do
      expect(get_json("/api/traces/#{opted}")).to eq([])
      relayed = get_json("/api/traces").find { |row| row["id"] == 962_004 }
      expect(relayed["hops"]).to eq([visible_num, peer_num])
      expect(row_keys(get_json("/api/traces/#{peer}"))).to include(962_004)
    end

    it "leaves the opted-out node's ingestor out of GET /api/ingestors" do
      expect(ingestor_ids).to eq([hidden, visible].sort)
    end

    it "leaves the opted-out node out of /version last_node_update and the well-known last_update" do
      set_last_heard(opted => now - 1, hidden => now - 5, visible => now - 20, peer => now - 20)
      expect(freshness_hints).to eq([now - 5, now - 5])
    end
  end

  # +/og-image.png+ caches its capture on disk, and a capture fails over to
  # the cached file; a restart that switches mode must not serve the other
  # mode's capture (SPEC HC7). The capture is stubbed, so no browser runs.
  describe "GET /og-image.png after a switch of mode" do
    around do |example|
      clear_og_captures
      example.run
    ensure
      clear_og_captures
    end

    # Capture once in the starting mode, then switch mode and let the next
    # capture fail, as a restart without a working browser does.
    #
    # @param start_private [Boolean] whether the first capture runs under PRIVATE=1.
    # @param bytes [String] the first capture's stand-in bytes.
    # @return [void]
    def capture_then_switch(start_private, bytes)
      set_private_flag(start_private)
      PotatoMesh::OgImage.capture_strategy = ->(_url) { bytes }
      get "/og-image.png"
      expect(last_response.body).to eq(bytes)
      set_private_flag(!start_private)
      PotatoMesh::OgImage.capture_strategy = ->(_url) { raise PotatoMesh::OgImage::CaptureError, "no browser" }
      get "/og-image.png"
      expect(last_response.status).to eq(200)
    end

    it "serves the bundled default, not the public capture, once PRIVATE=1 is set" do
      capture_then_switch(false, "PUBLIC CAPTURE")
      expect(last_response.body).not_to include("PUBLIC CAPTURE")
      expect(last_response.body.bytesize).to eq(File.size(PotatoMesh::Config.og_image_default_path))
    end

    it "serves the bundled default, not the private capture, once PRIVATE is unset" do
      capture_then_switch(true, "PRIVATE CAPTURE")
      expect(last_response.body).not_to include("PRIVATE CAPTURE")
      expect(last_response.body.bytesize).to eq(File.size(PotatoMesh::Config.og_image_default_path))
    end
  end
end
