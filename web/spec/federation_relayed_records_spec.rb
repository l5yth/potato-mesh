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
require "digest"
require "json"
require "openssl"
require "uri"
require_relative "support/federation_identity"

# A crawl stores the federation records that other peers relay. Such a record
# proves only that it was signed by the key it carries. Unless it refreshes
# the row stored for its domain under the same key, it is stored only when
# that domain's own well-known document names its key (SPEC FS8). A relayed
# record and a direct announcement alike must carry the id their key derives,
# its SHA-256 (SPEC FS9). The registration route runs the same well-known
# check on direct announcements.
RSpec.describe "Federation relayed records" do
  let(:application_class) { PotatoMesh::Application }
  let(:relay_domain) { "relay.mesh" }
  let(:domain) { "genuine.mesh" }
  let(:genuine_key) { OpenSSL::PKey::RSA.new(2048) }
  let(:other_key) { OpenSSL::PKey::RSA.new(2048) }
  let(:well_known_path) { "/.well-known/potato-mesh" }
  let(:fresh_nodes) do
    Array.new(PotatoMesh::Config.remote_instance_min_node_count) do |index|
      { "node_id" => format("!%08x", index), "last_heard" => Time.now.to_i - index }
    end
  end

  # Rack::Test entry point for the registration route examples.
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
    db = application_class.open_database
    yield db
  ensure
    db&.close
  end

  # Instance attributes for +domain_value+ under +key+, as that instance
  # signs them.
  #
  # @param key [OpenSSL::PKey::RSA] the instance key.
  # @param domain_value [String] the instance domain.
  # @param overrides [Hash] attributes replacing the defaults.
  # @return [Hash] instance attributes.
  def instance_attributes(key, domain_value = domain, **overrides)
    pem = key.public_key.to_pem
    {
      id: Digest::SHA256.hexdigest(pem),
      domain: domain_value,
      pubkey: pem,
      name: "Genuine Mesh",
      version: "v0.8.0",
      channel: "#MeshNet",
      frequency: "868MHz",
      latitude: 52.5,
      longitude: 13.4,
      last_update_time: Time.now.to_i,
      is_private: false,
      nodes_count: 12,
      meshcore_nodes_count: 4,
      meshtastic_nodes_count: 8,
      reticulum_nodes_count: 0,
    }.merge(overrides)
  end

  # Sign +attributes+ with +key+ over the v2 canonical.
  #
  # @param key [OpenSSL::PKey::RSA] signing key.
  # @param attributes [Hash] instance attributes.
  # @return [String] base64 signature.
  def sign(key, attributes)
    canonical = application_class.canonical_instance_payload(attributes)
    Base64.strict_encode64(key.sign(OpenSSL::Digest::SHA256.new, canonical))
  end

  # A record signed with +key+, decoded from its wire form.
  #
  # @param key [OpenSSL::PKey::RSA] signing key.
  # @param attributes [Hash] instance attributes.
  # @return [Hash] the record as a peer's +/api/instances+ entry.
  def wire_record(key, attributes)
    payload = application_class.instance_announcement_payload(attributes, sign(key, attributes))
    JSON.parse(JSON.generate(payload))
  end

  # The +fetch_instance_json+ result for a well-known document in which
  # +domain_value+ names +key+.
  #
  # @param key [OpenSSL::PKey::RSA] the key the document names.
  # @param domain_value [String] the domain the document describes.
  # @return [Array(Hash, URI::Generic)] decoded document and its URI.
  def well_known(key, domain_value = domain)
    [FederationIdentitySupport.well_known_document(key, domain_value), URI("https://#{domain_value}#{well_known_path}")]
  end

  # The row stored for +domain+.
  #
  # @return [Array(String, String, String), nil] id, public key and name.
  def stored_row
    with_db { |db| db.get_first_row("SELECT id, pubkey, name FROM instances WHERE domain = ?", domain) }
  end

  # Every stored row.
  #
  # @return [Array<Array(String, String, String)>] id, domain and public key, by domain.
  def stored_rows
    with_db { |db| db.execute("SELECT id, domain, pubkey FROM instances ORDER BY domain") }
  end

  # Store +attributes+ signed with +key+, as an accepted announcement does.
  #
  # @param key [OpenSSL::PKey::RSA] signing key.
  # @param attributes [Hash] instance attributes.
  # @return [void]
  def store(key, attributes)
    with_db { |db| application_class.upsert_instance_record(db, attributes, sign(key, attributes)) }
  end

  let(:warnings) { [] }

  # Enable federation, keep DNS offline, answer the registration route's
  # well-known fetch with +result+ and its node fetch with fresh nodes, record
  # its warnings, and schedule no crawl.
  #
  # @param result [Array] result returned for +/.well-known/potato-mesh+.
  # @return [void]
  def stub_registration(result)
    allow(PotatoMesh::Config).to receive(:federation_enabled?).and_return(true)
    allow_any_instance_of(Sinatra::Application).to receive(:resolve_remote_ip_addresses).and_return([])
    allow_any_instance_of(Sinatra::Application).to receive(:enqueue_federation_crawl).and_return(false)
    allow_any_instance_of(Sinatra::Application).to receive(:fetch_instance_json) do |_instance, host, path|
      if path == well_known_path
        result
      elsif path == "/api/nodes"
        [fresh_nodes, URI("https://#{host}#{path}")]
      else
        [nil, ["#{host}#{path}: not served"]]
      end
    end
    allow_any_instance_of(Sinatra::Application).to receive(:warn_log) do |_instance, message, **metadata|
      warnings << [message, metadata]
    end
  end

  # POST +attributes+ as an announcement signed with +key+.
  #
  # @param key [OpenSSL::PKey::RSA] signing key.
  # @param attributes [Hash] instance attributes.
  # @return [void]
  def register(key, attributes)
    payload = application_class.instance_announcement_payload(attributes, sign(key, attributes))
    post "/api/instances", payload.to_json, { "CONTENT_TYPE" => "application/json" }
  end

  before do
    FileUtils.mkdir_p(File.dirname(PotatoMesh::Config.db_path))
    application_class.init_db unless application_class.db_schema_present?
    application_class.ensure_schema_upgrades
    with_db { |db| db.execute("DELETE FROM instances") }
  end

  describe "crawling a peer that relays a record" do
    let(:fetched) { [] }
    let(:refused) { "https://#{domain}#{well_known_path}: Errno::ECONNREFUSED: Connection refused" }

    # Serve +relayed+ as the relaying peer's records and +well_known+ as the
    # domains' identity documents. Node lists are fresh and peers relay
    # nothing further; nothing touches the network.
    #
    # @param relayed [Hash, Array<Hash>] the relayed record or records, in
    #   listing order.
    # @param well_known [Array, Hash{String => Array}] +fetch_instance_json+
    #   result for every domain's +/.well-known/potato-mesh+, or one per domain.
    # @return [void]
    def stub_peers(relayed:, well_known:)
      listing = relayed.is_a?(Array) ? relayed : [relayed]
      allow(application_class).to receive(:fetch_instance_json) do |host, path|
        fetched << [host, path]
        if host == relay_domain && path == "/api/instances"
          [listing, URI("https://#{host}#{path}")]
        elsif path == well_known_path
          well_known.is_a?(Hash) ? well_known.fetch(host) { [nil, ["#{host}#{path}: not served"]] } : well_known
        elsif path.start_with?("/api/nodes")
          [fresh_nodes, URI("https://#{host}#{path}")]
        elsif path == "/api/instances"
          [[], URI("https://#{host}#{path}")]
        else
          [nil, ["#{host}#{path}: not served"]]
        end
      end
    end

    # Crawl the relaying peer once.
    #
    # @return [Set<String>] visited domains.
    def crawl
      with_db { |db| application_class.ingest_known_instances_from!(db, relay_domain) }
    end

    # Assert that the crawl skipped a record for +record_domain+ with +reason+.
    #
    # @param record_domain [String] domain of the skipped record.
    # @param reason [String] expected log reason.
    # @return [void]
    def expect_discarded(record_domain, reason)
      expect(application_class).to have_received(:warn_log).with(
        "Discarded remote instance entry",
        hash_including(
          context: "federation.instances",
          domain: record_domain,
          reason: reason,
          relayed_by: relay_domain,
        ),
      )
    end

    # Number of well-known fetches the crawls made.
    #
    # @return [Integer] fetches of any domain's well-known document.
    def well_known_fetches
      fetched.count { |_host, path| path == well_known_path }
    end

    before do
      application_class.clear_federation_shutdown_request!
      allow(application_class).to receive(:warn_log)
    end

    context "when the stored row for the domain holds another key" do
      let(:genuine) { instance_attributes(genuine_key) }

      before { store(genuine_key, genuine) }

      it "keeps the stored row when the domain's well-known names the stored key" do
        forged = instance_attributes(other_key, name: "Forged Mesh")
        stub_peers(relayed: wire_record(other_key, forged), well_known: well_known(genuine_key))

        crawl

        expect(stored_row).to eq([genuine[:id], genuine[:pubkey], "Genuine Mesh"])
        expect(well_known_fetches).to eq(1)
        expect_discarded(domain, "unconfirmed key change: public key mismatch")
      end

      it "keeps the stored row when the domain's well-known cannot be fetched" do
        forged = instance_attributes(other_key, name: "Forged Mesh")
        stub_peers(relayed: wire_record(other_key, forged), well_known: [nil, [refused]])

        crawl

        expect(stored_row).to eq([genuine[:id], genuine[:pubkey], "Genuine Mesh"])
        expect_discarded(domain, "unconfirmed key change: #{refused}")
      end

      it "accepts a key rotation that the domain's well-known confirms" do
        rotated = instance_attributes(other_key, name: "Rotated Mesh")
        stub_peers(relayed: wire_record(other_key, rotated), well_known: well_known(other_key))

        crawl

        expect(stored_row).to eq([rotated[:id], rotated[:pubkey], "Rotated Mesh"])
        expect(well_known_fetches).to eq(1)
      end

      it "refreshes the stored row from a record under the stored key without fetching the well-known" do
        refreshed = genuine.merge(name: "Genuine Mesh renamed", last_update_time: genuine[:last_update_time] + 60)
        stub_peers(relayed: wire_record(genuine_key, refreshed), well_known: [nil, ["not expected"]])

        crawl

        expect(stored_row).to eq([genuine[:id], genuine[:pubkey], "Genuine Mesh renamed"])
        expect(well_known_fetches).to eq(0)
      end
    end

    context "when the record's id is not the SHA-256 of its key" do
      let(:genuine) { instance_attributes(genuine_key) }
      # The genuine instance's id under the attacker's key, for the attacker's
      # own domain, which vouches for that key: only the id rule stops it.
      let(:hijack) { instance_attributes(other_key, "attacker.mesh", id: genuine[:id], name: "Hijacked") }
      let(:attacker_well_known) { well_known(other_key, "attacker.mesh") }

      it "keeps a stored row when the record would move its id to the record's domain" do
        store(genuine_key, genuine)
        stub_peers(relayed: wire_record(other_key, hijack), well_known: attacker_well_known)

        crawl

        expect(stored_rows).to eq([[genuine[:id], domain, genuine[:pubkey]]])
        expect(fetched).to eq([[relay_domain, "/api/instances"]])
        expect_discarded("attacker.mesh", "id does not match key")
      end

      it "keeps a stored row when the record would re-key it in place" do
        store(genuine_key, genuine)
        forged = instance_attributes(other_key, id: genuine[:id], name: "Forged Mesh")
        stub_peers(relayed: wire_record(other_key, forged), well_known: well_known(other_key))

        crawl

        expect(stored_row).to eq([genuine[:id], genuine[:pubkey], "Genuine Mesh"])
        expect(fetched).to eq([[relay_domain, "/api/instances"]])
        expect_discarded(domain, "id does not match key")
      end

      it "stores the genuine record when a record squatting its id is listed first" do
        stub_peers(
          relayed: [wire_record(other_key, hijack), wire_record(genuine_key, genuine)],
          well_known: { "attacker.mesh" => attacker_well_known, domain => well_known(genuine_key) },
        )

        crawl

        expect(stored_rows).to eq([[genuine[:id], domain, genuine[:pubkey]]])
        expect_discarded("attacker.mesh", "id does not match key")
      end

      it "keeps a genuine row stored between the check of a record carrying its id and that record's upsert" do
        # Simulate the genuine instance announcing directly while the crawl
        # handles the record: its row lands right after the check.
        allow(application_class).to receive(:confirm_relayed_instance_key).and_wrap_original do |original, *args|
          original.call(*args).tap { store(genuine_key, genuine) }
        end
        stub_peers(relayed: wire_record(other_key, hijack), well_known: attacker_well_known)

        crawl

        expect(stored_rows).to eq([[genuine[:id], domain, genuine[:pubkey]]])
      end
    end

    context "when no row is stored for the domain" do
      it "skips a record whose domain's well-known names another key" do
        forged = instance_attributes(other_key, name: "Forged Mesh")
        stub_peers(relayed: wire_record(other_key, forged), well_known: well_known(genuine_key))

        crawl

        expect(stored_rows).to eq([])
        expect_discarded(domain, "unconfirmed new domain: public key mismatch")
      end

      it "skips a record whose domain's well-known cannot be fetched" do
        record = instance_attributes(genuine_key)
        stub_peers(relayed: wire_record(genuine_key, record), well_known: [nil, [refused]])

        crawl

        expect(stored_rows).to eq([])
        expect_discarded(domain, "unconfirmed new domain: #{refused}")
      end

      it "stores a record its domain's well-known confirms, fetching that document once" do
        record = instance_attributes(genuine_key)
        stub_peers(relayed: wire_record(genuine_key, record), well_known: well_known(genuine_key))

        2.times { crawl }

        expect(stored_row).to eq([record[:id], record[:pubkey], "Genuine Mesh"])
        expect(well_known_fetches).to eq(1)
      end
    end
  end

  describe "POST /api/instances well-known check" do
    let(:genuine) { instance_attributes(genuine_key) }

    it "rejects an announcement whose well-known document cannot be fetched" do
      stub_registration([nil, []])

      register(genuine_key, genuine)

      expect(last_response.status).to eq(400)
      expect(JSON.parse(last_response.body)).to eq("error" => "failed to verify well-known document")
      expect(warnings).to include(
        [
          "Instance registration rejected",
          hash_including(domain: domain, reason: "failed to fetch well-known document", details: "no response"),
        ],
      )
      expect(stored_row).to be_nil
    end

    it "rejects an announcement whose well-known document names another key" do
      stub_registration(well_known(other_key))

      register(genuine_key, genuine)

      expect(last_response.status).to eq(400)
      expect(JSON.parse(last_response.body)).to eq("error" => "public key mismatch")
      expect(warnings).to include(
        ["Instance registration rejected", hash_including(domain: domain, reason: "public key mismatch")],
      )
      expect(stored_row).to be_nil
    end

    it "falls back to a generic reason when the well-known validator names none" do
      stub_registration(well_known(genuine_key))
      allow_any_instance_of(Sinatra::Application).to receive(:validate_well_known_document).and_return([false, nil])

      register(genuine_key, genuine)

      expect(last_response.status).to eq(400)
      expect(JSON.parse(last_response.body)).to eq("error" => "invalid well-known document")
      expect(stored_row).to be_nil
    end
  end

  describe "POST /api/instances id check" do
    it "rejects an announcement whose id is not the SHA-256 of its key" do
      genuine = instance_attributes(genuine_key)
      store(genuine_key, genuine)
      # From the attacker's own domain, which vouches for the attacker's key
      # and serves fresh nodes: only the id rule stops the announcement.
      hijack = instance_attributes(other_key, "attacker.mesh", id: genuine[:id], name: "Hijacked")
      stub_registration(well_known(other_key, "attacker.mesh"))

      register(other_key, hijack)

      expect(last_response.status).to eq(400)
      expect(JSON.parse(last_response.body)).to eq("error" => "id does not match key")
      expect(warnings).to include(
        ["Instance registration rejected", hash_including(domain: "attacker.mesh", reason: "id does not match key")],
      )
      expect(stored_rows).to eq([[genuine[:id], domain, genuine[:pubkey]]])
    end
  end
end
