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

# The two activity windows of federation.  The node counts of a federation
# record cover the last 24 hours (+remote_instance_max_node_age+, SPEC FS2 and
# RL9), as the "(24h)" headers of the instances table say, while the dashboard
# and the nodes table count seven days.  A peer stays federated while its
# newest node was heard in the last seven days
# (+remote_instance_max_inactivity+, ACCEPTANCE FS-A5).
RSpec.describe "Federation activity windows" do
  let(:app) { Sinatra::Application }
  let(:application_class) { PotatoMesh::Application }
  let(:now) { Time.now.to_i }
  let(:hour) { 60 * 60 }
  let(:day) { 24 * hour }

  # Build a peer's /api/nodes payload of the minimum accepted size.
  #
  # @param newest_age_seconds [Integer] seconds since the peer's most
  #   recently heard node; every other node is older.
  # @return [Array<Hash>] remote node entries, newest first.
  def peer_nodes(newest_age_seconds)
    Array.new(PotatoMesh::Config.remote_instance_min_node_count) do |index|
      { "node_id" => format("!%08x", index + 1), "last_heard" => now - newest_age_seconds - index }
    end
  end

  # Answer one peer request the way the peer's own routes do: every node list
  # keeps the nodes heard since +since=+ and, from v0.5.10 on, within the
  # 7-day floor of +GET /api/nodes+, and +limit=+ keeps the newest of them.
  # The peer also serves its well-known document, which a first-contact key
  # check reads.
  #
  # @param domain [String] the peer's domain.
  # @param nodes [Array<Hash>] the peer's nodes, newest first.
  # @param path [String] requested path and query string.
  # @param serves [Array<Symbol>] node lists the peer answers: +:acceptance+
  #   (no +since=+, the list a peer is judged on) and +:recent+ (+since=+
  #   inside the last day, the 24-hour count fallback).
  # @param stats [Hash, nil] the peer's /api/stats payload; nil fails it.
  # @param floor [Boolean] whether the peer applies the 7-day floor.
  # @param extra [Array<Hash>] entries the peer adds to every list unfiltered.
  # @return [Array(Object, Object)] payload and metadata, as
  #   +fetch_instance_json+ returns them.
  def peer_response(domain, nodes, path, serves:, stats:, floor:, extra:)
    if path == "/.well-known/potato-mesh"
      return [{ "domain" => domain, "public_key" => "peer-key" }, :well_known]
    end
    if path == "/api/stats"
      return stats ? [stats, :stats] : [nil, ["stats unavailable"]]
    end

    uri = URI(path)
    return [nil, []] unless uri.path == "/api/nodes"

    query = URI.decode_www_form(uri.query.to_s).to_h
    since = query["since"]&.to_i
    list = since.nil? ? :acceptance : :recent
    return [nil, ["#{list} node list unavailable"]] unless serves.include?(list)

    threshold = [since, floor ? now - (7 * day) : nil].compact.max
    heard = threshold ? nodes.select { |node| node["last_heard"] && node["last_heard"] >= threshold } : nodes
    heard += extra
    [query.key?("limit") ? heard.first(query["limit"].to_i) : heard, :nodes]
  end

  # Crawl a seed that lists one unsigned peer per entry of +quiet_for+.
  # Every fetch is stubbed, so no DNS lookup or connection leaves the process.
  #
  # @param quiet_for [Hash{String => Integer}] peer domain to seconds since
  #   its newest node.
  # @param serves [Array<Symbol>] node lists the peers answer, see
  #   {#peer_response}.
  # @param stats [Hash, nil] /api/stats payload the peers serve.
  # @param floor [Boolean] whether the peers apply the 7-day floor.
  # @param extra [Array<Hash>] entries every peer adds to its node lists.
  # @return [Array<Hash>] attributes of the peers the crawl stored.
  def crawl_peers(quiet_for, serves: %i[acceptance recent], stats: nil, floor: true, extra: [])
    listing = quiet_for.keys.map do |domain|
      { "id" => Digest::SHA256.hexdigest("peer-key"), "domain" => domain, "public_key" => "peer-key", "signature" => "peer-signature" }
    end
    allow(application_class).to receive(:fetch_instance_json) do |host, path|
      if host == "seed.mesh.test" && path == "/api/instances"
        [listing, :instances]
      elsif quiet_for.key?(host)
        peer_response(host, peer_nodes(quiet_for[host]), path, serves: serves, stats: stats, floor: floor, extra: extra)
      else
        [nil, []]
      end
    end
    allow(application_class).to receive(:verify_instance_signature).and_return(true)
    allow(application_class).to receive(:validate_well_known_document).and_return([true, nil])
    allow(application_class).to receive(:warn_log)
    allow(application_class).to receive(:debug_log)
    stored = []
    allow(application_class).to receive(:upsert_instance_record) do |_db, attributes, _signature|
      stored << attributes
    end

    application_class.ingest_known_instances_from!(double(:db, get_first_value: nil, get_first_row: nil), "seed.mesh.test")
    stored
  end

  describe "federation record counts (SPEC FS2, RL9)" do
    let(:api_token) { "test-token" }
    let(:auth_headers) do
      {
        "CONTENT_TYPE" => "application/json",
        "HTTP_AUTHORIZATION" => "Bearer #{api_token}",
      }
    end

    before do
      @original_token = ENV.fetch("API_TOKEN", nil)
      ENV["API_TOKEN"] = api_token
      delete_nodes
      PotatoMesh::App::ApiCache.invalidate_all
    end

    after do
      ENV["API_TOKEN"] = @original_token
      delete_nodes
    end

    # Empty the nodes table of the database the suite shares.
    #
    # @return [void]
    def delete_nodes
      db = application_class.open_database
      db.execute("DELETE FROM nodes")
    ensure
      db&.close
    end

    # POST one Reticulum node through the ingest API.
    #
    # @param age_seconds [Integer] seconds between the node's last_heard and now.
    # @return [void]
    def post_reticulum_node_heard(age_seconds)
      payload = {
        "!a1b2c3d4" => {
          "user" => { "longName" => "Argos Station", "shortName" => "a1b2" },
          "lastHeard" => now - age_seconds,
        },
        "protocol" => "reticulum",
      }
      post "/api/nodes", payload.to_json, auth_headers
      expect(last_response.status).to eq(201)
    end

    it "leaves a node heard 6d 9h ago out of the 24h self count but in the 7-day stats" do
      post_reticulum_node_heard(153 * hour)

      get "/api/stats"
      stats = JSON.parse(last_response.body)
      expect(stats["reticulum"]["nodes"]["week"]).to eq(1)
      expect(stats["reticulum"]["nodes"]["day"]).to eq(0)
      attributes = application_class.self_instance_attributes
      expect(attributes[:reticulum_nodes_count]).to eq(0)
      expect(attributes[:nodes_count]).to eq(0)
    end

    it "counts a node heard inside 24 hours in the self record" do
      post_reticulum_node_heard(30)

      attributes = application_class.self_instance_attributes
      expect(attributes[:reticulum_nodes_count]).to eq(1)
      expect(attributes[:nodes_count]).to eq(1)
    end

    it "stores the day figure of an unsigned peer's /api/stats" do
      stats = { "total" => { "nodes" => { "hour" => 1, "day" => 2, "week" => 3, "month" => 4 } } }

      stored = crawl_peers({ "fresh.mesh.test" => 60 }, stats: stats)

      expect(stored.map { |attributes| attributes[:nodes_count] }).to eq([2])
    end

    it "counts the 24-hour list when /api/stats fails" do
      stored = crawl_peers({ "quiet.mesh.test" => 2 * day })

      expect(stored.map { |attributes| attributes[:nodes_count] }).to eq([0])
    end

    it "counts a 24-hour-list node heard exactly 24 hours ago" do
      allow(Time).to receive(:now).and_return(Time.at(now))

      stored = crawl_peers({ "edge.mesh.test" => day })

      expect(stored.map { |attributes| attributes[:nodes_count] }).to eq([1])
    end

    it "does not count a 24-hour-list entry without last_heard" do
      stored = crawl_peers({ "quiet.mesh.test" => 2 * day }, extra: [{ "node_id" => "!0000beef" }])

      expect(stored.map { |attributes| attributes[:nodes_count] }).to eq([0])
    end

    it "never counts the 7-day acceptance list" do
      stored = crawl_peers({ "quiet.mesh.test" => 2 * day }, serves: %i[acceptance])

      expect(stored.map { |attributes| attributes[:domain] }).to eq(["quiet.mesh.test"])
      expect(stored.first[:nodes_count]).to be_nil
    end
  end

  describe "peer acceptance window (ACCEPTANCE FS-A5)" do
    it "accepts a peer whose newest node was heard 2 days ago" do
      expect(application_class.validate_remote_nodes(peer_nodes(2 * day))).to eq([true, nil])
    end

    it "rejects a peer whose newest node was heard 8 days ago" do
      expect(application_class.validate_remote_nodes(peer_nodes(8 * day))).to eq([false, "node data is stale"])
    end

    it "accepts a peer whose newest node was heard 6 days 23 hours ago" do
      expect(application_class.validate_remote_nodes(peer_nodes(6 * day + 23 * hour))).to eq([true, nil])
    end

    it "rejects a peer whose newest node was heard 7 days 1 hour ago" do
      expect(application_class.validate_remote_nodes(peer_nodes(7 * day + hour))).to eq([false, "node data is stale"])
    end

    it "keeps a peer quiet for 2 days in the crawl and drops one that lists nodes 8 days old as stale" do
      stored = crawl_peers({ "quiet.mesh.test" => 2 * day, "gone.mesh.test" => 8 * day }, floor: false)

      expect(stored.map { |attributes| attributes[:domain] }).to eq(["quiet.mesh.test"])
      expect(application_class).to have_received(:warn_log).with(
        "Discarded remote instance entry",
        hash_including(domain: "gone.mesh.test", reason: "node data is stale"),
      )
    end

    it "judges each peer on its 10 newest nodes inside its 7-day floor, counting 24 hours" do
      # Each peer has exactly the minimum node count, so the request's limit
      # must still return enough nodes to accept the 2-day peer.
      stored = crawl_peers({ "quiet.mesh.test" => 2 * day, "gone.mesh.test" => 8 * day })

      expect(stored.map { |attributes| attributes[:domain] }).to eq(["quiet.mesh.test"])
      # The count comes from the 24-hour list, empty for a quiet peer.
      expect(stored.first[:nodes_count]).to eq(0)
      expect(application_class).to have_received(:warn_log).with(
        "Discarded remote instance entry",
        hash_including(domain: "gone.mesh.test", reason: "insufficient nodes"),
      )
    end
  end

  describe ".remote_node_last_heard" do
    it "reads either casing, takes the later value and skips entries that are not objects" do
      expect(application_class.remote_node_last_heard({ "last_heard" => 10, "lastHeard" => 20 })).to eq(20)
      expect(application_class.remote_node_last_heard({ "lastHeard" => 30 })).to eq(30)
      expect(application_class.remote_node_last_heard({ "node_id" => "!00000001" })).to be_nil
      expect(application_class.remote_node_last_heard("!00000001")).to be_nil
    end
  end
end
