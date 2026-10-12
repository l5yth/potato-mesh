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

# What the reviews of the federation bounds found (SPEC FB3, FB5, FB9, FB10):
# one canonical host per domain, stored with its registrable domain, and a
# host whose group cannot be computed treated as having none; no IP literal
# and no host without a registrable domain federates; every fresh row ranks
# by when this instance first verified it, after this instance and the
# seeds; a relayer's quota defers rather than drops, and a level's deferred
# records go before the next level; the announcer rotates what a full queue
# skipped and backs off a target whose announcement failed.

# The instances table as every version before SPEC FB2 created it.
REVIEW_LEGACY_INSTANCES_SCHEMA = <<~SQL
  CREATE TABLE instances (
    id TEXT PRIMARY KEY, domain TEXT NOT NULL, pubkey TEXT NOT NULL, name TEXT, version TEXT,
    channel TEXT, frequency TEXT, latitude REAL, longitude REAL, last_update_time INTEGER,
    is_private BOOLEAN NOT NULL DEFAULT 0, nodes_count INTEGER, meshcore_nodes_count INTEGER,
    meshtastic_nodes_count INTEGER, reticulum_nodes_count INTEGER, contact_link TEXT, signature TEXT
  );
  CREATE UNIQUE INDEX idx_instances_domain ON instances(domain);
SQL

