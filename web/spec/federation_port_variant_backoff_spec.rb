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

# Regression guard for gap FL-G1 (SPEC PV1): an unauthenticated registration,
# or a relayed crawl record, for a peer's non-default, unreachable port must
# not lock the genuine peer, reached on its default port, out of federation.
#
# The peer fetch cooldown, backoff and kept knowledge are keyed per endpoint
# (+federation_backoff_key+): a host's default port is one key and all its
# port variants share another. A refused fetch of +victim:<closed port>+ backs
# off only the variants' key, so the genuine peer stays verifiable and
# reachable by registrations, crawls and the announcer. Before PV1 the key was
# the bare host, so that refusal claimed and backed off the genuine peer too.
# A crawl claims the key of every endpoint it fetches, so it keeps what it
# learned for a registration inside the cooldown, and it skips an endpoint
# whose cooldown another claim holds (SPEC FL3, FL7).
#
# Runs through the app's real request and crawl code against the in-process
# fake federation (no socket leaves the process, test domains use +.invalid+).
RSpec.describe "Federation port-variant registrations and a peer's backoff (FL-G1)" do
  include_context "fake federation peers"

  let(:peers) { FederationFakePeers }
  let(:application) { FederationFakePeers::APP }
  let(:victim) { "victim.fed.invalid" }
  let(:closed_port) { 8443 }
  let(:variant) { "#{victim}:#{closed_port}" }
  let(:relayer) { "relayer.fed.invalid" }
  let(:attacker_key) { peers::KEYS["attacker-key"] }

  # The key stored for +domain+.
  #
  # @param domain [String] instance domain.
  # @return [String, nil] PEM public key.
  def stored_key(domain)
    with_db { |db| db.get_first_value("SELECT pubkey FROM instances WHERE domain = ?", domain) }
  end

  # Requests the fake peers logged for +authority+ (Host header, so a
  # non-default port is distinct from the bare host) of a given kind.
  #
  # @param authority [String] the request authority (host, or host:port).
  # @param kind [Symbol] a {FederationFakePeers::KINDS} entry.
  # @return [Integer] request count.
  def requests_to(authority, kind)
    fed.log.count { |entry| entry[:headers]["host"] == authority && entry[:kind] == kind }
  end

  # Skip reasons logged for +domain+ under +message+.
  #
  # @param message [String] the log message.
  # @param domain [String] the domain the skip names.
  # @return [Array<String>] the reasons.
  def skip_reasons(message, domain)
    log_lines(message).map { |line| line[2] }.select { |meta| meta[:domain] == domain }.map { |meta| meta[:reason] }
  end

  before do
    # The victim's chosen port is closed: every connection to victim:8443 is
    # refused, as a real peer that serves no such port would refuse it, while
    # the bare victim on its default port answers normally.
    closed = variant
    fed.hooks << lambda do |entry|
      raise Errno::ECONNREFUSED, "spec: #{closed} refuses" if entry[:headers]["host"] == closed
    end
  end

  describe "an unauthenticated registration for a closed port variant" do
    it "leaves the genuine bare-domain peer able to register" do
      forged = announce(variant, attacker_key)
      expect(forged.status).to eq(400)

      genuine = announce(victim)

      expect(genuine.status).to eq(201)
      expect(stored_key(victim)).to eq(peers::KEYS[victim].public_key.to_pem)
    end

    it "lets a crawl still reach the bare-domain peer" do
      announce(variant, attacker_key)
      fed.lists[victim] = []
      logs.clear

      crawl(victim)

      expect(requests_to(victim, :instances)).to be >= 1
      expect(skip_reasons("Skipped remote instance crawl", victim)).not_to include("peer backoff", "peer fetch cooldown")
    end

    it "lets the announcer still reach the bare-domain peer" do
      announce(variant, attacker_key)
      allow(application).to receive(:federation_target_domains).and_return([victim])
      logs.clear

      application.announce_instance_to_all_domains

      expect(requests_to(victim, :instances)).to be >= 1
      expect(skip_reasons("Skipped federation announcement", victim)).to be_empty
    end
  end

  describe "a forged closed-port variant relayed in a crawl" do
    it "leaves the genuine bare-domain peer able to register" do
      fed.lists[relayer] = [peers.record(variant, attacker_key)]
      crawl(relayer)

      genuine = announce(victim)

      expect(genuine.status).to eq(201)
      expect(stored_key(victim)).to eq(peers::KEYS[victim].public_key.to_pem)
    end

    it "lets a later crawl still reach the bare-domain peer" do
      fed.lists[relayer] = [peers.record(variant, attacker_key)]
      crawl(relayer)
      fed.lists[victim] = []
      logs.clear

      crawl(victim)

      expect(requests_to(victim, :instances)).to be >= 1
      expect(skip_reasons("Skipped remote instance crawl", victim)).not_to include("peer backoff", "peer fetch cooldown")
    end

    it "lets the announcer still reach the bare-domain peer" do
      fed.lists[relayer] = [peers.record(variant, attacker_key)]
      crawl(relayer)
      allow(application).to receive(:federation_target_domains).and_return([victim])
      logs.clear

      application.announce_instance_to_all_domains

      expect(requests_to(victim, :instances)).to be >= 1
      expect(skip_reasons("Skipped federation announcement", victim)).to be_empty
    end
  end

  describe "a crawl that reaches both endpoints of a host" do
    it "claims each endpoint's cooldown, so a registration inside it is answered from the crawl's fetches" do
      fed.lists[relayer] = [peers.record(variant, attacker_key), peers.record(victim)]
      crawl(relayer)
      fetched = requests_to(victim, :well_known) + requests_to(victim, :nodes_acceptance)

      genuine = announce(victim, name: "Newer", last_update_time: Time.now.to_i + 60)

      expect(genuine.status).to eq(201)
      expect(requests_to(victim, :well_known) + requests_to(victim, :nodes_acceptance)).to eq(fetched)
    end

    it "skips an endpoint whose cooldown a registration holds, after claiming the host's other endpoint" do
      expect(announce(victim, attacker_key).status).to eq(400)
      fetched = requests_to(victim, :well_known)
      fed.lists[relayer] = [peers.record(variant, attacker_key), peers.record(victim)]
      logs.clear

      crawl(relayer)

      expect(requests_to(victim, :well_known)).to eq(fetched)
      expect(skip_reasons("Skipped remote instance entry", victim)).to eq(["peer fetch cooldown"])
    end
  end
end
