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
require "net/http"
require "openssl"
require "sqlite3"
require "set"
require "uri"
require "socket"

RSpec.describe PotatoMesh::App::Federation do
  subject(:federation_helpers) do
    Class.new do
      extend PotatoMesh::App::Federation

      class << self
        def debug_messages
          @debug_messages ||= []
        end

        def debug_log(message, **_metadata)
          debug_messages << message
        end

        def reset_debug_messages
          @debug_messages = []
        end

        def warn_messages
          @warn_messages ||= []
        end

        def warn_log(message, **_metadata)
          warn_messages << message
        end

        def reset_warn_messages
          @warn_messages = []
        end

        def settings
          @settings ||= Struct.new(
            :federation_thread,
            :initial_federation_thread,
            :federation_worker_pool,
            :federation_shutdown_requested,
          ).new
        end

        def set(key, value)
          writer = "#{key}="
          if settings.respond_to?(writer)
            settings.public_send(writer, value)
          else
            raise ArgumentError, "unsupported setting #{key}"
          end
        end
      end
    end
  end

  before do
    federation_helpers.instance_variable_set(:@remote_instance_cert_store, nil)
    federation_helpers.instance_variable_set(:@remote_instance_verify_callback, nil)
    federation_helpers.reset_debug_messages
    federation_helpers.reset_warn_messages
    federation_helpers.clear_federation_crawl_state!
    federation_helpers.shutdown_federation_worker_pool!
  end

  after do
    federation_helpers.clear_federation_crawl_state!
    federation_helpers.shutdown_federation_worker_pool!
  end

  describe ".remote_instance_cert_store" do
    it "initializes the store with default paths and disables CRL checks" do
      store_double = Class.new do
        attr_reader :default_paths_called, :assigned_flags

        def set_default_paths
          @default_paths_called = true
        end

        def flags=(value)
          @assigned_flags = value
        end

        def respond_to_missing?(method_name, include_private = false)
          method_name == :flags= || super
        end
      end.new

      allow(OpenSSL::X509::Store).to receive(:new).and_return(store_double)

      result = federation_helpers.remote_instance_cert_store

      expect(result).to eq(store_double)
      expect(store_double.default_paths_called).to be(true)
      expect(store_double.assigned_flags).to eq(0)
    end

    it "memoizes the generated store" do
      first = federation_helpers.remote_instance_cert_store
      second = federation_helpers.remote_instance_cert_store
      expect(second).to equal(first)
    end

    it "logs and returns nil when initialization fails" do
      allow(OpenSSL::X509::Store).to receive(:new).and_raise(OpenSSL::X509::StoreError, "boom")

      expect(federation_helpers.remote_instance_cert_store).to be_nil
      expect(federation_helpers.debug_messages.last).to include("Failed to initialize certificate store")
    end
  end

  describe ".remote_instance_verify_callback" do
    let(:callback) { federation_helpers.remote_instance_verify_callback }

    it "memoizes the generated callback" do
      first = federation_helpers.remote_instance_verify_callback
      second = federation_helpers.remote_instance_verify_callback
      expect(second).to equal(first)
    end

    it "allows the handshake to continue when CRLs are unavailable" do
      store_context = instance_double(OpenSSL::X509::StoreContext, error: OpenSSL::X509::V_ERR_UNABLE_TO_GET_CRL)

      expect(callback.call(false, store_context)).to be(true)
      expect(federation_helpers.debug_messages.last).to include("Ignoring TLS CRL retrieval failure")
    end

    it "rejects other verification failures" do
      store_context = instance_double(OpenSSL::X509::StoreContext, error: OpenSSL::X509::V_ERR_CERT_HAS_EXPIRED)

      expect(callback.call(false, store_context)).to be(false)
    end

    it "falls back to the default behavior when the handshake is already valid" do
      expect(callback.call(true, nil)).to be(true)
    end
  end

  describe ".build_remote_http_client" do
    let(:connect_timeout) { 5 }
    let(:read_timeout) { 12 }
    let(:public_addrinfo) { Addrinfo.ip("203.0.113.5") }

    before do
      allow(PotatoMesh::Config).to receive(:remote_instance_http_timeout).and_return(connect_timeout)
      allow(PotatoMesh::Config).to receive(:remote_instance_read_timeout).and_return(read_timeout)
      allow(Addrinfo).to receive(:getaddrinfo).and_return([public_addrinfo])
    end

    it "configures SSL settings for HTTPS endpoints" do
      uri = URI.parse("https://remote.example.com/api")
      store = OpenSSL::X509::Store.new
      allow(federation_helpers).to receive(:remote_instance_cert_store).and_return(store)
      callback = proc { true }
      allow(federation_helpers).to receive(:remote_instance_verify_callback).and_return(callback)

      http = federation_helpers.build_remote_http_client(uri)

      expect(http.use_ssl?).to be(true)
      expect(http.open_timeout).to eq(connect_timeout)
      expect(http.read_timeout).to eq(read_timeout)
      expect(http.cert_store).to eq(store)
      expect(http.verify_mode).to eq(OpenSSL::SSL::VERIFY_PEER)
      expect(http.verify_callback).to eq(callback)
      if http.respond_to?(:min_version)
        expect(http.min_version).to eq(:TLS1_2)
      end
    end

    it "omits SSL configuration for HTTP endpoints" do
      uri = URI.parse("http://remote.example.com/api")

      http = federation_helpers.build_remote_http_client(uri)

      expect(http.use_ssl?).to be(false)
      expect(http.cert_store).to be_nil
      expect(http.open_timeout).to eq(connect_timeout)
      expect(http.read_timeout).to eq(read_timeout)
    end

    it "leaves the certificate store unset when unavailable" do
      uri = URI.parse("https://remote.example.com/api")
      allow(federation_helpers).to receive(:remote_instance_cert_store).and_return(nil)
      allow(federation_helpers).to receive(:remote_instance_verify_callback).and_return(nil)

      http = federation_helpers.build_remote_http_client(uri)

      expect(http.cert_store).to be_nil
      expect(http.verify_callback).to be_nil
    end

    it "rejects URIs that resolve exclusively to restricted addresses" do
      uri = URI.parse("https://loopback.mesh/api")
      allow(Addrinfo).to receive(:getaddrinfo).and_return([Addrinfo.ip("127.0.0.1")])

      expect do
        federation_helpers.build_remote_http_client(uri)
      end.to raise_error(ArgumentError, "restricted domain")
    end

    it "binds the HTTP client to the first unrestricted address" do
      uri = URI.parse("https://remote.example.com/api")
      allow(Addrinfo).to receive(:getaddrinfo).and_return([
        Addrinfo.ip("127.0.0.1"),
        public_addrinfo,
        Addrinfo.ip("10.0.0.3"),
      ])

      http = federation_helpers.build_remote_http_client(uri)

      if http.respond_to?(:ipaddr)
        expect(http.ipaddr).to eq("203.0.113.5")
      else
        skip "Net::HTTP#ipaddr accessor unavailable"
      end
    end
  end

  describe ".ingest_known_instances_from!" do
    let(:db) { double(:db) }
    let(:seed_domain) { "seed.mesh" }
    let(:payload_entries) do
      Array.new(3) do |index|
        {
          "id" => "remote-#{index}",
          "domain" => "ally-#{index}.mesh",
          "pubkey" => "ignored-pubkey-#{index}",
          "signature" => "ignored-signature-#{index}",
        }
      end
    end
    let(:attributes_list) do
      payload_entries.map do |entry|
        {
          id: entry["id"],
          domain: entry["domain"],
          pubkey: entry["pubkey"],
          name: nil,
          version: nil,
          channel: nil,
          frequency: nil,
          latitude: nil,
          longitude: nil,
          last_update_time: nil,
          is_private: false,
        }
      end
    end
    let(:node_payload) do
      Array.new(PotatoMesh::Config.remote_instance_min_node_count) do |index|
        { "node_id" => "node-#{index}", "last_heard" => Time.now.to_i - index }
      end
    end
    let(:response_map) do
      mapping = { [seed_domain, "/api/instances"] => [payload_entries, :instances] }
      attributes_list.each do |attributes|
        mapping[[attributes[:domain], "/api/nodes"]] = [node_payload, :nodes]
        mapping[[attributes[:domain], "/api/instances"]] = [[], :instances]
      end
      mapping
    end

    before do
      allow(federation_helpers).to receive(:fetch_instance_json) do |host, path|
        response_map.fetch([host, path]) { [nil, []] }
      end
      allow(federation_helpers).to receive(:verify_instance_signature).and_return(true)
      allow(federation_helpers).to receive(:validate_remote_nodes).and_return([true, nil])
      payload_entries.each_with_index do |entry, index|
        allow(federation_helpers).to receive(:remote_instance_attributes_from_payload).with(entry).and_return([attributes_list[index], "signature-#{index}", nil])
      end
    end

    it "stops processing once the per-response limit is exceeded" do
      processed_domains = []
      allow(federation_helpers).to receive(:upsert_instance_record) do |_db, attrs, _signature|
        processed_domains << attrs[:domain]
      end
      allow(PotatoMesh::Config).to receive(:federation_max_instances_per_response).and_return(2)
      allow(PotatoMesh::Config).to receive(:federation_max_domains_per_crawl).and_return(10)

      visited = federation_helpers.ingest_known_instances_from!(db, seed_domain)

      expect(processed_domains).to eq([
        attributes_list[0][:domain],
        attributes_list[1][:domain],
      ])
      expect(visited).to include(seed_domain, attributes_list[0][:domain], attributes_list[1][:domain])
      expect(visited).not_to include(attributes_list[2][:domain])
      expect(federation_helpers.debug_messages).to include(a_string_including("response limit"))
    end

    it "halts recursion once the crawl limit would be exceeded" do
      processed_domains = []
      allow(federation_helpers).to receive(:upsert_instance_record) do |_db, attrs, _signature|
        processed_domains << attrs[:domain]
      end
      allow(PotatoMesh::Config).to receive(:federation_max_instances_per_response).and_return(5)
      allow(PotatoMesh::Config).to receive(:federation_max_domains_per_crawl).and_return(2)

      visited = federation_helpers.ingest_known_instances_from!(db, seed_domain)

      expect(processed_domains).to eq([attributes_list.first[:domain]])
      expect(visited).to include(seed_domain, attributes_list.first[:domain])
      expect(visited).not_to include(attributes_list[1][:domain], attributes_list[2][:domain])
      expect(federation_helpers.debug_messages).to include(a_string_including("crawl limit"))
    end

    it "requests an expanded recent node window when counting remote activity" do
      now = Time.at(1_700_000_000)
      allow(Time).to receive(:now).and_return(now)
      allow(PotatoMesh::Config).to receive(:remote_instance_max_node_age).and_return(900)
      recent_cutoff = now.to_i - 900

      mapping = { [seed_domain, "/api/instances"] => [payload_entries, :instances] }
      attributes_list.each_with_index do |attributes, index|
        mapping[[attributes[:domain], "/api/nodes?since=#{recent_cutoff}&limit=1000"]] = [node_payload, :nodes]
        mapping[[attributes[:domain], "/api/nodes"]] = [node_payload, :nodes]
        mapping[[attributes[:domain], "/api/instances"]] = [[], :instances]
        allow(federation_helpers).to receive(:remote_instance_attributes_from_payload).with(payload_entries[index]).and_return([attributes, "signature-#{index}", nil])
      end

      captured_paths = []
      allow(federation_helpers).to receive(:fetch_instance_json) do |host, path|
        captured_paths << [host, path]
        mapping.fetch([host, path]) { [nil, []] }
      end
      allow(federation_helpers).to receive(:verify_instance_signature).and_return(true)
      allow(federation_helpers).to receive(:validate_remote_nodes).and_return([true, nil])
      allow(federation_helpers).to receive(:upsert_instance_record)

      federation_helpers.ingest_known_instances_from!(db, seed_domain)

      expect(captured_paths).to include(
        [attributes_list[0][:domain], "/api/nodes?since=#{recent_cutoff}&limit=1000"],
        [attributes_list[1][:domain], "/api/nodes?since=#{recent_cutoff}&limit=1000"],
        [attributes_list[2][:domain], "/api/nodes?since=#{recent_cutoff}&limit=1000"],
      )
      expect(captured_paths).not_to include(
        [attributes_list[0][:domain], "/api/nodes"],
        [attributes_list[1][:domain], "/api/nodes"],
        [attributes_list[2][:domain], "/api/nodes"],
      )
      expect(attributes_list.map { |attrs| attrs[:nodes_count] }).to all(eq(node_payload.length))
    end

    it "falls back to full node data when the recent window request fails" do
      now = Time.at(1_700_000_000)
      allow(Time).to receive(:now).and_return(now)
      allow(PotatoMesh::Config).to receive(:remote_instance_max_node_age).and_return(900)
      recent_cutoff = now.to_i - 900

      mapping = { [seed_domain, "/api/instances"] => [payload_entries, :instances] }
      attributes_list.each_with_index do |attributes, index|
        mapping[[attributes[:domain], "/api/nodes?since=#{recent_cutoff}&limit=1000"]] = [nil, ["no window"]]
        mapping[[attributes[:domain], "/api/nodes"]] = [node_payload, :nodes]
        mapping[[attributes[:domain], "/api/instances"]] = [[], :instances]
        allow(federation_helpers).to receive(:remote_instance_attributes_from_payload).with(payload_entries[index]).and_return([attributes, "signature-#{index}", nil])
      end

      captured_paths = []
      allow(federation_helpers).to receive(:fetch_instance_json) do |host, path|
        captured_paths << [host, path]
        mapping.fetch([host, path]) { [nil, []] }
      end
      allow(federation_helpers).to receive(:verify_instance_signature).and_return(true)
      allow(federation_helpers).to receive(:validate_remote_nodes).and_return([true, nil])
      allow(federation_helpers).to receive(:upsert_instance_record)

      federation_helpers.ingest_known_instances_from!(db, seed_domain)

      expect(captured_paths).to include(
        [attributes_list[0][:domain], "/api/nodes"],
        [attributes_list[1][:domain], "/api/nodes"],
        [attributes_list[2][:domain], "/api/nodes"],
      )
      expect(attributes_list.map { |attrs| attrs[:nodes_count] }).to all(be_nil)
    end
  end

  describe ".upsert_instance_record" do
    let(:application_class) { PotatoMesh::Application }
    let(:base_attributes) do
      {
        id: "remote-instance",
        domain: "Remote.Mesh",
        pubkey: PotatoMesh::Application::INSTANCE_PUBLIC_KEY_PEM,
        name: "Remote Mesh",
        version: "1.0.0",
        channel: "longfox",
        frequency: "915",
        latitude: 45.0,
        longitude: -122.0,
        last_update_time: Time.now.to_i,
        is_private: false,
        contact_link: "https://example.org/contact",
      }
    end

    def with_db
      db = SQLite3::Database.new(PotatoMesh::Config.db_path)
      db.busy_timeout = PotatoMesh::Config.db_busy_timeout_ms
      db.execute("PRAGMA foreign_keys = ON")
      yield db
    ensure
      db&.close
    end

    before do
      FileUtils.mkdir_p(File.dirname(PotatoMesh::Config.db_path))
      application_class.init_db unless application_class.db_schema_present?
      application_class.ensure_schema_upgrades
      with_db do |db|
        db.execute("DELETE FROM instances")
      end
      allow(federation_helpers).to receive(:ip_from_domain).and_return(nil)
    end

    it "inserts the contact_link for new records" do
      with_db do |db|
        federation_helpers.send(:upsert_instance_record, db, base_attributes, "sig-1")

        stored = db.get_first_value("SELECT contact_link FROM instances WHERE id = ?", base_attributes[:id])
        expect(stored).to eq("https://example.org/contact")
      end
    end

    it "updates the contact_link on conflict" do
      with_db do |db|
        federation_helpers.send(:upsert_instance_record, db, base_attributes, "sig-1")

        federation_helpers.send(
          :upsert_instance_record,
          db,
          base_attributes.merge(contact_link: "https://example.org/new-contact", name: "Renamed Mesh"),
          "sig-2",
        )

        row =
          db.get_first_row("SELECT contact_link, name, signature FROM instances WHERE id = ?", base_attributes[:id])
        expect(row[0]).to eq("https://example.org/new-contact")
        expect(row[1]).to eq("Renamed Mesh")
        expect(row[2]).to eq("sig-2")
      end
    end

    it "allows the contact_link to be cleared" do
      with_db do |db|
        federation_helpers.send(:upsert_instance_record, db, base_attributes, "sig-1")

        federation_helpers.send(:upsert_instance_record, db, base_attributes.merge(contact_link: nil), "sig-3")

        row = db.get_first_row("SELECT contact_link, signature FROM instances WHERE id = ?", base_attributes[:id])
        expect(row[0]).to be_nil
        expect(row[1]).to eq("sig-3")
      end
    end

    it "stores the nodes_count for new records" do
      with_db do |db|
        federation_helpers.send(:upsert_instance_record, db, base_attributes.merge(nodes_count: 77), "sig-1")

        stored = db.get_first_value("SELECT nodes_count FROM instances WHERE id = ?", base_attributes[:id])
        expect(stored).to eq(77)
      end
    end

    it "updates the nodes_count on conflict" do
      with_db do |db|
        federation_helpers.send(:upsert_instance_record, db, base_attributes.merge(nodes_count: 12), "sig-1")

        federation_helpers.send(
          :upsert_instance_record,
          db,
          base_attributes.merge(nodes_count: 99, name: "Renamed Mesh"),
          "sig-2",
        )

        row =
          db.get_first_row("SELECT nodes_count, name, signature FROM instances WHERE id = ?", base_attributes[:id])
        expect(row[0]).to eq(99)
        expect(row[1]).to eq("Renamed Mesh")
        expect(row[2]).to eq("sig-2")
      end
    end
  end

  describe ".federation_user_agent_header" do
    it "combines the version and sanitized domain" do
      allow(federation_helpers).to receive(:app_constant).and_call_original
      allow(federation_helpers).to receive(:app_constant).with(:APP_VERSION).and_return("9.9.9")
      allow(federation_helpers).to receive(:app_constant).with(:INSTANCE_DOMAIN).and_return("Example.Mesh")

      header = federation_helpers.federation_user_agent_header

      expect(header).to eq("PotatoMesh/9.9.9 (+https://example.mesh)")
    end

    it "falls back to the product name when the domain is unavailable" do
      allow(federation_helpers).to receive(:app_constant).and_call_original
      allow(federation_helpers).to receive(:app_constant).with(:APP_VERSION).and_return("1.2.3")
      allow(federation_helpers).to receive(:app_constant).with(:INSTANCE_DOMAIN).and_return(nil)

      header = federation_helpers.federation_user_agent_header

      expect(header).to eq("PotatoMesh/1.2.3")
    end

    it "uses an explicit unknown marker when the version is blank" do
      allow(federation_helpers).to receive(:app_constant).and_call_original
      allow(federation_helpers).to receive(:app_constant).with(:APP_VERSION).and_return("")
      allow(federation_helpers).to receive(:app_constant).with(:INSTANCE_DOMAIN).and_return("Example.Mesh")

      header = federation_helpers.federation_user_agent_header

      expect(header).to eq("PotatoMesh/unknown (+https://example.mesh)")
    end
  end

  describe ".perform_instance_http_request" do
    let(:uri) { URI.parse("https://remote.example.com/api") }
    let(:http_client) { instance_double(Net::HTTP) }

    before do
      allow(federation_helpers).to receive(:build_remote_http_client).with(uri).and_return(http_client)
    end

    it "wraps errors that omit a message with the error class name" do
      stub_const(
        "RemoteTcpFailure",
        Class.new(StandardError) do
          def message
            ""
          end
        end,
      )

      allow(http_client).to receive(:start).and_raise(RemoteTcpFailure.new)

      expect do
        federation_helpers.send(:perform_instance_http_request, uri)
      end.to raise_error(PotatoMesh::App::InstanceFetchError, "RemoteTcpFailure")
    end

    it "includes the error class name when the message omits it" do
      allow(http_client).to receive(:start).and_raise(OpenSSL::SSL::SSLError.new("handshake failed"))

      expect do
        federation_helpers.send(:perform_instance_http_request, uri)
      end.to raise_error(
        PotatoMesh::App::InstanceFetchError,
        "OpenSSL::SSL::SSLError: handshake failed",
      )
    end

    it "preserves messages that already include the error class" do
      allow(http_client).to receive(:start).and_raise(Net::ReadTimeout.new)

      expect do
        federation_helpers.send(:perform_instance_http_request, uri)
      end.to raise_error(PotatoMesh::App::InstanceFetchError, "Net::ReadTimeout")
    end

    it "wraps restricted address resolution failures" do
      allow(federation_helpers).to receive(:build_remote_http_client).and_call_original
      allow(Addrinfo).to receive(:getaddrinfo).and_return([Addrinfo.ip("127.0.0.1")])

      expect do
        federation_helpers.send(:perform_instance_http_request, uri)
      end.to raise_error(PotatoMesh::App::InstanceFetchError, "ArgumentError: restricted domain")
    end

    it "applies federation headers to instance fetch requests" do
      connection = instance_double("Net::HTTPConnection")
      success_response = Net::HTTPOK.new("1.1", "200", "OK")
      allow(success_response).to receive(:body).and_return("{}")
      allow(success_response).to receive(:code).and_return("200")

      captured_request = nil
      allow(http_client).to receive(:start) do |&block|
        block.call(connection)
      end
      allow(connection).to receive(:request) do |request|
        captured_request = request
        success_response
      end

      result = federation_helpers.send(:perform_instance_http_request, uri)

      expect(result).to eq("{}")
      expect(captured_request).not_to be_nil
      expect(captured_request["Accept"]).to eq("application/json")
      expect(captured_request["User-Agent"]).to eq(federation_helpers.send(:federation_user_agent_header))
      expect(captured_request["Content-Type"]).to be_nil
    end
  end

  describe ".announce_instance_to_domain" do
    let(:payload) { "{}" }
    let(:https_uri) { URI.parse("https://remote.mesh/api/instances") }
    let(:http_uri) { URI.parse("http://remote.mesh/api/instances") }
    let(:http_connection) { instance_double("Net::HTTPConnection") }
    let(:success_response) { Net::HTTPOK.new("1.1", "200", "OK") }

    before do
      allow(success_response).to receive(:code).and_return("200")
    end

    it "retries over HTTP when HTTPS connections are refused" do
      https_client = instance_double(Net::HTTP)
      http_client = instance_double(Net::HTTP)

      allow(federation_helpers).to receive(:build_remote_http_client).with(https_uri).and_return(https_client)
      allow(federation_helpers).to receive(:build_remote_http_client).with(http_uri).and_return(http_client)

      allow(https_client).to receive(:start).and_raise(Errno::ECONNREFUSED.new("refused"))
      allow(http_connection).to receive(:request).and_return(success_response)
      allow(http_client).to receive(:start).and_yield(http_connection).and_return(success_response)

      result = federation_helpers.announce_instance_to_domain("remote.mesh", payload)

      expect(result).to be(true)
      expect(federation_helpers.debug_messages).to include("HTTPS federation announcement failed, retrying with HTTP")
      expect(federation_helpers.warn_messages).to be_empty
    end

    it "logs a warning when HTTPS refusal persists after HTTP fallback" do
      https_client = instance_double(Net::HTTP)
      http_client = instance_double(Net::HTTP)

      allow(federation_helpers).to receive(:build_remote_http_client).with(https_uri).and_return(https_client)
      allow(federation_helpers).to receive(:build_remote_http_client).with(http_uri).and_return(http_client)

      allow(https_client).to receive(:start).and_raise(Errno::ECONNREFUSED.new("refused"))
      allow(http_client).to receive(:start).and_raise(SocketError.new("dns failure"))

      result = federation_helpers.announce_instance_to_domain("remote.mesh", payload)

      expect(result).to be(false)
      expect(federation_helpers.debug_messages).to include("HTTPS federation announcement failed, retrying with HTTP")
      expect(
        federation_helpers.warn_messages.count { |message| message.include?("Federation announcement raised exception") },
      ).to eq(2)
    end

    it "applies federation headers to announcement requests" do
      https_client = instance_double(Net::HTTP)
      allow(federation_helpers).to receive(:build_remote_http_client).with(https_uri).and_return(https_client)

      captured_request = nil
      allow(https_client).to receive(:start).and_yield(http_connection).and_return(success_response)
      allow(http_connection).to receive(:request) do |request|
        captured_request = request
        success_response
      end

      result = federation_helpers.announce_instance_to_domain("remote.mesh", payload)

      expect(result).to be(true)
      expect(captured_request).not_to be_nil
      expect(captured_request["Content-Type"]).to eq("application/json")
      expect(captured_request["Accept"]).to eq("application/json")
      expect(captured_request["User-Agent"]).to eq(federation_helpers.send(:federation_user_agent_header))
    end
  end

  describe ".ensure_federation_worker_pool!" do
    before do
      allow(PotatoMesh::Config).to receive(:federation_worker_pool_size).and_return(1)
      allow(PotatoMesh::Config).to receive(:federation_worker_queue_capacity).and_return(1)
      allow(PotatoMesh::Config).to receive(:federation_task_timeout_seconds).and_return(0.05)
    end

    it "returns nil when federation is disabled" do
      allow(federation_helpers).to receive(:federation_enabled?).and_return(false)

      expect(federation_helpers.ensure_federation_worker_pool!).to be_nil
    end

    it "creates and memoizes the worker pool" do
      allow(federation_helpers).to receive(:federation_enabled?).and_return(true)

      pool = federation_helpers.ensure_federation_worker_pool!
      expect(pool).to be_a(PotatoMesh::App::WorkerPool)
      expect(federation_helpers.ensure_federation_worker_pool!).to equal(pool)
    ensure
      pool&.shutdown(timeout: 0.05)
      federation_helpers.set(:federation_worker_pool, nil)
    end
  end

  describe ".shutdown_federation_worker_pool!" do
    it "logs an error when shutdown fails" do
      pool = instance_double(PotatoMesh::App::WorkerPool)
      allow(pool).to receive(:shutdown).and_raise(StandardError, "boom")

      federation_helpers.set(:federation_worker_pool, pool)
      federation_helpers.shutdown_federation_worker_pool!

      expect(federation_helpers.warn_messages.last).to include("Failed to shut down federation worker pool")
      expect(federation_helpers.send(:settings).federation_worker_pool).to be_nil
    end
  end

  describe ".enqueue_federation_crawl" do
    let(:pool) { instance_double(PotatoMesh::App::WorkerPool) }

    before do
      allow(PotatoMesh::Config).to receive(:federation_crawl_cooldown_seconds).and_return(300)
    end

    it "returns false and logs when the pool is unavailable" do
      allow(federation_helpers).to receive(:federation_worker_pool).and_return(nil)

      result = federation_helpers.enqueue_federation_crawl(
        "remote.mesh",
        per_response_limit: 5,
        overall_limit: 9,
      )

      expect(result).to be(false)
      expect(federation_helpers.debug_messages.last).to include("Skipped remote instance crawl")
    end

    it "schedules ingestion work on the pool" do
      allow(federation_helpers).to receive(:federation_worker_pool).and_return(pool)
      db = instance_double(SQLite3::Database)
      allow(db).to receive(:close)

      expect(federation_helpers).to receive(:open_database).and_return(db)
      expect(federation_helpers).to receive(:ingest_known_instances_from!).with(
        db,
        "remote.mesh",
        per_response_limit: 5,
        overall_limit: 9,
      )

      task = instance_double(PotatoMesh::App::WorkerPool::Task)
      expect(pool).to receive(:schedule) do |&block|
        block.call
        task
      end

      result = federation_helpers.enqueue_federation_crawl(
        "remote.mesh",
        per_response_limit: 5,
        overall_limit: 9,
      )

      expect(result).to be(true)
      expect(db).to have_received(:close)
    end

    it "logs when the worker queue is saturated" do
      allow(federation_helpers).to receive(:federation_worker_pool).and_return(pool)
      allow(pool).to receive(:schedule).and_raise(PotatoMesh::App::WorkerPool::QueueFullError, "full")
      expect(federation_helpers).to receive(:warn_log).with(
        "Skipped remote instance crawl",
        hash_including(
          context: "federation.instances",
          domain: "remote.mesh",
          reason: "worker queue saturated",
        ),
      ).and_call_original

      result = federation_helpers.enqueue_federation_crawl(
        "remote.mesh",
        per_response_limit: 1,
        overall_limit: 2,
      )

      expect(result).to be(false)
    end

    it "does not apply cooldown when scheduling fails due to queue saturation" do
      allow(PotatoMesh::Config).to receive(:federation_crawl_cooldown_seconds).and_return(300)
      allow(federation_helpers).to receive(:federation_worker_pool).and_return(pool)
      allow(pool).to receive(:schedule).and_raise(PotatoMesh::App::WorkerPool::QueueFullError, "full")

      first = federation_helpers.enqueue_federation_crawl(
        "remote.mesh",
        per_response_limit: 1,
        overall_limit: 2,
      )
      second = federation_helpers.enqueue_federation_crawl(
        "remote.mesh",
        per_response_limit: 1,
        overall_limit: 2,
      )

      expect(first).to be(false)
      expect(second).to be(false)
      expect(federation_helpers.debug_messages).not_to include(
        a_string_including("recent crawl completed"),
      )
    end

    it "logs when the worker pool is shutting down" do
      allow(federation_helpers).to receive(:federation_worker_pool).and_return(pool)
      allow(pool).to receive(:schedule).and_raise(PotatoMesh::App::WorkerPool::ShutdownError, "closed")
      expect(federation_helpers).to receive(:warn_log).with(
        "Skipped remote instance crawl",
        hash_including(
          context: "federation.instances",
          domain: "remote.mesh",
          reason: "worker pool shut down",
        ),
      ).and_call_original

      result = federation_helpers.enqueue_federation_crawl(
        "remote.mesh",
        per_response_limit: 1,
        overall_limit: 2,
      )

      expect(result).to be(false)
    end

    it "deduplicates crawls while a domain crawl is already in flight" do
      db = instance_double(SQLite3::Database)
      allow(db).to receive(:close)
      captured_job = nil

      allow(federation_helpers).to receive(:federation_worker_pool).and_return(pool)
      allow(pool).to receive(:schedule) do |&block|
        captured_job = block
        instance_double(PotatoMesh::App::WorkerPool::Task)
      end
      allow(federation_helpers).to receive(:open_database).and_return(db)
      allow(federation_helpers).to receive(:ingest_known_instances_from!)

      first = federation_helpers.enqueue_federation_crawl(
        "remote.mesh",
        per_response_limit: 5,
        overall_limit: 9,
      )
      second = federation_helpers.enqueue_federation_crawl(
        "remote.mesh",
        per_response_limit: 5,
        overall_limit: 9,
      )

      expect(first).to be(true)
      expect(second).to be(false)
      expect(captured_job).not_to be_nil
      captured_job.call
      expect(db).to have_received(:close)
    end

    it "releases the crawl slot when opening the database fails" do
      allow(federation_helpers).to receive(:federation_crawl_cooldown_seconds).and_return(0)
      captured_job = nil
      allow(federation_helpers).to receive(:federation_worker_pool).and_return(pool)
      allow(pool).to receive(:schedule) do |&block|
        captured_job = block
        instance_double(PotatoMesh::App::WorkerPool::Task)
      end
      allow(federation_helpers).to receive(:open_database).and_raise(SQLite3::Exception, "db unavailable")
      allow(federation_helpers).to receive(:ingest_known_instances_from!)

      first = federation_helpers.enqueue_federation_crawl(
        "remote.mesh",
        per_response_limit: 5,
        overall_limit: 9,
      )
      expect(first).to be(true)
      expect(captured_job).not_to be_nil

      expect { captured_job.call }.to raise_error(SQLite3::Exception, "db unavailable")

      second = federation_helpers.enqueue_federation_crawl(
        "remote.mesh",
        per_response_limit: 5,
        overall_limit: 9,
      )
      expect(second).to be(true)
    end
  end

  describe ".shutdown_federation_background_work!" do
    it "marks shutdown and clears announcer references" do
      initial_thread = instance_double(Thread)
      recurring_thread = instance_double(Thread)
      pool = instance_double(PotatoMesh::App::WorkerPool)
      allow(PotatoMesh::Config).to receive(:federation_shutdown_timeout_seconds).and_return(0.05)
      allow(PotatoMesh::Config).to receive(:federation_task_timeout_seconds).and_return(0.05)

      [initial_thread, recurring_thread].each do |thread|
        allow(thread).to receive(:alive?).and_return(false)
      end
      allow(pool).to receive(:shutdown)

      federation_helpers.set(:initial_federation_thread, initial_thread)
      federation_helpers.set(:federation_thread, recurring_thread)
      federation_helpers.set(:federation_worker_pool, pool)

      federation_helpers.shutdown_federation_background_work!

      expect(federation_helpers.federation_shutdown_requested?).to be(true)
      expect(federation_helpers.send(:settings).initial_federation_thread).to be_nil
      expect(federation_helpers.send(:settings).federation_thread).to be_nil
      expect(federation_helpers.send(:settings).federation_worker_pool).to be_nil
    end
  end

  describe ".wait_for_federation_tasks" do
    it "does nothing for empty input" do
      federation_helpers.wait_for_federation_tasks([])
      expect(federation_helpers.warn_messages).to be_empty
    end

    it "logs timeouts" do
      task = instance_double(PotatoMesh::App::WorkerPool::Task)
      allow(task).to receive(:wait).and_raise(PotatoMesh::App::WorkerPool::TaskTimeoutError, "late")
      allow(PotatoMesh::Config).to receive(:federation_task_timeout_seconds).and_return(0.01)

      federation_helpers.wait_for_federation_tasks([["remote.mesh", task]])

      expect(federation_helpers.warn_messages.last).to include("task timed out")
    end

    it "logs unexpected failures" do
      task = instance_double(PotatoMesh::App::WorkerPool::Task)
      allow(task).to receive(:wait).and_raise(RuntimeError, "boom")
      allow(PotatoMesh::Config).to receive(:federation_task_timeout_seconds).and_return(0.01)

      federation_helpers.wait_for_federation_tasks([["remote.mesh", task]])

      expect(federation_helpers.warn_messages.last).to include("task failed")
    end
  end

  describe ".announce_instance_to_all_domains" do
    let(:pool) { instance_double(PotatoMesh::App::WorkerPool) }

    before do
      allow(federation_helpers).to receive(:federation_enabled?).and_return(true)
      allow(federation_helpers).to receive(:ensure_self_instance_record!).and_return([
        { domain: "self.mesh" },
        "signature",
      ])
      allow(federation_helpers).to receive(:instance_announcement_payload).and_return({})
      allow(JSON).to receive(:generate).and_return("payload-json")
      allow(federation_helpers).to receive(:federation_target_domains).and_return(%w[alpha.mesh beta.mesh])
    end

    it "schedules announcements on the worker pool" do
      task = instance_double(PotatoMesh::App::WorkerPool::Task)
      allow(federation_helpers).to receive(:wait_for_federation_tasks)
      allow(federation_helpers).to receive(:federation_worker_pool).and_return(pool)
      expect(pool).to receive(:schedule).twice.and_return(task)

      federation_helpers.announce_instance_to_all_domains
    end

    it "falls back to synchronous announcements when the queue is saturated" do
      allow(federation_helpers).to receive(:federation_worker_pool).and_return(pool)
      allow(pool).to receive(:schedule).and_raise(PotatoMesh::App::WorkerPool::QueueFullError, "full")
      allow(federation_helpers).to receive(:wait_for_federation_tasks)
      expect(federation_helpers).to receive(:announce_instance_to_domain).with("alpha.mesh", "payload-json").once
      expect(federation_helpers).to receive(:announce_instance_to_domain).with("beta.mesh", "payload-json").once

      federation_helpers.announce_instance_to_all_domains
    end

    it "runs synchronously when the worker pool is unavailable" do
      allow(federation_helpers).to receive(:federation_worker_pool).and_return(nil)
      expect(federation_helpers).to receive(:announce_instance_to_domain).with("alpha.mesh", "payload-json")
      expect(federation_helpers).to receive(:announce_instance_to_domain).with("beta.mesh", "payload-json")

      federation_helpers.announce_instance_to_all_domains
    end
  end
end
