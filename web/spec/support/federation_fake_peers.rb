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

require "base64"
require "digest"
require "json"
require "net/http"
require "openssl"
require "set"
require "uri"
require_relative "federation_identity"

# A fake federation for specs that run the app's real federation request code,
# +fetch_instance_json+ down to +build_federation_http_request+, without a
# socket. +build_remote_http_client+ returns a {FakeHTTP} that a {Fed} answers
# per host and path, and DNS lookups and sockets raise, so nothing leaves the
# process. Fixture domains use the reserved +.invalid+ TLD.
module FederationFakePeers
  # The application class under test.
  APP = PotatoMesh::Application

  # One signing key per domain, generated once per process.
  KEYS = Hash.new { |hash, domain| hash[domain] = OpenSSL::PKey::RSA.new(2048) }

  # Request kinds {Fed#counts} reports, in report order.
  KINDS = %i[instances well_known stats nodes_acceptance nodes_24h nodes_full nodes_7d other].freeze

  # Classify a request path into the federation fetch kinds the specs count.
  #
  # @param path [String] request path with its query string.
  # @return [Symbol] one of {KINDS}.
  def self.kind(path)
    case path
    when "/api/instances" then :instances
    when "/.well-known/potato-mesh" then :well_known
    when "/api/stats" then :stats
    when "/api/nodes" then :nodes_full
    when "/api/nodes?limit=10" then :nodes_acceptance
    when %r{\A/api/nodes\?since=\d+&limit=1000\z} then :nodes_24h
    when %r{\A/api/nodes\?since=\d+&limit=10\z} then :nodes_7d
    else :other
    end
  end

  # The fake peers: per-host instance lists, node lists, stats and well-known
  # documents, status and header overrides, refused hosts, per-request hooks,
  # and a log of every request with the status it was answered with.
  class Fed
    # @return [Hash{String => Array<Hash>}] each host's +/api/instances+ list.
    attr_reader :lists
    # @return [Hash{String => Array<Hash>}] each host's nodes, newest first.
    attr_reader :nodes
    # @return [Hash{String => Hash}] each host's +/api/stats+ payload.
    attr_reader :stats
    # @return [Hash{String => Hash}] each host's well-known document.
    attr_reader :well_known
    # @return [Hash{Array(String, Symbol) => Integer}] status per host and kind.
    attr_reader :status
    # @return [Hash{Array(String, Symbol) => Hash}] response headers per host and kind.
    attr_reader :headers
    # @return [Set<String>] hosts that refuse every connection.
    attr_reader :refused
    # @return [Array<Proc>] hooks called with each request entry before it is answered.
    attr_reader :hooks
    # @return [Array<Hash>] every request, in order.
    attr_reader :log
    # @return [Integer] most requests answered at the same time.
    attr_reader :max_in_flight

    def initialize
      @lists = {}
      @nodes = {}
      @stats = {}
      @well_known = {}
      @status = {}
      @headers = {}
      @refused = Set.new
      @hooks = []
      @log = []
      @mutex = Mutex.new
      @in_flight = 0
      @max_in_flight = 0
    end

    # Answer one request.
    #
    # A 200 answer becomes a 304 when the request revalidates the ETag or
    # Last-Modified the fixture serves, as the app's own routes answer.
    #
    # @param uri [URI::Generic] requested URI.
    # @param request [Net::HTTPRequest] request the app built.
    # @return [Array(Integer, Hash, Object)] status, headers and body.
    # @raise [Errno::ECONNREFUSED] when the host is in {#refused}.
    def call(uri, request)
      entry = {
        scheme: uri.scheme, host: uri.host, path: uri.request_uri, kind: FederationFakePeers.kind(uri.request_uri),
        headers: request.each_header.to_h, thread: Thread.current,
      }
      @mutex.synchronize do
        @log << entry
        @in_flight += 1
        @max_in_flight = [@max_in_flight, @in_flight].max
      end
      begin
        @hooks.each { |hook| hook.call(entry) }
        raise Errno::ECONNREFUSED, "spec: #{entry[:host]} refuses" if @refused.include?(entry[:host])

        entry[:status] = answer_status(entry)
        hdrs = @headers.fetch([entry[:host], entry[:kind]], {})
        [entry[:status], hdrs, entry[:status] == 200 ? body_for(entry) : ""]
      ensure
        @mutex.synchronize { @in_flight -= 1 }
      end
    end

    # Requests per kind sent to +host+.
    #
    # @param host [String] peer host.
    # @return [Hash{Symbol => Integer}] non-zero counts by kind.
    def counts(host)
      KINDS.to_h { |k| [k, @log.count { |e| e[:host] == host && e[:kind] == k }] }.reject { |_, v| v.zero? }
    end

    # All requests, or all requests to +host+.
    #
    # @param host [String, nil] peer host, nil for every host.
    # @return [Integer] request count.
    def total(host = nil)
      @log.count { |e| host.nil? || e[:host] == host }
    end

    # Paths requested from +host+ that start with +prefix+, since values masked.
    #
    # @param host [String] peer host.
    # @param prefix [String] path prefix.
    # @return [Array<String>] request paths in order.
    def paths(host, prefix: "/")
      @log.select { |e| e[:host] == host && e[:path].start_with?(prefix) }.map { |e| e[:path].sub(/since=\d+/, "since=N") }
    end

    private

    def answer_status(entry)
      code = @status.fetch([entry[:host], entry[:kind]], 200)
      return code unless code == 200

      hdrs = @headers.fetch([entry[:host], entry[:kind]], {})
      sent = entry[:headers]
      return 304 if hdrs["ETag"] && sent["if-none-match"] == hdrs["ETag"]
      return 304 if hdrs["Last-Modified"] && sent["if-modified-since"] == hdrs["Last-Modified"]

      200
    end

    def body_for(entry)
      host = entry[:host]
      case entry[:kind]
      when :instances then @lists.fetch(host, [])
      when :well_known then @well_known.fetch(host) { FederationIdentitySupport.well_known_document(KEYS[host], host) }
      when :stats then @stats.fetch(host) { FederationFakePeers.default_stats }
      when :nodes_full, :nodes_acceptance, :nodes_24h, :nodes_7d then node_body(host, entry[:path])
      else {}
      end
    end

    # Serve a node list as +GET /api/nodes+ does: a 7-day floor, +since+ and
    # +limit+, newest first.
    def node_body(host, path)
      all = @nodes.fetch(host) { FederationFakePeers.fresh_nodes }
      query = URI.decode_www_form(URI.parse(path).query.to_s).to_h
      floor = Time.now.to_i - PotatoMesh::Config.week_seconds
      threshold = [query["since"].to_i, floor].max
      limit = (query["limit"] || 200).to_i
      all.select { |n| n["last_heard"].to_i >= threshold }.sort_by { |n| -n["last_heard"].to_i }.first(limit)
    end
  end

  # Net::HTTP stand-in that the stubbed +build_remote_http_client+ returns:
  # the app's request code runs unchanged and the {Fed} answers it.
  class FakeHTTP
    # @param uri [URI::Generic] the URI the client was built for.
    # @param fed [Fed] the fake federation answering requests.
    def initialize(uri, fed)
      @uri = uri
      @fed = fed
    end

    # Mirror Net::HTTP#start: yield the open connection.
    #
    # @yieldparam connection [FakeHTTP] this client.
    # @return [Object] the block's result.
    def start
      yield self
    end

    # Mirror Net::HTTP#request in its block form.
    #
    # @param req [Net::HTTPRequest] the request the app built.
    # @yieldparam response [Net::HTTPResponse] the answer.
    # @return [Net::HTTPResponse] the answer.
    def request(req)
      code, hdrs, body = @fed.call(@uri, req)
      response = Net::HTTPResponse::CODE_TO_OBJ.fetch(code.to_s).new("1.1", code.to_s, "spec")
      hdrs.each { |k, v| response[k] = v }
      payload = body.is_a?(String) ? body : JSON.generate(body)
      response.define_singleton_method(:read_body) { |*_args, &blk| blk ? blk.call(payload) : payload }
      yield response if block_given?
      response
    end
  end

  # Worker-pool stand-in: runs each scheduled block inline and counts it.
  class SyncPool
    # @return [Integer] blocks scheduled so far.
    attr_reader :scheduled

    def initialize
      @scheduled = 0
    end

    # Run +block+ now.
    #
    # @return [PotatoMesh::App::WorkerPool::Task] a task holding its result.
    def schedule
      @scheduled += 1
      PotatoMesh::App::WorkerPool::Task.new.tap { |task| task.fulfill(yield) }
    end

    # @return [Boolean] always true.
    def alive?
      true
    end
  end

  # A peer's +/api/stats+ payload in the 0.7.0 shape.
  #
  # @return [Hash] stats payload.
  def self.default_stats
    {
      "total" => { "nodes" => { "hour" => 1, "day" => 2, "week" => 3, "month" => 4 } },
      "meshtastic" => { "nodes" => { "day" => 2 } },
    }
  end

  # Remote node entries, newest first, one second apart.
  #
  # @param count [Integer] number of nodes.
  # @param newest_age [Integer] seconds since the newest node was heard.
  # @param protocol [String] protocol of every node.
  # @param offset [Integer] first node number, to keep ids distinct.
  # @return [Array<Hash>] node entries.
  def self.fresh_nodes(count = 10, newest_age: 0, protocol: "meshtastic", offset: 0)
    now = Time.now.to_i
    Array.new(count) do |i|
      { "node_id" => format("!%08x", 0x1000 + offset + i), "last_heard" => now - newest_age - i, "protocol" => protocol }
    end
  end

  # Instance attributes for +domain+ under +key+, as that instance signs them.
  #
  # @param domain [String] instance domain.
  # @param key [OpenSSL::PKey::RSA] instance key.
  # @param overrides [Hash] attributes replacing the defaults.
  # @return [Hash] instance attributes.
  def self.attrs(domain, key = KEYS[domain], **overrides)
    pem = key.public_key.to_pem
    {
      id: Digest::SHA256.hexdigest(pem), domain: domain, pubkey: pem, name: "Mesh #{domain}",
      version: "v0.8.0", channel: "#LongFast", frequency: "868MHz", latitude: 52.5, longitude: 13.4,
      last_update_time: Time.now.to_i, is_private: false, nodes_count: 12,
      meshcore_nodes_count: 4, meshtastic_nodes_count: 8, reticulum_nodes_count: 0,
    }.merge(overrides)
  end

  # Sign +attributes+ over the v2 canonical.
  #
  # @param key [OpenSSL::PKey::RSA] signing key.
  # @param attributes [Hash] instance attributes.
  # @return [String] base64 signature.
  def self.sign(key, attributes)
    Base64.strict_encode64(key.sign(OpenSSL::Digest::SHA256.new, APP.canonical_instance_payload(attributes)))
  end

  # The announcement a peer POSTs, signed with +key+.
  #
  # @return [Hash] announcement payload.
  def self.payload(domain, key = KEYS[domain], **overrides)
    a = attrs(domain, key, **overrides)
    APP.instance_announcement_payload(a, sign(key, a))
  end

  # The record as a peer's +/api/instances+ lists it.
  #
  # @return [Hash] decoded wire record.
  def self.record(domain, key = KEYS[domain], **overrides)
    JSON.parse(JSON.generate(payload(domain, key, **overrides)))
  end

  # Store the record for +domain+ as an accepted announcement does.
  #
  # @param db [SQLite3::Database] open database handle.
  # @return [void]
  def self.store(db, domain, key = KEYS[domain], **overrides)
    a = attrs(domain, key, **overrides)
    APP.upsert_instance_record(db, a, sign(key, a))
  end
