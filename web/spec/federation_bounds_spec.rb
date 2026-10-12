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
require "open3"
require_relative "support/federation_fake_peers"

# The bounds of the federation peer set (SPEC FB1-FB7), through the app's
# real federation code against the fake federation: a record signed more
# than an hour ahead is refused; freshness is judged on this instance's
# clock; at most 3 rows per registrable domain and 512 rows in all are
# kept, in one order that also caps the announce targets, the crawl roots
# and the GET /api/instances list; the announcer honours a peer's backoff
# and skips what a full queue refuses; and the crawl walks breadth first
# with a quota of new domains per relayer.
# The instances table as every version before SPEC FB2 created it.
LEGACY_INSTANCES_SCHEMA = <<~SQL
  CREATE TABLE instances (
    id TEXT PRIMARY KEY, domain TEXT NOT NULL, pubkey TEXT NOT NULL, name TEXT, version TEXT,
    channel TEXT, frequency TEXT, latitude REAL, longitude REAL, last_update_time INTEGER,
    is_private BOOLEAN NOT NULL DEFAULT 0, nodes_count INTEGER, meshcore_nodes_count INTEGER,
    meshtastic_nodes_count INTEGER, reticulum_nodes_count INTEGER, contact_link TEXT, signature TEXT
  );
  CREATE UNIQUE INDEX idx_instances_domain ON instances(domain);
SQL

