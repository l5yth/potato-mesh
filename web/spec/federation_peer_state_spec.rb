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

# The state federation keeps to limit what it sends: the process-wide peer
# store (fetch cooldown, backoff, revalidation, SPEC FL3 and FL4), the state
# of one crawl (SPEC FL1 and FL6), the registration slots (SPEC FL7), and
# their helpers.
RSpec.describe "Federation peer state" do
  let(:application) { PotatoMesh::Application }

  describe PotatoMesh::App::Federation::PeerBackoff do
    subject(:store) { described_class.new }

    it "ignores a nil host" do
      expect(store.claim(nil, cooldown: 900)).to eq(0.0)
      expect(store.wait_seconds(nil, cooldown: 900)).to eq(0.0)
      expect(store.backoff_seconds(nil)).to eq(0.0)
      expect(store.record_failure(nil)).to be_nil
      expect(store.record_success(nil)).to be_nil
      expect(store.validators(nil, "https://x/")).to be_nil
      expect(store.store_validators(nil, "https://x/", etag: "e", last_modified: nil, body: "{}")).to be_nil
    end

    it "lets a host be claimed once per cooldown" do
      expect(store.claim("peer", cooldown: 900, now: 0.0)).to eq(0.0)
      expect(store.claim("peer", cooldown: 900, now: 100.0)).to eq(800.0)
      expect(store.wait_seconds("peer", cooldown: 900, now: 100.0)).to eq(800.0)
      expect(store.claim("peer", cooldown: 900, now: 900.0)).to eq(0.0)
    end

    it "lets one of many threads claim a host" do
      results = Array.new(16) { Thread.new { store.claim("peer", cooldown: 900) } }.map(&:value)

      expect(results.count(&:zero?)).to eq(1)
    end

    it "backs off from 60 seconds, doubling per failure, up to 24 hours" do
      waits = Array.new(12) do
        store.record_failure("peer", now: 0.0)
        store.backoff_seconds("peer", now: 0.0)
      end

      expect(waits.first(4)).to eq([60.0, 120.0, 240.0, 480.0])
      expect(waits.last).to eq(86_400.0)
      expect(store.wait_seconds("peer", cooldown: 900, now: 0.0)).to eq(86_400.0)
      40.times { store.record_failure("peer", now: 0.0) }
      expect(store.backoff_seconds("peer", now: 0.0)).to eq(86_400.0)
    end

    it "honours a Retry-After longer than the backoff, within 24 hours" do
      store.record_failure("slow", retry_after: 600, now: 0.0)
      store.record_failure("slower", retry_after: 10 * 86_400, now: 0.0)

      expect(store.backoff_seconds("slow", now: 0.0)).to eq(600.0)
      expect(store.backoff_seconds("slower", now: 0.0)).to eq(86_400.0)
      expect(store.backoff_seconds("slow", now: 700.0)).to eq(0.0)
    end

    it "waits the longer of the cooldown and the backoff, and clears the backoff on success" do
      store.claim("peer", cooldown: 900, now: 0.0)
      store.record_failure("peer", retry_after: 1200, now: 0.0)

      expect(store.wait_seconds("peer", cooldown: 900, now: 0.0)).to eq(1200.0)
      store.record_success("peer")
      expect(store.wait_seconds("peer", cooldown: 900, now: 0.0)).to eq(900.0)
      expect(store.record_success("unknown")).to be_nil
    end

    it "tells what is left of the cooldown alone, apart from the backoff" do
      store.record_failure("peer", now: 0.0)
      left = ->(now) { store.cooldown_seconds("peer", cooldown: 900, now: now) }

      expect([store.cooldown_seconds(nil, cooldown: 900), store.cooldown_seconds("unknown", cooldown: 900), left.call(0.0)]).to eq([0.0, 0.0, 0.0])
      expect(store.claim("peer", cooldown: 900, now: 100.0)).to eq(0.0)
      expect([left.call(400.0), left.call(1_000.0), left.call(2_000.0)]).to eq([600.0, 0.0, 0.0])
    end

    it "keeps the validators and body of an answer that has a validator and fits" do
      store.store_validators("peer", "https://peer/a", etag: 'W/"1"', last_modified: nil, body: "one")
      store.store_validators("peer", "https://peer/a", etag: 'W/"2"', last_modified: nil, body: "two")
      store.store_validators("peer", "https://peer/b", etag: nil, last_modified: nil, body: "none")
      stub_const("PotatoMesh::App::Federation::PeerBackoff::MAX_BODY_BYTES", 3)
      store.store_validators("peer", "https://peer/c", etag: 'W/"3"', last_modified: nil, body: "long")

      expect(store.validators("peer", "https://peer/a")).to eq(etag: 'W/"2"', last_modified: nil, body: "two")
      expect(store.validators("peer", "https://peer/b")).to be_nil
      expect(store.validators("peer", "https://peer/c")).to be_nil
      expect(store.validators("other", "https://other/a")).to be_nil
    end

    it "forgets the least recently used host beyond MAX_HOSTS" do
      stub_const("PotatoMesh::App::Federation::PeerBackoff::MAX_HOSTS", 2)
      store.store_validators("first", "https://first/", etag: "e", last_modified: nil, body: "1")
      store.claim("second", cooldown: 900, now: 0.0)
      store.claim("third", cooldown: 900, now: 0.0)

      expect(store.validators("first", "https://first/")).to be_nil
      expect(store.wait_seconds("second", cooldown: 900, now: 0.0)).to eq(900.0)
      expect(store.wait_seconds("third", cooldown: 900, now: 0.0)).to eq(900.0)
    end

    it "drops the oldest host's kept bodies beyond MAX_TOTAL_BODY_BYTES" do
      stub_const("PotatoMesh::App::Federation::PeerBackoff::MAX_TOTAL_BODY_BYTES", 10)
      store.store_validators("old", "https://old/", etag: "e", last_modified: nil, body: "123456")
      store.store_validators("new", "https://new/", etag: nil, last_modified: "Mon, 05 Oct 2026 10:00:00 GMT", body: "abcdef")

      expect(store.validators("old", "https://old/")).to be_nil
      expect(store.validators("new", "https://new/")).to include(body: "abcdef")
    end

    it "forgets everything on reset!" do
      store.claim("peer", cooldown: 900, now: 0.0)
      store.record_failure("peer", now: 0.0)

      store.reset!

      expect(store.wait_seconds("peer", cooldown: 900, now: 0.0)).to eq(0.0)
    end
  end

  describe "what a claim kept for a host's cooldown (SPEC FL7)" do
    subject(:store) { PotatoMesh::App::Federation::PeerBackoff.new }

    let(:document) { { "domain" => "peer.mesh", "public_key" => "key" } }
    let(:accepted) { { accepted: true } }

    it "keeps the document and the node-list result of a domain until the cooldown ends" do
      store.claim("peer", cooldown: 900, now: 0.0)
      store.record_well_known("peer", "peer.mesh", document, :uri)
      store.record_acceptance("peer", "peer.mesh", accepted)

      expect(store.knowledge("peer", "peer.mesh", cooldown: 900, now: 899.0)).to eq(
        well_known: [document, :uri], acceptance: accepted,
      )
      expect(store.knowledge("peer", "other.mesh", cooldown: 900, now: 899.0)).to be_nil
      expect(store.knowledge("peer", "peer.mesh", cooldown: 900, now: 900.0)).to be_nil
    end

    it "keeps a failed fetch as such" do
      store.claim("peer", cooldown: 900, now: 0.0)
      store.record_well_known("peer", "peer.mesh", nil, ["refused"])

      expect(store.knowledge("peer", "peer.mesh", cooldown: 900, now: 1.0)).to eq(well_known: [nil, ["refused"]])
    end

    it "keeps nothing without a claim, and starts every claim knowing nothing" do
      store.record_well_known("peer", "peer.mesh", document, :uri)
      store.record_failure("peer", now: 0.0)
      store.record_acceptance("peer", "peer.mesh", accepted)
      expect(store.knowledge("peer", "peer.mesh", cooldown: 900, now: 0.0)).to be_nil

      store.record_success("peer")
      store.claim("peer", cooldown: 900, now: 0.0)
      store.record_acceptance("peer", "peer.mesh", accepted)
      store.claim("peer", cooldown: 900, now: 1000.0)

      expect(store.knowledge("peer", "peer.mesh", cooldown: 900, now: 1000.0)).to be_nil
    end

    it "ignores a nil host" do
      expect(store.record_well_known(nil, "peer.mesh", document, :uri)).to be_nil
      expect(store.record_acceptance(nil, "peer.mesh", accepted)).to be_nil
      expect(store.knowledge(nil, "peer.mesh", cooldown: 900)).to be_nil
    end

    it "keeps at most MAX_KNOWN_DOMAINS_PER_HOST domains of a host, the oldest leaving first" do
      stub_const("PotatoMesh::App::Federation::PeerBackoff::MAX_KNOWN_DOMAINS_PER_HOST", 2)
      store.claim("peer", cooldown: 900, now: 0.0)
      %w[a.mesh b.mesh c.mesh].each { |domain| store.record_well_known("peer", domain, document, :uri) }

      known = %w[a.mesh b.mesh c.mesh].map { |domain| !store.knowledge("peer", domain, cooldown: 900, now: 1.0).nil? }

      expect(known).to eq([false, true, true])
    end

    it "does not keep a document over MAX_DOCUMENT_BYTES" do
      stub_const("PotatoMesh::App::Federation::PeerBackoff::MAX_DOCUMENT_BYTES", 10)
      store.claim("peer", cooldown: 900, now: 0.0)
      store.record_well_known("peer", "peer.mesh", document, :uri)

      expect(store.knowledge("peer", "peer.mesh", cooldown: 900, now: 1.0)).to be_nil
    end

    it "counts kept documents with the kept bodies and drops them with their host" do
      stub_const("PotatoMesh::App::Federation::PeerBackoff::MAX_TOTAL_BODY_BYTES", 60)
      store.claim("old", cooldown: 900, now: 0.0)
      store.record_well_known("old", "old.mesh", document, :uri)
      store.record_well_known("old", "old.mesh", document, :uri)
      store.store_validators("new", "https://new/", etag: "e", last_modified: nil, body: "x" * 40)

      expect(store.knowledge("old", "old.mesh", cooldown: 900, now: 1.0)).to be_nil
      expect(store.validators("new", "https://new/")).to include(body: "x" * 40)
    end

    it "forgets what an evicted host kept" do
      stub_const("PotatoMesh::App::Federation::PeerBackoff::MAX_HOSTS", 1)
      store.claim("first", cooldown: 900, now: 0.0)
      store.record_well_known("first", "first.mesh", document, :uri)
      store.claim("second", cooldown: 900, now: 0.0)

      expect(store.knowledge("first", "first.mesh", cooldown: 900, now: 1.0)).to be_nil
      store.store_validators("second", "https://second/", etag: "e", last_modified: nil, body: "y")
      expect(store.validators("second", "https://second/")).to include(body: "y")
    end
  end

  describe ".instance_copy_outdated?" do
    let(:copy) { { pubkey: "key-1", last_update_time: 100 } }

    it "outdates a copy under the stored key that is not newer than the stored row" do
      outdated = [["key-1", 100], ["key-1", 101], ["key-1", 99], ["key-2", 101], ["key-1", nil], [nil, nil]].map do |stored|
        application.instance_copy_outdated?(stored, copy)
      end

      expect(outdated).to eq([true, true, false, false, false, false])
    end

    it "reads the stored key and update of a domain, nil without a row" do
      db = application.open_database
      db.execute("DELETE FROM instances WHERE domain = ?", "outdated.mesh")

      expect(application.stored_instance_key_and_update(db, "Outdated.Mesh")).to eq([nil, nil])
    ensure
      db&.close
    end

    it "reads the stored key and update under a copy's id, whichever domain form holds the row" do
      key = FederationFakePeers::KEYS["copy.fed.invalid"]
      copy = FederationFakePeers.attrs("copy.fed.invalid", key, last_update_time: 1_000)
      db = application.open_database
      db.execute("DELETE FROM instances WHERE id = ?", copy[:id])
      expect(application.stored_instance_copy(db, copy)).to eq([nil, nil])

      FederationFakePeers.store(db, "copy.fed.invalid:443", key, last_update_time: 900)

      expect(application.stored_instance_copy(db, copy)).to eq([copy[:pubkey], 900])
      expect(application.stored_instance_key_and_update(db, "copy.fed.invalid")).to eq([nil, nil])
    ensure
      db&.execute("DELETE FROM instances WHERE id = ?", copy[:id]) if copy
      db&.close
    end
  end

  describe ".federation_peer_host" do
    it "keys a domain by its lowercase host, ports included" do
      expect(application.federation_peer_host("Peer.Mesh.Invalid:8443")).to eq("peer.mesh.invalid")
      expect(application.federation_peer_host("[2001:db8::1]:8443")).to eq("[2001:db8::1]")
    end

    it "returns nil for a domain that is no host" do
      expect(application.federation_peer_host(nil)).to be_nil
      expect(application.federation_peer_host("bad host")).to be_nil
    end
  end

  describe ".federation_domain_key" do
    it "drops a default port, :443 or :80, and keeps any other" do
      domains = ["peer.mesh:443", "peer.mesh:80", "peer.mesh", "peer.mesh:8443", "peer.mesh:4430", "[2001:db8::1]:443", nil]

      expect(domains.map { |domain| application.federation_domain_key(domain) }).to eq(
        ["peer.mesh", "peer.mesh", "peer.mesh", "peer.mesh:8443", "peer.mesh:4430", "[2001:db8::1]", ""],
      )
    end

    it "calls a domain with an explicit port other than a default one a port variant" do
      domains = ["peer.mesh:8443", "peer.mesh:443", "peer.mesh:80", "peer.mesh", "[2001:db8::1]:8443", "[2001:db8::1]"]

      expect(domains.map { |domain| application.federation_port_variant?(domain) }).to eq([true, false, false, false, true, false])
    end

    it "compares well-known domains ignoring case and a default port" do
      pairs = [%w[Peer.Mesh peer.mesh:443], %w[peer.mesh:80 peer.mesh], %w[peer.mesh:8443 peer.mesh], ["peer.mesh", nil]]

      expect(pairs.map { |left, right| application.same_federation_domain?(left, right) }).to eq([true, true, false, false])
    end
  end

  describe ".federation_retry_after_seconds" do
    let(:now) { Time.utc(2026, 10, 7, 12, 0, 0) }

    it "reads delay seconds and HTTP dates" do
      expect(application.federation_retry_after_seconds("600", now: now)).to eq(600.0)
      expect(application.federation_retry_after_seconds((now + 120).httpdate, now: now)).to eq(120.0)
      expect(application.federation_retry_after_seconds((now - 120).httpdate, now: now)).to eq(0.0)
    end

    it "returns nil when the header is missing or does not parse" do
      expect(application.federation_retry_after_seconds(nil, now: now)).to be_nil
      expect(application.federation_retry_after_seconds("  ", now: now)).to be_nil
      expect(application.federation_retry_after_seconds("soon", now: now)).to be_nil
    end
  end

  describe PotatoMesh::App::InstanceHttpResponseError do
    it "counts only a 429 or a 503 as the peer asking for less traffic" do
      failures = [429, 503, 500, 404, 304, nil].to_h { |status| [status, described_class.new("x", status: status).peer_failure?] }

      expect(failures).to eq(429 => true, 503 => true, 500 => false, 404 => false, 304 => false, nil => false)
      expect(described_class.new("x", retry_after: 5.0).retry_after).to eq(5.0)
    end
  end

  describe "registration slots" do
    it "holds at most federation_max_registrations_in_flight slots and never goes below zero" do
      claims = Array.new(5) { application.claim_federation_registration_slot }
      application.release_federation_registration_slot
      after_release = application.claim_federation_registration_slot
      6.times { application.release_federation_registration_slot }

      expect(claims).to eq([true, true, true, true, false])
      expect(after_release).to be(true)
      expect(PotatoMesh::App::Federation.registration_slots[:in_flight]).to eq(0)
    end
  end

  describe ".clear_federation_crawl_state!" do
    it "forgets the peer store and the registration slots" do
      PotatoMesh::App::Federation.peer_backoff.claim("peer", cooldown: 900)
      application.claim_federation_registration_slot

      application.clear_federation_crawl_state!

      expect(PotatoMesh::App::Federation.peer_backoff.wait_seconds("peer", cooldown: 900)).to eq(0.0)
      expect(PotatoMesh::App::Federation.registration_slots[:in_flight]).to eq(0)
    end
  end

  describe PotatoMesh::App::Federation::CrawlState do
    let(:time) { [0.0] }
    let(:crawl) do
      described_class.new(own_domain: "own.mesh", max_domains: 2, max_requests: 3, deadline_seconds: 10, clock: -> { time.first })
    end

    it "spends requests within its request budget" do
      3.times do
        expect(crawl.request_allowed?("a.mesh")).to be(true)
        crawl.spend_request("a.mesh")
      end

      expect(crawl.request_allowed?("a.mesh")).to be(false)
      expect(crawl.stop_reason).to eq("request budget spent")
      expect(crawl.requests).to eq(3)
      expect(crawl.stopped?).to be(true)
    end

    it "counts domains, not requests, against its domain budget" do
      %w[a.mesh b.mesh].each do |domain|
        crawl.request_allowed?(domain)
        crawl.spend_request(domain)
      end

      expect(crawl.request_allowed?("b.mesh")).to be(true)
      expect(crawl.request_allowed?("c.mesh")).to be(false)
      expect(crawl.stop_reason).to eq("domain limit reached")
      expect(crawl.fetched_domains.to_a).to eq(%w[a.mesh b.mesh])
    end

    it "stops once its deadline passes" do
      expect(crawl.stopped?).to be(false)
      time[0] = 10.0

      expect(crawl.stopped?).to be(true)
      expect(crawl.request_allowed?("a.mesh")).to be(false)
      expect(crawl.stop_reason).to eq("deadline passed")
    end

    it "knows its own domain, its claims, its walks and its visits" do
      crawl.claim("a.mesh")
      crawl.walk("a.mesh")
      crawl.record_visit("a.mesh", { domain: "a.mesh", accepted: true })

      expect([crawl.own_domain?("own.mesh"), crawl.own_domain?("a.mesh")]).to eq([true, false])
      expect(described_class.new(own_domain: nil, max_domains: 1, max_requests: 1, deadline_seconds: 1).own_domain?(nil)).to be(false)
      expect([crawl.claimed?("a.mesh"), crawl.claimed?("b.mesh")]).to eq([true, false])
      expect([crawl.walked?("a.mesh"), crawl.walked?("b.mesh")]).to eq([true, false])
      expect(crawl.visit("a.mesh")).to eq(domain: "a.mesh", accepted: true)
      expect(crawl.visit("b.mesh")).to be_nil
    end

    it "fetches a domain's well-known once, a failure included" do
      calls = 0
      results = Array.new(2) { crawl.well_known("a.mesh") { calls += 1 and [nil, ["refused"]] } }

      expect(results).to eq([[nil, ["refused"]], [nil, ["refused"]]])
      expect(calls).to eq(1)
    end

    it "lets one port variant of each host fetch its well-known" do
      takes = [%w[a.mesh a.mesh:8443], %w[a.mesh a.mesh:8443], %w[a.mesh a.mesh:9443], %w[b.mesh b.mesh:9443]].map do |host, domain|
        crawl.port_variant_fetch?(host, domain)
      end

      expect(takes).to eq([true, true, false, true])
    end
  end
end
