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
require_relative "support/federation_fake_peers"

# What federation sends to its peers, through the app's real request code
# against a fake federation (SPEC FL1-FL8): a crawl fetches each peer host
# once, judges it on one node list and keeps the newest signed copy; a host is
# fetched at most once per cooldown and the announcer crawls on its timer; the
# client revalidates, honours Retry-After and backs off; a crawl has a request
# budget, a domain budget and a deadline; a registration is verified within a
# deadline and few at once; and the operator docs say so.
RSpec.describe "Federation crawl limits" do
  include_context "fake federation peers"

  let(:peers) { FederationFakePeers }
  let(:application) { FederationFakePeers::APP }
  let(:root) { "root.fed.invalid" }
  let(:a) { "a.fed.invalid" }
  let(:b) { "b.fed.invalid" }
  let(:x) { "x.fed.invalid" }
  let(:victim) { "victim.fed.invalid" }
  let(:hostile) { "hostile.fed.invalid" }
  # A record's four node counts, all absent.
  let(:no_counts) { { nodes_count: nil, meshcore_nodes_count: nil, meshtastic_nodes_count: nil, reticulum_nodes_count: nil } }

  # The stored row for +domain+.
  #
  # @param domain [String] instance domain.
  # @return [Array, nil] name, last update time and the four counts.
  def stored_row(domain)
    with_db do |db|
      db.get_first_row(
        "SELECT name, last_update_time, nodes_count, meshcore_nodes_count, meshtastic_nodes_count, " \
        "reticulum_nodes_count FROM instances WHERE domain = ?",
        domain,
      )
    end
  end

  describe "a crawl fetches each peer once (FL1)" do
    it "fetches a peer listed in two walked lists once" do
      fed.lists[root] = [peers.record(a), peers.record(b)]
      fed.lists[a] = [peers.record(x)]
      fed.lists[b] = [peers.record(x)]

      crawl(root)

      expect(fed.counts(x)).to eq(instances: 1, well_known: 1, nodes_acceptance: 1)
    end

    it "fetches a peer listed 64 times in one list once and stores it once" do
      fed.lists[hostile] = Array.new(64) { peers.record(victim) }

      crawl(hostile)

      expect(fed.counts(victim)).to eq(instances: 1, well_known: 1, nodes_acceptance: 1)
      expect(stored_rows.map(&:first)).to eq([victim])
    end

    it "never fetches its own domain" do
      attributes, signature = application.ensure_self_instance_record!
      own = JSON.parse(JSON.generate(application.instance_announcement_payload(attributes, signature)))
      fed.lists[root] = [peers.record(root), own]

      crawl(root)

      expect(fed.total(attributes[:domain])).to eq(0)
      expect(fed.counts(root)).to eq(instances: 1, well_known: 1, nodes_acceptance: 1)
    end

    it "keeps the newest signed copy of an instance and never rolls a stored row back" do
      now = Time.now.to_i
      with_db { |db| peers.store(db, x, name: "Stored", last_update_time: now - 60) }
      fed.lists[root] = [
        peers.record(x, name: "Older", last_update_time: now - (8 * 86_400)),
        peers.record(x, name: "Newest", last_update_time: now),
        peers.record(x, name: "Middle", last_update_time: now - 30),
      ]

      crawl(root)

      expect(stored_row(x).first(2)).to eq(["Newest", now])
    end

    it "keeps listing a stored instance when an older copy of its record is relayed" do
      with_db { |db| peers.store(db, victim, name: "Current") }
      fed.lists[hostile] = [peers.record(victim, name: "Old", last_update_time: Time.now.to_i - (8 * 86_400))]

      crawl(hostile)
      get "/api/instances"

      expect(stored_row(victim).first).to eq("Current")
      expect(JSON.parse(last_response.body).map { |row| row["domain"] }).to include(victim)
    end

    it "keeps a newer copy stored while the crawl fetched a record's counts" do
      now = Time.now.to_i
      fed.lists[root] = [peers.record(x, **no_counts, name: "Relayed", last_update_time: now - 30)]
      fed.hooks << lambda do |entry|
        next unless entry[:host] == x && entry[:kind] == :stats

        with_db { |db| peers.store(db, x, name: "Stored meanwhile", last_update_time: now) }
      end

      crawl(root)

      expect(stored_row(x).first(2)).to eq(["Stored meanwhile", now])
      expect(fed.counts(x)).to include(stats: 1)
    end

    it "costs a host one well-known fetch for 64 port variants in one list" do
      attacker_key = peers::KEYS["attacker-key"]
      fed.lists[hostile] = (1..64).map { |port| peers.record("#{victim}:#{port}", attacker_key) }

      crawl(hostile)

      expect(fed.counts(victim)).to eq(well_known: 1)
      reasons = log_lines("Discarded remote instance entry").map { |line| line[2][:reason] }
      expect(reasons.count { |reason| reason.include?("fetched another port variant's well-known in this crawl") }).to eq(63)
    end

    it "lets the bare domain of a host fetch its own well-known beside the port variants" do
      attacker_key = peers::KEYS["attacker-key"]
      fed.lists[hostile] = (1..63).map { |port| peers.record("#{victim}:#{port}", attacker_key) } + [peers.record(victim)]

      crawl(hostile)

      expect(fed.counts(victim)).to eq(instances: 1, well_known: 2, nodes_acceptance: 1)
      expect(stored_rows.map(&:first)).to eq([victim])
    end

    it "treats a default port as the bare domain" do
      now = Time.now.to_i
      fed.lists[root] = [
        peers.record("#{x}:443", peers::KEYS[x], last_update_time: now),
        peers.record(x, last_update_time: now - 10),
        peers.record("spec.mesh.test:443"),
      ]

      crawl(root)

      expect(fed.counts(x)).to eq(instances: 1, well_known: 1, nodes_acceptance: 1)
      expect(stored_rows.map(&:first)).to eq(["#{x}:443"])
      expect(log_lines("Skipped remote instance entry").map { |line| line[2][:reason] }).to include("own instance")
    end

    it "counts fetched domains against FEDERATION_MAX_DOMAINS_PER_CRAWL" do
      quiet = %w[q1 q2 q3 q4].map { |name| "#{name}.fed.invalid" }
      fed.lists[root] = quiet.map { |domain| peers.record(domain) }
      quiet.each { |domain| fed.nodes[domain] = peers.fresh_nodes(10, newest_age: 8 * 86_400) }

      with_env("FEDERATION_MAX_DOMAINS_PER_CRAWL" => "3") { crawl(root) }

      expect(fed.log.map { |entry| entry[:host] }.uniq).to eq([root, quiet[0], quiet[1]])
    end
  end

  describe "one node list per peer (FL2)" do
    it "judges a crawled peer on one /api/nodes?limit=10 request" do
      fed.lists[root] = [peers.record(x)]

      crawl(root)

      expect(fed.paths(x, prefix: "/api/nodes")).to eq(["/api/nodes?limit=10"])
    end

    it "judges an announcing peer on one /api/nodes?limit=10 request" do
      fed.lists[a] = [peers.record(a)]

      expect(announce(a).status).to eq(201)

      expect(fed.paths(a, prefix: "/api/nodes")).to eq(["/api/nodes?limit=10"])
    end

    it "stores the signed counts of a record that carries them without asking the peer" do
      fed.lists[root] = [peers.record(x)]
      fed.stats[x] = { "total" => { "nodes" => { "day" => 99 } }, "meshtastic" => { "nodes" => { "day" => 77 } } }
      fed.nodes[x] = peers.fresh_nodes(50)

      crawl(root)

      expect(stored_row(x).last(4)).to eq([12, 4, 8, 0])
      expect(fed.counts(x).keys).to contain_exactly(:instances, :well_known, :nodes_acceptance)
    end

    it "asks /api/stats, then the 24-hour list, only for a record without counts" do
      fed.lists[root] = [peers.record(a, **no_counts), peers.record(b, **no_counts)]
      fed.stats[a] = {
        "total" => { "nodes" => { "hour" => 1, "day" => 7, "week" => 9 } },
        "meshcore" => { "nodes" => { "day" => 3 } },
        "meshtastic" => { "nodes" => { "day" => 4 } },
        "reticulum" => { "nodes" => { "day" => 0 } },
      }
      fed.status[[b, :stats]] = 500
      fed.nodes[b] = peers.fresh_nodes(6, protocol: "meshcore") +
                     peers.fresh_nodes(6, newest_age: 2 * 86_400, offset: 100)

      crawl(root)

      expect(stored_row(a).last(4)).to eq([7, 3, 4, 0])
      expect(fed.counts(a)).to eq(instances: 1, well_known: 1, stats: 1, nodes_acceptance: 1)
      expect(stored_row(b).last(4)).to eq([6, 6, 0, 0])
      expect(fed.counts(b)).to eq(instances: 1, well_known: 1, stats: 1, nodes_acceptance: 1, nodes_24h: 1)
    end

    it "keeps a peer heard 2 days ago and refuses one heard 8 days ago on that one list" do
      fed.lists[root] = [peers.record(a), peers.record(b)]
      fed.nodes[a] = peers.fresh_nodes(10, newest_age: 2 * 86_400)
      fed.nodes[b] = peers.fresh_nodes(10, newest_age: 8 * 86_400)

      crawl(root)

      expect(stored_rows.map(&:first)).to eq([a])
      expect(log_lines("Discarded remote instance entry").map { |line| line[2] }).to include(
        hash_including(domain: b, reason: "insufficient nodes"),
      )
    end
  end

  describe "one fetch per peer per cooldown, crawls on the timer (FL3)" do
    it "verifies an announcing peer and schedules no crawl" do
      fed.lists[a] = [peers.record(a), peers.record(x)]

      expect(announce(a).status).to eq(201)

      expect(pool.scheduled).to eq(0)
      expect(fed.counts(a)).to eq(well_known: 1, nodes_acceptance: 1)
      expect(fed.total(x)).to eq(0)
    end

    it "skips a crawl entry for a peer fetched inside the cooldown and keeps its stored row" do
      now = Time.now.to_i
      expect(announce(x, last_update_time: now - 60).status).to eq(201)
      fed.log.clear
      fed.lists[root] = [peers.record(x, name: "Relayed copy", last_update_time: now)]

      crawl(root)

      expect(fed.total(x)).to eq(0)
      expect(stored_row(x).first(2)).to eq(["Mesh #{x}", now - 60])
    end

    it "fetches a peer once across two crawls inside the cooldown" do
      fed.lists[root] = [peers.record(x)]

      2.times { crawl(root) }

      expect(fed.counts(x)).to eq(instances: 1, well_known: 1, nodes_acceptance: 1)
      expect(fed.counts(root)).to eq(instances: 1)
    end

    it "answers a re-announcement under the stored key inside the cooldown from the stored row" do
      payload = JSON.generate(peers.payload(a))

      statuses = Array.new(3) { post("/api/instances", payload, json_headers).status }

      expect(statuses).to eq([201, 201, 201])
      expect(fed.counts(a)).to eq(well_known: 1, nodes_acceptance: 1)
    end

    it "stores a newer copy under the stored key inside the cooldown without a fetch and ignores an older one" do
      now = Time.now.to_i
      expect(announce(a, last_update_time: now - 60).status).to eq(201)

      newer = announce(a, name: "Renamed", last_update_time: now)
      after_newer = stored_row(a).first(2)
      older = announce(a, name: "Old copy", last_update_time: now - 120)

      expect([newer.status, older.status]).to eq([201, 201])
      expect(after_newer).to eq(["Renamed", now])
      expect(stored_row(a).first(2)).to eq(["Renamed", now])
      expect(fed.counts(a)).to eq(well_known: 1, nodes_acceptance: 1)
    end

    it "answers 503 with Retry-After to a registration inside a cooldown that kept nothing to judge it by" do
      fed.lists[root] = []
      crawl(root)

      response = announce(root)

      expect(response.status).to eq(503)
      expect(response.headers["Retry-After"]).to match(/\A\d+\z/)
      expect(response.headers["Retry-After"].to_i).to be_between(1, 900)
      expect(fed.counts(root)).to eq(instances: 1)
    end

    it "crawls from the announcer thread once per announcement interval" do
      announcements = 0
      roots = []
      allow(PotatoMesh::Config).to receive(:federation_announcement_interval).and_return(0.05)
      allow(application).to receive(:announce_instance_to_all_domains) { announcements += 1 }
      allow(application).to receive(:ingest_known_instances_from!) { |_db, domain, **| roots << domain }

      thread = application.start_federation_announcer!
      deadline = monotonic + 3
      sleep 0.05 until (announcements >= 3 && roots.size >= 3) || monotonic > deadline
      application.shutdown_federation_background_work!(timeout: 1)

      expect(thread.alive?).to be(false)
      expect(announcements).to be >= 3
      expect(roots).to include(*PotatoMesh::Config.federation_seed_domains)
    end
  end

  describe "revalidation, Retry-After and backoff (FL4)" do
    it "revalidates with If-None-Match and reuses the stored body on 304" do
      fed.lists[x] = [peers.record(a)]
      fed.headers[[x, :instances]] = { "ETag" => 'W/"abc123"' }

      first, = application.fetch_instance_json(x, "/api/instances")
      second, = application.fetch_instance_json(x, "/api/instances")

      expect(fed.log.last[:headers]).to include("if-none-match" => 'W/"abc123"')
      expect(fed.log.last[:status]).to eq(304)
      expect(second).to eq(first)
    end

    it "revalidates the well-known with If-Modified-Since and never skips a fetch for max-age" do
      modified = "Tue, 06 Oct 2026 10:00:00 GMT"
      fed.headers[[x, :well_known]] = { "Last-Modified" => modified, "Cache-Control" => "public, max-age=86400" }

      first, = application.fetch_instance_json(x, "/.well-known/potato-mesh")
      second, = application.fetch_instance_json(x, "/.well-known/potato-mesh")

      expect(fed.total(x)).to eq(2)
      expect(fed.log.last[:headers]).to include("if-modified-since" => modified)
      expect(second).to eq(first)
    end

    it "sends no request to a host inside the Retry-After of its 429" do
      fed.status[[x, :stats]] = 429
      fed.headers[[x, :stats]] = { "Retry-After" => "600" }

      application.fetch_instance_json(x, "/api/stats")
      payload, = application.fetch_instance_json(x, "/api/nodes?limit=10")

      expect(fed.total(x)).to eq(1)
      expect(payload).to be_nil
    end

    it "does not back a peer off for a request this instance's own deadline kept from being sent" do
      payload, errors = application.with_federation_deadline(0) { application.fetch_instance_json(x, "/api/instances") }

      expect(payload).to be_nil
      expect(errors).to eq(["https://#{x}/api/instances: verification deadline passed"])
      expect(fed.total(x)).to eq(0)
      expect(PotatoMesh::App::Federation.peer_backoff.backoff_seconds(x)).to eq(0.0)
    end

    it "backs off a failing host and doubles the wait after the next failure" do
      fed.refused << x

      3.times { application.fetch_instance_json(x, "/api/instances") }
      first_failure = fed.total(x)
      travel(61) { application.fetch_instance_json(x, "/api/instances") }
      second_failure = fed.total(x)
      travel(61 + 119) { application.fetch_instance_json(x, "/api/instances") }

      expect([first_failure, second_failure, fed.total(x)]).to eq([2, 4, 4])
    end
  end

  describe "request budget, domain budget and deadline (FL6)" do
    it "stops a crawl cleanly once FEDERATION_MAX_REQUESTS_PER_CRAWL requests are spent" do
      domains = (1..10).map { |i| "p#{i}.fed.invalid" }
      fed.lists[root] = domains.map { |domain| peers.record(domain) }

      with_env("FEDERATION_MAX_REQUESTS_PER_CRAWL" => "7") { crawl(root) }

      expect(fed.total).to eq(7)
      expect(stored_rows.map(&:first)).to eq(domains.first(2))
    end

    it "stops a crawl at its deadline, FEDERATION_TASK_TIMEOUT" do
      domains = (1..6).map { |i| "slow#{i}.fed.invalid" }
      fed.lists[root] = domains.map { |domain| peers.record(domain) }
      fed.hooks << ->(entry) { sleep 0.25 if entry[:host].start_with?("slow") }

      started = monotonic
      with_env("FEDERATION_TASK_TIMEOUT" => "1") { crawl(root) }
      elapsed = monotonic - started

      expect(elapsed).to be < 1.6
      expect(stored_rows.size).to be < domains.size
    end

    it "lets the worker pool's task timeout end a crawl" do
      fed.lists[hostile] = %w[p1 p2 p3 p4].map { |name| peers.record("#{name}.fed.invalid") }
      first = true
      fed.hooks << lambda do |_entry|
        if first
          first = false
          sleep 0.6
        end
      end
      worker_pool = PotatoMesh::App::WorkerPool.new(size: 1, max_queue: 2, task_timeout: 0.3, name: "spec-fl6")

      task = worker_pool.schedule { crawl(hostile) }
      outcome = begin
          task.wait(timeout: 5)
          :completed
        rescue PotatoMesh::App::WorkerPool::TaskTimeoutError
          :timed_out
        ensure
          worker_pool.shutdown(timeout: 1, force_kill_after: 1)
        end

      expect(outcome).to eq(:timed_out)
      expect(fed.total).to eq(1)
    end

    it "fetches an unreachable host once per crawl, however often it is listed" do
      with_db { |db| peers.store(db, x) }
      fed.lists[root] = [peers.record(a), peers.record(x)]
      fed.lists[a] = [peers.record(x)]
      fed.refused << x

      crawl(root)

      expect(fed.total(x)).to eq(2)
    end

    it "judges a forged and a genuine copy of a new domain against one well-known fetch" do
      genuine_key = peers::KEYS[victim]
      fed.lists[hostile] = [peers.record(victim, peers::KEYS["attacker-key"], name: "Forged"), peers.record(victim)]

      crawl(hostile)

      expect(stored_rows.map { |row| row.first(2) }).to eq([[victim, genuine_key.public_key.to_pem]])
      expect(fed.counts(victim)[:well_known]).to eq(1)
    end
  end

  describe "bounded registration verification (FL7)" do
    # Time the block.
    #
    # @return [Array(Object, Float)] the block's result and the seconds it took.
    def timed
      started = monotonic
      result = yield
      [result, monotonic - started]
    end

    it "ends a registration naming a peer that never answers within REMOTE_INSTANCE_REQUEST_TIMEOUT" do
      fed.hooks << ->(entry) { sleep 5 if entry[:host] == a }

      response, elapsed = with_env("REMOTE_INSTANCE_REQUEST_TIMEOUT" => "1") { timed { announce(a) } }

      expect(response.status).to eq(400)
      expect(JSON.parse(response.body)).to eq("error" => "failed to verify well-known document")
      expect(elapsed).to be < 1.6
    end

    it "ends a registration whose node list stalls after its well-known answered within the same deadline" do
      fed.hooks << ->(entry) { sleep(entry[:kind] == :well_known ? 0.4 : 5) if entry[:host] == a }

      response, elapsed = with_env("REMOTE_INSTANCE_REQUEST_TIMEOUT" => "1") { timed { announce(a) } }

      expect(response.status).to eq(400)
      expect(JSON.parse(response.body)).to eq("error" => "failed to fetch nodes")
      expect(elapsed).to be < 1.6
    end

    it "caps the verifications in flight and answers 503 with Retry-After when they are full" do
      slow = (1..8).map { |i| "slow#{i}.fed.invalid" }
      payloads = slow.to_h { |domain| [domain, JSON.generate(peers.payload(domain))] }
      fed.hooks << ->(entry) { sleep 0.5 if entry[:host].start_with?("slow") }

      responses = slow.map do |domain|
        Thread.new { Rack::MockRequest.new(app).post("/api/instances", input: payloads[domain], "CONTENT_TYPE" => "application/json") }
      end.map(&:value)

      expect(fed.max_in_flight).to be <= 4
      expect(responses.map(&:status).tally).to eq(201 => 4, 503 => 4)
      expect(responses.select { |response| response.status == 503 }.map { |response| response.headers["Retry-After"] }).to all(match(/\A\d+\z/))
    end

    it "answers 201 only once the announcer is verified and stored" do
      response = announce(a)

      expect(response.status).to eq(201)
      expect(JSON.parse(response.body)).to eq("status" => "registered")
      expect(stored_rows.map(&:first)).to eq([a])
    end
  end

  describe "crawl and registration edge cases" do
    let(:store) { PotatoMesh::App::Federation.peer_backoff }

    # Reasons of the captured "Skipped remote instance entry" lines.
    #
    # @return [Array<String>] skip reasons.
    def skip_reasons
      log_lines("Skipped remote instance entry").map { |line| line[2][:reason] }
    end

    it "visits one domain per host and skips another domain on it" do
      fed.lists[root] = [peers.record(x), peers.record("#{x}:8443")]

      crawl(root)

      expect(skip_reasons).to include("host already fetched in this crawl for #{x}")
      expect(fed.counts(x)).to eq(instances: 1, well_known: 1, nodes_acceptance: 1)
    end

    it "skips a peer that backs off and keeps its stored row" do
      with_db { |db| peers.store(db, x, name: "Stored") }
      store.record_failure(x)
      fed.lists[root] = [peers.record(x, name: "Relayed")]

      crawl(root)

      expect(skip_reasons).to eq(["peer backoff"])
      expect(fed.total(x)).to eq(0)
      expect(stored_row(x).first).to eq("Stored")
    end

    it "discards a record whose host another crawl or a registration claimed meanwhile" do
      allow(store).to receive(:claim).and_wrap_original do |original, host, **options|
        host == x ? 30.0 : original.call(host, **options)
      end
      fed.lists[root] = [peers.record(x)]

      crawl(root)

      expect(fed.total(x)).to eq(0)
      expect(log_lines("Discarded remote instance entry").map { |line| line[2][:reason] }).to eq(
        ["unconfirmed new domain: #{x}: peer fetch cooldown, 30 s left"],
      )
    end

    it "fills only the counts a record lacks from the 24-hour list" do
      fed.lists[root] = [peers.record(a, **no_counts, meshcore_nodes_count: 5)]
      fed.status[[a, :stats]] = 500
      fed.nodes[a] = peers.fresh_nodes(10, protocol: "meshtastic")

      crawl(root)

      expect(stored_row(a).last(4)).to eq([10, 5, 10, 0])
    end

    it "returns the crawl untouched for a domain that does not sanitize" do
      result = with_db { |db| application.ingest_known_instances_from!(db, "bad domain") }

      expect(result).to be_a(PotatoMesh::App::Federation::CrawlState)
      expect(fed.total).to eq(0)
    end

    it "stops walking a list once shutdown is requested" do
      fed.lists[root] = [peers.record(a), peers.record(b)]
      fed.hooks << ->(entry) { application.request_federation_shutdown! if entry[:host] == root }

      crawl(root)

      expect(fed.total).to eq(1)
    ensure
      application.clear_federation_shutdown_request!
    end

    it "crawls every seed and known peer under one state, stopping at its budget" do
      crawl = with_env("FEDERATION_MAX_REQUESTS_PER_CRAWL" => "1") { application.crawl_federation! }

      expect(crawl.requests).to eq(1)
      expect(log_lines("Federation crawl complete").map { |line| line[2] }).to eq(
        [{
          context: "federation.instances", root_count: PotatoMesh::Config.federation_seed_domains.size,
          domain_count: 1, request_count: 1, stop_reason: "request budget spent",
        }],
      )
    end

    it "raises from a crawl whose database does not open" do
      allow(application).to receive(:open_database).and_call_original
      allow(application).to receive(:open_database).with(no_args).and_raise(SQLite3::CantOpenException, "spec: no db")

      expect { application.crawl_federation! }.to raise_error(SQLite3::CantOpenException)
    end

    it "answers 503 when another registration claims the host between the check and the claim" do
      allow(store).to receive(:claim).and_return(42.0)

      response = announce(a)

      expect(response.status).to eq(503)
      expect(response.headers["Retry-After"]).to eq("42")
      expect(fed.total(a)).to eq(0)
    end

    it "rejects a registration whose node list fetch returns nothing" do
      allow_any_instance_of(application).to receive(:fetch_instance_json).and_wrap_original do |original, domain, path|
        path.start_with?("/api/nodes") ? [nil, []] : original.call(domain, path)
      end

      response = announce(a)

      expect(response.status).to eq(400)
      expect(log_lines("Instance registration rejected").map { |line| line[2] }).to include(
        hash_including(reason: "failed to fetch nodes", details: "no response"),
      )
    end

    it "returns no payload and records no outcome when a request yields no body" do
      allow(application).to receive(:perform_instance_http_request).and_return(nil)

      expect(application.fetch_instance_json(x, "/api/instances")).to eq([nil, []])
      expect(store.backoff_seconds(x)).to eq(0.0)
    end
  end

  describe "operator docs (FL8)" do
    let(:repository_root) { File.expand_path("../..", __dir__) }
    let(:readme) { File.read(File.join(repository_root, "README.md")) }
    let(:nginx) { File.read(File.join(repository_root, "deploy/nginx.example.conf")) }

    # The README's Federation section.
    #
    # @return [String] the section body.
    def federation_section
      readme[/^### Federation\n(.*?)^### /m, 1].to_s
    end

    # The Advanced tuning table row of +name+.
    #
    # @param name [String] environment variable.
    # @return [String, nil] the row, nil when the table has none.
    def tuning_row(name)
      readme.lines.find { |line| line.start_with?("| `#{name}` |") }
    end

    it "states the crawl after boot and every 8 hours" do
      expect(federation_section).to include("crawl peers after boot and every 8 hours")
      expect(PotatoMesh::Config.federation_announcement_interval).to eq(8 * 60 * 60)
    end

    it "names the User-Agent federation requests carry" do
      expect(federation_section).to include("`PotatoMesh/<version> (+https://<domain>)`")
      expect(application.federation_user_agent_header).to match(%r{\APotatoMesh/\S+ \(\+https://spec\.mesh\.test\)\z})
    end

    it "documents the fetch cooldown and the request budget with their defaults" do
      expect(tuning_row("FEDERATION_PEER_FETCH_COOLDOWN")).to include("| `900` |")
      expect(tuning_row("FEDERATION_MAX_REQUESTS_PER_CRAWL")).to include("| `1024` |")
    end

    it "says what the domain limit and the boot delay apply to" do
      expect(tuning_row("FEDERATION_MAX_DOMAINS_PER_CRAWL")).to include("peer domains one crawl fetches")
      expect(tuning_row("INITIAL_FEDERATION_DELAY_SECONDS")).to include("first announcement and crawl")
      expect(tuning_row("FEDERATION_CRAWL_COOLDOWN")).to be_nil
    end

    it "carries an optional limit_req block for the federation User-Agent in the nginx example" do
      expect(nginx).to match(/^# map \$http_user_agent \$potatomesh_peer \{$/)
      expect(nginx).to match(%r{^#\s+~\^PotatoMesh/\s+\$binary_remote_addr;$})
      expect(nginx).to match(/^# limit_req_zone \$potatomesh_peer zone=potatomesh_peers:/)
      expect(nginx).to match(/^# limit_req_status 429;$/)
      expect(nginx).to match(/^\s+# limit_req zone=potatomesh_peers /)
    end
  end
end