RSpec.describe "Federation bounds" do
  include_context "fake federation peers"

  let(:peers) { FederationFakePeers }
  let(:application) { FederationFakePeers::APP }
  let(:federation) { PotatoMesh::App::Federation }
  let(:now) { Time.now.to_i }
  let(:day) { 86_400 }
  let(:root) { "root.fed.invalid" }
  let(:a) { "a.fed.invalid" }
  let(:b) { "b.fed.invalid" }
  let(:c) { "c.fed.invalid" }
  let(:d) { "d.fed.invalid" }
  let(:x) { "x.fed.invalid" }
  let(:seed) { "seed.invalid" }

  before do
    # The shared context lifts the caps and the quota for the FL and FK
    # examples; this file checks them at their values.
    stub_const("PotatoMesh::App::Federation::INSTANCE_ROW_LIMIT", 512)
    stub_const("PotatoMesh::App::Federation::REGISTRABLE_DOMAIN_ROW_LIMIT", 3)
    stub_const("PotatoMesh::App::Federation::RELAYER_NEW_DOMAIN_QUOTA", 8)
    allow(PotatoMesh::Config).to receive(:federation_seed_domains).and_return([seed])
  end

  # Run the block with +Time.now+ fixed at +seconds+.
  #
  # @param seconds [Integer] unix time.
  # @return [Object] the block's result.
  def at_time(seconds)
    allow(Time).to receive(:now).and_return(Time.at(seconds))
    yield
  ensure
    allow(Time).to receive(:now).and_call_original
  end

  # Domains of every stored row, sorted.
  #
  # @return [Array<String>] stored domains.
  def stored_domains
    stored_rows.map(&:first)
  end

  # Domains GET /api/instances lists, in the order it lists them.
  #
  # @return [Array<String>] listed domains.
  def listed_domains
    PotatoMesh::App::ApiCache.invalidate_all
    get "/api/instances"
    expect(last_response.status).to eq(200)
    JSON.parse(last_response.body).map { |row| row["domain"] }
  end

  # When this instance last verified the row of +domain+, and when the
  # instance last announced itself to it, by this instance's clock.
  #
  # @param domain [String] stored domain.
  # @return [Array(Integer, Integer)] the two times, nil where unset.
  def instance_times(domain)
    with_db do |db|
      db.get_first_row("SELECT last_verified_time, last_announced_time FROM instances WHERE domain = ?", domain)
    end
  end

  # The stored name of +domain+.
  #
  # @param domain [String] stored domain.
  # @return [String, nil] the name.
  def stored_name(domain)
    with_db { |db| db.get_first_value("SELECT name FROM instances WHERE domain = ?", domain) }
  end

  # Attributes of a row that the caps judge, with a placeholder key: the
  # write path stores without checking a signature.
  #
  # @param domain [String] row domain.
  # @return [Hash] instance attributes.
  def plain_attributes(domain)
    pem = "spec-pem-#{domain}"
    { id: Digest::SHA256.hexdigest(pem), domain: domain, pubkey: pem, name: "Row #{domain}", last_update_time: Time.now.to_i, is_private: false }
  end

  # Write the row of +domain+ through +upsert_instance_record+.
  #
  # @param db [SQLite3::Database] open database handle.
  # @param domain [String] row domain.
  # @param announced [Boolean] whether the write follows an announcement.
  # @return [void]
  def write_row(db, domain, announced: false)
    options = announced ? { announced: true } : {}
    application.upsert_instance_record(db, plain_attributes(domain), "spec-signature", **options)
  end

  # Insert the row of +domain+ directly, as an older version stored it and
  # the upgrade left it: first verified when it was last verified.
  #
  # @param db [SQLite3::Database] open database handle.
  # @param domain [String] row domain.
  # @param verified [Integer, nil] last verification time.
  # @return [void]
  def insert_row(db, domain, verified:)
    attributes = plain_attributes(domain)
    db.execute(
      "INSERT INTO instances (id, domain, pubkey, name, last_update_time, is_private, signature, last_verified_time, " \
      "first_verified_time) VALUES (?, ?, ?, ?, ?, 0, 'spec-signature', ?, ?)",
      [attributes[:id], domain, attributes[:pubkey], attributes[:name], now, verified, verified],
    )
  end

  # Stored rows per registrable domain.
  #
  # @return [Hash{String => Integer}] row counts.
  def rows_per_registrable_domain
    stored_domains.map { |domain| application.federation_registrable_domain(domain) }.tally
  end

  describe "a last_update ahead of this instance's clock (FB1)" do
    it "refuses an announcement signed more than an hour ahead before any request" do
      at_time(now) do
        response = announce(a, last_update_time: now + 3601)

        expect(response.status).to eq(400)
        expect(JSON.parse(response.body)).to eq("error" => "last_update in the future")
      end

      expect(fed.total(a)).to eq(0)
      expect(stored_rows).to eq([])
      expect(log_lines("Instance registration rejected").map(&:last)).to include(
        hash_including(context: "ingest.register", domain: a, reason: "last_update in the future"),
      )
    end

    it "accepts an announcement signed one hour ahead" do
      at_time(now) { expect(announce(a, last_update_time: now + 3600).status).to eq(201) }

      expect(stored_domains).to eq([a])
    end

    it "discards a crawled record signed more than an hour ahead before any request to its host" do
      fed.lists[root] = [peers.record(a, last_update_time: now + 3601), peers.record(b, last_update_time: now + 3600)]

      at_time(now) { crawl(root) }

      expect(fed.total(a)).to eq(0)
      expect(stored_domains).to eq([b])
      expect(log_lines("Discarded remote instance entry").map(&:last)).to include(
        hash_including(domain: a, reason: "last_update in the future", relayed_by: root),
      )
    end
  end

  describe "freshness on this instance's clock (FB2)" do
    it "stops listing and announcing to a row 7 days after it was verified, whatever its signed last_update says" do
      at_time(now) { with_db { |db| peers.store(db, a, last_update_time: now + (10 * 365 * day)) } }

      at_time(now + (8 * day)) do
        expect(listed_domains).not_to include(a)
        expect(application.federation_target_domains("spec.mesh.test")).not_to include(a)
      end
    end

    it "keeps listing a row a crawl verified again with a copy that is not newer" do
      at_time(now) { with_db { |db| peers.store(db, x, last_update_time: now - 60) } }
      fed.lists[root] = [peers.record(x, last_update_time: now - 60)]

      at_time(now + (6 * day)) { crawl(root) }

      expect(fed.counts(x)).to include(nodes_acceptance: 1)
      expect(instance_times(x)).to eq([now + (6 * day), nil])
      at_time(now + (8 * day)) { expect(listed_domains).to include(x) }
    end

    it "records when a peer announced itself and keeps that time across a crawl's write" do
      at_time(now) { expect(announce(a, last_update_time: now - 60).status).to eq(201) }
      expect(instance_times(a)).to eq([now, now])
      fed.lists[root] = [peers.record(a, name: "Relayed newer", last_update_time: now + 600)]

      at_time(now + 901) { crawl(root) }

      expect(stored_name(a)).to eq("Relayed newer")
      expect(instance_times(a)).to eq([now + 901, now])
    end

    it "refreshes the announcement time of a verified announcement whose copy another write made old" do
      at_time(now) { expect(announce(a, last_update_time: now - 120).status).to eq(201) }
      fed.hooks << lambda do |entry|
        next unless entry[:host] == a && entry[:kind] == :nodes_acceptance

        with_db { |db| peers.store(db, a, name: "Stored meanwhile", last_update_time: now + 1000) }
      end

      at_time(now + 901) { expect(announce(a, name: "Announced", last_update_time: now + 900).status).to eq(201) }

      expect(stored_name(a)).to eq("Stored meanwhile")
      expect(instance_times(a)).to eq([now + 901, now + 901])
    end

    it "upgrades an older database: the verification time from the stored update, none for a row ahead" do
      Dir.mktmpdir do |dir|
        path = File.join(dir, "legacy.db")
        SQLite3::Database.open(path) do |db|
          db.execute_batch(LEGACY_INSTANCES_SCHEMA)
          [["past", now - day], ["near", now + 1800], ["ahead", now + 7200], ["text", "soon"], ["none", nil]].each do |name, update|
            db.execute(
              "INSERT INTO instances (id, domain, pubkey, last_update_time, is_private) VALUES (?, ?, 'pem', ?, 0)",
              ["legacy-#{name}", "#{name}.legacy.invalid", update],
            )
          end
        end
        allow(PotatoMesh::Config).to receive(:db_path).and_return(path)

        at_time(now) { application.ensure_schema_upgrades }

        rows = SQLite3::Database.open(path) do |db|
          db.execute("SELECT id, last_verified_time, last_announced_time FROM instances ORDER BY id")
        end
        expect(rows).to eq(
          [
            ["legacy-ahead", nil, nil], ["legacy-near", now, nil], ["legacy-none", nil, nil],
            ["legacy-past", now - day, nil], ["legacy-text", nil, nil],
          ],
        )
      end
    end
  end

  describe "rows per registrable domain (FB3)" do
    it "names the registrable domain of a host by the public suffix list" do
      expect(application.federation_registrable_domain("a.b.example.co.uk")).to eq("example.co.uk")
      expect(application.federation_registrable_domain("Mesh.Example.org.:8443")).to eq("example.org")
      expect(application.federation_registrable_domain("x.fed.invalid")).to eq("fed.invalid")
      expect(application.federation_registrable_domain("foo.github.io")).to eq("foo.github.io")
      expect(application.federation_registrable_domain("a.xn--1lqs71d.jp")).to eq("a.xn--1lqs71d.jp")
      expect(application.federation_registrable_domain("mesh.東京.jp")).to eq("mesh.xn--1lqs71d.jp")
      expect(application.federation_registrable_domain("co.uk")).to be_nil
      expect(application.federation_registrable_domain("203.0.113.5:41447")).to be_nil
      expect(application.federation_registrable_domain("[2001:db8::1]:443")).to be_nil
    end

    it "keeps the three longest-standing of six subdomains of one registrable domain that announce themselves" do
      subdomains = (1..6).map { |i| "s#{i}.evil.invalid" }

      subdomains.each_with_index do |domain, index|
        at_time(now + (index * 10)) { expect(announce(domain).status).to eq(201) }
      end
      at_time(now + 70) { expect(announce("other.invalid").status).to eq(201) }

      expect(stored_domains).to eq((["other.invalid"] + subdomains.first(3)).sort)
    end

    it "keeps three rows of a registrable domain whose subdomains a crawl finds and asks nothing of the rest" do
      subdomains = (1..5).map { |i| "c#{i}.evil.invalid" }
      fed.lists[root] = subdomains.map { |domain| peers.record(domain) }

      crawl(root)

      expect(subdomains.map { |domain| fed.counts(domain).key?(:nodes_acceptance) }).to eq([true, true, true, false, false])
      expect(stored_domains).to eq(subdomains.first(3))
    end

    it "counts our own row and port variants in their registrable domain" do
      at_time(now) { application.ensure_self_instance_record! }
      with_db do |db|
        %w[a.mesh.test:8443 b.mesh.test c.mesh.test].each_with_index do |domain, index|
          at_time(now + 1 + index) { write_row(db, domain) }
        end
      end

      expect(stored_domains).to eq(%w[a.mesh.test:8443 b.mesh.test spec.mesh.test])
    end
  end

  describe "the total cap and the keep order (FB4)" do
    before do
      # With no node stored our own row is listed (SPEC RC4).
      with_db { |db| db.execute("DELETE FROM nodes") }
    end

    it "keeps at most 512 rows, a new row never evicting one known longer" do
      with_db do |db|
        520.times { |index| at_time(now - 520 + index) { write_row(db, "p#{index}.invalid") } }
      end

      expect(stored_rows.size).to eq(512)
      expect(stored_domains).not_to include(*(512..519).map { |index| "p#{index}.invalid" })
      expect(stored_domains).to include("p0.invalid", "p511.invalid")
    end

    it "keeps our own row and the seeds first, then the fresh peers longest-standing first, announced or crawled" do
      at_time(now) { application.ensure_self_instance_record! }
      with_db do |db|
        at_time(now - (9 * day)) { write_row(db, seed) }
        at_time(now - (6 * day)) { write_row(db, "ann6.invalid", announced: true) }
        at_time(now - (8 * day)) { write_row(db, "ann8.invalid", announced: true) }
        at_time(now - day) { write_row(db, "crawl1.invalid") }
        at_time(now - (2 * day)) { write_row(db, "crawl2.invalid") }
        # Announced after crawl1 was crawled: the newest fresh row.
        at_time(now - day + 3600) { write_row(db, "ann1.invalid", announced: true) }
        insert_row(db, "never.invalid", verified: nil)
      end
      stub_const("PotatoMesh::App::Federation::INSTANCE_ROW_LIMIT", 5)

      at_time(now) { application.enforce_instance_caps! }

      expect(stored_domains).to eq(%w[ann6.invalid crawl1.invalid crawl2.invalid seed.invalid spec.mesh.test])
      at_time(now) do
        expect(application.federation_target_domains("spec.mesh.test")).to eq(
          [seed, "ann6.invalid", "crawl2.invalid", "crawl1.invalid"],
        )
        expect(listed_domains).to eq(%w[spec.mesh.test ann6.invalid crawl2.invalid crawl1.invalid])
      end

      with_db { |db| at_time(now) { write_row(db, "fresh.invalid") } }

      expect(stored_domains).to eq(%w[ann6.invalid crawl1.invalid crawl2.invalid seed.invalid spec.mesh.test])
    end

    it "lists at most 512 rows in the keep order and writes nothing on a GET /api/instances miss" do
      at_time(now) { application.ensure_self_instance_record! }
      with_db { |db| 600.times { |index| insert_row(db, "r#{index}.invalid", verified: now - index) } }

      listed = at_time(now) { listed_domains }

      expect(listed.size).to eq(512)
      expect(listed.first(3)).to eq(%w[spec.mesh.test r599.invalid r598.invalid])
      expect(listed.last).to eq("r89.invalid")
      expect(stored_rows.size).to eq(601)
    end

    it "caps the announce targets and the crawl roots at 512 in the keep order" do
      with_db { |db| 600.times { |index| insert_row(db, "t#{index}.invalid", verified: now - index) } }

      targets = at_time(now) { application.federation_target_domains("spec.mesh.test") }

      expect(targets.size).to eq(512)
      expect(targets.first(2)).to eq([seed, "t599.invalid"])
      expect(targets.last).to eq("t89.invalid")
    end

    it "trims the table to the caps at each announcement cycle" do
      with_db do |db|
        600.times { |index| insert_row(db, "q#{index}.invalid", verified: now - index) }
        5.times { |index| insert_row(db, "w#{index}.wide.invalid", verified: now - 1000 - index) }
        insert_row(db, "203.0.113.9", verified: now)
      end
      allow(application).to receive(:federation_target_domains).and_return([])

      at_time(now) { application.announce_instance_to_all_domains }

      expect(stored_rows.size).to eq(512)
      expect(stored_domains.grep(/wide/)).to eq(%w[w2.wide.invalid w3.wide.invalid w4.wide.invalid])
      expect(stored_domains).to include("spec.mesh.test", "q599.invalid")
      expect(stored_domains).not_to include("q0.invalid", "203.0.113.9")
      expect(log_lines("Evicted instance records beyond the caps").map(&:last)).to eq(
        [{ context: "federation.instances", evicted: 94, unfederated_domain: 1, registrable_domain_limit: 2, total_limit: 91 }],
      )
    end

    it "keeps the order without seeds, skipping a seed that does not sanitize" do
      allow(PotatoMesh::Config).to receive(:federation_seed_domains).and_return(["bad seed"])
      with_db do |db|
        at_time(now - 60) { write_row(db, "older.invalid") }
        at_time(now) { write_row(db, "newer.invalid") }
      end

      expect(application.federation_seed_keys).to eq([])
      expect(at_time(now) { application.federation_target_domains("spec.mesh.test") }).to eq(%w[older.invalid newer.invalid])
    end

    it "logs and keeps every row when the caps cannot be held" do
      allow(application).to receive(:evict_instances_beyond_caps).and_raise(SQLite3::IOException, "spec: disk I/O error")
      with_db { |db| insert_row(db, "kept.invalid", verified: now) }

      application.enforce_instance_caps!

      expect(log_lines("Failed to evict instance records beyond the caps").map(&:last)).to eq(
        [{ context: "federation.instances", error_class: "SQLite3::IOException", error_message: "spec: disk I/O error" }],
      )
      expect(stored_domains).to eq(["kept.invalid"])
    end

    it "logs when the database does not open to hold the caps" do
      allow(application).to receive(:open_database).and_raise(SQLite3::CantOpenException, "spec: no db")

      application.enforce_instance_caps!

      expect(log_lines("Failed to evict instance records beyond the caps").map { |line| line.last[:error_class] }).to eq(
        ["SQLite3::CantOpenException"],
      )
    end

    it "trims the table to the caps at boot" do
      Dir.mktmpdir do |dir|
        env = {
          "XDG_CONFIG_HOME" => File.join(dir, "config"), "XDG_DATA_HOME" => File.join(dir, "data"),
          "FEDERATION" => "0", "RACK_ENV" => "test", "INSTANCE_DOMAIN" => "boot.mesh.test",
        }
        boot = lambda do
          Open3.capture3(env, RbConfig.ruby, "-e", 'require "./lib/potato_mesh/application"', chdir: File.expand_path("..", __dir__))
        end
        _stdout, stderr, status = boot.call
        expect(status.success?).to be(true), stderr
        path = File.join(dir, "data", "potato-mesh", "mesh.db")
        SQLite3::Database.open(path) do |db|
          db.execute("BEGIN")
          600.times { |index| insert_row(db, "boot#{index}.invalid", verified: now - index) }
          db.execute("COMMIT")
        end

        _stdout, stderr, status = boot.call

        expect(status.success?).to be(true), stderr
        count = SQLite3::Database.open(path) { |db| db.get_first_value("SELECT COUNT(*) FROM instances") }
        expect(count).to eq(512)
      end
    end
  end

  describe "the announcer (FB5)" do
    before do
      allow(application).to receive(:federation_target_domains).and_return([a, b])
    end

    it "sends nothing to a peer that backs off and announces to the others" do
      federation.peer_backoff.record_failure(a)

      application.announce_instance_to_all_domains

      expect(fed.total(a)).to eq(0)
      expect(fed.counts(b)).to eq(instances: 1)
      expect(log_lines("Skipped federation announcement").map(&:last)).to match(
        [hash_including(context: "federation.announce", domain: a, reason: "peer backoff", retry_in: be_between(1, 60))],
      )
      expect(log_lines("Federation announcement cycle complete").last.last).to include(
        target_count: 2, success_count: 1, failure_count: 0, skipped_count: 1,
      )
    end

    it "skips an announcement the full worker queue refuses instead of sending it on the announcer thread" do
      full = instance_double(PotatoMesh::App::WorkerPool)
      allow(full).to receive(:schedule).and_raise(PotatoMesh::App::WorkerPool::QueueFullError, "full")
      allow(application).to receive(:federation_worker_pool).and_return(full)

      application.announce_instance_to_all_domains

      expect(fed.total).to eq(0)
      expect(log_lines("Skipped federation announcement").map(&:last)).to eq(
        [a, b].map { |domain| { context: "federation.announce", domain: domain, reason: "worker queue saturated" } },
      )
      expect(log_lines("Federation announcement cycle complete").last.last).to include(skipped_count: 2)
    end

    it "documents that a task beyond the work queue is skipped" do
      readme = File.read(File.expand_path("../../README.md", __dir__))

      expect(readme.lines.find { |line| line.start_with?("| `FEDERATION_WORK_QUEUE` |") }).to eq(
        "| `FEDERATION_WORK_QUEUE` | `128` | Queued federation tasks; an announcement or crawl beyond them is skipped until the next cycle. |\n",
      )
    end
  end

  describe "breadth-first crawl with a relayer quota (FB6)" do
    it "walks every list of one level before the lists those name" do
      one, two, three, four = %w[aa.invalid bb.invalid cc.invalid dd.invalid]
      fed.lists[root] = [peers.record(one), peers.record(two)]
      fed.lists[one] = [peers.record(three)]
      fed.lists[two] = [peers.record(four)]

      crawl(root)

      expect(fed.log.select { |entry| entry[:kind] == :instances }.map { |entry| entry[:host] }).to eq([root, one, two, three, four])
    end

    it "verifies the genuine peers a list names after a deep chain of new domains" do
      chain = (1..12).map { |i| "chain#{i}.invalid" }
      genuine = %w[g1.invalid g2.invalid g3.invalid]
      fed.lists[root] = [peers.record(chain.first)] + genuine.map { |domain| peers.record(domain) }
      chain.each_cons(2) { |link, following| fed.lists[link] = [peers.record(following)] }

      with_env("FEDERATION_MAX_DOMAINS_PER_CRAWL" => "10") { crawl(root) }

      expect(stored_domains).to include(*genuine)
    end

    # The domains the crawl's rounds deferred, in order, each once.
    #
    # @return [Array<String>] deferred domains.
    def deferred_domains
      log_lines("Deferred remote instance entry").map { |line| line[2][:domain] }.uniq
    end

    # Index of the first request sent to +host+.
    #
    # @param host [String] peer host.
    # @return [Integer, nil] position in the request log.
    def first_request(host)
      fed.log.index { |entry| entry[:host] == host }
    end

    it "takes up 8 new domains of one relayer in a round and the rest before the lists those name" do
      news = (1..12).map { |i| "n#{i}.invalid" }
      at_time(now - 60) { with_db { |db| peers.store(db, "known.invalid") } }
      fed.lists[root] = news.map { |domain| peers.record(domain) } + [peers.record("known.invalid", name: "Refreshed")]
      fed.lists[news.first] = [peers.record("z1.invalid")]

      at_time(now) { crawl(root) }

      expect(news.select { |domain| fed.counts(domain).key?(:nodes_acceptance) }).to eq(news)
      expect(stored_name("known.invalid")).to eq("Refreshed")
      expect(deferred_domains).to eq(news.last(4))
      expect(log_lines("Deferred remote instance entry").first.last).to eq(
        context: "federation.instances", domain: "n9.invalid", reason: "new-domain quota of fed.invalid spent", relayed_by: root,
      )
      expect(first_request("n9.invalid")).to be < first_request("z1.invalid")
    end

    it "shares one quota among the relayers of one registrable domain and counts a new domain listed twice once" do
      shared = %w[a1.share.invalid a2.share.invalid]
      first = (1..6).map { |i| "f#{i}.invalid" }
      second = (1..6).map { |i| "g#{i}.invalid" }
      other = (1..9).map { |i| "h#{i}.invalid" }
      fed.lists[root] = (shared + ["b1.other.invalid"]).map { |domain| peers.record(domain) }
      # f1 is refused, so its second copy still names a domain with no row.
      fed.lists[shared.first] = [peers.record(first.first)] + first.map { |domain| peers.record(domain) }
      fed.nodes[first.first] = peers.fresh_nodes(10, newest_age: 8 * day)
      fed.lists[shared.last] = second.map { |domain| peers.record(domain) }
      fed.lists["b1.other.invalid"] = other.map { |domain| peers.record(domain) }

      crawl(root)

      expect(deferred_domains).to eq(second.last(4) + other.last(1))
      expect((first + second + other).count { |domain| fed.counts(domain).key?(:nodes_acceptance) }).to eq(21)
      expect(stored_domains).not_to include(first.first)
    end

    it "walks nothing for this instance's own domain" do
      crawl("spec.mesh.test")

      expect(fed.total).to eq(0)
    end

    # Make the stored-row read for +domain+ raise, as a failing disk would.
    #
    # @param domain [String] domain whose read raises.
    # @return [void]
    def fail_stored_row_read(domain)
      allow(application).to receive(:stored_instance_key_and_update).and_wrap_original do |original, db, read_domain|
        raise SQLite3::IOException, "spec: disk I/O error" if read_domain == domain

        original.call(db, read_domain)
      end
    end

    it "logs a database error in the walk of a list a peer named and walks the next list" do
      fed.lists[root] = [peers.record(a), peers.record(b)]
      fed.lists[a] = [peers.record(c)]
      fed.lists[b] = [peers.record(d)]
      fail_stored_row_read(c)

      crawl(root)

      expect(log_lines("Failed to persist remote instance").map(&:last)).to eq(
        [{ context: "federation.instances", domain: a, error_class: "SQLite3::IOException", error_message: "spec: disk I/O error" }],
      )
      expect(stored_domains).to eq([a, b, d])
    end

    it "ends the crawl on a database error in the walk of a list it started from" do
      fed.lists[root] = [peers.record(c)]
      fail_stored_row_read(c)

      expect { crawl(root) }.to raise_error(SQLite3::IOException, "spec: disk I/O error")
    end

    it "costs a host one well-known request for 64 port variants, the ones past the quota taken up unfetched later" do
      attacker_key = peers::KEYS["attacker-key"]
      variants = (1..64).map { |port| "victim.fed.invalid:#{port}" }
      fed.lists[x] = variants.map { |domain| peers.record(domain, attacker_key) }

      crawl(x)

      expect(fed.counts("victim.fed.invalid")).to eq(well_known: 1)
      discarded = log_lines("Discarded remote instance entry").map { |line| line[2][:reason] }
      expect(discarded.count { |reason| reason.include?("fetched another port variant's well-known in this crawl") }).to eq(63)
      expect(deferred_domains).to eq(variants.last(56))
    end
  end
