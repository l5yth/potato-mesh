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

# The read path's cache keys and predicates (SPEC RC1-RC4, security and
# performance review): the bucketed endpoints serve canonical window/bucket
# pairs, every rx_time window searches its index, the response cache holds a
# bounded key set whose fixed entries no variant evicts, and a
# GET /api/instances miss only reads.
RSpec.describe "Read-path cache keys and predicates" do
  let(:app) { Sinatra::Application }
  let(:application_class) { PotatoMesh::Application }
  # A fixed clock 123 s past a bucket boundary of every canonical width.
  let(:reference_time) { Time.at(1_791_000_123) }
  let(:now) { reference_time.to_i }

  # Execute the block with a read-write connection to the spec database.
  #
  # @param readonly [Boolean] whether to open the database read-only.
  # @yieldparam db [SQLite3::Database] open handle.
  # @return [Object] the block's value.
  def with_db(readonly: false)
    db = SQLite3::Database.new(PotatoMesh::Config.db_path, readonly: readonly)
    db.busy_timeout = PotatoMesh::Config.db_busy_timeout_ms
    yield db
  ensure
    db&.close
  end

  # Empty every table the examples read.
  #
  # @return [void]
  def clear_tables
    with_db do |db|
      %w[instances trace_hops traces neighbors messages nodes positions telemetry ingestors ingestor_activity waypoints].each do |table|
        db.execute("DELETE FROM #{table}")
      end
    end
  end

  # GET +path+ and parse its JSON body.
  #
  # @param path [String] request path with query.
  # @return [Object] parsed body.
  def get_json(path)
    get path
    expect(last_response.status).to eq(200), "GET #{path} answered #{last_response.status}"
    JSON.parse(last_response.body)
  end

  # Store one telemetry reading straight in the database, past every cache.
  #
  # @param id [Integer] row id.
  # @param rx_time [Integer] receive time.
  # @param battery [Float] battery level.
  # @return [void]
  def insert_telemetry(id, rx_time, battery: 50.0)
    with_db do |db|
      db.execute(
        "INSERT INTO telemetry(id, node_id, rx_time, rx_iso, battery_level) VALUES(?,?,?,?,?)",
        [id, "!rc000001", rx_time, Time.at(rx_time).utc.iso8601, battery],
      )
    end
  end

  # Store one ingestor activity row straight in the database.
  #
  # @param at [Integer] activity timestamp.
  # @param packets [Integer] packets counted.
  # @return [void]
  def insert_activity(at, packets: 3600)
    with_db do |db|
      db.execute(
        "INSERT INTO ingestor_activity(ingestor_id, at, packets, protocol) VALUES (?,?,?,?)",
        ["!rc0000aa", at, packets, "meshtastic"],
      )
    end
  end

  # Store one node heard at +last_heard+ straight in the database.
  #
  # @param node_id [String] canonical node id.
  # @param num [Integer] node number.
  # @param last_heard [Integer] last heard time.
  # @return [void]
  def insert_node(node_id, num, last_heard)
    with_db do |db|
      db.execute(
        "INSERT INTO nodes(node_id, num, short_name, long_name, last_heard, first_heard) VALUES(?,?,?,?,?,?)",
        [node_id, num, "RC#{num % 100}", "Read cache #{num}", last_heard, last_heard],
      )
    end
  end

  # Count the SQL statements matching +pattern+ that the block issues.
  #
  # @param pattern [Regexp] statement pattern.
  # @yield the requests to count.
  # @return [Integer] matching statements executed.
  def count_statements(pattern)
    count = 0
    allow_any_instance_of(SQLite3::Database).to receive(:execute).and_wrap_original do |original, sql, *args, &block|
      count += 1 if sql.is_a?(String) && sql.match?(pattern)
      original.call(sql, *args, &block)
    end
    yield
    count
  end

  # The bucket widths of a series, from its +bucket_start+ and +bucket_end+.
  #
  # @param series [Array<Hash>] parsed buckets.
  # @return [Array<Integer>] distinct widths.
  def bucket_widths(series)
    series.map { |bucket| bucket["bucket_end"] - bucket["bucket_start"] }.uniq
  end

  before do
    allow(Time).to receive(:now).and_return(reference_time)
    ENV.delete("PRIVATE")
    clear_tables
    PotatoMesh::App::ApiCache.invalidate_all
  end

  after { PotatoMesh::App::ApiCache.invalidate_all }

  # Statement shapes of the two bucketed queries.
  TELEMETRY_BUCKETS_SQL = /AS sample_count/
  ACTIVITY_BUCKETS_SQL = /ingestor_total/

  describe "canonical windows of the bucketed endpoints (RC1)" do
    it "computes /api/telemetry/aggregated at most once per canonical pair for eleven distinct windows" do
      insert_telemetry(1, now - 120)
      windows = [3_600, 7_200, 43_200, 86_400, 172_800, 259_200, 345_601, 432_000, 604_800, 1_209_600, 2_419_200]
      computed = count_statements(TELEMETRY_BUCKETS_SQL) do
        windows.each { |window| get_json("/api/telemetry/aggregated?windowSeconds=#{window}&bucketSeconds=3600") }
      end
      # Two canonical pairs: 1 day in 5-minute and 7 days in 1-hour buckets.
      expect(computed).to be <= 2
    end

    it "computes /api/stats/activity at most once per canonical pair for eleven distinct windows" do
      insert_activity(now - 120)
      windows = [3_600, 7_200, 43_200, 86_400, 172_800, 259_200, 345_601, 432_000, 604_800, 1_209_600, 2_419_200]
      computed = count_statements(ACTIVITY_BUCKETS_SQL) do
        windows.each { |window| get_json("/api/stats/activity?window_seconds=#{window}&bucket_seconds=3600") }
      end
      # Two canonical pairs: 1 day in 1-hour and 7 days in 2-hour buckets.
      expect(computed).to be <= 2
    end

    it "serves a telemetry request the nearest canonical pair and reports its bucket" do
      insert_telemetry(1, now - 5 * 3600)
      insert_telemetry(2, now - 2 * 86_400)
      insert_telemetry(3, now - 120)

      # One hour in one-minute buckets: the 1-day pair, both readings of the day.
      day = get_json("/api/telemetry/aggregated?windowSeconds=3600&bucketSeconds=60")
      expect(day.map { |bucket| bucket["bucket_seconds"] }.uniq).to eq([300])
      expect(day.sum { |bucket| bucket["sample_count"] }).to eq(2)

      # 28 days in 1-day buckets: the 7-day pair, all three readings.
      week = get_json("/api/telemetry/aggregated?windowSeconds=2419200&bucketSeconds=86400")
      expect(week.map { |bucket| bucket["bucket_seconds"] }.uniq).to eq([3600])
      expect(week.sum { |bucket| bucket["sample_count"] }).to eq(3)

      # The window decides before the bucket: 7 days in 20-minute buckets is the 7-day pair.
      expect(get_json("/api/telemetry/aggregated?windowSeconds=604800&bucketSeconds=1200").map { |b| b["bucket_seconds"] }.uniq).to eq([3600])
      # One second past the midpoint of the two windows is nearer the week.
      expect(get_json("/api/telemetry/aggregated?windowSeconds=345601&bucketSeconds=600").map { |b| b["bucket_seconds"] }.uniq).to eq([3600])
      # Equally near both pairs in window and bucket: the shorter window.
      expect(get_json("/api/telemetry/aggregated?windowSeconds=345600&bucketSeconds=1950").map { |b| b["bucket_seconds"] }.uniq).to eq([300])
    end

    it "serves an activity request the nearest canonical pair" do
      insert_activity(now - 5 * 3600)
      insert_activity(now - 2 * 86_400)
      insert_activity(now - 120)

      day = get_json("/api/stats/activity?window_seconds=3600&bucket_seconds=600")
      expect(bucket_widths(day)).to eq([3600])
      expect(day.length).to eq(2)

      week = get_json("/api/stats/activity?window_seconds=2419200&bucket_seconds=86400")
      expect(bucket_widths(week)).to eq([7200])
      expect(week.length).to eq(3)

      expect(bucket_widths(get_json("/api/stats/activity?window_seconds=604800&bucket_seconds=3600"))).to eq([7200])
      expect(bucket_widths(get_json("/api/stats/activity?window_seconds=345600&bucket_seconds=5400"))).to eq([3600])
    end

    it "rounds a telemetry since down to its bucket and answers it from the canonical entry" do
      boundary = (now / 300) * 300 - 3000
      insert_telemetry(1, boundary + 10, battery: 80.0)

      computed = count_statements(TELEMETRY_BUCKETS_SQL) do
        get_json("/api/telemetry/aggregated?windowSeconds=86400&bucketSeconds=300")
        # A since inside the bucket keeps the whole bucket, the reading included.
        series = get_json("/api/telemetry/aggregated?windowSeconds=86400&bucketSeconds=300&since=#{boundary + 200}")
        expect(series.map { |bucket| bucket["bucket_start"] }).to eq([boundary])
        expect(series.first.dig("aggregates", "battery_level", "avg")).to eq(80.0)
        # The next bucket on is empty.
        expect(get_json("/api/telemetry/aggregated?windowSeconds=86400&bucketSeconds=300&since=#{boundary + 300}")).to eq([])
        20.times { |i| get_json("/api/telemetry/aggregated?windowSeconds=86400&bucketSeconds=300&since=#{now - 7200 + i * 37}") }
      end
      expect(computed).to eq(1)
    end

    it "rounds an activity since down to its bucket and answers it from the canonical entry" do
      boundary = (now / 3600) * 3600 - 7200
      insert_activity(boundary + 10)

      computed = count_statements(ACTIVITY_BUCKETS_SQL) do
        get_json("/api/stats/activity")
        series = get_json("/api/stats/activity?since=#{boundary + 1800}")
        expect(series.map { |bucket| bucket["bucket_start"] }).to eq([boundary])
        expect(get_json("/api/stats/activity?since=#{boundary + 3600}")).to eq([])
        20.times { |i| get_json("/api/stats/activity?since=#{now - 7200 + i * 37}") }
      end
      expect(computed).to eq(1)
    end

    it "answers a since at or before the window floor with the canonical body" do
      insert_telemetry(1, now - 120)
      insert_activity(now - 120)

      get "/api/telemetry/aggregated?windowSeconds=86400&bucketSeconds=300"
      body = last_response.body
      etag = last_response.headers["ETag"]
      get "/api/telemetry/aggregated?windowSeconds=86400&bucketSeconds=300&since=1"
      expect(last_response.body).to eq(body)
      expect(last_response.headers["ETag"]).to eq(etag)

      get "/api/stats/activity"
      activity = last_response.body
      get "/api/stats/activity?since=#{now - 86_400}"
      expect(last_response.body).to eq(activity)
    end

    it "serves a bucket too small for its window as the canonical pair" do
      insert_telemetry(1, now - 120)
      insert_activity(now - 120)

      expect(get_json("/api/telemetry/aggregated?windowSeconds=604800&bucketSeconds=300").map { |b| b["bucket_seconds"] }.uniq).to eq([3600])
      expect(get_json("/api/telemetry/aggregated?windowSeconds=86400&bucketSeconds=1").map { |b| b["bucket_seconds"] }.uniq).to eq([300])
      expect(bucket_widths(get_json("/api/stats/activity?window_seconds=86400&bucket_seconds=1"))).to eq([3600])
    end

    it "keeps answering a non-positive window or bucket with 400" do
      get "/api/telemetry/aggregated?windowSeconds=0&bucketSeconds=300"
      expect(last_response.status).to eq(400)
      get "/api/telemetry/aggregated?windowSeconds=86400&bucketSeconds=-300"
      expect(last_response.status).to eq(400)
      get "/api/stats/activity?window_seconds=-1&bucket_seconds=3600"
      expect(last_response.status).to eq(400)
      get "/api/stats/activity?window_seconds=86400&bucket_seconds=0"
      expect(last_response.status).to eq(400)
    end
  end

  describe "rx_time predicates (RC2)" do
    # Run the block, capture the first statement it issues against +table+
    # and return the detail lines of that statement's query plan.
    #
    # @param table [String] table the statement reads.
    # @yield the query helper call.
    # @return [Array<String>] EXPLAIN QUERY PLAN detail lines.
    def plan_for(table)
      captured = nil
      allow_any_instance_of(SQLite3::Database).to receive(:execute).and_wrap_original do |original, sql, *args, &block|
        captured ||= [sql, args.first] if sql.is_a?(String) && sql.match?(/FROM #{table}\b/)
        original.call(sql, *args, &block)
      end
      yield
      sql, binds = captured
      expect(sql).not_to be_nil, "no statement read #{table}"
      with_db(readonly: true) do |db|
        db.execute("EXPLAIN QUERY PLAN #{sql}", binds || []).map { |row| row[3] }
      end
    end

    # A plan reading +table+ through its rx_time index with +bounds+.
    #
    # @param table [String] table name.
    # @param bounds [String] the index constraint as EXPLAIN prints it.
    # @return [RSpec::Matchers::BuiltIn::Include] matcher.
    def search_rx_time(table, bounds)
      include(a_string_matching(/\ASEARCH (TABLE )?#{table} USING INDEX idx_#{table}_rx_time \(#{Regexp.escape(bounds)}\)/))
    end

    {
      "telemetry" => ->(before) { PotatoMesh::Application.query_telemetry(1000, before: before) },
      "positions" => ->(before) { PotatoMesh::Application.query_positions(1000, before: before) },
      "neighbors" => ->(before) { PotatoMesh::Application.query_neighbors(1000, before: before) },
      "traces" => ->(before) { PotatoMesh::Application.query_traces(1000, before: before) },
    }.each do |table, query|
      it "searches idx_#{table}_rx_time for the #{table} window" do
        plan = plan_for(table) { query.call(nil) }
        expect(plan).to search_rx_time(table, "rx_time>?")
        expect(plan.grep(/\ASCAN (TABLE )?#{table}\b/)).to eq([])
      end

      it "searches idx_#{table}_rx_time between the window floor and before" do
        plan = plan_for(table) { query.call(now - 60) }
        expect(plan).to search_rx_time(table, "rx_time>? AND rx_time<?")
      end
    end

    it "searches idx_telemetry_rx_time for the aggregated window" do
      plan = plan_for("telemetry") do
        PotatoMesh::Application.query_telemetry_buckets(window_seconds: 86_400, bucket_seconds: 300)
      end
      expect(plan).to search_rx_time("telemetry", "rx_time>?")
      expect(plan.grep(/\ASCAN (TABLE )?telemetry\b/)).to eq([])
    end
  end

  describe "bounded response cache keys (RC3)" do
    it "keeps /api/stats cached through 70 distinct /api/nodes limits" do
      insert_node("!rc0a0001", 0x0a0001, now - 60)
      cached = get_json("/api/stats")["total"]["nodes"]["day"]
      # Written past the ingest routes, so no invalidation: only a recompute shows it.
      insert_node("!rc0a0002", 0x0a0002, now - 60)

      70.times { |i| get_json("/api/nodes?limit=#{i + 1}") }

      expect(get_json("/api/stats")["total"]["nodes"]["day"]).to eq(cached)
    end

    it "keeps the fixed entries through more protocol variants than the cache holds" do
      insert_node("!rc0a0001", 0x0a0001, now - 60)
      stats = get_json("/api/stats")["total"]["nodes"]["day"]
      page = get_json("/api/nodes?limit=1000").length
      insert_node("!rc0a0002", 0x0a0002, now - 60)

      routes = %w[/api/nodes /api/positions /api/telemetry /api/neighbors /api/traces /api/ingestors /api/waypoints /api/messages]
      variants = routes.product(%w[meshcore meshtastic reticulum], [10, 200, 1000])
      expect(variants.length).to be > PotatoMesh::App::ApiCache::MAX_ENTRIES
      variants.each { |path, protocol, limit| get_json("#{path}?limit=#{limit}&protocol=#{protocol}") }

      expect(get_json("/api/stats")["total"]["nodes"]["day"]).to eq(stats)
      expect(get_json("/api/nodes?limit=1000").length).to eq(page)
    end

    it "serves a limit outside the cached set fresh and caches the limits the app requests" do
      insert_node("!rc0a0001", 0x0a0001, now - 60)
      expect(get_json("/api/nodes?limit=7").length).to eq(1)
      expect(get_json("/api/nodes?limit=10").length).to eq(1)
      insert_node("!rc0a0002", 0x0a0002, now - 60)

      expect(get_json("/api/nodes?limit=7").length).to eq(2)
      expect(get_json("/api/nodes?limit=10").length).to eq(1)
    end
  end

  describe "GET /api/instances reads only (RC4)" do
    # Two rows naming one domain in different forms, the older first, and
    # a self record an hour stale.
    #
    # @return [void]
    def seed_duplicates_and_stale_self!
      application_class.ensure_self_instance_record!
      with_db do |db|
        sql = "INSERT INTO instances (id, domain, pubkey, name, last_update_time, is_private, signature, last_verified_time) " \
              "VALUES (?, ?, ?, ?, ?, 0, ?, ?)"
        pem = OpenSSL::PKey::RSA.new(2048).public_key.export
        db.execute(sql, ["rc-dup-old", "rc-dup.example ", pem, "Old", now - 600, "sig-old", now - 600])
        db.execute(sql, ["rc-dup-new", "RC-Dup.Example", pem, "New", now - 60, "sig-new", now - 60])
        db.execute("UPDATE instances SET last_update_time = ? WHERE id = ?", [now - 3600, SELF_INSTANCE_ID])
      end
    end

    # Every stored instance row (id prefix, domain, name, last update,
    # signature prefix), ordered by id.
    #
    # @return [Array<Array>] rows.
    def instance_rows
      with_db(readonly: true) do |db|
        db.execute("SELECT substr(id, 1, 10), domain, name, last_update_time, substr(signature, 1, 8) FROM instances ORDER BY id")
      end
    end

    it "answers a cache miss without changing a stored row" do
      seed_duplicates_and_stale_self!
      before_rows = instance_rows

      ids = get_json("/api/instances").map { |entry| entry["id"] }

      expect(ids).to include(SELF_INSTANCE_ID, "rc-dup-new")
      expect(instance_rows).to eq(before_rows)
    end

    # Our own row as the last cycle left it, older than the 7-day window,
    # and one node heard at +last_heard+.
    #
    # @param last_heard [Integer] the node's last heard time.
    # @return [void]
    def stale_self_with_node!(last_heard)
      application_class.ensure_self_instance_record!
      with_db do |db|
        db.execute(
          "UPDATE instances SET last_update_time = ? WHERE id = ?",
          [now - PotatoMesh::Config.week_seconds - 3600, SELF_INSTANCE_ID],
        )
      end
      insert_node("!rc0b0001", 0x0b0001, last_heard)
    end

    it "lists our own row once a node is heard again, before the next cycle" do
      stale_self_with_node!(now - 60)
      before_rows = instance_rows

      ids = get_json("/api/instances").map { |entry| entry["id"] }

      expect(ids).to include(SELF_INSTANCE_ID)
      expect(instance_rows).to eq(before_rows)
    end

    it "leaves our own row out while its newest node is older than the window" do
      stale_self_with_node!(now - PotatoMesh::Config.week_seconds - 60)

      expect(get_json("/api/instances").map { |entry| entry["id"] }).not_to include(SELF_INSTANCE_ID)
    end

    it "deduplicates and refreshes the self record on the federation cycle" do
      seed_duplicates_and_stale_self!
      allow(application_class).to receive(:federation_target_domains).and_return([])

      application_class.announce_instance_to_all_domains

      rows = with_db(readonly: true) { |db| db.execute("SELECT id, domain, last_update_time FROM instances ORDER BY id") }
      expect(rows.map(&:first)).to contain_exactly("rc-dup-new", SELF_INSTANCE_ID)
      expect(rows.to_h { |id, domain, _| [id, domain] }["rc-dup-new"]).to eq("rc-dup.example")
      expect(rows.to_h { |id, _, updated| [id, updated] }[SELF_INSTANCE_ID]).to eq(now)
    end
  end

  describe "cost parameters from the query string only (RC6)" do
    # GET +path+ with a form-encoded body and parse the JSON answer.
    #
    # @param path [String] request path with query.
    # @param body [String] form-encoded request body.
    # @return [Object] parsed body.
    def get_json_with_form_body(path, body)
      get path, {}, { input: body, "CONTENT_TYPE" => "application/x-www-form-urlencoded" }
      expect(last_response.status).to eq(200), "GET #{path} with body #{body} answered #{last_response.status}"
      JSON.parse(last_response.body)
    end

    it "answers a GET whose form body carries since, before or limit as if the body were absent" do
      insert_node("!rc0c0001", 0x0c0001, now - 3600)
      insert_node("!rc0c0002", 0x0c0002, now - 10)
      # limit=7 is served uncached (RC3), so every answer is a fresh query.
      both = get_json("/api/nodes?limit=7").map { |node| node["node_id"] }.sort
      expect(both.length).to eq(2)

      ["since=#{now - 30}", "before=#{now - 30}", "limit=1"].each do |body|
        ids = get_json_with_form_body("/api/nodes?limit=7", body).map { |node| node["node_id"] }.sort
        expect(ids).to eq(both), "a body of #{body} changed the answer"
      end
    end

    it "takes the bucketed endpoints' window and bucket from the query string only" do
      insert_telemetry(1, now - 120)
      insert_activity(now - 120)

      series = get_json_with_form_body("/api/telemetry/aggregated", "windowSeconds=604800&bucketSeconds=3600")
      expect(series.map { |bucket| bucket["bucket_seconds"] }.uniq).to eq([300])
      activity = get_json_with_form_body("/api/stats/activity", "window_seconds=604800&bucket_seconds=7200")
      expect(bucket_widths(activity)).to eq([3600])
    end

    it "keeps a cached page cached when a form body carries since, before or limit" do
      insert_node("!rc0c0001", 0x0c0001, now - 60)
      expect(get_json("/api/nodes?limit=10").length).to eq(1)
      # Written past the ingest routes, so only a fresh query shows it.
      insert_node("!rc0c0002", 0x0c0002, now - 30)

      ["since=1", "before=#{now}", "limit=999"].each do |body|
        expect(get_json_with_form_body("/api/nodes?limit=10", body).length).to eq(1), "a body of #{body} bypassed the cache"
      end
    end
  end
end