RSpec.describe "Federation bounds after the review" do
  include_context "fake federation peers"

  let(:peers) { FederationFakePeers }
  let(:application) { FederationFakePeers::APP }
  let(:federation) { PotatoMesh::App::Federation }
  let(:now) { Time.now.to_i }
  let(:day) { 86_400 }
  let(:root) { "root.fed.invalid" }
  let(:seeds) { %w[seed1.invalid seed2.invalid seed3.invalid] }

  before do
    # The shared context lifts the caps and the quota for the FL and FK
    # examples; this file checks them at their values.
    stub_const("PotatoMesh::App::Federation::INSTANCE_ROW_LIMIT", 512)
    stub_const("PotatoMesh::App::Federation::REGISTRABLE_DOMAIN_ROW_LIMIT", 3)
    stub_const("PotatoMesh::App::Federation::RELAYER_NEW_DOMAIN_QUOTA", 8)
    allow(PotatoMesh::Config).to receive(:federation_seed_domains).and_return(seeds)
    # With no node stored our own row is listed (SPEC RC4).
    with_db { |db| db.execute("DELETE FROM nodes") }
  end

  around do |example|
    # Smaller keys for the many fixture peers of this file, restored after.
    keys = FederationFakePeers::KEYS
    original = keys.default_proc
    keys.default_proc = proc { |hash, domain| hash[domain] = OpenSSL::PKey::RSA.new(1024) }
    example.run
  ensure
    keys.default_proc = original
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

  # Insert the row of +domain+ directly, without the group a write stores.
  #
  # @param db [SQLite3::Database] open database handle.
  # @param domain [String] row domain.
  # @param verified [Integer] last and first verification time.
  # @return [void]
  def insert_row(db, domain, verified:)
    pem = "review-pem-#{domain}"
    db.execute(
      "INSERT INTO instances (id, domain, pubkey, name, last_update_time, is_private, signature, last_verified_time, " \
      "first_verified_time) VALUES (?, ?, ?, ?, ?, 0, 'spec-signature', ?, ?)",
      [Digest::SHA256.hexdigest(pem), domain, pem, "Row #{domain}", now, verified, verified],
    )
  end

  # Write the record of +domain+ through +upsert_instance_record+, signed
  # with the key {FederationFakePeers::KEYS} holds for it.
  #
  # @param db [SQLite3::Database] open database handle.
  # @param domain [String] record domain.
  # @return [Boolean] what the write returned.
  def write_record(db, domain)
    attributes = peers.attrs(domain)
    application.upsert_instance_record(db, attributes, peers.sign(peers::KEYS[domain], attributes))
  end

  # Serve the well-known document of a domain with a port under its host.
  #
  # @param domain [String] a domain with a port.
  # @return [void]
  def serve_well_known(domain)
    host = URI.parse("https://#{domain}").host
    fed.well_known[host] = FederationIdentitySupport.well_known_document(peers::KEYS[domain], domain)
  end

  describe "one canonical host per domain (FB3)" do
    it "reads a domain in lower case without trailing dots, its IDN labels in punycode" do
      expect(application.federation_canonical_domain("t1.Evil.Invalid.:8443")).to eq("t1.evil.invalid:8443")
      expect(application.federation_canonical_domain("Mesh.Example.Org..")).to eq("mesh.example.org")
      expect(application.federation_canonical_domain("мэш.рф")).to eq("xn--l1ayo.xn--p1ai")
      expect(application.federation_canonical_domain("ｍｅｓｈ．ｅｘａｍｐｌｅ．ｏｒｇ")).to eq("mesh.example.org")
      expect(application.federation_canonical_domain("[2001:DB8::1]:443")).to eq("[2001:db8::1]:443")
      expect(application.federation_canonical_domain("a b.org")).to be_nil
      expect(application.federation_domain_refusal("a b.org")).to eq("invalid domain")
      expect(application.federation_canonical_domain("\xFF.org".b)).to be_nil
      expect(application.federation_canonical_domain(nil)).to be_nil
    end

    it "decodes and encodes punycode labels as RFC 3492 does" do
      punycode = PotatoMesh::App::Federation::Punycode
      { "bücher" => "bcher-kva", "東京" => "1lqs71d", "рф" => "p1ai", "пример" => "e1afmkfd" }.each do |unicode, ascii|
        expect(punycode.encode(unicode)).to eq(ascii)
        expect(punycode.decode(ascii)).to eq(unicode)
      end
      expect(punycode.decode("bcher-KVA")).to eq("bücher")
      expect { punycode.decode("ü-a") }.to raise_error(ArgumentError, "non-basic code point")
      expect { punycode.decode("9") }.to raise_error(ArgumentError, "truncated punycode")
      expect { punycode.decode("!") }.to raise_error(ArgumentError, "invalid punycode digit")
      expect { punycode.decode("9999999a") }.to raise_error(ArgumentError, "code point out of range")
      expect { punycode.decode("ib9b") }.to raise_error(ArgumentError, "surrogate code point")
      expect(application.federation_unicode_label("xn--!")).to be_nil
    end

    it "treats a host whose Punycode label does not decode as having no registrable domain, and never raises" do
      expect(application.federation_registrable_domain("a.xn--ib9b.example.org")).to be_nil
      expect(application.federation_domain_refusal("a.xn--ib9b.example.org")).to eq("no registrable domain")
      # The reviewer's fuzz: 20 000 random Punycode labels (43 raised before).
      srand(7)
      alphabet = [*"a".."z", *"0".."9", "-"]
      outcomes = Hash.new(0)
      20_000.times do
        domain = "xn--#{Array.new(rand(1..59)) { alphabet.sample }.join}.example.org"
        outcomes[[application.federation_registrable_domain(domain).nil?, application.federation_domain_refusal(domain)]] += 1
      rescue StandardError => e
        outcomes[e.class.name] += 1
      end

      expect(outcomes.keys).to all(satisfy { |key| [[false, nil], [true, "no registrable domain"], [true, "invalid domain"]].include?(key) })
      expect(outcomes[[true, "no registrable domain"]]).to be >= 43
      # Whatever else the suffix list raises on, the host has no group.
      allow(PublicSuffix).to receive(:domain).and_raise(ArgumentError, "spec: invalid byte sequence")
      expect(application.federation_registrable_domain("mesh.example.org")).to be_nil
    end

    it "refuses a label longer than 63 characters, and text longer than any host, without encoding it" do
      expect(PotatoMesh::App::Federation::Punycode).not_to receive(:encode)

      expect(application.federation_canonical_domain("#{Array.new(5000) { |i| 0x4E00 + i }.pack("U*")}.example.org")).to be_nil
      expect(application.federation_canonical_domain("#{"é" * 64}.example.org")).to be_nil
      expect(application.federation_canonical_domain("#{"a." * 600}example.org")).to be_nil
    end

    it "refuses announcements whose signed host ends in a dot before the port" do
      statuses = (1..6).map do |i|
        domain = "t#{i}.evil.invalid.:8443"
        serve_well_known(domain)
        at_time(now + i) { announce(domain).status }
      end

      expect(statuses).to eq([400] * 6)
      expect(JSON.parse(last_response.body)).to eq("error" => "invalid signature")
      expect(stored_rows).to eq([])
    end

    it "discards crawled records whose signed host ends in a dot before the port, unfetched" do
      fed.lists[root] = (1..4).map { |i| peers.record("d#{i}.evil.invalid.:8443") }

      crawl(root)

      expect(fed.log.map { |entry| entry[:host] }.uniq).to eq([root])
      expect(log_lines("Discarded remote instance entry").map { |line| line.last[:reason] }).to eq(["invalid signature"] * 4)
    end

    it "stores the canonical form of a domain written with trailing dots, and groups it" do
      with_db do |db|
        (1..6).each { |i| at_time(now + i) { write_record(db, "s#{i}.evil.invalid.:8443") } }
      end

      expect(stored_domains).to eq(%w[s1.evil.invalid:8443 s2.evil.invalid:8443 s3.evil.invalid:8443])
      expect(with_db { |db| db.execute("SELECT DISTINCT registrable_domain FROM instances").flatten }).to eq(["evil.invalid"])
    end

    it "judges a legacy upper-case row of a group on the next write and stores its group" do
      with_db do |db|
        insert_row(db, "EVIL.INVALID", verified: now - 10)
        (1..3).each { |i| at_time(now + i) { expect(write_record(db, "w#{i}.evil.invalid")).to be(i < 3) } }
      end

      expect(stored_domains).to eq(%w[EVIL.INVALID w1.evil.invalid w2.evil.invalid])
      expect(with_db { |db| db.get_first_value("SELECT registrable_domain FROM instances WHERE domain = 'EVIL.INVALID'") }).to eq("evil.invalid")
    end

    it "upgrades a database holding a row whose group cannot be computed, and the cycle deletes the row" do
      Dir.mktmpdir do |dir|
        path = File.join(dir, "legacy.db")
        SQLite3::Database.open(path) do |db|
          db.execute_batch(REVIEW_LEGACY_INSTANCES_SCHEMA)
          %w[a.xn--ib9b.example.org kept.invalid].each_with_index do |domain, index|
            db.execute("INSERT INTO instances (id, domain, pubkey, last_update_time, is_private) VALUES (?, ?, 'pem', ?, 0)", ["id#{index}", domain, now])
          end
        end
        allow(PotatoMesh::Config).to receive(:db_path).and_return(path)

        application.ensure_schema_upgrades
        groups = SQLite3::Database.open(path) { |db| db.execute("SELECT domain, registrable_domain FROM instances ORDER BY id") }
        application.enforce_instance_caps!

        expect(groups).to eq([["a.xn--ib9b.example.org", nil], ["kept.invalid", "kept.invalid"]])
        expect(SQLite3::Database.open(path) { |db| db.execute("SELECT domain FROM instances").flatten }).to eq(["kept.invalid"])
      end
    end

    it "boots past a stored row whose group cannot be computed and deletes it" do
      Dir.mktmpdir do |dir|
        env = {
          "XDG_CONFIG_HOME" => File.join(dir, "config"), "XDG_DATA_HOME" => File.join(dir, "data"),
          "FEDERATION" => "0", "RACK_ENV" => "test", "INSTANCE_DOMAIN" => "boot.mesh.test",
        }
        boot = -> { Open3.capture3(env, RbConfig.ruby, "-e", 'require "./lib/potato_mesh/application"', chdir: File.expand_path("..", __dir__)) }
        _stdout, stderr, status = boot.call
        expect(status.success?).to be(true), stderr
        path = File.join(dir, "data", "potato-mesh", "mesh.db")
        SQLite3::Database.open(path) { |db| insert_row(db, "a.xn--ib9b.example.org", verified: now) }

        _stdout, stderr, status = boot.call

        expect(status.success?).to be(true), stderr
        expect(SQLite3::Database.open(path) { |db| db.get_first_value("SELECT COUNT(*) FROM instances WHERE domain LIKE '%xn--ib9b%'") }).to eq(0)
      end
    end

    it "indexes the stored group" do
      index = with_db { |db| db.get_first_value("SELECT sql FROM sqlite_master WHERE name = 'idx_instances_registrable_domain'") }

      expect(index).to eq("CREATE INDEX idx_instances_registrable_domain ON instances(registrable_domain)")
    end

    it "signs our own record and the well-known document under the canonical form of INSTANCE_DOMAIN" do
      allow(application).to receive(:app_constant).and_call_original
      allow(application).to receive(:app_constant).with(:INSTANCE_DOMAIN).and_return("Mesh.Example.org.:8443")

      expect(application.self_instance_domain).to eq("mesh.example.org:8443")
      expect(application.self_instance_attributes[:domain]).to eq("mesh.example.org:8443")
      expect(JSON.parse(application.build_well_known_document.first)["domain"]).to eq("mesh.example.org:8443")
    end

    it "merges the duplicates of one canonical domain on the cycle" do
      with_db do |db|
        insert_row(db, "dup.evil.invalid.:8443", verified: now - 60)
        insert_row(db, "DUP.EVIL.INVALID:8443", verified: now)
      end
      allow(application).to receive(:federation_target_domains).and_return([])

      application.announce_instance_to_all_domains

      expect(stored_domains).to eq(%w[dup.evil.invalid:8443 spec.mesh.test])
    end
  end

  describe "no IP literal federates (FB10)" do
    it "refuses announcements from IPv4 and IPv6 literals and from a public suffix, before any request" do
      %w[203.0.113.5 203.0.113.5:41447 [2001:db8::1] [2001:db8:0::1]:443].each do |domain|
        response = announce(domain)
        expect([domain, response.status, JSON.parse(response.body)]).to eq([domain, 400, { "error" => "ip literal domain" }])
      end
      # A mapped literal is a restricted address first, as before.
      expect(JSON.parse(announce("[::ffff:203.0.113.5]").body)).to eq("error" => "restricted domain")
      response = announce("github.io")

      expect(JSON.parse(response.body)).to eq("error" => "no registrable domain")
      expect(fed.total).to eq(0)
      expect(stored_rows).to eq([])
      expect(log_lines("Instance registration rejected").map { |line| line.last[:reason] }.tally).to eq(
        "ip literal domain" => 4, "restricted IP address" => 1, "no registrable domain" => 1,
      )
    end

    it "discards crawled records of IP literals and public suffixes before any request to them" do
      fed.lists[root] = %w[203.0.113.7 [2001:db8::7]:443 github.io].map { |domain| peers.record(domain) } + [peers.record("ok.invalid")]

      crawl(root)

      expect(fed.log.map { |entry| entry[:host] }.uniq).to eq([root, "ok.invalid"])
      expect(log_lines("Discarded remote instance entry").map { |line| line.last.slice(:domain, :reason) }).to eq(
        [
          { domain: "203.0.113.7", reason: "ip literal domain" },
          { domain: "[2001:db8::7]:443", reason: "ip literal domain" },
          { domain: "github.io", reason: "no registrable domain" },
        ],
      )
      expect(stored_domains).to eq(["ok.invalid"])
    end

    it "neither announces to nor crawls a stored IP row, and the cycle deletes it" do
      with_db do |db|
        insert_row(db, "203.0.113.8", verified: now)
        insert_row(db, "[2001:db8::8]", verified: now)
        insert_row(db, "kept.invalid", verified: now)
      end

      expect(application.federation_target_domains("spec.mesh.test")).to eq(seeds + ["kept.invalid"])
      crawl("203.0.113.8")
      expect(fed.total).to eq(0)
      expect(log_lines("Skipped remote instance crawl").map(&:last)).to include(hash_including(domain: "203.0.113.8", reason: "ip literal domain"))

      application.enforce_instance_caps!

      expect(stored_domains).to eq(["kept.invalid"])
    end

    it "refuses an IP literal written through upsert_instance_record" do
      attributes = peers.attrs("203.0.113.9")

      expect { with_db { |db| application.upsert_instance_record(db, attributes, "sig") } }.to raise_error(ArgumentError, "ip literal domain")
    end

    it "stores no own row and announces nothing when this instance is on an IP address" do
      allow(application).to receive(:app_constant).and_call_original
      allow(application).to receive(:app_constant).with(:INSTANCE_DOMAIN_SOURCE).and_return(:environment)

      expect(application.self_instance_registration_decision("203.0.113.9")).to eq(
        [false, "INSTANCE_DOMAIN is not a federated hostname (ip literal domain)"],
      )
      allow(application).to receive(:ensure_self_instance_record!).and_return([{ domain: "203.0.113.9" }, "sig"])
      allow(application).to receive(:federation_target_domains).and_return(["kept.invalid"])

      application.announce_instance_to_all_domains

      expect(fed.total).to eq(0)
      expect(log_lines("Skipped federation announcement cycle").map(&:last)).to eq(
        [{ context: "federation.announce", reason: "ip literal domain" }],
      )
      # It still crawls and answers announcements; only its own record goes
      # nowhere, and peers refuse it.
      fed.lists[root] = [peers.record("listed.invalid")]
      crawl(root)
      expect(stored_domains).to eq(["listed.invalid"])
      expect(announce("p1.invalid").status).to eq(201)
    end

    it "documents what happens to an instance on an IP address" do
      readme = File.read(File.expand_path("../../README.md", __dir__))
      contracts = File.read(File.expand_path("../../data/mesh_ingestor/CONTRACTS.md", __dir__))
      sentence = "An instance on an IP address does not announce itself, and peers refuse it"

      expect(readme.lines.grep(/\A- `FEDERATION=1`/).first).to include(sentence)
      expect(contracts).to include(sentence)
      expect(readme).not_to include("does not federate")
    end
  end

  describe "longest-standing first (FB9)" do
    it "orders the announce targets and the crawl roots by first verification, the seeds first" do
      with_db do |db|
        at_time(now - (5 * day)) { write_record(db, "old.invalid") }
        at_time(now - day) do
          announce("recent.invalid")
        end
        at_time(now - (3 * day)) { write_record(db, "middle.invalid") }
      end

      expect(application.federation_target_domains("spec.mesh.test")).to eq(seeds + %w[old.invalid middle.invalid recent.invalid])
    end

    it "keeps every genuine peer a root lists after 61 new domains" do
      attackers = (1..61).map { |i| format("a%02d.invalid", i) }
      genuine = %w[zg1.invalid zg2.invalid zg3.invalid]
      fed.lists[root] = (attackers + genuine).map { |domain| peers.record(domain) }

      crawl(root)

      expect(stored_domains).to include(*genuine)
      expect(stored_rows.size).to eq(64)
    end

    it "keeps every genuine peer when 8 domains announce 3 fresh subdomains to the seeds before each crawl" do
      genuine = (1..31).map { |i| "g#{i}.invalid" }
      groups = (1..8).map { |i| "atk#{i}.invalid" }
      genuine.each { |domain| fed.lists[domain] = (seeds + genuine).map { |d| peers.record(d) } }
      results = (0..2).map do |cycle|
        attackers = groups.flat_map { |group| (1..3).map { |n| "c#{cycle}n#{n}.#{group}" } }
        seeds.each { |seed| fed.lists[seed] = ([seed] + (seeds - [seed]) + attackers + genuine).map { |d| peers.record(d) } }
        application.clear_federation_crawl_state!
        travel((cycle + 1) * 8 * 3600) { application.crawl_federation! }
        stored = stored_domains
        [genuine.count { |d| stored.include?(d) }, stored.count { |d| d.include?(".atk") }]
      end

      expect(results).to eq([[31, 24]] * 3)
      expect(stored_domains.grep(/\.atk/).all? { |domain| domain.start_with?("c0") }).to be(true)
    end

    it "skips a new subdomain of a full group without a request or a slot" do
      fed.lists[root] = (1..6).map { |i| peers.record("e#{i}.evil.invalid") } + [peers.record("ok.invalid")]

      crawl(root)

      expect((1..6).map { |i| fed.total("e#{i}.evil.invalid").positive? }).to eq([true, true, true, false, false, false])
      expect(log_lines("Skipped remote instance entry").map { |line| line.last[:reason] }).to eq(["registrable domain evil.invalid full"] * 3)
      expect(log_lines("Deferred remote instance entry")).to eq([])
      expect(stored_domains).to include("ok.invalid")
    end

    it "skips a new subdomain of a full group without seeds configured too" do
      allow(PotatoMesh::Config).to receive(:federation_seed_domains).and_return([])
      fed.lists[root] = (1..4).map { |i| peers.record("e#{i}.evil.invalid") }

      crawl(root)

      expect(log_lines("Skipped remote instance entry").map { |line| line.last[:domain] }).to eq(["e4.evil.invalid"])
      expect(fed.total("e4.evil.invalid")).to eq(0)
    end

    it "lets a new crawled row outrank a stale one of its group" do
      with_db { |db| 3.times { |i| insert_row(db, "s#{i}.evil.invalid", verified: now - (8 * day) - i) } }
      fed.lists[root] = [peers.record("new.evil.invalid")]

      crawl(root)

      expect(stored_domains).to eq(%w[new.evil.invalid s0.evil.invalid s1.evil.invalid])
    end

    it "never lets an announced newcomer evict a crawled row of its group known longer" do
      fed.lists[root] = %w[a.grp.invalid b.grp.invalid c.grp.invalid].map { |domain| peers.record(domain) }
      crawl(root)

      status = travel(60) { announce("d.grp.invalid").status }

      expect(status).to eq(201)
      expect(stored_domains).to eq(%w[a.grp.invalid b.grp.invalid c.grp.invalid])
      expect(log_lines("Registered remote instance").map { |line| line.last.slice(:domain, :stored) }).to eq([{ domain: "d.grp.invalid", stored: false }])
    end

    it "never lets announcements from new domains evict a crawled federation known longer" do
      stub_const("PotatoMesh::App::Federation::INSTANCE_ROW_LIMIT", 8)
      genuine = (1..6).map { |i| "g#{i}.invalid" }
      fed.lists[root] = genuine.map { |domain| peers.record(domain) }
      crawl(root)

      (1..5).each { |i| travel(60 + i) { expect(announce("f#{i}.invalid").status).to eq(201) } }

      expect(stored_domains).to eq(%w[f1.invalid f2.invalid] + genuine)
    end

    it "takes up the records a seed's list kept for a later round before the next level spends the budget" do
      genuine = %w[zg1.invalid zg2.invalid]
      genuine.each { |domain| fed.lists[domain] = [] }
      attackers = (1..24).map { |i| "a#{i}.atk#{i}.invalid" }
      counter = 0
      # Each attacker lists 64 new domains of new groups, each listing more.
      fed.hooks << lambda do |entry|
        next unless entry[:kind] == :instances && entry[:host].include?(".atk")
        next if fed.lists.key?(entry[:host])

        fed.lists[entry[:host]] = Array.new(64) { peers.record("n#{counter += 1}.atkx#{counter}.invalid") }
      end
      seeds.each { |seed| fed.lists[seed] = (attackers + [seed] + (seeds - [seed]) + genuine).map { |domain| peers.record(domain) } }

      state = with_env("FEDERATION_MAX_DOMAINS_PER_CRAWL" => "64") { application.crawl_federation! }

      expect(state.stop_reason).to eq("domain limit reached")
      expect(stored_domains).to include(*genuine)
    end

    it "verifies the peers a list names that this instance holds before the new ones" do
      at_time(now - 60) { with_db { |db| peers.store(db, "known.invalid") } }
      fed.lists[root] = (1..12).map { |i| peers.record("n#{i}.invalid") } + [peers.record("known.invalid", name: "Refreshed")]

      with_env("FEDERATION_MAX_DOMAINS_PER_CRAWL" => "3") { crawl(root) }

      expect(with_db { |db| db.get_first_value("SELECT name FROM instances WHERE domain = 'known.invalid'") }).to eq("Refreshed")
      expect(fed.log.index { |entry| entry[:host] == "known.invalid" }).to be < fed.log.index { |entry| entry[:host] == "n1.invalid" }
    end

    it "logs a database error while a deferred record of a peer's list is taken up, and raises for a root's" do
      fed.lists[root] = [peers.record("relay.invalid")]
      fed.lists["relay.invalid"] = (1..9).map { |i| peers.record("n#{i}.invalid") }
      allow(application).to receive(:stored_instance_key_and_update).and_wrap_original do |original, db, domain|
        raise SQLite3::IOException, "spec: disk I/O error" if domain == "n9.invalid" && log_lines("Deferred remote instance entry").any?

        original.call(db, domain)
      end

      crawl(root)

      expect(log_lines("Failed to persist remote instance").map(&:last)).to eq(
        [{ context: "federation.instances", domain: "relay.invalid", error_class: "SQLite3::IOException", error_message: "spec: disk I/O error" }],
      )
      fed.lists[root] = (1..9).map { |i| peers.record("m#{i}.invalid") }
      allow(application).to receive(:stored_instance_key_and_update).and_wrap_original do |original, db, domain|
        raise SQLite3::IOException, "spec: disk I/O error" if domain == "m9.invalid" && log_lines("Deferred remote instance entry").size > 1

        original.call(db, domain)
      end
      application.clear_federation_crawl_state!

      expect { crawl(root) }.to raise_error(SQLite3::IOException)
    end

    it "stops taking up deferred records once the crawl stops" do
      fed.lists[root] = (1..12).map { |i| peers.record("n#{i}.invalid") }

      with_env("FEDERATION_MAX_DOMAINS_PER_CRAWL" => "9") { crawl(root) }

      expect((1..12).count { |i| fed.total("n#{i}.invalid").positive? }).to eq(8)
    end

    it "stops before the next round on shutdown" do
      fed.lists[root] = (1..12).map { |i| peers.record("n#{i}.invalid") }
      fed.hooks << ->(entry) { application.request_federation_shutdown! if entry[:host] == "n8.invalid" && entry[:kind] == :nodes_acceptance }

      crawl(root)

      expect((9..12).map { |i| fed.total("n#{i}.invalid") }).to eq([0, 0, 0, 0])
    ensure
      application.clear_federation_shutdown_request!
    end
  end

  describe "the announcer (FB5)" do
    # A worker pool that takes +capacity+ tasks per cycle and refuses the rest.
    class ReviewLimitedPool
      # @return [Array<String>] domains the pool ran, per cycle.
      attr_reader :ran

      # @param capacity [Integer] tasks taken per cycle.
      def initialize(capacity)
        @capacity = capacity
        @taken = 0
        @ran = []
      end

      # Start a cycle with an empty queue.
      #
      # @return [void]
      def next_cycle!
        @taken = 0
      end

      # Run +block+ now, or refuse it once the queue is full.
      #
      # @return [PotatoMesh::App::WorkerPool::Task] a task holding its result.
      def schedule
        raise PotatoMesh::App::WorkerPool::QueueFullError, "spec: full" if @taken >= @capacity

        @taken += 1
        PotatoMesh::App::WorkerPool::Task.new.tap { |task| task.fulfill(yield) }
      end
    end

    it "offers the targets a full queue skipped first in the next cycle" do
      targets = (1..5).map { |i| "t#{i}.invalid" }
      allow(application).to receive(:federation_target_domains).and_return(targets)
      limited = ReviewLimitedPool.new(2)
      allow(application).to receive(:federation_worker_pool).and_return(limited)

      sent = 3.times.map do
        limited.next_cycle!
        fed.log.clear
        application.announce_instance_to_all_domains
        fed.log.map { |entry| entry[:host] }
      end

      expect(sent).to eq([%w[t1.invalid t2.invalid], %w[t3.invalid t4.invalid], %w[t5.invalid t1.invalid]])
    end

    it "backs off a target whose announcement found no answer, so the crawl after it sends nothing" do
      allow(application).to receive(:federation_target_domains).and_return(["dark.invalid"])
      fed.refused << "dark.invalid"

      application.announce_instance_to_all_domains
      attempts = fed.total("dark.invalid")
      allow(application).to receive(:federation_target_domains).and_call_original
      with_db { |db| insert_row(db, "dark.invalid", verified: now) }
      application.crawl_federation!

      expect(attempts).to eq(2)
      expect(federation.peer_backoff.backoff_seconds("dark.invalid")).to be_between(1, 60)
      expect(fed.total("dark.invalid")).to eq(2)
    end

    it "backs off a target that answers 429 for its Retry-After, and clears a backoff on another answer" do
      allow(application).to receive(:federation_target_domains).and_return(["busy.invalid"])
      fed.status[["busy.invalid", :instances]] = 429
      fed.headers[["busy.invalid", :instances]] = { "Retry-After" => "600" }

      application.announce_instance_to_all_domains

      expect(federation.peer_backoff.backoff_seconds("busy.invalid")).to be_between(590, 600)
      answer = Net::HTTPBadRequest.new("1.1", "400", "spec")
      application.record_announce_outcome("busy.invalid", answer)
      expect(federation.peer_backoff.backoff_seconds("busy.invalid")).to eq(0.0)
      application.request_federation_shutdown!
      application.record_announce_outcome("other.invalid", nil)
      expect(federation.peer_backoff.backoff_seconds("other.invalid")).to eq(0.0)
    ensure
      application.clear_federation_shutdown_request!
    end

    it "logs stored: false for an announcement the caps evicted as it was written" do
      (1..4).each { |i| at_time(now + i) { expect(announce("s#{i}.evil.invalid").status).to eq(201) } }

      expect(log_lines("Registered remote instance").map { |line| line.last[:stored] }).to eq([true, true, true, false])
      expect(stored_domains).to eq(%w[s1.evil.invalid s2.evil.invalid s3.evil.invalid])
    end
  end

  describe "the upgrade of an older database (FB3, FB9)" do
    it "adds the first verification time and the stored group, an IP row left without one" do
      Dir.mktmpdir do |dir|
        path = File.join(dir, "fb2.db")
        SQLite3::Database.open(path) do |db|
          db.execute_batch(REVIEW_LEGACY_INSTANCES_SCHEMA)
          db.execute("ALTER TABLE instances ADD COLUMN last_verified_time INTEGER")
          db.execute("ALTER TABLE instances ADD COLUMN last_announced_time INTEGER")
          { "a" => "MESH.Example.ORG", "b" => "203.0.113.5", "c" => "x.fed.invalid.:8443" }.each do |id, domain|
            db.execute("INSERT INTO instances (id, domain, pubkey, last_update_time, is_private, last_verified_time) VALUES (?, ?, 'pem', ?, 0, ?)", [id, domain, now, now - 60])
          end
        end
        allow(PotatoMesh::Config).to receive(:db_path).and_return(path)

        application.ensure_schema_upgrades

        rows = SQLite3::Database.open(path) { |db| db.execute("SELECT id, first_verified_time, registrable_domain FROM instances ORDER BY id") }
        expect(rows).to eq([["a", now - 60, "example.org"], ["b", now - 60, nil], ["c", now - 60, "fed.invalid"]])
      end
    end
  end
end
