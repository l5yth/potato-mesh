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

# Registrations inside a peer host's fetch cooldown are judged against what
# the fetch that started the cooldown kept (SPEC FL7), an announcement never
# rolls the stored row back (SPEC FL1, FL7), and the first crawl runs with the
# first announcement after boot (SPEC FL3). Through the app's real request code
# against the fake federation.
RSpec.describe "Federation registrations inside a peer's cooldown" do
  include_context "fake federation peers"

  let(:peers) { FederationFakePeers }
  let(:application) { FederationFakePeers::APP }
  let(:root) { "root.fed.invalid" }
  let(:a) { "a.fed.invalid" }
  let(:x) { "x.fed.invalid" }
  let(:attacker_key) { peers::KEYS["attacker-key"] }

  # The key stored for +domain+.
  #
  # @param domain [String] instance domain.
  # @return [String, nil] PEM public key.
  def stored_key(domain)
    with_db { |db| db.get_first_value("SELECT pubkey FROM instances WHERE domain = ?", domain) }
  end

  # The name and signed last update stored for +domain+.
  #
  # @param domain [String] instance domain.
  # @return [Array(String, Integer), nil] name and last update time.
  def stored_name_and_update(domain)
    with_db { |db| db.get_first_row("SELECT name, last_update_time FROM instances WHERE domain = ?", domain) }
  end

  # The error a response carries.
  #
  # @param response [Rack::MockResponse] the response.
  # @return [String, nil] its +error+ field.
  def error_of(response)
    JSON.parse(response.body)["error"]
  end

  describe "judged against what the fetch that started the cooldown kept (FL7)" do
    it "accepts a genuine first registration inside a cooldown a forged one started, without a fetch" do
      forged = announce(a, attacker_key)
      expect([forged.status, error_of(forged)]).to eq([400, "public key mismatch"])
      expect(fed.counts(a)).to eq(well_known: 1, nodes_acceptance: 1)

      genuine = announce(a)

      expect(genuine.status).to eq(201)
      expect(stored_key(a)).to eq(peers::KEYS[a].public_key.to_pem)
      expect(fed.counts(a)).to eq(well_known: 1, nodes_acceptance: 1)
    end

    it "accepts a genuine key change inside the cooldown when the kept document names the new key" do
      with_db { |db| peers.store(db, a, peers::KEYS["a-retired-key"]) }
      expect(announce(a, attacker_key).status).to eq(400)

      response = announce(a)

      expect(response.status).to eq(201)
      expect(stored_key(a)).to eq(peers::KEYS[a].public_key.to_pem)
      expect(fed.counts(a)).to eq(well_known: 1, nodes_acceptance: 1)
    end

    it "refuses a forged registration inside the cooldown a genuine one started, without a fetch" do
      expect(announce(a).status).to eq(201)

      response = announce(a, attacker_key)

      expect([response.status, error_of(response)]).to eq([400, "public key mismatch"])
      expect(stored_key(a)).to eq(peers::KEYS[a].public_key.to_pem)
      expect(fed.counts(a)).to eq(well_known: 1, nodes_acceptance: 1)
      expect(log_lines("Instance registration rejected").last[2]).to include(reason: "public key mismatch", cached: true)
    end

    it "refuses a registration inside the cooldown whose kept node list refused the peer" do
      fed.nodes[a] = peers.fresh_nodes(10, newest_age: 8 * 86_400)
      expect(announce(a, attacker_key).status).to eq(400)

      response = announce(a)

      expect([response.status, error_of(response)]).to eq([400, "insufficient nodes"])
      expect(stored_rows).to eq([])
      expect(fed.counts(a)).to eq(well_known: 1, nodes_acceptance: 1)
    end

    it "refuses a registration inside the cooldown whose kept well-known fetch failed" do
      fed.refused << a
      expect(announce(a, attacker_key).status).to eq(400)
      attempts = fed.total(a)

      response = announce(a)

      expect([response.status, error_of(response)]).to eq([400, "failed to verify well-known document"])
      expect(fed.total(a)).to eq(attempts)
    end

    it "refuses a newer copy under the stored key inside the cooldown when the kept node list refused the peer" do
      now = Time.now.to_i
      with_db { |db| peers.store(db, a, name: "Stored", last_update_time: now - 120) }
      fed.nodes[a] = peers.fresh_nodes(10, newest_age: 8 * 86_400)
      expect(announce(a, last_update_time: now - 60).status).to eq(400)

      response = announce(a, name: "Newer", last_update_time: now)

      expect([response.status, error_of(response)]).to eq([400, "insufficient nodes"])
      expect(stored_name_and_update(a)).to eq(["Stored", now - 120])
      expect(fed.counts(a)).to eq(nodes_acceptance: 1)
    end

    it "answers a registration inside a cooldown a crawl started from the crawl's own fetches" do
      fed.lists[root] = [peers.record(x)]
      crawl(root)

      response = announce(x, attacker_key)

      expect([response.status, error_of(response)]).to eq([400, "public key mismatch"])
      expect(fed.counts(x)).to eq(instances: 1, well_known: 1, nodes_acceptance: 1)
    end

    it "answers 503 to a new key whose kept document vouches when no node list was kept" do
      fed.lists[root] = [peers.record(x, attacker_key)]
      crawl(root)
      expect(fed.counts(x)).to eq(well_known: 1)

      response = announce(x)

      expect(response.status).to eq(503)
      expect(fed.counts(x)).to eq(well_known: 1)
    end

    it "answers 503 to a newer copy under the stored key when the cooldown kept no node list" do
      now = Time.now.to_i
      with_db { |db| peers.store(db, x, name: "Stored", last_update_time: now - 60) }
      crawl(x)

      response = announce(x, name: "Newer", last_update_time: now)

      expect([response.status, error_of(response)]).to eq([503, "peer fetch cooldown"])
      expect(stored_name_and_update(x)).to eq(["Stored", now - 60])
      expect(fed.counts(x)).to eq(instances: 1)
    end

    it "answers 503 to a newer copy under the stored key from a host that still backs off after its cooldown" do
      now = Time.now.to_i
      with_db { |db| peers.store(db, x, name: "Stored", last_update_time: now - 600) }
      fed.nodes[x] = peers.fresh_nodes(10, newest_age: 8 * 86_400)
      PotatoMesh::App::Federation.peer_backoff.claim(x, cooldown: 900)
      8.times { PotatoMesh::App::Federation.peer_backoff.record_failure(x) }

      response = travel(1_000) { announce(x, name: "Newer", nodes_count: 0, last_update_time: now + 1_000) }

      expect([response.status, error_of(response)]).to eq([503, "peer backoff"])
      expect(response.headers["Retry-After"].to_i).to be > 900
      expect(stored_name_and_update(x)).to eq(["Stored", now - 600])
      expect(fed.total(x)).to eq(0)
    end

    it "answers 503 for another domain on the host, whose fetch kept nothing for it" do
      expect(announce("#{a}:8443").status).to eq(400)

      response = announce(a)

      expect(response.status).to eq(503)
      expect(fed.counts(a)).to eq(well_known: 1, nodes_acceptance: 1)
    end

    it "lets what a fetch kept expire with the cooldown" do
      expect(announce(a).status).to eq(201)

      travel(901) { expect(announce(a, attacker_key).status).to eq(400) }

      expect(fed.counts(a)).to eq(well_known: 2, nodes_acceptance: 2)
    end
  end

  describe "the newest copy wins on POST /api/instances (FL1, FL7)" do
    it "answers an older copy under the stored key 201 without a fetch or a change" do
      now = Time.now.to_i
      expect(announce(a, name: "Current", last_update_time: now).status).to eq(201)

      response = travel(901) { announce(a, name: "Old", last_update_time: now - 120) }

      expect(response.status).to eq(201)
      expect(JSON.parse(response.body)).to eq("status" => "registered")
      expect(stored_name_and_update(a)).to eq(["Current", now])
      expect(fed.counts(a)).to eq(well_known: 1, nodes_acceptance: 1)
    end

    it "answers an older copy under another form of the stored domain 201 without a fetch or a change" do
      now = Time.now.to_i
      with_db { |db| peers.store(db, a, name: "Current", last_update_time: now) }

      response = announce("#{a}:443", peers::KEYS[a], name: "Old", last_update_time: now - 120)

      expect(response.status).to eq(201)
      expect(stored_rows.map(&:first)).to eq([a])
      expect(stored_name_and_update(a)).to eq(["Current", now])
      expect(fed.total(a)).to eq(0)
    end

    it "answers an equal copy under the stored key 201 without a fetch" do
      payload = JSON.generate(peers.payload(a))
      post "/api/instances", payload, json_headers
      expect(last_response.status).to eq(201)

      travel(901) { post "/api/instances", payload, json_headers }

      expect(last_response.status).to eq(201)
      expect(fed.counts(a)).to eq(well_known: 1, nodes_acceptance: 1)
    end

    it "stores a newer copy under the stored key after one node-list request, without the well-known" do
      now = Time.now.to_i
      with_db { |db| peers.store(db, a, name: "Current", last_update_time: now - 60) }

      response = announce(a, name: "Newer", last_update_time: now)

      expect(response.status).to eq(201)
      expect(stored_name_and_update(a)).to eq(["Newer", now])
      expect(fed.total(a)).to eq(1)
      expect(fed.counts(a)).to eq(nodes_acceptance: 1)
    end

    it "still reads the well-known for a key change outside the cooldown" do
      with_db { |db| peers.store(db, a, peers::KEYS["a-retired-key"]) }

      response = announce(a)

      expect(response.status).to eq(201)
      expect(stored_key(a)).to eq(peers::KEYS[a].public_key.to_pem)
      expect(fed.counts(a)).to eq(well_known: 1, nodes_acceptance: 1)
    end

    it "keeps a newer copy stored while an older announcement was being verified" do
      now = Time.now.to_i
      fed.hooks << lambda do |entry|
        next unless entry[:kind] == :well_known

        with_db { |db| peers.store(db, a, name: "Stored meanwhile", last_update_time: now) }
      end

      response = announce(a, name: "Announced", last_update_time: now - 30)

      expect(response.status).to eq(201)
      expect(stored_name_and_update(a)).to eq(["Stored meanwhile", now])
    end
  end

  describe "the first crawl after boot (FL3)" do
    it "runs the first crawl after the boot delay, with the first announcement" do
      announcements = 0
      roots = []
      allow(PotatoMesh::Config).to receive(:initial_federation_delay_seconds).and_return(0)
      allow(application).to receive(:announce_instance_to_all_domains) { announcements += 1 }
      allow(application).to receive(:ingest_known_instances_from!) { |_db, domain, **| roots << domain }

      thread = application.start_initial_federation_announcement!
      thread.join(5)

      expect(thread.alive?).to be(false)
      expect(announcements).to eq(1)
      expect(roots).to eq(PotatoMesh::Config.federation_seed_domains)
    end
  end
end
