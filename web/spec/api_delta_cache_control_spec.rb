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
require "digest"

# The HTTP caching of the API reads (SPEC DN1, DN2, DN5, security and
# performance review).  A delta read, one whose +since+ is above 0, answers
# +Cache-Control: no-cache+ on its 200 and on its 304, so a browser
# revalidates every delta: a repeat of its URL gets the rows stored since,
# and an unchanged delta is a 304 from the weak ETag.  An empty list answers
# +no-cache+ too, so the refresh of an empty collection, which sends the URL
# of its full read again, gets the collection's first row.  Every other read,
# a +before+ page included, keeps its +max-age+.  Rows are stored through the
# real ingest routes.
RSpec.describe "API delta reads and the HTTP cache" do
  let(:app) { Sinatra::Application }
  let(:api_token) { "delta-no-cache-spec-token" }
  let(:auth_headers) do
    { "CONTENT_TYPE" => "application/json", "HTTP_AUTHORIZATION" => "Bearer #{api_token}" }
  end
  let(:now) { Time.now.to_i }
  let(:node_id) { "!0dc0ffee" }
  let(:full) { "public, must-revalidate, max-age=10" }
  let(:delta) { "public, no-cache" }
  # The collections that take both +since+ and +before+ (SPEC BP1, RA8).
  let(:collections) { %w[nodes ingestors destinations messages positions waypoints neighbors telemetry traces] }
  # A Reticulum identity, for a destination row: RNS derives the hash from
  # the key, the first 16 bytes of the SHA-256 of its 64 bytes, and the node
  # id from the hash's head.
  let(:reticulum_key) { "ab" * 64 }
  let(:reticulum_identity) { Digest::SHA256.digest([reticulum_key].pack("H*"))[0, 16].unpack1("H*") }
  let(:reticulum_node_id) { "!#{reticulum_identity[0, 8]}" }

  around do |example|
    saved = ENV.to_h.slice("API_TOKEN", "PRIVATE", "EVENTS")
    ENV["API_TOKEN"] = api_token
    ENV.delete("PRIVATE")
    ENV.delete("EVENTS")
    clear_tables
    PotatoMesh::App::ApiCache.invalidate_all
    example.run
  ensure
    %w[API_TOKEN PRIVATE EVENTS].each { |key| saved.key?(key) ? ENV[key] = saved[key] : ENV.delete(key) }
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

  # POST one ingest body and expect it stored.
  #
  # @param path [String] ingest route.
  # @param body [Object] JSON-serialisable payload.
  # @return [void]
  def ingest(path, body)
    post path, body.to_json, auth_headers
    expect(last_response.status).to eq(201), "POST #{path}: #{last_response.status} #{last_response.body}"
  end

  # Store one text message from +node_id+ through +POST /api/messages+.
  #
  # @param id [Integer] message id.
  # @param rx_time [Integer] receive time.
  # @return [void]
  def store_message(id, rx_time)
    ingest("/api/messages", [{ id: id, rx_time: rx_time, rx_iso: Time.at(rx_time).utc.iso8601, from_id: node_id,
                               to_id: "^all", channel: 0, portnum: "TEXT_MESSAGE_APP", text: "delta #{id}" }])
  end

  # Store a row of every collection for +node_id+, an ingestor heartbeat
  # that counts mesh activity and a Reticulum node with one destination, so
  # that no full read and no +before+ page of the example is empty (SPEC DN5).
  #
  # @return [void]
  def seed_every_collection
    t = now - 30
    iso = Time.at(t).utc.iso8601
    num = 0x0dc0ffee
    store_message(7_100, t)
    ingest("/api/positions", { id: 7_101, node_id: node_id, node_num: num, rx_time: t, rx_iso: iso, latitude: 52.52, longitude: 13.405 })
    ingest("/api/telemetry", { id: 7_102, node_id: node_id, node_num: num, rx_time: t, rx_iso: iso, battery_level: 77, voltage: 3.9 })
    ingest("/api/neighbors", { node_id: node_id, node_num: num, rx_time: t, rx_iso: iso,
                               neighbors: [{ neighbor_id: "!0dc0ffef", snr: 5.5, rx_time: t, rx_iso: iso }] })
    ingest("/api/traces", { id: 7_103, request_id: 1, src: num, dest: 0x0dc0ffef, hops: [num, 0x0dc0ffef], rx_time: t, rx_iso: iso })
    ingest("/api/waypoints", { id: 7_104, node_id: node_id, node_num: num, from_id: node_id, name: "mast",
                               latitude: 52.5, longitude: 13.4, rx_time: t, rx_iso: iso })
    ingest("/api/ingestors", { node_id: node_id, start_time: t, last_seen_time: t, version: "1.0.0", packets: 12 })
    ingest("/api/nodes", { reticulum_node_id => {
      "lastHeard" => t, "protocol" => "reticulum", "identityHash" => reticulum_identity,
      "interface" => "RNodeInterface[RNode Berlin]",
      "destination" => { "id" => "a1b2c3d4e5f60718293a4b5c6d7e8f90", "aspect" => "lxmf.delivery", "role" => "PEER" },
      "user" => { "shortName" => reticulum_identity[0, 4], "longName" => "Argos Station", "role" => "PEER", "publicKey" => reticulum_key },
    } })
  end

  # Every read route that takes +since+, with the +max-age+ of its full read:
  # the collections, the per-id routes and the two bucketed series (RC1).
  #
  # @return [Hash{String => Integer}] request path to its full read's max-age.
  def since_routes
    per_id = %w[nodes messages positions waypoints neighbors telemetry traces].map { |name| "/api/#{name}/#{node_id}" }
    routes = (collections.map { |name| "/api/#{name}" } + per_id).to_h { |path| [path, 10] }
    routes.merge("/api/telemetry/aggregated" => 30, "/api/stats/activity" => 30)
  end

  # GET +path+ and return its +Cache-Control+, expecting a 200.
  #
  # @param path [String] request path with query.
  # @return [String, nil] the +Cache-Control+ header.
  def cache_control_of(path)
    get path
    expect(last_response.status).to eq(200), "GET #{path} answered #{last_response.status}"
    last_response.headers["Cache-Control"]
  end

  before do
    # The per-id node route answers 404 for an unknown node.
    user = { "shortName" => "DNCF", "longName" => "Delta Coffee", "role" => "CLIENT" }
    ingest("/api/nodes", { node_id => { "num" => 0x0dc0ffee, "lastHeard" => now - 30, "user" => user } })
  end

  it "answers a delta read on every route that takes since with no-cache (DN1)" do
    answers = since_routes.keys.to_h { |path| [path, cache_control_of("#{path}?since=#{now - 60}")] }
    expect(answers).to eq(since_routes.keys.to_h { |path| [path, delta] })
  end

  it "keeps the max-age of a full read, without since and with since=0 (DN1)" do
    seed_every_collection
    bodies = since_routes.keys.to_h { |path| get(path) && [path, last_response.body] }
    expect(bodies.select { |_path, body| body == "[]" }.keys).to eq([]), "every full read holds a row"
    expected = since_routes.to_h { |path, max_age| [path, "public, must-revalidate, max-age=#{max_age}"] }
    expect(since_routes.keys.to_h { |path| [path, cache_control_of(path)] }).to eq(expected)
    expect(since_routes.keys.to_h { |path| [path, cache_control_of("#{path}?since=0")] }).to eq(expected)
  end

  it "reads since as the routes do: from the query string, a value not above 0 a full read (DN1)" do
    ["-5", "abc", ""].each do |value|
      expect(cache_control_of("/api/nodes?since=#{value}")).to eq(full), "since=#{value.inspect}"
    end
    expect(cache_control_of("/api/nodes?since=1")).to eq(delta)
    # A form body's since is never read (RC6), so it makes no delta: the
    # answer is a full read, or the 415 of IH4 once no path takes a form.
    get "/api/nodes", {}, { input: "since=#{now - 60}", "CONTENT_TYPE" => "application/x-www-form-urlencoded" }
    expect(last_response.status).to eq(200).or eq(415)
    expect(last_response.headers["Cache-Control"]).not_to eq(delta)
    head "/api/nodes?since=#{now - 60}"
    expect(last_response.headers["Cache-Control"]).to eq(delta)
  end

  it "revalidates an unchanged delta to a 304 with no-cache, and answers a new row with a 200 (DN1)" do
    store_message(7_001, now - 30)
    path = "/api/messages?limit=1000&since=#{now - 60}"
    get path
    expect(last_response.status).to eq(200)
    expect(last_response.headers["Cache-Control"]).to eq(delta)
    stored_etag = last_response.headers["ETag"]
    expect(stored_etag).to start_with("W/")

    # A browser revalidates its stored answer: unchanged, a 304 that keeps it.
    get path, {}, { "HTTP_IF_NONE_MATCH" => stored_etag }
    expect(last_response.status).to eq(304)
    expect(last_response.headers["Cache-Control"]).to eq(delta)
    expect(last_response.headers["ETag"]).to eq(stored_etag)

    store_message(7_002, now - 20)
    get path, {}, { "HTTP_IF_NONE_MATCH" => stored_etag }
    expect(last_response.status).to eq(200)
    expect(last_response.headers["Cache-Control"]).to eq(delta)
    expect(last_response.headers["ETag"]).not_to eq(stored_etag)
    expect(JSON.parse(last_response.body).map { |row| row["id"] }).to contain_exactly(7_001, 7_002)
  end

  it "sends no-cache on every answer to a delta read, an error included (DN1)" do
    ["/api/nodes/!0000beef", "/api/no-such-route"].each do |path|
      get "#{path}?since=#{now - 60}"
      expect(last_response.status).to eq(404), path
      expect(last_response.headers["Cache-Control"]).to eq(delta), path
    end
    # The stream answers 404 with EVENTS=0; with since, as a delta read.
    ENV["EVENTS"] = "0"
    get "/api/events?since=#{now - 60}"
    expect(last_response.status).to eq(404)
    expect(last_response.headers["Cache-Control"]).to eq(delta)
  end

  it "answers an empty list with no-cache, on its 304 too, and its first row with a 200 and max-age=10 (DN5)" do
    path = "/api/waypoints?limit=1000"
    get path
    expect(last_response.status).to eq(200)
    expect(last_response.body).to eq("[]")
    expect(last_response.headers["Cache-Control"]).to eq(delta)
    empty_etag = last_response.headers["ETag"]

    # The refresh of an empty collection sends its full read's URL again.
    get path, {}, { "HTTP_IF_NONE_MATCH" => empty_etag }
    expect(last_response.status).to eq(304)
    expect(last_response.headers["Cache-Control"]).to eq(delta)

    t = now - 5
    ingest("/api/waypoints", { id: 7_201, node_id: node_id, node_num: 0x0dc0ffee, from_id: node_id, name: "first",
                               latitude: 52.5, longitude: 13.4, rx_time: t, rx_iso: Time.at(t).utc.iso8601 })
    get path, {}, { "HTTP_IF_NONE_MATCH" => empty_etag }
    expect(last_response.status).to eq(200)
    expect(JSON.parse(last_response.body).map { |row| row["id"] }).to eq([7_201])
    expect(last_response.headers["Cache-Control"]).to eq(full)
    expect(last_response.headers["ETag"]).not_to eq(empty_etag)

    # Every empty list does, on the per-id routes and the series too.
    { "/api/positions/#{node_id}" => delta, "/api/telemetry/aggregated" => delta, "/api/nodes" => full }.each do |empty_path, header|
      expect(cache_control_of(empty_path)).to eq(header), empty_path
    end
  end

  it "keeps max-age=10 on a before page, and a before page with since is a delta (DN2)" do
    seed_every_collection
    collections.each do |name|
      expect(cache_control_of("/api/#{name}?before=#{now}")).to eq(full), name
      expect(cache_control_of("/api/#{name}?since=#{now - 60}&before=#{now}")).to eq(delta), name
    end
  end

  it "keeps the private directive under PRIVATE=1 (DN1)" do
    ENV["PRIVATE"] = "1"
    expect(cache_control_of("/api/nodes?since=#{now - 60}")).to eq("private, no-cache")
    expect(cache_control_of("/api/nodes")).to eq("private, must-revalidate, max-age=10")
    expect(cache_control_of("/api/positions")).to eq("private, no-cache")
  end
end