end

# Wire the fake federation into the app for every example of the including
# group: federation is enabled, DNS and sockets raise, every federation
# request from the class (the crawl) or an instance (the registration route)
# reaches {FederationFakePeers::Fed}, the worker pool runs inline, logs are
# captured in +logs+ and the instances table and the process-wide federation
# state start empty.
RSpec.shared_context "fake federation peers" do
  let(:fed) { FederationFakePeers::Fed.new }
  let(:pool) { FederationFakePeers::SyncPool.new }
  let(:logs) { [] }
  let(:json_headers) { { "CONTENT_TYPE" => "application/json" } }

  # Rack::Test entry point.
  #
  # @return [Class] the Sinatra application under test.
  def app
    Sinatra::Application
  end

  # Yield a read-write handle on the spec database and close it afterwards.
  #
  # @yieldparam db [SQLite3::Database] open database handle.
  # @return [Object] the block's result.
  def with_db
    db = FederationFakePeers::APP.open_database
    yield db
  ensure
    db&.close
  end

  # Every stored instance row.
  #
  # @return [Array<Array>] domain, public key, then the four counts, by domain.
  def stored_rows
    with_db do |db|
      db.execute(
        "SELECT domain, pubkey, nodes_count, meshcore_nodes_count, meshtastic_nodes_count, reticulum_nodes_count " \
        "FROM instances ORDER BY domain",
      )
    end
  end

  # Crawl +root+ once, as a direct call.
  #
  # @param root [String] domain whose instance list starts the crawl.
  # @return [Object] what +ingest_known_instances_from!+ returns.
  def crawl(root)
    with_db { |db| FederationFakePeers::APP.ingest_known_instances_from!(db, root) }
  end

  # POST the announcement of +domain+ signed with +key+.
  #
  # @return [Rack::MockResponse] the response.
  def announce(domain, key = FederationFakePeers::KEYS[domain], **overrides)
    post "/api/instances", JSON.generate(FederationFakePeers.payload(domain, key, **overrides)), json_headers
    last_response
  end

  # Captured log lines with +message+.
  #
  # @param message [String] log message.
  # @return [Array<Array(Symbol, String, Hash)>] level, message and metadata.
  def log_lines(message)
    logs.select { |line| line[1] == message }
  end

  # Run the block with +vars+ set in ENV, restoring the previous values.
  #
  # @param vars [Hash{String => String}] variables to set.
  # @return [Object] the block's result.
  def with_env(vars)
    previous = vars.to_h { |name, _| [name, ENV.fetch(name, nil)] }
    vars.each { |name, value| ENV[name] = value }
    yield
  ensure
    previous.each { |name, value| value.nil? ? ENV.delete(name) : ENV[name] = value }
  end

  # @return [Float] monotonic clock reading in seconds.
  def monotonic
    Process.clock_gettime(Process::CLOCK_MONOTONIC)
  end

  # Run the block with +Time.now+ moved +seconds+ ahead.
  #
  # @param seconds [Numeric] offset.
  # @return [Object] the block's result.
  def travel(seconds)
    allow(Time).to receive(:now).and_wrap_original { |original, *args| original.call(*args) + seconds }
    yield
  ensure
    allow(Time).to receive(:now).and_call_original
  end

  before do
    # The examples run federation, so they also pass under FEDERATION=0.
    allow(PotatoMesh::Config).to receive(:federation_enabled?).and_return(true)
    # Anything that tries to resolve or connect fails loudly.
    allow(Addrinfo).to receive(:getaddrinfo).and_raise(SocketError, "spec: DNS disabled")
    allow(TCPSocket).to receive(:open).and_raise(SocketError, "spec: sockets disabled")
    allow(TCPSocket).to receive(:new).and_raise(SocketError, "spec: sockets disabled")
    allow(Socket).to receive(:tcp).and_raise(SocketError, "spec: sockets disabled")

    application = FederationFakePeers::APP
    fake = fed
    allow(application).to receive(:resolve_remote_ip_addresses).and_return([])
    allow_any_instance_of(application).to receive(:resolve_remote_ip_addresses).and_return([])
    allow(application).to receive(:build_remote_http_client) { |uri, ip_address: nil| FederationFakePeers::FakeHTTP.new(uri, fake) }
    allow_any_instance_of(application).to receive(:build_remote_http_client) do |_app, uri, ip_address: nil|
      FederationFakePeers::FakeHTTP.new(uri, fake)
    end

    inline_pool = pool
    allow(application).to receive(:federation_worker_pool) { inline_pool }

    captured = logs
    %i[warn_log info_log debug_log].each do |level|
      allow(application).to receive(level) { |message, **meta| captured << [level, message, meta] }
      allow_any_instance_of(application).to receive(level) { |_app, message, **meta| captured << [level, message, meta] }
    end

    application.clear_federation_shutdown_request!
    application.clear_federation_crawl_state!
    FileUtils.mkdir_p(File.dirname(PotatoMesh::Config.db_path))
    application.init_db unless application.db_schema_present?
    application.ensure_schema_upgrades
    with_db { |db| db.execute("DELETE FROM instances") }
    PotatoMesh::App::ApiCache.invalidate_all
  end
end
