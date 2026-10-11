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
require "sqlite3"
require "uri"
require_relative "support/metrics_spec_helpers"
require_relative "support/data_processing_harness"
require_relative "support/federation_identity"
require_relative "support/ingest_spec_helpers"

# Byte caps on ingested strings (SPEC SL1-SL9; ACCEPTANCE SL-A1-SL-A3).
# Every ingest write bounds its record before storing it: free text is cut on
# a grapheme-cluster boundary, tokens over their cap store NULL, records whose
# ids are not in a legitimate form are skipped, an ingestor's protocol is kept
# only when known, and a signed instance field over its cap rejects the
# record instead of being cut.
RSpec.describe "Ingest field limits" do
  include IngestSpecHelpers

  let(:app) { Sinatra::Application }
  let(:api_token) { "field-limits-token" }
  let(:auth_headers) do
    { "CONTENT_TYPE" => "application/json", "HTTP_AUTHORIZATION" => "Bearer #{api_token}" }
  end
  let(:now) { Time.now.to_i }
  # One family emoji: seven code points, 25 bytes, one grapheme cluster.
  let(:family) { "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}" }

  # A +POST /api/nodes+ body holding one Meshtastic entry.
  #
  # @param node_id [String] map key.
  # @param fields [Hash] entry fields merged over a minimal heard node.
  # @return [Hash] request body.
  def node_body(node_id = "!5c000001", fields = {})
    { node_id => { "lastHeard" => now, "user" => { "longName" => "Limit Node", "role" => "CLIENT" } }.merge(fields), "protocol" => "meshtastic" }
  end

  # A minimal text message from a canonical sender.
  #
  # @param fields [Hash] fields merged over the defaults.
  # @return [Hash] message record.
  def message_record(fields = {})
    {
      "id" => 5_100_001, "rx_time" => now, "rx_iso" => Time.at(now).utc.iso8601,
      "from_id" => "!5c000002", "to_id" => "^all", "channel" => 0,
      "portnum" => "TEXT_MESSAGE_APP", "text" => "limit probe", "protocol" => "meshtastic",
    }.merge(fields)
  end

  before do
    @original_token = ENV["API_TOKEN"]
    ENV["API_TOKEN"] = api_token
    with_db do |db|
      %w[messages nodes destinations positions telemetry neighbors traces trace_hops waypoints ingestors instances].each do |table|
        db.execute("DELETE FROM #{table}")
      end
    end
    PotatoMesh::App::ApiCache.invalidate_all
  end

  after do
    @original_token.nil? ? ENV.delete("API_TOKEN") : ENV["API_TOKEN"] = @original_token
    PotatoMesh::App::ApiCache.invalidate_all
  end

  describe "a 1 MB long_name (SL-A1)" do
    it "is stored within 512 bytes as valid UTF-8 ending on a grapheme-cluster boundary" do
      long_name = family * 40_000
      expect(long_name.bytesize).to eq(1_000_000)

      post_ok("/api/nodes", node_body("!b5b5b501", "user" => { "longName" => long_name, "shortName" => "B5" }))

      stored = db_value("SELECT long_name FROM nodes WHERE node_id = '!b5b5b501'")
      aggregate_failures do
        expect(stored.bytesize).to be <= 512
        expect(stored).to be_valid_encoding
        expect(long_name.start_with?(stored)).to be(true)
        # Twenty whole families fit in 500 bytes; a 21st would need 525.
        expect(stored.grapheme_clusters).to eq([family] * 20)
      end

      get "/api/nodes/!b5b5b501"
      expect(last_response).to be_ok
      expect(last_response.body.bytesize).to be < 4096
    end
  end

  describe "each capped column at its cap and one byte over (SL-A2)" do
    # The receive time every record of this group carries.
    let(:rx_time) { now - 30 }

    # [column, policy, cap, route, record builder, query].  A builder takes
    # the probe value and returns the request body; the query reads the
    # stored value back.  +:text+ cuts to the cap, +:token+ stores NULL,
    # +:rx_iso+ stores NULL and the write derives the time from +rx_time+.
    cases = [
      ["nodes.long_name", :text, 512, "/api/nodes", ->(v) { node_body("!5c000001", "user" => { "longName" => v }) }, "SELECT long_name FROM nodes"],
      ["nodes.short_name", :text, 16, "/api/nodes", ->(v) { node_body("!5c000001", "user" => { "shortName" => v }) }, "SELECT short_name FROM nodes"],
      ["nodes.hw_model", :token, 64, "/api/nodes", ->(v) { node_body("!5c000001", "user" => { "hwModel" => v }) }, "SELECT hw_model FROM nodes"],
      # A MeshCore node: the cap is protocol-neutral, and a Meshtastic user
      # without a role would read as the proto3 default CLIENT (SPEC NI5).
      ["nodes.role", :token, 32, "/api/nodes", ->(v) { node_body("!5c000001", "user" => { "role" => v }).merge("protocol" => "meshcore") }, "SELECT role FROM nodes"],
      ["nodes.macaddr", :token, 32, "/api/nodes", ->(v) { node_body("!5c000001", "user" => { "macaddr" => v }) }, "SELECT macaddr FROM nodes"],
      ["nodes.public_key", :token, 512, "/api/nodes", ->(v) { node_body("!5c000001", "user" => { "publicKey" => v }) }, "SELECT public_key FROM nodes"],
      ["nodes.identity_hash", :token, 64, "/api/nodes", ->(v) { node_body("!5c000001", "identityHash" => v) }, "SELECT identity_hash FROM nodes"],
      ["nodes.modem_preset", :token, 32, "/api/nodes", ->(v) { node_body("!5c000001", "modem_preset" => v) }, "SELECT modem_preset FROM nodes"],
      [
        "nodes.location_source", :token, 32, "/api/nodes",
        ->(v) { node_body("!5c000001", "position" => { "latitude" => 52.5, "longitude" => 13.4, "time" => rx_time, "locationSource" => v }) },
        "SELECT location_source FROM nodes",
      ],
      [
        "destinations.id", :token, 64, "/api/nodes",
        ->(v) { node_body("!5c000001", "destination" => { "id" => v, "aspect" => "lxmf.delivery", "role" => "PEER" }) },
        "SELECT id FROM destinations",
      ],
      [
        "destinations.name", :text, 512, "/api/nodes",
        ->(v) { node_body("!5c000001", "user" => { "longName" => v }, "destination" => { "id" => "9c59da5e1516745d74cc908243e0ba2b" }) },
        "SELECT name FROM destinations",
      ],
      [
        "destinations.aspect", :token, 64, "/api/nodes",
        ->(v) { node_body("!5c000001", "destination" => { "id" => "9c59da5e1516745d74cc908243e0ba2b", "aspect" => v }) },
        "SELECT aspect FROM destinations",
      ],
      [
        "destinations.role", :token, 32, "/api/nodes",
        ->(v) { node_body("!5c000001", "destination" => { "id" => "9c59da5e1516745d74cc908243e0ba2b", "role" => v }) },
        "SELECT role FROM destinations",
      ],
      [
        "destinations.interface", :text, 256, "/api/nodes",
        ->(v) { node_body("!5c000001", "interface" => v, "destination" => { "id" => "9c59da5e1516745d74cc908243e0ba2b" }) },
        "SELECT interface FROM destinations",
      ],
      ["messages.text", :text, 1024, "/api/messages", ->(v) { message_record("text" => v) }, "SELECT text FROM messages"],
      ["messages.encrypted", :token, 512, "/api/messages", ->(v) { message_record("encrypted" => v) }, "SELECT encrypted FROM messages"],
      ["messages.channel_name", :text, 64, "/api/messages", ->(v) { message_record("channel_name" => v) }, "SELECT channel_name FROM messages"],
      ["messages.emoji", :token, 64, "/api/messages", ->(v) { message_record("emoji" => v) }, "SELECT emoji FROM messages"],
      ["messages.path", :token, 512, "/api/messages", ->(v) { message_record("path" => v) }, "SELECT path FROM messages"],
      ["messages.portnum", :token, 32, "/api/messages", ->(v) { message_record("portnum" => v) }, "SELECT portnum FROM messages"],
      ["messages.modem_preset", :token, 32, "/api/messages", ->(v) { message_record("modem_preset" => v) }, "SELECT modem_preset FROM messages"],
      ["messages.rx_iso", :rx_iso, 32, "/api/messages", ->(v) { message_record("rx_time" => rx_time, "rx_iso" => v) }, "SELECT rx_iso FROM messages"],
      [
        "positions.location_source", :token, 32, "/api/positions",
        ->(v) { { "id" => 5_100_002, "rx_time" => rx_time, "node_id" => "!5c000003", "latitude" => 52.5, "longitude" => 13.4, "location_source" => v } },
        "SELECT location_source FROM positions",
      ],
      [
        "positions.payload_b64", :token, 512, "/api/positions",
        ->(v) { { "id" => 5_100_002, "rx_time" => rx_time, "node_id" => "!5c000003", "payload_b64" => v } },
        "SELECT payload_b64 FROM positions",
      ],
      [
        "positions.rx_iso", :rx_iso, 32, "/api/positions",
        ->(v) { { "id" => 5_100_002, "rx_time" => rx_time, "rx_iso" => v, "node_id" => "!5c000003" } },
        "SELECT rx_iso FROM positions",
      ],
      [
        "nodes.modem_preset from a position", :token, 32, "/api/positions",
        ->(v) { { "id" => 5_100_002, "rx_time" => rx_time, "node_id" => "!5c000003", "modem_preset" => v } },
        "SELECT modem_preset FROM nodes",
      ],
      [
        "telemetry.portnum", :token, 32, "/api/telemetry",
        ->(v) { { "id" => 5_100_003, "rx_time" => rx_time, "node_id" => "!5c000004", "portnum" => v, "battery_level" => 80 } },
        "SELECT portnum FROM telemetry",
      ],
      [
        "telemetry.payload_b64", :token, 512, "/api/telemetry",
        ->(v) { { "id" => 5_100_003, "rx_time" => rx_time, "node_id" => "!5c000004", "payload_b64" => v, "battery_level" => 80 } },
        "SELECT payload_b64 FROM telemetry",
      ],
      [
        "telemetry.rx_iso", :rx_iso, 32, "/api/telemetry",
        ->(v) { { "id" => 5_100_003, "rx_time" => rx_time, "rx_iso" => v, "node_id" => "!5c000004", "battery_level" => 80 } },
        "SELECT rx_iso FROM telemetry",
      ],
      [
        "telemetry.user_string", :text, 256, "/api/telemetry",
        ->(v) { { "id" => 5_100_003, "rx_time" => rx_time, "node_id" => "!5c000004", "user_string" => v } },
        "SELECT user_string FROM telemetry",
      ],
      [
        "nodes.modem_preset from telemetry", :token, 32, "/api/telemetry",
        ->(v) { { "id" => 5_100_003, "rx_time" => rx_time, "node_id" => "!5c000004", "modem_preset" => v, "battery_level" => 80 } },
        "SELECT modem_preset FROM nodes",
      ],
      [
        "waypoints.name", :text, 128, "/api/waypoints",
        ->(v) { { "id" => 5_100_004, "rx_time" => rx_time, "node_id" => "!5c000005", "name" => v } },
        "SELECT name FROM waypoints",
      ],
      [
        "waypoints.description", :text, 512, "/api/waypoints",
        ->(v) { { "id" => 5_100_004, "rx_time" => rx_time, "node_id" => "!5c000005", "description" => v } },
        "SELECT description FROM waypoints",
      ],
      [
        "waypoints.payload_b64", :token, 512, "/api/waypoints",
        ->(v) { { "id" => 5_100_004, "rx_time" => rx_time, "node_id" => "!5c000005", "payload_b64" => v } },
        "SELECT payload_b64 FROM waypoints",
      ],
      [
        "waypoints.rx_iso", :rx_iso, 32, "/api/waypoints",
        ->(v) { { "id" => 5_100_004, "rx_time" => rx_time, "rx_iso" => v, "node_id" => "!5c000005" } },
        "SELECT rx_iso FROM waypoints",
      ],
      [
        "traces.rx_iso", :rx_iso, 32, "/api/traces",
        ->(v) { { "id" => 5_100_005, "rx_time" => rx_time, "rx_iso" => v, "src" => 0x5c000006, "dest" => 0x5c000007, "hops" => [] } },
        "SELECT rx_iso FROM traces",
      ],
      [
        "ingestors.version", :text, 64, "/api/ingestors",
        ->(v) { { "node_id" => "!5c000008", "start_time" => rx_time, "last_seen_time" => rx_time, "version" => v } },
        "SELECT version FROM ingestors",
      ],
      [
        "ingestors.modem_preset", :token, 32, "/api/ingestors",
        ->(v) { { "node_id" => "!5c000008", "start_time" => rx_time, "last_seen_time" => rx_time, "version" => "0.8.0", "modem_preset" => v } },
        "SELECT modem_preset FROM ingestors",
      ],
    ]

    cases.each do |column, policy, cap, route, builder, query|
      it "keeps #{column} at #{cap} bytes" do
        value = "x" * cap
        post_ok(route, instance_exec(value, &builder))
        expect(db_value(query)).to eq(value)
      end

      expected = { text: "cut to #{cap} bytes", token: "NULL", rx_iso: "derived from rx_time" }.fetch(policy)
      it "stores #{column} at #{cap + 1} bytes as #{expected}" do
        post_ok(route, instance_exec("x" * (cap + 1), &builder))
        stored = db_value(query)
        case policy
        when :text then expect(stored).to eq("x" * cap)
        when :token then expect(stored).to be_nil
        else expect(stored).to eq(Time.at(rx_time).utc.iso8601)
        end
      end
    end

    it "cuts a user_string nested in a JSON-encoded host section" do
      host = { "userString" => "u" * 300 }.to_json
      post_ok("/api/telemetry", { "id" => 5_100_009, "rx_time" => rx_time, "node_id" => "!5c000004", "host_metrics" => host })
      expect(db_value("SELECT user_string FROM telemetry")).to eq("u" * 256)
    end

    it "keeps the first 8 one-wire temperatures" do
      probes = (1..9).map { |i| i + 0.5 }
      post_ok("/api/telemetry", { "id" => 5_100_010, "rx_time" => rx_time, "node_id" => "!5c000004", "one_wire_temperature" => probes })
      expect(JSON.parse(db_value("SELECT one_wire_temperature FROM telemetry"))).to eq(probes.first(8))
    end

    it "cuts a long_name to its cap on a MeshCore chat placeholder that renames a generic node" do
      with_db do |db|
        db.execute(
          "INSERT INTO nodes(node_id, num, short_name, long_name, role, last_heard, first_heard, protocol, synthetic) VALUES (?,?,?,?,?,?,?,?,?)",
          ["!5c00000b", 0x5c00000b, "000B", "Meshcore 000B", "COMPANION", now - 60, now - 60, "meshcore", 0],
        )
      end
      sender = "N" * 600
      post_ok("/api/messages", message_record("from_id" => "!5c00000b", "text" => "#{sender}: hi", "protocol" => "meshcore"))
      expect(db_value("SELECT long_name FROM nodes WHERE node_id = '!5c00000b'")).to eq("N" * 512)
    end
  end

  describe "signed instance fields (SL-A3)" do
    let(:application_class) { PotatoMesh::Application }
    let(:key) { OpenSSL::PKey::RSA.new(2048) }
    let(:domain) { "big.mesh" }
    let(:well_known_path) { "/.well-known/potato-mesh" }
    let(:warnings) { [] }
    let(:fresh_nodes) do
      Array.new(PotatoMesh::Config.remote_instance_min_node_count) do |index|
        { "node_id" => format("!%08x", index), "last_heard" => now - index }
      end
    end

    # Attributes of +domain+ under +key+, its id derived from the key.
    #
    # @param overrides [Hash] attributes replacing the defaults.
    # @return [Hash] instance attributes.
    def instance_attributes(**overrides)
      pem = key.public_key.to_pem
      {
        id: Digest::SHA256.hexdigest(pem), domain: domain, pubkey: pem, name: "Big Mesh",
        version: "v0.8.0", channel: "#MeshNet", frequency: "868MHz", latitude: 52.5, longitude: 13.4,
        last_update_time: now, is_private: false, contact_link: "https://big.mesh/contact",
        nodes_count: 12, meshcore_nodes_count: 4, meshtastic_nodes_count: 8, reticulum_nodes_count: 0,
      }.merge(overrides)
    end

    # Rows stored in +instances+.
    #
    # @return [Array<Array(String, String)>] domain and name of each row.
    def stored_instances
      with_db { |db| db.execute("SELECT domain, name FROM instances").map { |row| row.values_at("domain", "name") } }
    end

    before do
      FileUtils.mkdir_p(File.dirname(PotatoMesh::Config.db_path))
      application_class.init_db unless application_class.db_schema_present?
      application_class.ensure_schema_upgrades
    end

    describe "POST /api/instances" do
      before do
        allow(PotatoMesh::Config).to receive(:federation_enabled?).and_return(true)
        allow_any_instance_of(Sinatra::Application).to receive(:resolve_remote_ip_addresses).and_return([])
        # The crawl-limits change (SPEC FL3) removes the crawl an announcement used to
        # schedule; stub it only while the method exists.
        if Sinatra::Application.method_defined?(:enqueue_federation_crawl) ||
           Sinatra::Application.private_method_defined?(:enqueue_federation_crawl)
          allow_any_instance_of(Sinatra::Application).to receive(:enqueue_federation_crawl).and_return(false)
        end
        allow_any_instance_of(Sinatra::Application).to receive(:fetch_instance_json) do |_instance, host, path|
          if path == well_known_path
            [FederationIdentitySupport.well_known_document(key, domain), URI("https://#{host}#{path}")]
          elsif path.start_with?("/api/nodes")
            [fresh_nodes, URI("https://#{host}#{path}")]
          else
            [nil, ["#{host}#{path}: not served"]]
          end
        end
        allow_any_instance_of(Sinatra::Application).to receive(:warn_log) do |_instance, message, **metadata|
          warnings << [message, metadata]
        end
      end

      # POST an announcement of +attributes+, signed with the instance key.
      #
      # @param attributes [Hash] instance attributes.
      # @return [void]
      def announce(attributes)
        post "/api/instances", FederationIdentitySupport.signed_announcement(key, attributes).to_json, { "CONTENT_TYPE" => "application/json" }
      end

      it "answers 400 to a signed announcement with a 257-byte name, before checking its signature" do
        signature_checks = 0
        allow_any_instance_of(Sinatra::Application).to receive(:verify_instance_signature).and_wrap_original do |original, *args|
          signature_checks += 1
          original.call(*args)
        end

        announce(instance_attributes(name: "M" * 257))

        aggregate_failures do
          expect(last_response.status).to eq(400)
          expect(JSON.parse(last_response.body)).to eq("error" => "name exceeds 256 bytes")
          expect(warnings).to include(
            ["Instance registration rejected", hash_including(context: "ingest.register", domain: domain, reason: "name exceeds 256 bytes")],
          )
          expect(signature_checks).to eq(0)
          expect(stored_instances).to eq([])
        end
      end

      %i[version channel frequency contact_link].each do |field|
        it "answers 400 to a #{field} of 257 bytes" do
          announce(instance_attributes(field => "v" * 257))
          expect(last_response.status).to eq(400)
          expect(JSON.parse(last_response.body)).to eq("error" => "#{field} exceeds 256 bytes")
        end
      end

      it "counts bytes, not characters" do
        announce(instance_attributes(name: "\u00FC" * 129))
        expect(JSON.parse(last_response.body)).to eq("error" => "name exceeds 256 bytes")
      end

      it "answers 400 to a signature of 1025 bytes" do
        payload = FederationIdentitySupport.signed_announcement(key, instance_attributes).merge("signature" => "A" * 1025)
        post "/api/instances", payload.to_json, { "CONTENT_TYPE" => "application/json" }
        expect(last_response.status).to eq(400)
        expect(JSON.parse(last_response.body)).to eq("error" => "signature exceeds 1024 bytes")
      end

      it "answers 400 to an announcement whose public key runs past 2048 bytes" do
        # A PEM followed by junk still parses and verifies, so the key has a cap.
        padded = key.public_key.to_pem + ("x" * 300_000) + "\n"
        allow_any_instance_of(Sinatra::Application).to receive(:fetch_instance_json) do |_instance, host, path|
          if path == well_known_path
            [FederationIdentitySupport.well_known_document(key, domain, pem: padded), URI("https://#{host}#{path}")]
          else
            [fresh_nodes, URI("https://#{host}#{path}")]
          end
        end

        announce(instance_attributes(id: Digest::SHA256.hexdigest(padded), pubkey: padded))

        expect(last_response.status).to eq(400)
        expect(JSON.parse(last_response.body)).to eq("error" => "public_key exceeds 2048 bytes")
        expect(stored_instances).to eq([])
      end

      it "registers an announcement whose signed fields are 256 bytes each, unchanged" do
        fields = %i[name version channel frequency contact_link].to_h { |field| [field, "f" * 256] }
        announce(instance_attributes(**fields))
        expect(last_response.status).to eq(201)
        expect(stored_instances).to eq([[domain, "f" * 256]])
      end
    end

    describe "a crawled peer relaying a record" do
      let(:relay_domain) { "relay.mesh" }
      let(:fetched) { [] }

      # Serve +record+ as the relaying peer's only listed record, with the
      # record domain's well-known naming the instance key and fresh nodes
      # everywhere.  Nothing touches the network.
      #
      # @param record [Hash] relayed record.
      # @param pem [String] the public key PEM the record domain's
      #   well-known names.
      # @return [void]
      def stub_relay(record, pem: key.public_key.to_pem)
        allow(application_class).to receive(:fetch_instance_json) do |host, path|
          fetched << [host, path]
          if host == relay_domain && path == "/api/instances"
            [[record], URI("https://#{host}#{path}")]
          elsif path == well_known_path
            [FederationIdentitySupport.well_known_document(key, domain, pem: pem), URI("https://#{host}#{path}")]
          elsif path.start_with?("/api/nodes")
            [fresh_nodes, URI("https://#{host}#{path}")]
          elsif path == "/api/instances"
            [[], URI("https://#{host}#{path}")]
          else
            [nil, ["#{host}#{path}: not served"]]
          end
        end
        allow(application_class).to receive(:warn_log)
      end

      before { application_class.clear_federation_shutdown_request! }

      it "skips a signed record with a 257-byte name and logs why" do
        stub_relay(FederationIdentitySupport.signed_announcement(key, instance_attributes(name: "M" * 257)))

        with_db { |db| application_class.ingest_known_instances_from!(db, relay_domain) }

        expect(application_class).to have_received(:warn_log).with(
          "Discarded remote instance entry",
          hash_including(context: "federation.instances", domain: relay_domain, reason: "name exceeds 256 bytes"),
        )
        expect(stored_instances).to eq([])
        expect(fetched).to eq([[relay_domain, "/api/instances"]])
      end

      it "skips a relayed record whose public key runs past 2048 bytes" do
        padded = key.public_key.to_pem + ("x" * 300_000) + "\n"
        attributes = instance_attributes(id: Digest::SHA256.hexdigest(padded), pubkey: padded)
        stub_relay(FederationIdentitySupport.signed_announcement(key, attributes), pem: padded)

        with_db { |db| application_class.ingest_known_instances_from!(db, relay_domain) }

        expect(application_class).to have_received(:warn_log).with(
          "Discarded remote instance entry",
          hash_including(context: "federation.instances", domain: relay_domain, reason: "public_key exceeds 2048 bytes"),
        )
        expect(stored_instances).to eq([])
        expect(fetched).to eq([[relay_domain, "/api/instances"]])
      end

      it "stores a relayed record whose signed fields fit" do
        stub_relay(FederationIdentitySupport.signed_announcement(key, instance_attributes))

        with_db { |db| application_class.ingest_known_instances_from!(db, relay_domain) }

        expect(stored_instances).to eq([[domain, "Big Mesh"]])
      end
    end
  end

  describe "node ids (SL5)" do
    # Node ids stored in +nodes+, sorted.
    #
    # @return [Array<String>] node ids.
    def node_ids
      with_db { |db| db.execute("SELECT node_id FROM nodes ORDER BY node_id").map { |row| row["node_id"] } }
    end

    it "skips POST /api/nodes keys that are not canonical node ids" do
      entry = { "lastHeard" => now, "user" => { "longName" => "Key Probe" } }
      body = {
        "!#{"f" * 4096}" => entry, "!5C00000A" => entry, "!5c0000a" => entry,
        "hello" => entry, "4096" => entry, "!5c00000a" => entry, "protocol" => "meshtastic",
      }

      post_ok("/api/nodes", body)

      expect(node_ids).to eq(["!5c00000a"])
    end

    it "skips messages whose sender, recipient or ingestor is not a legitimate id" do
      skipped = [
        { "from_id" => "attacker" }, { "from_id" => "!#{"f" * 4096}" }, { "from_id" => -5 },
        { "from_id" => "4294967296" }, { "from" => "!ZZZ", "from_id" => nil }, { "to_id" => "^local" },
        { "to" => "x" * 64, "to_id" => nil }, { "ingestor" => "!ingest01" }, { "ingestor" => 7 },
      ]
      kept = [
        { "from_id" => "1128114236", "to_id" => "2086340896" }, { "from_id" => 0x433da83c },
        { "from_id" => " !5c000002 ", "ingestor" => "!5c00000c" }, { "from_id" => "", "from" => "!5c000002" },
      ]
      batch = (skipped + kept).each_with_index.map do |fields, index|
        message_record({ "id" => 5_200_000 + index, "text" => "probe #{index}" }.merge(fields))
      end

      post_ok("/api/messages", batch)

      stored = with_db { |db| db.execute("SELECT id, from_id, to_id FROM messages ORDER BY id").map { |row| row.values_at("id", "from_id", "to_id") } }
      offset = 5_200_000 + skipped.length
      expect(stored).to eq(
        [
          [offset, "!433da83c", "!7c5b0920"],
          [offset + 1, "!433da83c", "^all"],
          [offset + 2, "!5c000002", "^all"],
          [offset + 3, "!5c000002", "^all"],
        ],
      )
    end

    it "skips positions, telemetry and waypoints whose node id is not a legitimate id" do
      post_ok("/api/positions", [
        { "id" => 5_300_001, "rx_time" => now, "node_id" => "!ZZZ", "latitude" => 52.5, "longitude" => 13.4 },
        { "id" => 5_300_002, "rx_time" => now, "node_id" => "!5c00000d", "to_id" => "^all", "latitude" => 52.5, "longitude" => 13.4 },
      ])
      post_ok("/api/telemetry", [
        { "id" => 5_300_003, "rx_time" => now, "node_id" => "!5c00000d", "to_id" => "^local", "battery_level" => 50 },
        { "id" => 5_300_004, "rx_time" => now, "node_id" => "!5c00000d", "battery_level" => 50 },
      ])
      post_ok("/api/waypoints", [
        { "id" => 5_300_005, "rx_time" => now, "node_id" => "!5c00000d", "ingestor" => "!ingest01", "name" => "Odd ingestor" },
        { "id" => 5_300_006, "rx_time" => now, "node_id" => "!5c00000d", "name" => "Kept" },
      ])
      post_ok("/api/traces", [
        { "id" => 5_300_007, "rx_time" => now, "src" => 0x5c00000d, "ingestor" => "!ingest01", "hops" => [] },
        { "id" => 5_300_008, "rx_time" => now, "src" => 0x5c00000d, "hops" => [] },
      ])

      ids = %w[positions telemetry waypoints traces].to_h { |table| [table, with_db { |db| db.execute("SELECT id FROM #{table}").map { |row| row["id"] } }] }
      expect(ids).to eq("positions" => [5_300_002], "telemetry" => [5_300_004], "waypoints" => [5_300_006], "traces" => [5_300_008])
      expect(node_ids).to eq(["!5c00000d"])
    end

    it "drops neighbour entries whose id is not a legitimate id, and skips a snapshot from one" do
      post_ok("/api/neighbors", [
        { "node_id" => "!5c00000e", "rx_time" => now, "neighbors" => [{ "neighbor_id" => "!ZZZ" }, { "neighbor_id" => "!5c00000f" }, "stray"] },
        { "node_id" => "attacker", "rx_time" => now, "neighbors" => [{ "neighbor_id" => "!5c000010" }] },
      ])

      rows = with_db { |db| db.execute("SELECT node_id, neighbor_id FROM neighbors").map { |row| row.values_at("node_id", "neighbor_id") } }
      expect(rows).to eq([["!5c00000e", "!5c00000f"]])
    end

    it "rejects an ingestor heartbeat whose node id is not a node reference" do
      post "/api/ingestors", { "node_id" => "!#{"f" * 4096}", "start_time" => now, "last_seen_time" => now, "version" => "0.8.0" }.to_json, auth_headers

      expect(last_response.status).to eq(400)
      expect(db_value("SELECT COUNT(*) FROM ingestors")).to eq(0)
    end

    it "stores a decrypted NodeInfo only under a canonical id it names" do
      dp = DataProcessingHarness.build.new
      decrypt = ->(id) do
        allow(PotatoMesh::App::Meshtastic::PayloadDecoder).to receive(:decode).and_return(
          "type" => "NODEINFO_APP", "payload" => { "id" => id, "user" => { "longName" => "Decoded" } },
        )
        with_db do |db|
          dp.store_decrypted_payload(
            db, {}, 7, { payload: "x", portnum: 4 },
            rx_time: now, rx_iso: nil, from_id: "!5c00001d", to_id: "^all", channel: 0,
            portnum: 4, hop_limit: nil, snr: nil, rssi: nil,
          )
        end
      end

      expect(decrypt.call("!Decrypted")).to be(false)
      expect(decrypt.call("!5c00001d")).to be(true)
      expect(node_ids).to eq(["!5c00001d"])
    end

    it "resolves a blank node reference from the record's node number" do
      post_ok("/api/nodes", node_body("!5c00002a").merge("!5c00002c" => { "lastHeard" => now, "user" => { "longName" => "Neighbour" } }))
      post_ok("/api/positions", [
        { "id" => 5_300_011, "rx_time" => now, "node_id" => "", "node_num" => 0x5c00002a, "latitude" => 52.5, "longitude" => 13.4 },
        { "id" => 5_300_012, "rx_time" => now, "node_id" => " ", "node_num" => 0x5c00002b, "latitude" => 52.5, "longitude" => 13.4 },
        { "id" => 5_300_013, "rx_time" => now, "node_id" => "", "latitude" => 52.5, "longitude" => 13.4 },
      ])
      post_ok("/api/telemetry", [
        { "id" => 5_300_014, "rx_time" => now, "node_id" => "", "node_num" => 0x5c00002a, "battery_level" => 50 },
        { "id" => 5_300_015, "rx_time" => now, "node_id" => "", "battery_level" => 50 },
      ])
      post_ok("/api/waypoints", [
        { "id" => 5_300_016, "rx_time" => now, "node_id" => "", "node_num" => 0x5c00002a, "name" => "Blank ref" },
        { "id" => 5_300_017, "rx_time" => now, "node_id" => "", "name" => "No ref" },
      ])
      post_ok("/api/neighbors", [
        {
          "node_id" => "", "node_num" => 0x5c00002a, "rx_time" => now,
          "neighbors" => [{ "neighbor_id" => "", "neighbor_num" => 0x5c00002c }, { "neighbor_id" => "", "neighbor_num" => 0x5c0000ff }],
        },
        { "node_id" => "", "node_num" => 0x5c0000fe, "rx_time" => now, "neighbors" => [] },
      ])

      rows = %w[positions telemetry waypoints].to_h do |table|
        [table, with_db { |db| db.execute("SELECT id, node_id FROM #{table} ORDER BY id").map { |row| row.values_at("id", "node_id") } }]
      end
      expect(rows).to eq(
        "positions" => [[5_300_011, "!5c00002a"], [5_300_012, "!5c00002b"], [5_300_013, nil]],
        "telemetry" => [[5_300_014, "!5c00002a"], [5_300_015, nil]],
        "waypoints" => [[5_300_016, "!5c00002a"], [5_300_017, nil]],
      )
      neighbors = with_db { |db| db.execute("SELECT node_id, neighbor_id FROM neighbors").map { |row| row.values_at("node_id", "neighbor_id") } }
      expect(neighbors).to eq([["!5c00002a", "!5c00002c"]])
    end

    it "parses no node from a bang id that is no hex, even beside a node number" do
      dp = DataProcessingHarness.build.new
      expect(dp.canonical_node_parts("!ZZZ", 5)).to be_nil
      expect(dp.canonical_node_parts("!0000000a", 5)).to eq(["!0000000a", 10, "000A"])
    end

    it "updates a node from telemetry given its id without a number" do
      # No route reaches this write without a node number since SL5; the
      # write itself still accepts one.
      dp = DataProcessingHarness.build.new
      with_db do |db|
        dp.update_node_from_telemetry(db, "!5c00002e", nil, now, {})
        dp.update_node_from_telemetry(db, "!5c00002e", nil, now, { battery_level: 50.0 })
      end
      expect(db_value("SELECT battery_level FROM nodes WHERE node_id = '!5c00002e'")).to eq(50.0)
    end
  end

  describe "ingestor protocols (SL7)" do
    it "keeps only known protocols, normalised" do
      [["!5c000011", "P" * 4096], ["!5c000012", " MeshCore "], ["!5c000013", "reticulum"]].each do |node_id, protocol|
        post_ok("/api/ingestors", { "node_id" => node_id, "start_time" => now, "last_seen_time" => now, "version" => "0.8.0", "protocol" => protocol })
      end

      rows = with_db { |db| db.execute("SELECT node_id, protocol FROM ingestors ORDER BY node_id").map { |row| row.values_at("node_id", "protocol") } }
      expect(rows).to eq([["!5c000011", "meshtastic"], ["!5c000012", "meshcore"], ["!5c000013", "reticulum"]])
    end

    it "stamps a record inheriting a stored unknown ingestor protocol with the default" do
      with_db do |db|
        db.execute(
          "INSERT INTO ingestors(node_id, start_time, last_seen_time, version, protocol) VALUES (?,?,?,?,?)",
          ["!5c000014", now, now, "0.7.0", "P" * 4096],
        )
      end

      post_ok("/api/messages", message_record("ingestor" => "!5c000014").except("protocol"))

      expect(db_value("SELECT protocol FROM messages")).to eq("meshtastic")
    end

    it "logs at most 64 bytes of a malformed protocol stamp" do
      logged = []
      allow_any_instance_of(Sinatra::Application).to receive(:warn_log) { |_instance, message, **metadata| logged << [message, metadata] }

      post_ok("/api/messages", message_record("protocol" => "P" * 1_000))

      stamp = logged.find { |message, _metadata| message.start_with?("Rejected malformed protocol stamp") }
      expect(stamp.last[:value]).to eq("P" * 64)
    end
  end

  describe "keyed evidence and metric labels" do
    include MetricsSpecHelpers

    it "stores a public key over its cap as NULL, so it is no keyed evidence (MR1)" do
      [["!5c000015", "k" * 512], ["!5c000016", "k" * 513]].each do |node_id, key|
        post_ok("/api/nodes", node_body(node_id, "user" => { "longName" => "Keyed", "publicKey" => key, "role" => "COMPANION" }).merge("protocol" => "meshcore"))
      end

      rows = with_db { |db| db.execute("SELECT node_id, length(public_key) AS key_bytes, last_advert_heard FROM nodes ORDER BY node_id") }
      expect(rows.map { |row| row.values_at("node_id", "key_bytes") }).to eq([["!5c000015", 512], ["!5c000016", nil]])
      expect(rows.first["last_advert_heard"]).to eq(now)
      expect(rows.last["last_advert_heard"]).to be_nil
    end

    it "labels the node gauge with the bounded names" do
      allow(PotatoMesh::Config).to receive(:prom_report_id_list).and_return(["*"])

      post_ok("/api/nodes", node_body("!5c000017", "user" => { "longName" => "L" * 1_000, "shortName" => "S" * 100, "hwModel" => "H" * 100, "role" => "CLIENT" }))

      # The series reads the stored row (SPEC PG2), which holds the bounded names.
      expect(scraped_samples("meshtastic_node", "!5c000017")).to eq(
        [%(meshtastic_node{node="!5c000017",short_name="#{"S" * 16}",long_name="#{"L" * 512}",hw_model="",role="CLIENT"} 1.0)],
      )
    end
  end

  describe "numeric fields (SL-A7)" do
    include MetricsSpecHelpers

    # 100 kB of text that is no number.
    let(:junk) { "x" * 100_000 }

    # The numeric columns of one node row.
    #
    # @param node_id [String] canonical node id.
    # @return [Hash, nil] the row's numeric columns by name.
    def node_numbers(node_id)
      with_db do |db|
        db.get_first_row(
          "SELECT hops_away, snr, rssi, is_favorite, is_unmessagable, battery_level, voltage, channel_utilization, " \
          "air_util_tx, uptime_seconds, latitude, longitude, altitude FROM nodes WHERE node_id = ?",
          [node_id],
        )
      end
    end

    # Expect the node API to serve +node_id+ in under 4 KiB.
    #
    # @param node_id [String] canonical node id.
    # @return [void]
    def expect_small_node_response(node_id)
      get "/api/nodes/#{node_id}"
      expect(last_response).to be_ok
      expect(last_response.body.bytesize).to be < 4096
    end

    it "stores a node's top-level numbers as NULL when they are no number, and converts numeric strings" do
      post_ok("/api/nodes", node_body("!5c000020", "hopsAway" => junk, "snr" => junk, "rssi" => junk, "isFavorite" => junk))
      post_ok("/api/nodes", node_body("!5c000021", "hops_away" => "3", "snr" => "5.5", "rssi" => "-96", "is_favorite" => "1"))
      post_ok("/api/nodes", node_body("!5c000022", "hopsAway" => 10 ** 30, "snr" => 7, "rssi" => -100, "isFavorite" => true))

      columns = %w[hops_away snr rssi is_favorite]
      expect(node_numbers("!5c000020").values_at(*columns)).to eq([nil, nil, nil, nil])
      expect(node_numbers("!5c000021").values_at(*columns)).to eq([3, 5.5, -96, 1])
      # An integer beyond 64 bits is no number SQLite can hold.
      expect(node_numbers("!5c000022").values_at(*columns)).to eq([nil, 7.0, -100, 1])
      expect_small_node_response("!5c000020")
    end

    it "stores a node's device metrics as NULL when they are no number, and converts numeric strings" do
      camel = %w[batteryLevel voltage channelUtilization airUtilTx uptimeSeconds]
      post_ok("/api/nodes", node_body("!5c000023", "deviceMetrics" => camel.to_h { |key| [key, junk] }))
      snake = { "battery_level" => "80", "voltage" => "4.1", "channel_utilization" => "12.5", "air_util_tx" => "1.5", "uptime_seconds" => "3600" }
      post_ok("/api/nodes", node_body("!5c000024", "device_metrics" => snake))

      columns = %w[battery_level voltage channel_utilization air_util_tx uptime_seconds]
      expect(node_numbers("!5c000023").values_at(*columns)).to eq([nil] * 5)
      expect(node_numbers("!5c000024").values_at(*columns)).to eq([80.0, 4.1, 12.5, 1.5, 3600])
      expect_small_node_response("!5c000023")
    end

    it "stores a node's position altitude and flags as NULL when they are no number, and converts numeric strings" do
      post_ok("/api/nodes", node_body("!5c000025", "position" => { "latitude" => 52.5, "longitude" => 13.4, "altitude" => junk, "time" => now - 5 },
                                                   "user" => { "longName" => "Junk flags", "isUnmessagable" => junk }))
      post_ok("/api/nodes", node_body("!5c000026", "position" => { "latitude" => "52.5", "longitude" => "13.4", "altitude" => "34.5", "time" => now - 5 },
                                                   "user" => { "longName" => "String flags", "is_unmessagable" => "1" }))

      columns = %w[latitude longitude altitude is_unmessagable]
      expect(node_numbers("!5c000025").values_at(*columns)).to eq([52.5, 13.4, nil, nil])
      expect(node_numbers("!5c000026").values_at(*columns)).to eq([52.5, 13.4, 34.5, 1])
      expect_small_node_response("!5c000025")
    end

    it "hands the node gauges numbers only" do
      allow(PotatoMesh::Config).to receive(:prom_report_id_list).and_return(["*"])

      post_ok("/api/nodes", node_body("!5c000027", "deviceMetrics" => { "batteryLevel" => junk, "voltage" => "4.1" },
                                                   "position" => { "latitude" => 52.5, "longitude" => "13.4", "altitude" => junk }))

      # The gauges read the stored row (SPEC PG2): NULL for text, a number for a numeric string.
      expect(scraped_samples("meshtastic_node_battery_level", "!5c000027")).to eq([])
      expect(scraped_samples("meshtastic_node_altitude", "!5c000027")).to eq([])
      expect(scraped_samples("meshtastic_node_voltage", "!5c000027")).to eq(['meshtastic_node_voltage{node="!5c000027"} 4.1'])
      expect(scraped_samples("meshtastic_node_longitude", "!5c000027")).to eq(['meshtastic_node_longitude{node="!5c000027"} 13.4'])
    end

    it "stores a message's numbers as NULL when they are no number, and converts numeric strings" do
      post_ok("/api/messages", [
        message_record("id" => 5_400_001, "text" => "junk numbers", "channel" => junk, "snr" => junk, "rssi" => junk, "hop_limit" => junk),
        message_record("id" => 5_400_002, "text" => "string numbers", "channel" => "2", "snr" => "5.5", "rssi" => "-96", "hop_limit" => "3"),
      ])

      rows = with_db { |db| db.execute("SELECT channel, snr, rssi, hop_limit FROM messages ORDER BY id").map { |row| row.values_at("channel", "snr", "rssi", "hop_limit") } }
      expect(rows).to eq([[nil, nil, nil, nil], [2, 5.5, -96, 3]])
      get "/api/messages"
      expect(last_response.body.bytesize).to be < 4096
    end

    it "skips a node entry that is not a mapping" do
      post_ok("/api/nodes", { "!5c000006" => "snr rssi hopsAway isFavorite", "!5c000007" => ["snr"], "!5c000008" => 42, "protocol" => "meshtastic" })
      expect(db_value("SELECT COUNT(*) FROM nodes")).to eq(0)
    end

    it "stores integers beyond 64 bits as NULL, so every read still serves" do
      huge = 10 ** 400
      post_ok("/api/nodes", node_body("!5c000028", "num" => huge, "lora_freq" => huge, "snr" => huge,
                                                   "position" => { "latitude" => 52.5, "longitude" => 13.4, "time" => now - 5, "precisionBits" => huge }))
      post_ok("/api/messages", message_record("id" => 5_400_003, "text" => "huge numbers", "hops" => huge, "reply_id" => huge, "lora_freq" => huge))
      post_ok("/api/ingestors", { "node_id" => "!5c000029", "start_time" => now, "last_seen_time" => now, "version" => "0.8.0", "lora_freq" => huge, "packets" => huge })
      post_ok("/api/positions", { "id" => 5_400_006, "rx_time" => now, "node_id" => "!5c00002d", "latitude" => huge, "longitude" => huge, "altitude" => huge, "precision_bits" => huge })
      post_ok("/api/telemetry", { "id" => 5_400_007, "rx_time" => now, "node_id" => "!5c00002d", "battery_level" => huge, "uptime_seconds" => huge, "voltage" => 4.1 })
      post_ok("/api/traces", { "id" => 5_400_004, "rx_time" => now, "src" => huge, "dest" => 0x5c00002d, "elapsed_ms" => huge, "hops" => [huge, 0x5c000029] })
      post_ok("/api/waypoints", { "id" => 5_400_005, "rx_time" => now, "node_id" => "!5c00002d", "name" => "Forever", "icon" => huge, "expire" => huge })

      stored = {
        node: "SELECT num, lora_freq, snr, precision_bits FROM nodes WHERE node_id = '!5c000028'",
        message: "SELECT hops, reply_id, lora_freq FROM messages WHERE id = 5400003",
        ingestor: "SELECT lora_freq FROM ingestors WHERE node_id = '!5c000029'",
        position: "SELECT latitude, longitude, altitude, precision_bits FROM positions WHERE id = 5400006",
        telemetry: "SELECT battery_level, uptime_seconds FROM telemetry WHERE id = 5400007",
        trace: "SELECT src, elapsed_ms FROM traces WHERE id = 5400004",
        waypoint: "SELECT icon, expire FROM waypoints WHERE id = 5400005",
      }.transform_values { |sql| with_db { |db| db.get_first_row(sql).values.uniq } }
      expect(stored.values).to all(eq([nil]))
      expect(db_value("SELECT COUNT(*) FROM ingestor_activity WHERE ingestor_id = '!5c000029'")).to eq(0)
      expect(with_db { |db| db.execute("SELECT node_id FROM trace_hops").map { |row| row["node_id"] } }).to eq([0x5c000029])
      %w[/api/nodes /api/messages /api/ingestors /api/positions /api/telemetry /api/traces /api/waypoints].each do |path|
        get path
        expect(last_response.status).to eq(200), "#{path} answered #{last_response.status}"
      end
    end

    it "reads a trace hop from a decimal string within the 64-bit range" do
      post_ok("/api/traces", { "id" => 5_400_008, "rx_time" => now, "src" => 0x5c000028, "hops" => ["1543503913", "9" * 400, " ", "!5c00002f"] })
      hops = with_db { |db| db.execute("SELECT node_id FROM trace_hops ORDER BY hop_index").map { |row| row["node_id"] } }
      expect(hops).to eq([0x5c000029, 0x5c00002f])
    end

    describe "a nested map of a node entry that is not a mapping" do
      # The node row's columns this group reads.
      #
      # @param node_id [String] canonical node id.
      # @return [Hash, nil] the row's columns by name.
      def node_row(node_id)
        with_db do |db|
          db.get_first_row(
            "SELECT role, macaddr, synthetic, voltage, battery_level, uptime_seconds, latitude, altitude, precision_bits FROM nodes WHERE node_id = ?",
            [node_id],
          )
        end
      end

      it "drops a deviceMetrics that is not a mapping, so a device_metrics beside it counts" do
        post_ok("/api/nodes", node_body("!5c000031", "deviceMetrics" => "voltage batteryLevel uptimeSeconds"))
        post_ok("/api/nodes", node_body("!5c000037", "deviceMetrics" => "voltage", "device_metrics" => { "voltage" => 4.1 }))

        expect(node_row("!5c000031").values_at("voltage", "battery_level", "uptime_seconds")).to eq([nil, nil, nil])
        expect(node_row("!5c000037")["voltage"]).to eq(4.1)
      end

      it "drops a user that is not a mapping" do
        post_ok("/api/nodes", node_body("!5c000032", "user" => "role macaddr synthetic longName"))
        expect(node_row("!5c000032").values_at("role", "macaddr", "synthetic")).to eq([nil, nil, 0])
      end

      it "drops a position that is not a mapping" do
        post_ok("/api/nodes", node_body("!5c000033", "position" => "latitude longitude altitude time"))
        expect(node_row("!5c000033").values_at("latitude", "altitude")).to eq([nil, nil])
      end

      it "drops a position's raw section that is not a mapping" do
        post_ok("/api/nodes", node_body("!5c000034", "position" => { "latitude" => 52.5, "longitude" => 13.4, "time" => now - 5, "raw" => "precision_bits" }))
        expect(node_row("!5c000034").values_at("latitude", "precision_bits")).to eq([52.5, nil])
      end

      it "drops a destination that is not a mapping" do
        post_ok("/api/nodes", node_body("!5c000035", "destination" => "id aspect role"))
        expect(db_value("SELECT COUNT(*) FROM destinations")).to eq(0)
        expect(node_row("!5c000035")).not_to be_nil
      end
    end
  end

  describe "FieldLimits" do
    let(:limits) { PotatoMesh::App::DataProcessing::FieldLimits }

    it "recognises canonical node ids only" do
      expect(%w[!5c000018 !00000000 !ffffffff].map { |id| limits.node_id?(id) }).to all(be(true))
      expect(["!5C000018", "!5c00001", "!5c0000180", " !5c000018", "5c000018", "0x5c000018", nil, 0x5c000018].map { |id| limits.node_id?(id) }).to all(be(false))
    end

    it "accepts node references in the forms CONTRACTS names" do
      accepted = [nil, "", "  ", "!5c000018", " !5c000018 ", 0, 0xFFFF_FFFF, "4294967295", "0000000123"]
      rejected = [-1, 0x1_0000_0000, "4294967296", "12345678901", "!ZZZ", "!#{"f" * 9}", "attacker", "^all", 1.5, [], {}, true]
      expect(accepted.map { |ref| limits.node_ref?(ref) }).to all(be(true))
      expect(rejected.map { |ref| limits.node_ref?(ref) }).to all(be(false))
    end

    it "accepts the broadcast id as a destination only" do
      expect(["^all", " ^all ", "!5c000018", 12].map { |ref| limits.destination_ref?(ref) }).to all(be(true))
      expect(["^local", "^ALL", :all].map { |ref| limits.destination_ref?(ref) }).to all(be(false))
    end

    it "accepts only canonical or absent ids for columns stored as posted" do
      expect([nil, "", " !5c000018 "].map { |ref| limits.stored_id?(ref) }).to all(be(true))
      expect([7, "123", "!a", "^all"].map { |ref| limits.stored_id?(ref) }).to all(be(false))
    end

    it "returns a record unchanged, as the same object, when every field fits" do
      record = { "text" => "ok", "nested" => { "name" => "fine" } }
      fields = [[%w[text], :text, 8], [%w[nested name], :text, 8], [%w[absent deeper], :token, 8], [%w[text deeper], :token, 1]]
      expect(limits.bound_fields(record, fields)).to be(record)
      expect(limits.bound_fields("not a record", fields)).to eq("not a record")
    end

    it "copies only the levels a cap changes" do
      inner = { "name" => "n" * 10, "keep" => "k" }
      record = { "nested" => inner, "token" => "t" * 10, "other" => { "x" => 1 } }
      bounded = limits.bound_fields(record, [[%w[nested name], :text, 4], [%w[token], :token, 4]])
      expect(bounded).to eq("nested" => { "name" => "nnnn", "keep" => "k" }, "token" => nil, "other" => { "x" => 1 })
      expect(bounded["other"]).to be(record["other"])
      expect(record).to eq("nested" => { "name" => "n" * 10, "keep" => "k" }, "token" => "t" * 10, "other" => { "x" => 1 })
    end

    it "drops a nested value that is not a mapping, copying only the levels it changes" do
      maps = PotatoMesh::App::DataProcessing::FieldLimits::NODE_MAPS
      record = { "user" => "role", "position" => { "raw" => "x", "latitude" => 1.0 }, "other" => { "k" => 1 }, "deviceMetrics" => nil }
      dropped = limits.drop_non_maps(record, maps)
      expect(dropped).to eq("position" => { "latitude" => 1.0 }, "other" => { "k" => 1 }, "deviceMetrics" => nil)
      expect(dropped["other"]).to be(record["other"])
      expect(record["user"]).to eq("role")
      fitting = { "user" => {}, "position" => { "raw" => {} }, "destination" => [] }
      expect(limits.drop_non_maps(fitting, maps)).to eq("user" => {}, "position" => { "raw" => {} })
      maps_only = fitting.except("destination")
      expect(limits.drop_non_maps(maps_only, maps)).to be(maps_only)
      expect(limits.drop_non_maps("raw", maps)).to eq("raw")
    end

    it "names the first signed instance field over its cap" do
      fields = { name: "n", version: "v" * 257, channel: "c" * 300, frequency: nil, contact_link: nil }
      expect(limits.instance_field_violation(fields, "sig", pubkey: "k")).to eq("version exceeds 256 bytes")
      expect(limits.instance_field_violation(fields.merge(version: "v", channel: "c"), "s" * 1024, pubkey: "k" * 2048)).to be_nil
      expect(limits.instance_field_violation({}, "s" * 1024, pubkey: "k" * 2049)).to eq("public_key exceeds 2048 bytes")
      expect(limits.instance_field_violation({}, "s" * 1025, pubkey: nil)).to eq("signature exceeds 1024 bytes")
      expect(limits.instance_field_violation({}, nil, pubkey: nil)).to be_nil
    end
  end

  describe "record bounding helpers" do
    let(:dp) { DataProcessingHarness.build.new }

    it "passes a record that is not a Hash through unchanged" do
      %i[bound_message_payload bound_position_payload bound_telemetry_payload bound_neighbor_payload bound_trace_payload bound_waypoint_payload bound_ingestor_payload].each do |helper|
        expect(dp.public_send(helper, "raw")).to eq("raw")
        expect(dp.public_send(helper, nil)).to be_nil
      end
      expect(dp.bound_node_payload("raw")).to eq("raw")
    end

    it "keeps a neighbour snapshot without an entry list as it is" do
      snapshot = { "node_id" => "!5c00001a", "neighbors" => "none" }
      expect(dp.bound_neighbor_payload(snapshot)).to be(snapshot)
      listed = { "node_id" => "!5c00001a", "neighbors" => [{ "neighbor_id" => "!5c00001b" }] }
      expect(dp.bound_neighbor_payload(listed)).to be(listed)
    end

    it "bounds the arguments of upsert_destination" do
      destination = { "id" => "d" * 65, "aspect" => "lxmf.delivery" }
      bounded = dp.bound_destination_fields(destination, "h" * 65, "n" * 600, "i" * 300)
      expect(bounded).to eq([{ "id" => nil, "aspect" => "lxmf.delivery" }, nil, "n" * 512, "i" * 256])
      expect(dp.bound_destination_fields(nil, "h", "n", nil)).to eq([nil, "h", "n", nil])
    end

    it "keeps numbers, converts numeric strings and drops anything else from a numeric field" do
      expect(dp.bounded_number(nil, :integer)).to be_nil
      expect(dp.bounded_number(true, :boolean)).to be(true)
      expect(dp.bounded_number(false, :boolean)).to be(false)
      expect(dp.bounded_number(true, :integer)).to be_nil
      expect(dp.bounded_number(7, :float)).to eq(7)
      expect(dp.bounded_number(5.5, :integer)).to eq(5.5)
      expect(dp.bounded_number(Float::INFINITY, :float)).to be_nil
      expect(dp.bounded_number("5.5", :float)).to eq(5.5)
      expect(dp.bounded_number("5.5", :integer)).to eq(5)
      expect(dp.bounded_number("1", :boolean)).to eq(1)
      expect(dp.bounded_number("x" * 100, :float)).to be_nil
      expect(dp.bounded_number({ "a" => 1 }, :integer)).to be_nil
      expect(dp.bounded_number(-(2 ** 63), :integer)).to eq(-(2 ** 63))
      expect(dp.bounded_number(2 ** 63, :integer)).to be_nil
      expect(dp.bounded_number("9" * 100, :integer)).to be_nil
    end

    it "keeps a known ingestor protocol and drops any other" do
      known = { "node_id" => "!5c00001c", "protocol" => "meshcore" }
      expect(dp.bound_ingestor_payload(known)).to be(known)
      expect(dp.bound_ingestor_payload(known.merge("protocol" => "MeshCore"))).to eq(known)
      expect(dp.bound_ingestor_payload(known.merge("protocol" => "lora"))).to eq(known.merge("protocol" => nil))
      expect(dp.bound_ingestor_payload({ "node_id" => "!5c00001c" })).to eq({ "node_id" => "!5c00001c" })
    end
  end
end