end

RSpec.describe "Federation bounds at their values (FB3, FB4, FB6, FB7)" do
  let(:federation) { PotatoMesh::App::Federation }
  let(:web_root) { File.expand_path("..", __dir__) }

  it "keeps 3 rows per registrable domain and 512 in all, and lets one relayer bring 8 new domains" do
    expect(federation.const_get(:REGISTRABLE_DOMAIN_ROW_LIMIT)).to eq(3)
    expect(federation.const_get(:INSTANCE_ROW_LIMIT)).to eq(512)
    expect(federation.const_get(:RELAYER_NEW_DOMAIN_QUOTA)).to eq(8)
    expect(federation.const_get(:LAST_UPDATE_MAX_AHEAD_SECONDS)).to eq(3600)
  end

  it "declares public_suffix in the Gemfile at the version the lockfile already resolves" do
    gemfile = File.read(File.join(web_root, "Gemfile"))
    lockfile = File.read(File.join(web_root, "Gemfile.lock"))
    locked = lockfile[/^    public_suffix \(([^)]+)\)$/, 1]

    expect(locked).to eq("7.0.5")
    expect(gemfile.lines.grep(/public_suffix/)).to eq(["gem \"public_suffix\", \"#{locked}\"\n"])
    expect(lockfile).to include("\n  public_suffix (= #{locked})\n")
  end
end
