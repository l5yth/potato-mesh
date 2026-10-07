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

# The Reticulum host's own position (SPEC RP4-RP7). The web app stores and
# serves positions protocol-neutrally, so these examples pin that the records
# and rows the Reticulum ingestor posts for its host land like any other
# protocol's, and that an announce-derived peer stays position-less.
RSpec.describe "Reticulum host position" do
  let(:app) { Sinatra::Application }
  let(:api_token) { "test-token" }
  let(:auth_headers) do
    {
      "CONTENT_TYPE" => "application/json",
      "HTTP_AUTHORIZATION" => "Bearer #{api_token}",
    }
  end
  let(:now) { Time.now.to_i }
  let(:host_id) { "!27716218" }
  let(:peer_id) { "!aabbccdd" }
  let(:position) do
    {
      "latitude" => 52.5029,
      "longitude" => 13.4042,
      "altitude" => 34.0,
      "time" => now,
      "locationSource" => "LOC_MANUAL",
    }
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

  # Remove all rows from the tables these examples write.
  #
  # @return [void]
  def clear_tables
    with_db do |db|
      %w[positions nodes destinations ingestors].each { |table| db.execute("DELETE FROM #{table}") }
    end
  end

  # A host destination record as the ingestor posts it at connect and on
  # every self-node report: the announce shape plus the host position.
  #
  # @return [Hash] node record.
  def host_record
    {
      "lastHeard" => now,
      "protocol" => "reticulum",
      "identityHash" => "27716218762cfd2864141ef286c39940",
      "user" => { "shortName" => "2771", "longName" => "Department of Decentralization", "role" => "NODE" },
      "destination" => { "id" => "9c59da5e1516745d74cc908243e0ba2b", "aspect" => "nomadnetwork.node", "role" => "NODE" },
      "position" => position,
    }
  end

  # The bare host record for a host with nothing announcing (SPEC RP6).
  #
  # @return [Hash] node record.
  def bare_host_record
    {
      "lastHeard" => now,
      "protocol" => "reticulum",
      "user" => { "shortName" => "2771", "longName" => "Reticulum 2771", "role" => "PEER" },
      "position" => position,
    }
  end

  # An announce-derived peer record: never positioned (SPEC RP4).
  #
  # @return [Hash] node record.
  def peer_record
    {
      "lastHeard" => now,
      "protocol" => "reticulum",
      "user" => { "shortName" => "aabb", "longName" => "Remote Peer", "role" => "PEER" },
      "destination" => { "id" => "c0ffee00222222222222222222222222", "aspect" => "lxmf.delivery", "role" => "PEER" },
    }
  end

  # The positions row the ingestor posts on each report (SPEC RP5).
  #
  # @return [Hash] positions payload.
  def position_row
    {
      "id" => 4_503_599_627_370_495,
      "rx_time" => now,
      "rx_iso" => Time.at(now).utc.iso8601,
      "node_id" => host_id,
      "node_num" => 0x27716218,
      "from_id" => host_id,
      "latitude" => 52.5029,
      "longitude" => 13.4042,
      "altitude" => 34.0,
      "position_time" => now,
      "location_source" => "LOC_MANUAL",
      "ingestor" => host_id,
      "protocol" => "reticulum",
    }
  end

  # POST node records the way the ingestor batches them.
  #
  # @param records [Hash{String => Hash}] node id to node record.
  # @return [Rack::MockResponse] the response.
  def post_nodes(records)
    post "/api/nodes", records.merge("ingestor" => host_id, "protocol" => "reticulum").to_json, auth_headers
    last_response
  end

  # POST the host's positions row.
  #
  # @return [Rack::MockResponse] the response.
  def post_position_row
    post "/api/positions", position_row.to_json, auth_headers
    last_response
  end

  describe "the host node record" do
    it "stores the position on the host and none on the peer" do
      expect(post_nodes(host_id => host_record, peer_id => peer_record).status).to eq(201)

      with_db(readonly: true) do |db|
        host = db.get_first_row("SELECT * FROM nodes WHERE node_id = ?", [host_id])
        expect(host.values_at("latitude", "longitude", "altitude")).to eq([52.5029, 13.4042, 34.0])
        expect(host.values_at("position_time", "location_source")).to eq([now, "LOC_MANUAL"])
        expect(host["precision_bits"]).to be_nil
        peer = db.get_first_row("SELECT * FROM nodes WHERE node_id = ?", [peer_id])
        expect(peer.values_at("latitude", "longitude", "position_time")).to eq([nil, nil, nil])
      end
    end

    it "serves the position on /api/nodes and /api/nodes/:id" do
      post_nodes(host_id => host_record, peer_id => peer_record)

      get "/api/nodes?protocol=reticulum"
      nodes = JSON.parse(last_response.body).to_h { |node| [node["node_id"], node] }
      expect(nodes[host_id].values_at("latitude", "longitude", "altitude")).to eq([52.5029, 13.4042, 34.0])
      expect(nodes[host_id]["location_source"]).to eq("LOC_MANUAL")
      expect(nodes[peer_id]).not_to have_key("latitude")

      get "/api/nodes/#{host_id}"
      expect(JSON.parse(last_response.body)["latitude"]).to eq(52.5029)
    end

    it "stores the bare record under the host's placeholder with no destination" do
      expect(post_nodes(host_id => bare_host_record).status).to eq(201)

      with_db(readonly: true) do |db|
        host = db.get_first_row("SELECT * FROM nodes WHERE node_id = ?", [host_id])
        expect(host.values_at("long_name", "short_name", "protocol")).to eq(["Reticulum 2771", "2771", "reticulum"])
        expect(host.values_at("latitude", "longitude")).to eq([52.5029, 13.4042])
        expect(db.get_first_value("SELECT COUNT(*) FROM destinations")).to eq(0)
      end

      # The node API fills a missing role with Meshtastic's CLIENT, which is
      # why the bare record carries Reticulum's base role (SPEC RA9).
      get "/api/nodes/#{host_id}"
      expect(JSON.parse(last_response.body)["role"]).to eq("PEER")
    end

    it "keeps a stored position when a later record carries none" do
      post_nodes(host_id => host_record)
      later = host_record.reject { |key, _| key == "position" }.merge("lastHeard" => now + 1)
      post_nodes(host_id => later)

      with_db(readonly: true) do |db|
        expect(db.get_first_value("SELECT latitude FROM nodes WHERE node_id = ?", [host_id])).to eq(52.5029)
      end
    end
  end

  describe "the host positions row" do
    it "is stored and served under the reticulum protocol" do
      post_nodes(host_id => host_record)
      expect(post_position_row.status).to eq(201)

      get "/api/positions?protocol=reticulum"
      rows = JSON.parse(last_response.body)
      expect(rows.length).to eq(1)
      expect(rows.first.values_at("node_id", "protocol", "latitude", "longitude", "altitude", "location_source")).to eq([host_id, "reticulum", 52.5029, 13.4042, 34.0, "LOC_MANUAL"])
      expect(rows.first["id"]).to eq(4_503_599_627_370_495)
    end

    it "counts in the reticulum telemetry umbrella of /api/stats (amends S3)" do
      post_nodes(host_id => host_record)
      post_position_row

      get "/api/stats"
      stats = JSON.parse(last_response.body)
      expect(stats["reticulum"]["telemetry"]["hour"]).to eq(1)
      expect(stats["reticulum"]["messages"]["hour"]).to eq(0)
    end

    it "lands first without harm: the record that follows completes the node" do
      expect(post_position_row.status).to eq(201)
      post_nodes(host_id => bare_host_record)

      with_db(readonly: true) do |db|
        host = db.get_first_row("SELECT * FROM nodes WHERE node_id = ?", [host_id])
        expect(host.values_at("protocol", "short_name", "long_name", "role")).to eq(["reticulum", "2771", "Reticulum 2771", "PEER"])
        expect(host.values_at("latitude", "longitude")).to eq([52.5029, 13.4042])
      end
    end
  end
end
