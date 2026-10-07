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
  NODES_API_PATH = "/api/nodes".freeze
  # The one node list a crawled peer is judged on (SPEC FL2).
  ACCEPTANCE_NODES_PATH = "/api/nodes?limit=10".freeze
  STATS_API_PATH = "/api/stats".freeze
  FULL_DATA_UNAVAILABLE_REASON = "full data unavailable".freeze
  HTTP_CONNECTION_DOUBLE = "Net::HTTPConnection".freeze

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

        def info_messages
          @info_messages ||= []
        end

        def info_log(message, **metadata)
          info_messages << [message, metadata]
        end

        def reset_info_messages
          @info_messages = []
        end

        def settings
          @settings ||= Struct.new(
            :federation_thread,
            :initial_federation_thread,
            :federation_worker_pool,
            :federation_shutdown_requested,
            :federation_shutdown_hook_installed,
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
    federation_helpers.reset_info_messages
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

    # SPEC SS1/SS2 regression: a peer that publishes an IPv6 transition address
    # embedding an internal IPv4 target must be rejected here, at the same
    # chokepoint that rejects the bare IPv4 form above. Exercised through
    # +build_remote_http_client+ rather than the predicate alone because the
    # pinning in this method is what turns a classification miss into a request.
    {
      "64:ff9b::a9fe:a9fe" => "NAT64-encoded cloud metadata",
      "2002:a9fe:a9fe::" => "6to4-encoded cloud metadata",
      "2001:0:4136:e378:8000:63bf:f5ff:fffe" => "Teredo-encoded RFC1918 client",
      "::127.0.0.1" => "IPv4-compatible loopback",
    }.each do |address, why|
      it "rejects URIs resolving to #{address} (#{why})" do
        uri = URI.parse("https://transition.mesh/api")
        allow(Addrinfo).to receive(:getaddrinfo).and_return([Addrinfo.ip(address)])

        expect do
          federation_helpers.build_remote_http_client(uri)
        end.to raise_error(ArgumentError, "restricted domain")
      end
    end

    it "still reaches an IPv4-only peer synthesised into NAT64 by DNS64" do
      uri = URI.parse("https://v4peer.mesh/api")
      # 64:ff9b::cb00:7105 embeds the public 203.0.113.5; blanket-blocking the
      # NAT64 prefix would strand every IPv4 peer on an IPv6-only network.
      allow(Addrinfo).to receive(:getaddrinfo).and_return([Addrinfo.ip("64:ff9b::cb00:7105")])

      http = federation_helpers.build_remote_http_client(uri)

      if http.respond_to?(:ipaddr)
        expect(http.ipaddr).to eq("64:ff9b::cb00:7105")
      else
        skip "Net::HTTP#ipaddr accessor unavailable"
      end
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

    it "pins to the explicit ip_address when provided" do
      uri = URI.parse("https://remote.example.com/api")

      http = federation_helpers.build_remote_http_client(uri, ip_address: "198.51.100.7")

      if http.respond_to?(:ipaddr)
        expect(http.ipaddr).to eq("198.51.100.7")
      else
        skip "Net::HTTP#ipaddr accessor unavailable"
      end
      expect(Addrinfo).not_to have_received(:getaddrinfo)
    end

    it "skips DNS resolution when ip_address is provided" do
      uri = URI.parse("http://remote.example.com/api")

      federation_helpers.build_remote_http_client(uri, ip_address: "198.51.100.7")

      expect(Addrinfo).not_to have_received(:getaddrinfo)
    end
  end

  describe ".sort_addresses_for_connection" do
    it "returns an empty array unchanged" do
      expect(federation_helpers.send(:sort_addresses_for_connection, [])).to eq([])
    end

    it "returns nil unchanged" do
      expect(federation_helpers.send(:sort_addresses_for_connection, nil)).to be_nil
    end

    it "returns a single-element array unchanged" do
      addr = [IPAddr.new("203.0.113.5")]
      expect(federation_helpers.send(:sort_addresses_for_connection, addr)).to eq(addr)
    end

    it "places IPv4 addresses before IPv6" do
      v6 = IPAddr.new("2001:db8::1")
      v4 = IPAddr.new("203.0.113.5")

      result = federation_helpers.send(:sort_addresses_for_connection, [v6, v4])

      expect(result).to eq([v4, v6])
    end

    it "preserves relative order within the same address family" do
      v4a = IPAddr.new("203.0.113.1")
      v4b = IPAddr.new("203.0.113.2")
      v6a = IPAddr.new("2001:db8::1")
      v6b = IPAddr.new("2001:db8::2")

      result = federation_helpers.send(:sort_addresses_for_connection, [v6a, v4a, v6b, v4b])

      expect(result).to eq([v4a, v4b, v6a, v6b])
    end

    it "preserves order when IPv4 already comes first" do
      v4 = IPAddr.new("203.0.113.5")
      v6 = IPAddr.new("2001:db8::1")

      result = federation_helpers.send(:sort_addresses_for_connection, [v4, v6])

      expect(result).to eq([v4, v6])
    end
  end

  describe ".connection_refused_or_unreachable?" do
    it "returns true for Errno::ECONNREFUSED" do
      expect(federation_helpers.send(:connection_refused_or_unreachable?, Errno::ECONNREFUSED.new)).to be(true)
    end

    it "returns true for Errno::EHOSTUNREACH" do
      expect(federation_helpers.send(:connection_refused_or_unreachable?, Errno::EHOSTUNREACH.new)).to be(true)
    end

    it "returns true for Errno::ENETUNREACH" do
      expect(federation_helpers.send(:connection_refused_or_unreachable?, Errno::ENETUNREACH.new)).to be(true)
    end

    it "returns true for Errno::ECONNRESET" do
      expect(federation_helpers.send(:connection_refused_or_unreachable?, Errno::ECONNRESET.new)).to be(true)
    end

    it "returns true for Errno::ETIMEDOUT" do
      expect(federation_helpers.send(:connection_refused_or_unreachable?, Errno::ETIMEDOUT.new)).to be(true)
    end

    it "returns true for Net::OpenTimeout" do
      expect(federation_helpers.send(:connection_refused_or_unreachable?, Net::OpenTimeout.new)).to be(true)
    end

    it "returns false for OpenSSL::SSL::SSLError" do
      expect(federation_helpers.send(:connection_refused_or_unreachable?, OpenSSL::SSL::SSLError.new("fail"))).to be(false)
    end

    it "returns false for Net::ReadTimeout" do
      expect(federation_helpers.send(:connection_refused_or_unreachable?, Net::ReadTimeout.new)).to be(false)
    end

    it "returns false for a generic StandardError" do
      expect(federation_helpers.send(:connection_refused_or_unreachable?, StandardError.new("nope"))).to be(false)
    end

    it "walks the cause chain to find a retryable error" do
      outer_with_cause = begin
          begin
            raise Errno::ECONNREFUSED, "refused"
          rescue Errno::ECONNREFUSED
            raise StandardError, "wrapper"
          end
        rescue StandardError => e
          e
        end

      expect(outer_with_cause).to be_a(StandardError)
      expect(outer_with_cause.cause).to be_a(Errno::ECONNREFUSED)
      expect(federation_helpers.send(:connection_refused_or_unreachable?, outer_with_cause)).to be(true)
    end
  end

  describe ".ingest_known_instances_from!" do
    let(:db) { double(:db, get_first_row: nil) }
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
        mapping[[attributes[:domain], ACCEPTANCE_NODES_PATH]] = [node_payload, :nodes]
        mapping[[attributes[:domain], "/api/instances"]] = [[], :instances]
      end
      mapping
    end

    before do
      allow(federation_helpers).to receive(:fetch_instance_json) do |host, path|
        response_map.fetch([host, path]) { [nil, []] }
      end
      allow(federation_helpers).to receive(:verify_instance_signature).and_return(true)
      # The relayed-record identity rules have their own spec (SPEC FS8, FS9).
      allow(federation_helpers).to receive(:confirm_relayed_instance_key).and_return([true, nil])
      allow(federation_helpers).to receive(:validate_remote_nodes).and_return([true, nil])
      payload_entries.each_with_index do |entry, index|
        allow(federation_helpers).to receive(:remote_instance_attributes_from_payload).with(entry).and_return([attributes_list[index], "signature-#{index}", nil])
      end
    end

    def configure_remote_node_window(now)
      allow(Time).to receive(:now).and_return(now)
      allow(PotatoMesh::Config).to receive(:remote_instance_max_node_age).and_return(900)
    end

    # A peer's answer to the acceptance request, its newest nodes inside the
    # 7-day floor, distinct from +node_payload+.
    def active_nodes_payload(now)
      Array.new(PotatoMesh::Config.remote_instance_min_node_count) do |index|
        { "node_id" => "active-node-#{index}", "last_heard" => now.to_i - index }
      end
    end

    def stats_mapping(now:, stats_response:, acceptance_nodes_response:, window_nodes_response: nil)
      recent_cutoff = now.to_i - 900
      mapping = { [seed_domain, "/api/instances"] => [payload_entries, :instances] }
      attributes_list.each do |attributes|
        mapping[[attributes[:domain], STATS_API_PATH]] = stats_response
        mapping[[attributes[:domain], ACCEPTANCE_NODES_PATH]] = acceptance_nodes_response
        mapping[[attributes[:domain], "/api/instances"]] = [[], :instances]
        next unless window_nodes_response

        mapping[[attributes[:domain], "/api/nodes?since=#{recent_cutoff}&limit=1000"]] = window_nodes_response
      end
      mapping
    end

    def stub_ingest_fetches(mapping, capture_paths: false)
      captured_paths = []
      allow(federation_helpers).to receive(:fetch_instance_json) do |host, path|
        captured_paths << [host, path] if capture_paths
        mapping.fetch([host, path]) { [nil, []] }
      end
      allow(federation_helpers).to receive(:verify_instance_signature).and_return(true)
      allow(federation_helpers).to receive(:validate_remote_nodes).and_return([true, nil])
      allow(federation_helpers).to receive(:upsert_instance_record)
      captured_paths
    end

    it "stops processing once the per-response limit is exceeded" do
      processed_domains = []
      allow(federation_helpers).to receive(:upsert_instance_record) do |_db, attrs, _signature|
        processed_domains << attrs[:domain]
      end
      allow(PotatoMesh::Config).to receive(:federation_max_instances_per_response).and_return(2)
      allow(PotatoMesh::Config).to receive(:federation_max_domains_per_crawl).and_return(10)

      crawl = federation_helpers.ingest_known_instances_from!(db, seed_domain)

      expect(processed_domains).to eq([
        attributes_list[0][:domain],
        attributes_list[1][:domain],
      ])
      expect(crawl.walked).to include(seed_domain, attributes_list[0][:domain], attributes_list[1][:domain])
      expect(crawl.walked).not_to include(attributes_list[2][:domain])
      expect(federation_helpers.debug_messages).to include(a_string_including("response limit"))
    end

    it "stops the crawl once it would fetch more domains than the crawl limit" do
      processed_domains = []
      allow(federation_helpers).to receive(:upsert_instance_record) do |_db, attrs, _signature|
        processed_domains << attrs[:domain]
      end
      allow(PotatoMesh::Config).to receive(:federation_max_instances_per_response).and_return(5)
      allow(PotatoMesh::Config).to receive(:federation_max_domains_per_crawl).and_return(2)

      crawl = federation_helpers.ingest_known_instances_from!(db, seed_domain)

      expect(processed_domains).to eq([attributes_list.first[:domain]])
      expect(crawl.fetched_domains.to_a).to eq([seed_domain, attributes_list.first[:domain]])
      expect(crawl.stop_reason).to eq("domain limit reached")
      expect(federation_helpers.debug_messages).to include("Stopped federation crawl")
    end

    it "prefers /api/stats when counting remote activity" do
      now = Time.at(1_700_000_000)
      configure_remote_node_window(now)

      mapping = stats_mapping(
        now:,
        stats_response: [{ "active_nodes" => { "hour" => 5, "day" => 7, "week" => 9, "month" => 11 }, "sampled" => false }, :stats],
        acceptance_nodes_response: [node_payload, :nodes],
      )
      captured_paths = stub_ingest_fetches(mapping, capture_paths: true)

      federation_helpers.ingest_known_instances_from!(db, seed_domain)

      expect(captured_paths).to include(
        [attributes_list[0][:domain], STATS_API_PATH],
        [attributes_list[1][:domain], STATS_API_PATH],
        [attributes_list[2][:domain], STATS_API_PATH],
      )
      expect(captured_paths).to include(
        [attributes_list[0][:domain], ACCEPTANCE_NODES_PATH],
        [attributes_list[1][:domain], ACCEPTANCE_NODES_PATH],
        [attributes_list[2][:domain], ACCEPTANCE_NODES_PATH],
      )
      expect(attributes_list.map { |attrs| attrs[:nodes_count] }).to all(eq(5))
    end

    it "reads the 0.7.0 stats shape for total and per-protocol counts" do
      now = Time.at(1_700_000_000)
      configure_remote_node_window(now)

      new_shape = {
        "total" => { "nodes" => { "hour" => 5, "day" => 7, "week" => 9, "month" => 11 } },
        "meshcore" => { "nodes" => { "hour" => 1, "day" => 2, "week" => 3, "month" => 4 } },
        "meshtastic" => { "nodes" => { "hour" => 4, "day" => 5, "week" => 6, "month" => 7 } },
        "reticulum" => { "nodes" => { "hour" => 0, "day" => 0, "week" => 0, "month" => 0 } },
        "sampled" => false,
      }
      mapping = stats_mapping(
        now:,
        stats_response: [new_shape, :stats],
        acceptance_nodes_response: [node_payload, :nodes],
      )
      stub_ingest_fetches(mapping)

      federation_helpers.ingest_known_instances_from!(db, seed_domain)

      # nodes_count comes from total.nodes (the 900s max age selects the hour window).
      expect(attributes_list.map { |attrs| attrs[:nodes_count] }).to all(eq(5))
      # Per-protocol 24h counts come from <protocol>.nodes.day.
      expect(attributes_list.map { |attrs| attrs[:meshcore_nodes_count] }).to all(eq(2))
      expect(attributes_list.map { |attrs| attrs[:meshtastic_nodes_count] }).to all(eq(5))
    end

    it "prefers recent node window counts when /api/stats is unavailable" do
      now = Time.at(1_700_000_000)
      configure_remote_node_window(now)
      acceptance_payload = node_payload.take(2)
      recent_window_payload = node_payload
      recent_path = "/api/nodes?since=#{now.to_i - 900}&limit=1000"

      mapping = stats_mapping(
        now:,
        stats_response: [nil, ["stats unavailable"]],
        acceptance_nodes_response: [acceptance_payload, :nodes],
        window_nodes_response: [recent_window_payload, :nodes],
      )
      captured_paths = stub_ingest_fetches(mapping, capture_paths: true)

      federation_helpers.ingest_known_instances_from!(db, seed_domain)

      expect(captured_paths).to include(
        [attributes_list[0][:domain], STATS_API_PATH],
        [attributes_list[1][:domain], STATS_API_PATH],
        [attributes_list[2][:domain], STATS_API_PATH],
      )
      expect(captured_paths).to include(
        [attributes_list[0][:domain], ACCEPTANCE_NODES_PATH],
        [attributes_list[1][:domain], ACCEPTANCE_NODES_PATH],
        [attributes_list[2][:domain], ACCEPTANCE_NODES_PATH],
      )
      expect(captured_paths).to include(
        [attributes_list[0][:domain], recent_path],
        [attributes_list[1][:domain], recent_path],
        [attributes_list[2][:domain], recent_path],
      )
      expect(attributes_list.map { |attrs| attrs[:nodes_count] }).to all(eq(recent_window_payload.length))
    end

    it "judges a peer on its acceptance list and counts its 24-hour window" do
      now = Time.at(1_700_000_000)
      configure_remote_node_window(now)
      active_payload = active_nodes_payload(now)

      mapping = stats_mapping(
        now:,
        stats_response: [nil, ["stats unavailable"]],
        acceptance_nodes_response: [active_payload, :nodes],
        window_nodes_response: [node_payload, :nodes],
      )
      stub_ingest_fetches(mapping)

      federation_helpers.ingest_known_instances_from!(db, seed_domain)

      # The 24-hour window feeds the count; the 7-day list decides acceptance.
      expect(attributes_list.map { |attrs| attrs[:nodes_count] }).to all(eq(node_payload.length))
      expect(federation_helpers).to have_received(:validate_remote_nodes).with(active_payload).exactly(3).times
      expect(federation_helpers).to have_received(:upsert_instance_record).exactly(3).times
    end

    it "skips the 24-hour window when /api/stats gives the count" do
      now = Time.at(1_700_000_000)
      configure_remote_node_window(now)
      recent_path = "/api/nodes?since=#{now.to_i - 900}&limit=1000"
      active_payload = active_nodes_payload(now)

      mapping = stats_mapping(
        now:,
        stats_response: [{ "active_nodes" => { "hour" => 9, "day" => 10, "week" => 11, "month" => 12 }, "sampled" => false }, :stats],
        acceptance_nodes_response: [active_payload, :nodes],
        window_nodes_response: [node_payload, :nodes],
      )
      captured_paths = stub_ingest_fetches(mapping, capture_paths: true)

      federation_helpers.ingest_known_instances_from!(db, seed_domain)

      expect(captured_paths).to include(
        [attributes_list[0][:domain], STATS_API_PATH],
        [attributes_list[1][:domain], STATS_API_PATH],
        [attributes_list[2][:domain], STATS_API_PATH],
      )
      expect(captured_paths).to include(
        [attributes_list[0][:domain], ACCEPTANCE_NODES_PATH],
        [attributes_list[1][:domain], ACCEPTANCE_NODES_PATH],
        [attributes_list[2][:domain], ACCEPTANCE_NODES_PATH],
      )
      expect(captured_paths.map(&:last)).not_to include(recent_path)
      # /api/stats feeds the count; the 7-day list decides acceptance.
      expect(attributes_list.map { |attrs| attrs[:nodes_count] }).to all(eq(9))
      expect(federation_helpers).to have_received(:validate_remote_nodes).with(active_payload).exactly(3).times
      expect(federation_helpers).to have_received(:upsert_instance_record).exactly(3).times
    end

    it "handles URI metadata from malformed /api/stats payloads without crashing" do
      now = Time.at(1_700_000_000)
      configure_remote_node_window(now)

      mapping = stats_mapping(
        now:,
        stats_response: [{ "unexpected" => "shape" }, URI.parse("https://ally-0.mesh/api/stats")],
        acceptance_nodes_response: [node_payload.take(2), :nodes],
        window_nodes_response: [node_payload, :nodes],
      )
      stub_ingest_fetches(mapping)

      expect do
        federation_helpers.ingest_known_instances_from!(db, seed_domain)
      end.not_to raise_error
      expect(attributes_list.map { |attrs| attrs[:nodes_count] }).to all(eq(node_payload.length))
    end

    it "skips remote entries whose acceptance list is unavailable, asking for no counts" do
      now = Time.at(1_700_000_000)
      configure_remote_node_window(now)
      recent_path = "/api/nodes?since=#{now.to_i - 900}&limit=1000"

      mapping = stats_mapping(
        now:,
        stats_response: [{ "active_nodes" => { "hour" => 3, "day" => 3, "week" => 3, "month" => 3 }, "sampled" => false }, :stats],
        acceptance_nodes_response: [nil, [FULL_DATA_UNAVAILABLE_REASON]],
        window_nodes_response: [nil, ["window unavailable"]],
      )
      captured_paths = stub_ingest_fetches(mapping, capture_paths: true)
      upserted = []
      allow(federation_helpers).to receive(:upsert_instance_record) do |_db, attrs, _signature|
        upserted << attrs
      end

      federation_helpers.ingest_known_instances_from!(db, seed_domain)

      expect(captured_paths).to include(
        [attributes_list[0][:domain], ACCEPTANCE_NODES_PATH],
        [attributes_list[1][:domain], ACCEPTANCE_NODES_PATH],
        [attributes_list[2][:domain], ACCEPTANCE_NODES_PATH],
      )
      expect(captured_paths.map(&:last)).not_to include(recent_path, STATS_API_PATH)
      expect(upserted).to be_empty
      expect(federation_helpers.warn_messages).to include("Failed to load remote node data")
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

    it "stores per-protocol node counts for new records" do
      with_db do |db|
        attrs = base_attributes.merge(
          nodes_count: 50,
          meshcore_nodes_count: 20,
          meshtastic_nodes_count: 30,
        )
        federation_helpers.send(:upsert_instance_record, db, attrs, "sig-1")

        row = db.get_first_row(
          "SELECT nodes_count, meshcore_nodes_count, meshtastic_nodes_count FROM instances WHERE id = ?",
          base_attributes[:id],
        )
        expect(row[0]).to eq(50)
        expect(row[1]).to eq(20)
        expect(row[2]).to eq(30)
      end
    end

    it "updates per-protocol node counts on conflict" do
      with_db do |db|
        attrs = base_attributes.merge(
          meshcore_nodes_count: 10,
          meshtastic_nodes_count: 15,
        )
        federation_helpers.send(:upsert_instance_record, db, attrs, "sig-1")

        updated_attrs = base_attributes.merge(
          meshcore_nodes_count: 25,
          meshtastic_nodes_count: 40,
        )
        federation_helpers.send(:upsert_instance_record, db, updated_attrs, "sig-2")

        row = db.get_first_row(
          "SELECT meshcore_nodes_count, meshtastic_nodes_count FROM instances WHERE id = ?",
          base_attributes[:id],
        )
        expect(row[0]).to eq(25)
        expect(row[1]).to eq(40)
      end
    end

    it "preserves nodes_count when re-upserted with nil" do
      with_db do |db|
        federation_helpers.send(:upsert_instance_record, db, base_attributes.merge(nodes_count: 77), "sig-1")

        federation_helpers.send(:upsert_instance_record, db, base_attributes, "sig-2")

        stored = db.get_first_value("SELECT nodes_count FROM instances WHERE id = ?", base_attributes[:id])
        expect(stored).to eq(77)
      end
    end

    it "preserves per-protocol counts when re-upserted with nil" do
      with_db do |db|
        attrs = base_attributes.merge(
          meshcore_nodes_count: 20,
          meshtastic_nodes_count: 30,
        )
        federation_helpers.send(:upsert_instance_record, db, attrs, "sig-1")

        federation_helpers.send(:upsert_instance_record, db, base_attributes, "sig-2")

        row = db.get_first_row(
          "SELECT meshcore_nodes_count, meshtastic_nodes_count FROM instances WHERE id = ?",
          base_attributes[:id],
        )
        expect(row[0]).to eq(20)
        expect(row[1]).to eq(30)
      end
    end

    it "allows nodes_count to be updated to zero" do
      with_db do |db|
        federation_helpers.send(:upsert_instance_record, db, base_attributes.merge(nodes_count: 50), "sig-1")

        federation_helpers.send(:upsert_instance_record, db, base_attributes.merge(nodes_count: 0), "sig-2")

        stored = db.get_first_value("SELECT nodes_count FROM instances WHERE id = ?", base_attributes[:id])
        expect(stored).to eq(0)
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

  describe ".perform_single_http_request" do
    let(:uri) { URI.parse("https://remote.example.com/api") }
    let(:http_client) { instance_double(Net::HTTP) }

    before do
      allow(federation_helpers).to receive(:build_remote_http_client).and_return(http_client)
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
        federation_helpers.send(:perform_single_http_request, uri)
      end.to raise_error(PotatoMesh::App::InstanceFetchError, "RemoteTcpFailure")
    end

    it "includes the error class name when the message omits it" do
      allow(http_client).to receive(:start).and_raise(OpenSSL::SSL::SSLError.new("handshake failed"))

      expect do
        federation_helpers.send(:perform_single_http_request, uri)
      end.to raise_error(
        PotatoMesh::App::InstanceFetchError,
        "OpenSSL::SSL::SSLError: handshake failed",
      )
    end

    it "preserves messages that already include the error class" do
      allow(http_client).to receive(:start).and_raise(Net::ReadTimeout.new)

      expect do
        federation_helpers.send(:perform_single_http_request, uri)
      end.to raise_error(PotatoMesh::App::InstanceFetchError, "Net::ReadTimeout")
    end

    it "applies federation headers to instance fetch requests" do
      connection = instance_double(HTTP_CONNECTION_DOUBLE)
      success_response = Net::HTTPOK.new("1.1", "200", "OK")
      allow(success_response).to receive(:code).and_return("200")
      allow(success_response).to receive(:read_body).and_yield("{}")

      captured_request = nil
      allow(http_client).to receive(:start) do |&block|
        block.call(connection)
      end
      allow(connection).to receive(:request) do |request, &block|
        captured_request = request
        block.call(success_response)
        success_response
      end

      result = federation_helpers.send(:perform_single_http_request, uri)

      expect(result).to eq("{}")
      expect(captured_request).not_to be_nil
      expect(captured_request["Accept"]).to eq("application/json")
      expect(captured_request["User-Agent"]).to eq(federation_helpers.send(:federation_user_agent_header))
      expect(captured_request["Content-Type"]).to be_nil
    end

    it "wraps non-success HTTP responses" do
      connection = instance_double(HTTP_CONNECTION_DOUBLE)
      failure_response = Net::HTTPBadGateway.new("1.1", "502", "Bad Gateway")
      allow(failure_response).to receive(:code).and_return("502")

      allow(http_client).to receive(:start) do |&block|
        block.call(connection)
      end
      allow(connection).to receive(:request) do |_request, &block|
        block.call(failure_response)
        failure_response
      end

      expect do
        federation_helpers.send(:perform_single_http_request, uri)
      end.to raise_error(
        PotatoMesh::App::InstanceFetchError,
        a_string_including("unexpected response 502"),
      )
    end

    it "rejects a response body larger than the configured maximum" do
      connection = instance_double(HTTP_CONNECTION_DOUBLE)
      success_response = Net::HTTPOK.new("1.1", "200", "OK")
      allow(success_response).to receive(:code).and_return("200")
      # Stream the body in chunks; the cap is exceeded partway through, so the
      # read must be aborted before the whole body is buffered into memory.
      allow(success_response).to receive(:read_body).and_yield("aaaa").and_yield("bbbb")

      allow(PotatoMesh::Config).to receive(:remote_instance_max_response_bytes).and_return(5)
      allow(http_client).to receive(:start) do |&block|
        block.call(connection)
      end
      allow(connection).to receive(:request) do |_request, &block|
        block.call(success_response)
        success_response
      end

      expect do
        federation_helpers.send(:perform_single_http_request, uri)
      end.to raise_error(
        PotatoMesh::App::InstanceFetchError,
        a_string_including("exceeds maximum size of 5 bytes"),
      )
    end

    it "passes ip_address through to build_remote_http_client" do
      allow(http_client).to receive(:start).and_raise(StandardError.new("test"))

      begin
        federation_helpers.send(:perform_single_http_request, uri, ip_address: "198.51.100.7")
      rescue PotatoMesh::App::InstanceFetchError
        # expected
      end

      expect(federation_helpers).to have_received(:build_remote_http_client).with(uri, ip_address: "198.51.100.7")
    end
  end

  describe ".perform_instance_http_request" do
    let(:uri) { URI.parse("https://remote.example.com/api") }
    let(:v4_addr) { IPAddr.new("203.0.113.5") }
    let(:v6_addr) { IPAddr.new("2001:db8::1") }

    before do
      allow(PotatoMesh::Config).to receive(:remote_instance_http_timeout).and_return(5)
      allow(PotatoMesh::Config).to receive(:remote_instance_read_timeout).and_return(10)
      allow(PotatoMesh::Config).to receive(:remote_instance_request_timeout).and_return(15)
    end

    it "succeeds on the first address" do
      allow(federation_helpers).to receive(:resolve_remote_ip_addresses).and_return([v4_addr])
      allow(federation_helpers).to receive(:perform_single_http_request)
                                     .with(uri, ip_address: "203.0.113.5")
                                     .and_return("{}")

      result = federation_helpers.send(:perform_instance_http_request, uri)

      expect(result).to eq("{}")
    end

    it "falls back to the next address on ECONNREFUSED" do
      allow(federation_helpers).to receive(:resolve_remote_ip_addresses).and_return([v6_addr, v4_addr])
      allow(federation_helpers).to receive(:perform_single_http_request)
                                     .with(uri, ip_address: "2001:db8::1")
                                     .and_raise(PotatoMesh::App::InstanceFetchError.new("Errno::ECONNREFUSED: Connection refused"))
      allow(federation_helpers).to receive(:connection_refused_or_unreachable?).and_return(true)
      allow(federation_helpers).to receive(:perform_single_http_request)
                                     .with(uri, ip_address: "203.0.113.5")
                                     .and_return('{"ok":true}')

      result = federation_helpers.send(:perform_instance_http_request, uri)

      expect(result).to eq('{"ok":true}')
    end

    it "raises after all addresses fail with connection errors" do
      allow(federation_helpers).to receive(:resolve_remote_ip_addresses).and_return([v6_addr, v4_addr])
      allow(federation_helpers).to receive(:connection_refused_or_unreachable?).and_return(true)
      allow(federation_helpers).to receive(:perform_single_http_request)
                                     .and_raise(PotatoMesh::App::InstanceFetchError.new("Errno::ECONNREFUSED: Connection refused"))

      expect do
        federation_helpers.send(:perform_instance_http_request, uri)
      end.to raise_error(PotatoMesh::App::InstanceFetchError, /ECONNREFUSED/)
    end

    it "raises immediately on non-connection errors without trying further addresses" do
      allow(federation_helpers).to receive(:resolve_remote_ip_addresses).and_return([v6_addr, v4_addr])
      ssl_error = PotatoMesh::App::InstanceFetchError.new("OpenSSL::SSL::SSLError: handshake failed")
      # After sorting, IPv4 (203.0.113.5) is tried first
      allow(federation_helpers).to receive(:perform_single_http_request)
                                     .with(uri, ip_address: "203.0.113.5")
                                     .and_raise(ssl_error)
      allow(federation_helpers).to receive(:connection_refused_or_unreachable?).and_return(false)

      expect do
        federation_helpers.send(:perform_instance_http_request, uri)
      end.to raise_error(PotatoMesh::App::InstanceFetchError, /SSLError/)

      expect(federation_helpers).not_to have_received(:perform_single_http_request)
                                          .with(uri, ip_address: "2001:db8::1")
    end

    it "stops iterating when shutdown is requested" do
      allow(federation_helpers).to receive(:resolve_remote_ip_addresses).and_return([v6_addr, v4_addr])
      call_count = 0
      allow(federation_helpers).to receive(:perform_single_http_request) do
        call_count += 1
        federation_helpers.request_federation_shutdown!
        raise PotatoMesh::App::InstanceFetchError, "refused"
      end
      allow(federation_helpers).to receive(:connection_refused_or_unreachable?).and_return(true)

      expect do
        federation_helpers.send(:perform_instance_http_request, uri)
      end.to raise_error(PotatoMesh::App::InstanceFetchError)

      expect(call_count).to eq(1)
    end

    it "falls back to address-less request when resolution returns no results" do
      allow(federation_helpers).to receive(:resolve_remote_ip_addresses).and_return([])
      allow(federation_helpers).to receive(:perform_single_http_request)
                                     .with(uri, ip_address: nil)
                                     .and_return("{}")

      result = federation_helpers.send(:perform_instance_http_request, uri)

      expect(result).to eq("{}")
    end

    it "tries IPv4 addresses before IPv6" do
      allow(federation_helpers).to receive(:resolve_remote_ip_addresses).and_return([v6_addr, v4_addr])
      call_order = []
      allow(federation_helpers).to receive(:perform_single_http_request) do |_uri, ip_address:|
        call_order << ip_address
        raise PotatoMesh::App::InstanceFetchError, "refused"
      end
      allow(federation_helpers).to receive(:connection_refused_or_unreachable?).and_return(true)

      begin
        federation_helpers.send(:perform_instance_http_request, uri)
      rescue PotatoMesh::App::InstanceFetchError
        # expected
      end

      expect(call_order).to eq(["203.0.113.5", "2001:db8::1"])
    end

    it "wraps restricted address resolution failures" do
      allow(Addrinfo).to receive(:getaddrinfo).and_return([Addrinfo.ip("127.0.0.1")])

      expect do
        federation_helpers.send(:perform_instance_http_request, uri)
      end.to raise_error(PotatoMesh::App::InstanceFetchError, "ArgumentError: restricted domain")
    end

    it "wraps DNS resolution failures so a peer with an unresolvable domain does not 500" do
      # Addrinfo.getaddrinfo raises Socket::ResolutionError (a SocketError) when
      # the peer domain does not resolve.  It must be wrapped as
      # InstanceFetchError — like the restricted-address ArgumentError above — so
      # the fetch path rejects the peer gracefully instead of bubbling a raw
      # SocketError up to a 500 response.
      allow(Addrinfo).to receive(:getaddrinfo)
                           .and_raise(Socket::ResolutionError.new("getaddrinfo: Name or service not known"))

      expect do
        federation_helpers.send(:perform_instance_http_request, uri)
      end.to raise_error(PotatoMesh::App::InstanceFetchError, /Name or service not known/)
    end
  end

  describe ".federation_sleep_with_shutdown" do
    it "returns false when shutdown is requested during sleep" do
      allow(Kernel).to receive(:sleep)
      call_count = 0
      allow(federation_helpers).to receive(:federation_shutdown_requested?) do
        call_count += 1
        call_count > 1
      end

      result = federation_helpers.federation_sleep_with_shutdown(1.0)

      expect(result).to be(false)
      expect(Kernel).to have_received(:sleep).at_least(:once)
    end

    it "returns true when the full delay elapses without shutdown" do
      allow(Kernel).to receive(:sleep)
      allow(federation_helpers).to receive(:federation_shutdown_requested?).and_return(false)

      result = federation_helpers.federation_sleep_with_shutdown(0.01)

      expect(result).to be(true)
    end
  end

  describe ".instance_announcement_payload" do
    it "includes node count fields when present" do
      attributes = {
        id: "test-id",
        domain: "test.mesh",
        pubkey: "key",
        name: "Test",
        version: "1.0",
        channel: "#ch",
        frequency: "868",
        latitude: 50.0,
        longitude: 10.0,
        last_update_time: Time.now.to_i,
        is_private: false,
        contact_link: nil,
        nodes_count: 42,
        meshcore_nodes_count: 30,
        meshtastic_nodes_count: 12,
        reticulum_nodes_count: 0,
      }
      payload = federation_helpers.instance_announcement_payload(attributes, "sig")
      expect(payload["nodes_count"]).to eq(42)
      expect(payload["meshcore_nodes_count"]).to eq(30)
      expect(payload["meshtastic_nodes_count"]).to eq(12)
      # v2 wire is snake_case with a forward-compat reticulum count + version marker.
      expect(payload["reticulum_nodes_count"]).to eq(0)
      expect(payload["public_key"]).to eq("key")
      expect(payload["signature_version"]).to eq(2)
      expect(payload).not_to have_key("nodesCount")
    end

    it "omits node count fields when nil" do
      attributes = {
        id: "test-id",
        domain: "test.mesh",
        pubkey: "key",
        name: "Test",
        version: "1.0",
        channel: "#ch",
        frequency: "868",
        latitude: 50.0,
        longitude: 10.0,
        last_update_time: Time.now.to_i,
        is_private: false,
        contact_link: nil,
      }
      payload = federation_helpers.instance_announcement_payload(attributes, "sig")
      expect(payload).not_to have_key("nodesCount")
      expect(payload).not_to have_key("meshcoreNodesCount")
      expect(payload).not_to have_key("meshtasticNodesCount")
    end
  end

  describe ".perform_announce_request" do
    let(:uri) { URI.parse("https://remote.mesh/api/instances") }
    let(:payload) { '{"id":"test"}' }
    let(:v4_addr) { IPAddr.new("203.0.113.5") }
    let(:v6_addr) { IPAddr.new("2001:db8::1") }
    let(:success_response) { Net::HTTPOK.new("1.1", "200", "OK") }

    before do
      allow(success_response).to receive(:code).and_return("200")
    end

    it "succeeds on the first resolved address" do
      allow(federation_helpers).to receive(:resolve_remote_ip_addresses).and_return([v4_addr])
      allow(federation_helpers).to receive(:perform_single_announce_request)
                                     .with(uri, payload, ip_address: "203.0.113.5")
                                     .and_return(success_response)

      result = federation_helpers.send(:perform_announce_request, uri, payload)

      expect(result).to eq(success_response)
    end

    it "falls back to the next address on ECONNREFUSED" do
      allow(federation_helpers).to receive(:resolve_remote_ip_addresses).and_return([v6_addr, v4_addr])
      # After sorting, IPv4 is tried first
      allow(federation_helpers).to receive(:perform_single_announce_request)
                                     .with(uri, payload, ip_address: "203.0.113.5")
                                     .and_raise(Errno::ECONNREFUSED.new("refused"))
      allow(federation_helpers).to receive(:perform_single_announce_request)
                                     .with(uri, payload, ip_address: "2001:db8::1")
                                     .and_return(success_response)

      result = federation_helpers.send(:perform_announce_request, uri, payload)

      expect(result).to eq(success_response)
    end

    it "raises after all addresses fail" do
      allow(federation_helpers).to receive(:resolve_remote_ip_addresses).and_return([v6_addr, v4_addr])
      allow(federation_helpers).to receive(:perform_single_announce_request)
                                     .and_raise(Errno::ECONNREFUSED.new("refused"))

      expect do
        federation_helpers.send(:perform_announce_request, uri, payload)
      end.to raise_error(Errno::ECONNREFUSED)
    end

    it "raises immediately on non-connection errors" do
      allow(federation_helpers).to receive(:resolve_remote_ip_addresses).and_return([v6_addr, v4_addr])
      # After sorting, IPv4 (203.0.113.5) is tried first
      allow(federation_helpers).to receive(:perform_single_announce_request)
                                     .with(uri, payload, ip_address: "203.0.113.5")
                                     .and_raise(OpenSSL::SSL::SSLError.new("handshake failed"))

      expect do
        federation_helpers.send(:perform_announce_request, uri, payload)
      end.to raise_error(OpenSSL::SSL::SSLError)

      expect(federation_helpers).not_to have_received(:perform_single_announce_request)
                                          .with(uri, payload, ip_address: "2001:db8::1")
    end

    it "falls back to address-less request when resolution returns no results" do
      allow(federation_helpers).to receive(:resolve_remote_ip_addresses).and_return([])
      allow(federation_helpers).to receive(:perform_single_announce_request)
                                     .with(uri, payload, ip_address: nil)
                                     .and_return(success_response)

      result = federation_helpers.send(:perform_announce_request, uri, payload)

      expect(result).to eq(success_response)
    end
  end

  describe ".announce_instance_to_domain" do
    let(:payload) { "{}" }
    let(:https_uri) { URI.parse("https://remote.mesh/api/instances") }
    let(:http_uri) { URI.parse("http://remote.mesh/api/instances") }
    let(:success_response) { Net::HTTPOK.new("1.1", "200", "OK") }

    before do
      allow(success_response).to receive(:code).and_return("200")
    end

    it "retries over HTTP when HTTPS connections are refused" do
      allow(federation_helpers).to receive(:perform_announce_request)
                                     .with(https_uri, payload)
                                     .and_raise(Errno::ECONNREFUSED.new("refused"))
      allow(federation_helpers).to receive(:perform_announce_request)
                                     .with(http_uri, payload)
                                     .and_return(success_response)

      result = federation_helpers.announce_instance_to_domain("remote.mesh", payload)

      expect(result).to be(true)
      expect(federation_helpers.debug_messages).to include("HTTPS federation announcement failed, retrying with HTTP")
      expect(federation_helpers.warn_messages).to be_empty
    end

    it "logs a warning when HTTPS refusal persists after HTTP fallback" do
      allow(federation_helpers).to receive(:perform_announce_request)
                                     .with(https_uri, payload)
                                     .and_raise(Errno::ECONNREFUSED.new("refused"))
      allow(federation_helpers).to receive(:perform_announce_request)
                                     .with(http_uri, payload)
                                     .and_raise(SocketError.new("dns failure"))

      result = federation_helpers.announce_instance_to_domain("remote.mesh", payload)

      expect(result).to be(false)
      expect(federation_helpers.debug_messages).to include("HTTPS federation announcement failed, retrying with HTTP")
      expect(
        federation_helpers.warn_messages.count { |message| message.include?("Federation announcement raised exception") },
      ).to eq(2)
    end

    it "logs success when the announcement is published" do
      allow(federation_helpers).to receive(:perform_announce_request)
                                     .with(https_uri, payload)
                                     .and_return(success_response)

      result = federation_helpers.announce_instance_to_domain("remote.mesh", payload)

      expect(result).to be(true)
      expect(federation_helpers.debug_messages).to include("Published federation announcement")
    end

    it "does not fall back to HTTP after HTTPS returned an HTTP response" do
      bad_response = Net::HTTPBadRequest.new("1.1", "400", "Bad Request")
      allow(bad_response).to receive(:code).and_return("400")
      expect(federation_helpers).to receive(:perform_announce_request)
                                      .with(https_uri, payload)
                                      .and_return(bad_response)
      expect(federation_helpers).not_to receive(:perform_announce_request)
                                          .with(http_uri, payload)

      result = federation_helpers.announce_instance_to_domain("remote.mesh", payload)

      expect(result).to be(false)
      expect(federation_helpers.warn_messages).to be_empty
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

    it "returns nil when federation shutdown has been requested" do
      allow(federation_helpers).to receive(:federation_enabled?).and_return(true)
      federation_helpers.request_federation_shutdown!

      expect(federation_helpers.ensure_federation_worker_pool!).to be_nil
      expect(federation_helpers.send(:settings).federation_worker_pool).to be_nil
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

  describe ".ensure_federation_shutdown_hook!" do
    it "registers a single at_exit hook when called repeatedly" do
      allow(federation_helpers).to receive(:at_exit)

      federation_helpers.ensure_federation_shutdown_hook!
      federation_helpers.ensure_federation_shutdown_hook!

      expect(federation_helpers).to have_received(:at_exit).once
      expect(federation_helpers.send(:settings).federation_shutdown_hook_installed).to be(true)
    end

    it "delegates hook installation from instances to the application class" do
      class_with_instance = Class.new do
        include PotatoMesh::App::Federation
      end

      expect(class_with_instance).to receive(:ensure_federation_shutdown_hook!).once
      class_with_instance.new.ensure_federation_shutdown_hook!
    end

    it "uses ivar guard when hook-installed setting is unavailable" do
      helper_without_hook_setting = Class.new do
        extend PotatoMesh::App::Federation

        class << self
          def settings
            @settings ||= Struct.new(:federation_thread, :initial_federation_thread, :federation_worker_pool, :federation_shutdown_requested).new
          end

          # No-op in this helper because tests only assert hook registration behavior.
          def shutdown_federation_background_work!(timeout: nil); end
        end
      end

      allow(helper_without_hook_setting).to receive(:at_exit)
      helper_without_hook_setting.ensure_federation_shutdown_hook!
      helper_without_hook_setting.ensure_federation_shutdown_hook!

      expect(helper_without_hook_setting).to have_received(:at_exit).once
      expect(
        helper_without_hook_setting.instance_variable_get(:@federation_shutdown_hook_installed),
      ).to be(true)
    end
  end

  describe ".stop_federation_thread!" do
    it "wakes, joins, and kills a stubborn live thread" do
      thread = instance_double(Thread)
      allow(thread).to receive(:alive?).and_return(true, true, false)
      allow(thread).to receive(:respond_to?).with(:wakeup).and_return(true)
      allow(thread).to receive(:wakeup).and_raise(ThreadError, "not asleep")
      allow(thread).to receive(:join)
      allow(thread).to receive(:kill)

      federation_helpers.set(:federation_thread, thread)
      federation_helpers.stop_federation_thread!(:federation_thread, timeout: 0.01)

      expect(thread).to have_received(:join).with(0.01)
      expect(thread).to have_received(:kill)
      expect(federation_helpers.send(:settings).federation_thread).to be_nil
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

    it "uses federation_shutdown_timeout_seconds (not the task timeout) and arms force_kill_after" do
      pool = instance_double(PotatoMesh::App::WorkerPool)
      allow(PotatoMesh::Config).to receive(:federation_shutdown_timeout_seconds).and_return(3)
      allow(PotatoMesh::Config).to receive(:federation_task_timeout_seconds).and_return(120)
      expect(pool).to receive(:shutdown).with(
        timeout: 3,
        force_kill_after: 3,
      )

      federation_helpers.set(:federation_worker_pool, pool)
      federation_helpers.shutdown_federation_worker_pool!
    end
  end

  describe ".run_federation_crawl_cycle" do
    let(:pool) { instance_double(PotatoMesh::App::WorkerPool) }
    let(:task) { instance_double(PotatoMesh::App::WorkerPool::Task) }

    it "returns false and logs when the pool is unavailable" do
      allow(federation_helpers).to receive(:federation_worker_pool).and_return(nil)

      expect(federation_helpers.run_federation_crawl_cycle).to be(false)
      expect(federation_helpers.debug_messages.last).to eq("Skipped federation crawl")
    end

    it "schedules nothing once shutdown has been requested" do
      federation_helpers.request_federation_shutdown!
      allow(federation_helpers).to receive(:federation_worker_pool)

      expect(federation_helpers.run_federation_crawl_cycle).to be(false)
      expect(federation_helpers).not_to have_received(:federation_worker_pool)
    ensure
      federation_helpers.clear_federation_shutdown_request!
    end

    it "runs one crawl on the pool and waits for it within the task timeout" do
      allow(federation_helpers).to receive(:federation_worker_pool).and_return(pool)
      allow(PotatoMesh::Config).to receive(:federation_task_timeout_seconds).and_return(7)
      allow(federation_helpers).to receive(:crawl_federation!)
      expect(pool).to receive(:schedule) do |&block|
        block.call
        task
      end
      expect(task).to receive(:wait).with(timeout: 7)

      expect(federation_helpers.run_federation_crawl_cycle).to be(true)
      expect(federation_helpers).to have_received(:crawl_federation!).once
    end

    it "logs when the worker queue is saturated" do
      allow(federation_helpers).to receive(:federation_worker_pool).and_return(pool)
      allow(pool).to receive(:schedule).and_raise(PotatoMesh::App::WorkerPool::QueueFullError, "full")
      expect(federation_helpers).to receive(:warn_log).with(
        "Skipped federation crawl",
        hash_including(context: "federation.instances", reason: "worker queue saturated"),
      ).and_call_original

      expect(federation_helpers.run_federation_crawl_cycle).to be(false)
    end

    it "logs when the worker pool is shutting down" do
      allow(federation_helpers).to receive(:federation_worker_pool).and_return(pool)
      allow(pool).to receive(:schedule).and_raise(PotatoMesh::App::WorkerPool::ShutdownError, "closed")
      expect(federation_helpers).to receive(:warn_log).with(
        "Skipped federation crawl",
        hash_including(context: "federation.instances", reason: "worker pool shut down"),
      ).and_call_original

      expect(federation_helpers.run_federation_crawl_cycle).to be(false)
    end

    it "logs a crawl that outlives the task timeout" do
      allow(federation_helpers).to receive(:federation_worker_pool).and_return(pool)
      allow(PotatoMesh::Config).to receive(:federation_task_timeout_seconds).and_return(7)
      allow(pool).to receive(:schedule).and_return(task)
      allow(task).to receive(:wait).and_raise(PotatoMesh::App::WorkerPool::TaskTimeoutError, "task exceeded timeout")
      expect(federation_helpers).to receive(:warn_log).with(
        "Federation crawl timed out",
        hash_including(context: "federation.instances", timeout: 7, error_message: "task exceeded timeout"),
      ).and_call_original

      expect(federation_helpers.run_federation_crawl_cycle).to be(false)
    end
  end

  describe ".fetch_instance_json" do
    it "short-circuits when shutdown has been requested" do
      federation_helpers.request_federation_shutdown!

      payload, metadata = federation_helpers.fetch_instance_json("remote.mesh", NODES_API_PATH)

      expect(payload).to be_nil
      expect(metadata).to eq(["federation shutdown requested"])
    end

    it "stops iterating URI candidates after shutdown is requested mid-loop" do
      calls = 0
      allow(federation_helpers).to receive(:instance_uri_candidates).and_return([
        URI.parse("https://remote.mesh/api/nodes"),
        URI.parse("http://remote.mesh/api/nodes"),
      ])
      allow(federation_helpers).to receive(:perform_instance_http_request) do |_uri|
        calls += 1
        federation_helpers.request_federation_shutdown!
        raise PotatoMesh::App::InstanceFetchError, "boom"
      end

      payload, metadata = federation_helpers.fetch_instance_json("remote.mesh", NODES_API_PATH)

      expect(payload).to be_nil
      expect(calls).to eq(1)
      expect(metadata.first).to include("boom")
    end

    it "returns [nil, errors] instead of raising when the peer domain fails DNS resolution" do
      # Regression for the production 500: a registering/crawled peer whose
      # domain does not resolve must surface as a recorded fetch error (so the
      # caller can reject it with a 4xx), never escape as an unhandled SocketError.
      allow(Addrinfo).to receive(:getaddrinfo)
                           .and_raise(Socket::ResolutionError.new("getaddrinfo: Name or service not known"))

      payload, metadata = federation_helpers.fetch_instance_json("does-not-resolve.invalid", NODES_API_PATH)

      expect(payload).to be_nil
      expect(metadata).not_to be_empty
      expect(metadata.join("; ")).to include("Name or service not known")
    end

    it "does not fall back to HTTP after HTTPS returned an HTTP response" do
      calls = []
      allow(federation_helpers).to receive(:instance_uri_candidates).and_return([
        URI.parse("https://remote.mesh/api/nodes"),
        URI.parse("http://remote.mesh/api/nodes"),
      ])
      allow(federation_helpers).to receive(:perform_instance_http_request) do |uri|
        calls << uri.scheme
        raise PotatoMesh::App::InstanceHttpResponseError, "unexpected response 404"
      end

      payload, metadata = federation_helpers.fetch_instance_json("remote.mesh", NODES_API_PATH)

      expect(payload).to be_nil
      expect(calls).to eq(["https"])
      expect(metadata.first).to include("unexpected response 404")
    end

    it "still falls back to HTTP when HTTPS connection itself fails" do
      calls = []
      allow(federation_helpers).to receive(:instance_uri_candidates).and_return([
        URI.parse("https://remote.mesh/api/nodes"),
        URI.parse("http://remote.mesh/api/nodes"),
      ])
      allow(federation_helpers).to receive(:perform_instance_http_request) do |uri|
        calls << uri.scheme
        if uri.scheme == "https"
          raise PotatoMesh::App::InstanceFetchError, "Errno::ECONNREFUSED: refused"
        else
          '{"ok":true}'
        end
      end

      payload, _ = federation_helpers.fetch_instance_json("remote.mesh", NODES_API_PATH)

      expect(payload).to eq({ "ok" => true })
      expect(calls).to eq(["https", "http"])
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

    it "logs cycle start and end at info level with target and result counts" do
      allow(federation_helpers).to receive(:federation_worker_pool).and_return(nil)
      allow(federation_helpers).to receive(:announce_instance_to_domain)
                                     .with("alpha.mesh", "payload-json").and_return(true)
      allow(federation_helpers).to receive(:announce_instance_to_domain)
                                     .with("beta.mesh", "payload-json").and_return(false)

      federation_helpers.announce_instance_to_all_domains

      messages = federation_helpers.info_messages
      start_entry = messages.find { |(msg, _)| msg.include?("cycle started") }
      end_entry = messages.find { |(msg, _)| msg.include?("cycle complete") }

      expect(start_entry).not_to be_nil
      expect(start_entry.last[:target_count]).to eq(2)

      expect(end_entry).not_to be_nil
      expect(end_entry.last[:success_count]).to eq(1)
      expect(end_entry.last[:failure_count]).to eq(1)
    end
  end

  describe ".fetch_instance_json network timeout and malformed response" do
    let(:uri_https) { URI.parse("https://remote.example.com/api/nodes") }
    let(:uri_http) { URI.parse("http://remote.example.com/api/nodes") }

    before do
      allow(PotatoMesh::Config).to receive(:remote_instance_http_timeout).and_return(5)
      allow(PotatoMesh::Config).to receive(:remote_instance_read_timeout).and_return(10)
      allow(PotatoMesh::Config).to receive(:remote_instance_request_timeout).and_return(15)
      allow(Addrinfo).to receive(:getaddrinfo).and_return([Addrinfo.ip("203.0.113.5")])
    end

    it "returns nil and an error list when a network timeout occurs" do
      # perform_instance_http_request wraps all StandardError subclasses
      # (including Timeout::Error) into InstanceFetchError before returning to
      # fetch_instance_json, which then records the message as an error entry.
      allow(federation_helpers).to receive(:perform_instance_http_request).and_raise(
        PotatoMesh::App::InstanceFetchError, "Timeout::Error: execution expired",
      )

      result, errors = federation_helpers.send(:fetch_instance_json, "remote.example.com", "/api/nodes")

      expect(result).to be_nil
      # At least one error entry should mention the timeout.
      expect(errors).to be_an(Array)
      expect(errors).not_to be_empty
      expect(errors.any? { |e| e.include?("Timeout") || e.include?("expired") }).to be(true)
    end

    it "returns nil and an error list when a Net::OpenTimeout fires" do
      # Net::OpenTimeout inherits from Timeout::Error; perform_instance_http_request
      # wraps it into InstanceFetchError with the class name prepended.
      allow(federation_helpers).to receive(:perform_instance_http_request).and_raise(
        PotatoMesh::App::InstanceFetchError, "Net::OpenTimeout: Failed to open TCP connection",
      )

      result, errors = federation_helpers.send(:fetch_instance_json, "remote.example.com", "/api/nodes")

      expect(result).to be_nil
      expect(errors).not_to be_empty
      expect(errors.any? { |e| e.include?("Timeout") || e.include?("TCP") }).to be(true)
    end

    it "returns nil and records the parse error when the remote responds with 200 but invalid JSON" do
      # perform_instance_http_request returns the raw body string on success;
      # fetch_instance_json then calls JSON.parse on it and must handle the
      # JSON::ParserError gracefully.
      allow(federation_helpers).to receive(:perform_instance_http_request).and_return(
        "not valid { json [",
      )

      result, errors = federation_helpers.send(:fetch_instance_json, "remote.example.com", "/api/nodes")

      expect(result).to be_nil
      expect(errors).not_to be_empty
      expect(errors.any? { |e| e.include?("invalid JSON") }).to be(true)
    end

    it "returns nil and records the parse error when the body is an empty string" do
      # An empty body is not valid JSON; JSON.parse raises a ParserError.
      allow(federation_helpers).to receive(:perform_instance_http_request).and_return("")

      result, errors = federation_helpers.send(:fetch_instance_json, "remote.example.com", "/api/nodes")

      expect(result).to be_nil
      expect(errors).not_to be_empty
    end
  end

  describe ".start_federation_announcer!" do
    it "clears shutdown, installs hook, and exits loop when sleep aborts" do
      thread_double = instance_double(Thread)
      captured = nil

      allow(federation_helpers).to receive(:federation_enabled?).and_return(true)
      allow(federation_helpers).to receive(:clear_federation_shutdown_request!)
      allow(federation_helpers).to receive(:ensure_federation_shutdown_hook!)
      allow(federation_helpers).to receive(:federation_sleep_with_shutdown).and_return(false)
      allow(Thread).to receive(:new) do |&block|
        captured = block
        thread_double
      end
      allow(thread_double).to receive(:respond_to?).with(:name=).and_return(false)
      allow(thread_double).to receive(:respond_to?).with(:daemon=).and_return(false)
      allow(federation_helpers).to receive(:set)

      result = federation_helpers.start_federation_announcer!
      expect(result).to eq(thread_double)
      expect(captured).to be_a(Proc)
      captured.call

      expect(federation_helpers).to have_received(:clear_federation_shutdown_request!)
      expect(federation_helpers).to have_received(:ensure_federation_shutdown_hook!)
      expect(federation_helpers).to have_received(:federation_sleep_with_shutdown)
    end

    it "logs and continues when announce raises in the loop" do
      thread_double = instance_double(Thread)
      captured = nil
      sleep_results = [true, false]

      allow(federation_helpers).to receive(:federation_enabled?).and_return(true)
      allow(federation_helpers).to receive(:clear_federation_shutdown_request!)
      allow(federation_helpers).to receive(:ensure_federation_shutdown_hook!)
      allow(federation_helpers).to receive(:federation_sleep_with_shutdown) { sleep_results.shift }
      allow(federation_helpers).to receive(:announce_instance_to_all_domains).and_raise(RuntimeError, "boom")
      allow(Thread).to receive(:new) do |&block|
        captured = block
        thread_double
      end
      allow(thread_double).to receive(:respond_to?).with(:name=).and_return(false)
      allow(thread_double).to receive(:respond_to?).with(:daemon=).and_return(false)
      allow(federation_helpers).to receive(:set)

      federation_helpers.start_federation_announcer!
      captured.call

      expect(federation_helpers).to have_received(:announce_instance_to_all_domains).once
      expect(federation_helpers.warn_messages.last).to include("Federation announcement loop error")
    end

    it "crawls after each announcement cycle and logs a crawl that raises" do
      thread_double = instance_double(Thread)
      captured = nil
      sleep_results = [true, true, false]

      allow(federation_helpers).to receive(:federation_enabled?).and_return(true)
      allow(federation_helpers).to receive(:clear_federation_shutdown_request!)
      allow(federation_helpers).to receive(:ensure_federation_shutdown_hook!)
      allow(federation_helpers).to receive(:federation_sleep_with_shutdown) { sleep_results.shift }
      allow(federation_helpers).to receive(:announce_instance_to_all_domains)
      allow(federation_helpers).to receive(:run_federation_crawl_cycle).and_raise(RuntimeError, "boom")
      allow(Thread).to receive(:new) do |&block|
        captured = block
        thread_double
      end
      allow(thread_double).to receive(:respond_to?).with(:name=).and_return(false)
      allow(thread_double).to receive(:respond_to?).with(:daemon=).and_return(false)
      allow(federation_helpers).to receive(:set)

      federation_helpers.start_federation_announcer!
      captured.call

      expect(federation_helpers).to have_received(:run_federation_crawl_cycle).once
      expect(federation_helpers).to have_received(:federation_sleep_with_shutdown).with(
        a_value_between(0, PotatoMesh::Config.federation_crawl_max_jitter_seconds),
      )
      expect(federation_helpers.warn_messages.last).to include("Federation crawl loop error")
    end
  end

  describe ".start_initial_federation_announcement!" do
    it "does nothing when federation is disabled" do
      allow(federation_helpers).to receive(:federation_enabled?).and_return(false)

      expect(federation_helpers.start_initial_federation_announcement!).to be_nil
    end

    it "returns the existing thread when one is alive" do
      allow(federation_helpers).to receive(:federation_enabled?).and_return(true)
      allow(federation_helpers).to receive(:clear_federation_shutdown_request!)
      allow(federation_helpers).to receive(:ensure_federation_shutdown_hook!)
      existing = instance_double(Thread, alive?: true)
      federation_helpers.set(:initial_federation_thread, existing)

      expect(federation_helpers.start_initial_federation_announcement!).to equal(existing)
    end

    # Capture the block of the initial announcement thread without starting
    # it, with federation on and no boot delay.
    #
    # @return [Proc] the thread's block.
    def capture_initial_announcement_thread
      thread_double = instance_double(Thread)
      captured = nil
      allow(federation_helpers).to receive(:federation_enabled?).and_return(true)
      allow(federation_helpers).to receive(:clear_federation_shutdown_request!)
      allow(federation_helpers).to receive(:ensure_federation_shutdown_hook!)
      allow(PotatoMesh::Config).to receive(:initial_federation_delay_seconds).and_return(0)
      allow(Thread).to receive(:new) do |&block|
        captured = block
        thread_double
      end
      allow(thread_double).to receive(:respond_to?).with(:name=).and_return(false)
      allow(thread_double).to receive(:respond_to?).with(:report_on_exception=).and_return(false)
      allow(thread_double).to receive(:respond_to?).with(:daemon=).and_return(false)
      federation_helpers.start_initial_federation_announcement!
      captured
    end

    it "logs and clears the slot when the announcement raises, and still crawls" do
      allow(federation_helpers).to receive(:announce_instance_to_all_domains).and_raise(RuntimeError, "boom")
      allow(federation_helpers).to receive(:run_federation_crawl_cycle)

      capture_initial_announcement_thread.call

      expect(federation_helpers.warn_messages.last).to include("Initial federation announcement failed")
      expect(federation_helpers).to have_received(:run_federation_crawl_cycle).once
      expect(federation_helpers.send(:settings).initial_federation_thread).to be_nil
    end

    it "runs the first crawl right after the first announcement" do
      steps = []
      allow(federation_helpers).to receive(:announce_instance_to_all_domains) { steps << :announce }
      allow(federation_helpers).to receive(:run_federation_crawl_cycle) { steps << :crawl }

      capture_initial_announcement_thread.call

      expect(steps).to eq(%i[announce crawl])
    end

    it "logs a first crawl that raises" do
      allow(federation_helpers).to receive(:announce_instance_to_all_domains)
      allow(federation_helpers).to receive(:run_federation_crawl_cycle).and_raise(RuntimeError, "boom")

      capture_initial_announcement_thread.call

      expect(federation_helpers.warn_messages.last).to include("Initial federation crawl failed")
      expect(federation_helpers.send(:settings).initial_federation_thread).to be_nil
    end

    it "logs an error raised before the first announcement" do
      block = capture_initial_announcement_thread
      allow(PotatoMesh::Config).to receive(:initial_federation_delay_seconds).and_raise(RuntimeError, "bad delay")
      allow(federation_helpers).to receive(:announce_instance_to_all_domains)

      block.call

      expect(federation_helpers.warn_messages.last).to include("Initial federation announcement failed")
      expect(federation_helpers).not_to have_received(:announce_instance_to_all_domains)
    end

    it "skips the announcement when shutdown is requested during the initial delay" do
      thread_double = instance_double(Thread)
      captured = nil

      allow(federation_helpers).to receive(:federation_enabled?).and_return(true)
      allow(federation_helpers).to receive(:clear_federation_shutdown_request!)
      allow(federation_helpers).to receive(:ensure_federation_shutdown_hook!)
      allow(PotatoMesh::Config).to receive(:initial_federation_delay_seconds).and_return(0.01)
      allow(federation_helpers).to receive(:federation_sleep_with_shutdown).and_return(false)
      allow(federation_helpers).to receive(:announce_instance_to_all_domains)
      allow(Thread).to receive(:new) do |&block|
        captured = block
        thread_double
      end
      allow(thread_double).to receive(:respond_to?).with(:name=).and_return(false)
      allow(thread_double).to receive(:respond_to?).with(:report_on_exception=).and_return(false)
      allow(thread_double).to receive(:respond_to?).with(:daemon=).and_return(false)

      federation_helpers.start_initial_federation_announcement!
      captured.call

      expect(federation_helpers).not_to have_received(:announce_instance_to_all_domains)
    end
  end

  describe ".announce_instance_to_domain (non-success branch)" do
    it "logs the failure when the response is not a success" do
      payload = "{}"
      https_uri = URI.parse("https://remote.mesh/api/instances")
      response = Net::HTTPInternalServerError.new("1.1", "500", "Server Error")
      allow(response).to receive(:code).and_return("500")
      allow(federation_helpers).to receive(:perform_announce_request)
                                     .with(https_uri, payload)
                                     .and_return(response)
      allow(federation_helpers).to receive(:perform_announce_request)
                                     .with(URI.parse("http://remote.mesh/api/instances"), payload)
                                     .and_return(response)

      result = federation_helpers.announce_instance_to_domain("remote.mesh", payload)

      expect(result).to be(false)
      expect(federation_helpers.debug_messages).to include("Federation announcement failed")
    end
  end

  describe ".perform_single_announce_request" do
    let(:uri) { URI.parse("https://remote.mesh/api/instances") }
    let(:payload) { '{"id":"x"}' }
    let(:http_client) { instance_double(Net::HTTP) }

    before do
      allow(PotatoMesh::Config).to receive(:remote_instance_request_timeout).and_return(5)
      allow(federation_helpers).to receive(:build_remote_http_client).and_return(http_client)
    end

    it "issues a POST through the connection block" do
      connection = instance_double(HTTP_CONNECTION_DOUBLE)
      response = Net::HTTPOK.new("1.1", "200", "OK")
      allow(response).to receive(:code).and_return("200")
      captured_request = nil

      allow(http_client).to receive(:start) { |&block| block.call(connection) }
      allow(connection).to receive(:request) do |request|
        captured_request = request
        response
      end

      result = federation_helpers.send(:perform_single_announce_request, uri, payload, ip_address: "203.0.113.5")

      expect(result).to eq(response)
      expect(captured_request).to be_a(Net::HTTP::Post)
      expect(captured_request.body).to eq(payload)
      expect(federation_helpers).to have_received(:build_remote_http_client).with(uri, ip_address: "203.0.113.5")
    end
  end

  describe ".announce_instance_to_all_domains (extra branches)" do
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
      allow(federation_helpers).to receive(:wait_for_federation_tasks)
    end

    it "executes the scheduled task block to announce on the pool" do
      task = instance_double(PotatoMesh::App::WorkerPool::Task)
      captured_blocks = []
      allow(federation_helpers).to receive(:federation_worker_pool).and_return(pool)
      allow(pool).to receive(:schedule) do |&block|
        captured_blocks << block
        task
      end
      allow(federation_helpers).to receive(:announce_instance_to_domain)

      federation_helpers.announce_instance_to_all_domains
      captured_blocks.each(&:call)

      expect(federation_helpers).to have_received(:announce_instance_to_domain).with("alpha.mesh", "payload-json")
      expect(federation_helpers).to have_received(:announce_instance_to_domain).with("beta.mesh", "payload-json")
    end

    it "falls back to synchronous announcements when the pool is shutting down" do
      allow(federation_helpers).to receive(:federation_worker_pool).and_return(pool)
      allow(pool).to receive(:schedule).and_raise(PotatoMesh::App::WorkerPool::ShutdownError, "closed")
      allow(federation_helpers).to receive(:announce_instance_to_domain)

      federation_helpers.announce_instance_to_all_domains

      expect(federation_helpers).to have_received(:announce_instance_to_domain).with("alpha.mesh", "payload-json")
      expect(federation_helpers).to have_received(:announce_instance_to_domain).with("beta.mesh", "payload-json")
      expect(federation_helpers.warn_messages).to include(a_string_including("Worker pool unavailable"))
    end
  end

  describe ".remote_active_node_count_from_stats" do
    let(:active) { { "hour" => 1, "day" => 2, "week" => 3, "month" => 4 } }

    it "returns the day count for sub-day windows" do
      payload = { "active_nodes" => active }
      expect(federation_helpers.remote_active_node_count_from_stats(payload, max_age_seconds: 7_200)).to eq(2)
    end

    it "returns the week count for sub-week windows" do
      payload = { "active_nodes" => active }
      expect(federation_helpers.remote_active_node_count_from_stats(payload, max_age_seconds: 90_000)).to eq(3)
    end

    it "returns the month count for windows beyond a week" do
      payload = { "active_nodes" => active }
      window = PotatoMesh::Config.week_seconds + 60
      expect(federation_helpers.remote_active_node_count_from_stats(payload, max_age_seconds: window)).to eq(4)
    end

    it "reads the 0.7.0 total.nodes shape" do
      payload = { "total" => { "nodes" => active } }
      expect(federation_helpers.remote_active_node_count_from_stats(payload, max_age_seconds: 7_200)).to eq(2)
    end

    it "prefers the new shape over a legacy active_nodes block" do
      payload = {
        "total" => { "nodes" => { "hour" => 1, "day" => 8, "week" => 9, "month" => 10 } },
        "active_nodes" => active,
      }
      expect(federation_helpers.remote_active_node_count_from_stats(payload, max_age_seconds: 7_200)).to eq(8)
    end

    it "returns nil when neither stats shape is present" do
      payload = { "sampled" => false }
      expect(federation_helpers.remote_active_node_count_from_stats(payload, max_age_seconds: 7_200)).to be_nil
    end
  end

  describe ".remote_stats_protocol_day" do
    it "reads the 0.7.0 nodes sub-hash" do
      payload = { "meshcore" => { "nodes" => { "day" => 9 } } }
      expect(federation_helpers.remote_stats_protocol_day(payload, "meshcore")).to eq(9)
    end

    it "falls back to the legacy flat day count" do
      payload = { "meshtastic" => { "day" => 4 } }
      expect(federation_helpers.remote_stats_protocol_day(payload, "meshtastic")).to eq(4)
    end

    it "returns nil when neither shape carries the protocol" do
      expect(federation_helpers.remote_stats_protocol_day({}, "meshcore")).to be_nil
    end
  end

  describe ".remote_instance_attributes_from_payload (extra branches)" do
    let(:application_class) { PotatoMesh::Application }

    it "honors the legacy is_private key when isPrivate is absent" do
      payload = {
        "id" => "remote-id",
        "domain" => "remote.mesh",
        "pubkey" => application_class::INSTANCE_PUBLIC_KEY_PEM,
        "signature" => "sig",
        "is_private" => true,
      }

      attributes, signature, reason = application_class.remote_instance_attributes_from_payload(payload)

      expect(reason).to be_nil
      expect(signature).to eq("sig")
      expect(attributes[:is_private]).to be(true)
    end

    it "treats numeric is_private values as truthy when non-zero" do
      payload = {
        "id" => "remote-id",
        "domain" => "remote.mesh",
        "pubkey" => application_class::INSTANCE_PUBLIC_KEY_PEM,
        "signature" => "sig",
        "isPrivate" => 1,
      }

      attributes, _signature, _reason = application_class.remote_instance_attributes_from_payload(payload)

      expect(attributes[:is_private]).to be(true)
    end

    it "wraps unexpected exceptions raised during parsing" do
      payload = {
        "id" => "remote-id",
        "domain" => "remote.mesh",
        "pubkey" => application_class::INSTANCE_PUBLIC_KEY_PEM,
        "signature" => "sig",
      }
      allow(application_class).to receive(:coerce_float).and_raise(StandardError, "exploded")

      attributes, signature, reason = application_class.remote_instance_attributes_from_payload(payload)

      expect(attributes).to be_nil
      expect(signature).to be_nil
      expect(reason).to eq("exploded")
    end
  end

  describe ".ingest_known_instances_from! (stopped crawl short-circuit)" do
    it "returns the crawl at once when it already spent its budget" do
      crawl = PotatoMesh::App::Federation::CrawlState.new(
        own_domain: nil, max_domains: 2, max_requests: 0, deadline_seconds: 60,
      )
      crawl.request_allowed?("seed.mesh")
      allow(federation_helpers).to receive(:fetch_instance_json)

      result = federation_helpers.ingest_known_instances_from!(:db, "seed.mesh", crawl: crawl, per_response_limit: 5)

      expect(result).to equal(crawl)
      expect(crawl.walked).to be_empty
      expect(federation_helpers).not_to have_received(:fetch_instance_json)
    end
  end

  describe ".https_connection_refused? (extra branches)" do
    it "returns false when no link in the cause chain is ECONNREFUSED" do
      outer = begin
          begin
            raise StandardError, "inner"
          rescue StandardError
            raise StandardError, "outer"
          end
        rescue StandardError => e
          e
        end

      expect(federation_helpers.send(:https_connection_refused?, outer)).to be(false)
    end

    it "walks the cause chain to find ECONNREFUSED" do
      outer = begin
          begin
            raise Errno::ECONNREFUSED, "refused"
          rescue Errno::ECONNREFUSED
            raise StandardError, "wrapper"
          end
        rescue StandardError => e
          e
        end

      expect(federation_helpers.send(:https_connection_refused?, outer)).to be(true)
    end
  end

  describe ".instance_uri_candidates" do
    it "returns an empty array when URI parsing fails" do
      allow(URI).to receive(:parse).and_raise(URI::InvalidURIError, "bad")

      expect(federation_helpers.send(:instance_uri_candidates, "remote.mesh", "/api/x")).to eq([])
    end
  end

  describe ".resolve_remote_ip_addresses (invalid address skipping)" do
    it "skips addrinfo entries that cannot be parsed as IPAddr" do
      bogus = instance_double(Addrinfo, ip_address: "not-an-ip")
      good = Addrinfo.ip("203.0.113.5")
      allow(Addrinfo).to receive(:getaddrinfo).and_return([bogus, good])

      uri = URI.parse("https://remote.mesh/api")
      result = federation_helpers.send(:resolve_remote_ip_addresses, uri)

      expect(result.map(&:to_s)).to eq(["203.0.113.5"])
    end
  end

  describe ".remote_instance_verify_callback (failure path)" do
    it "logs and clears the cached callback when creation raises" do
      federation_helpers.instance_variable_set(:@remote_instance_verify_callback, nil)
      allow(federation_helpers).to receive(:lambda).and_raise(StandardError, "boom")

      expect(federation_helpers.remote_instance_verify_callback).to be_nil
      expect(federation_helpers.debug_messages.last).to include("verify callback")
    end
  end

  describe ".active_node_count_since (rescue path)" do
    it "logs and returns nil when the database query raises" do
      handle = instance_double(SQLite3::Database)
      allow(handle).to receive(:close)
      allow(federation_helpers).to receive(:open_database).and_return(handle)
      allow(federation_helpers).to receive(:with_busy_retry).and_raise(SQLite3::Exception, "boom")

      expect(federation_helpers.active_node_count_since(100)).to be_nil
      expect(federation_helpers.warn_messages.last).to include("Failed to count active nodes")
      expect(handle).to have_received(:close)
    end
  end

  describe ".active_node_count_since_for_protocol (rescue path)" do
    it "logs and returns nil when the database query raises" do
      handle = instance_double(SQLite3::Database)
      allow(handle).to receive(:close)
      allow(federation_helpers).to receive(:open_database).and_return(handle)
      allow(federation_helpers).to receive(:with_busy_retry).and_raise(ArgumentError, "bad value")

      expect(federation_helpers.active_node_count_since_for_protocol(100, "meshcore")).to be_nil
      expect(federation_helpers.warn_messages.last).to include("Failed to count active nodes for protocol")
      expect(handle).to have_received(:close)
    end
  end

  describe "federation counts honour the opt-out marker" do
    around do |example|
      Dir.mktmpdir("federation-optout-") do |dir|
        db_path = File.join(dir, "mesh.db")
        RSpec::Mocks.with_temporary_scope do
          allow(PotatoMesh::Config).to receive(:db_path).and_return(db_path)
          allow(PotatoMesh::Config).to receive(:db_busy_timeout_ms).and_return(5000)
          db_helper = Object.new.extend(PotatoMesh::App::Database)
          db_helper.init_db
          db_helper.ensure_schema_upgrades
          example.run
        end
      end
    end

    let(:marker) { PotatoMesh::Config.node_opt_out_marker }
    let(:now) { Time.now.to_i }

    it "excludes opted-out nodes from active_node_count_since" do
      db = SQLite3::Database.new(PotatoMesh::Config.db_path)
      db.execute(
        "INSERT INTO nodes(node_id, num, short_name, long_name, last_heard, first_heard, role, protocol) " \
        "VALUES (?,?,?,?,?,?,?,?)",
        ["!visnode1", 0x10000001, "VN", "Visible", now, now, "CLIENT", "meshtastic"],
      )
      db.execute(
        "INSERT INTO nodes(node_id, num, short_name, long_name, last_heard, first_heard, role, protocol) " \
        "VALUES (?,?,?,?,?,?,?,?)",
        ["!hidnode1", 0x10000002, "HN", "Hidden #{marker}", now, now, "CLIENT", "meshtastic"],
      )
      db.close

      expect(federation_helpers.active_node_count_since(now - 60)).to eq(1)
    end

    it "excludes opted-out nodes from active_node_count_since_for_protocol" do
      db = SQLite3::Database.new(PotatoMesh::Config.db_path)
      db.execute(
        "INSERT INTO nodes(node_id, num, short_name, long_name, last_heard, first_heard, role, protocol) " \
        "VALUES (?,?,?,?,?,?,?,?)",
        ["!mcvisible", 0x20000001, "MV", "MC Visible", now, now, "COMPANION", "meshcore"],
      )
      db.execute(
        "INSERT INTO nodes(node_id, num, short_name, long_name, last_heard, first_heard, role, protocol) " \
        "VALUES (?,?,?,?,?,?,?,?)",
        ["!mchidden", 0x20000002, "MH", "MC #{marker} Hidden", now, now, "COMPANION", "meshcore"],
      )
      db.close

      expect(federation_helpers.active_node_count_since_for_protocol(now - 60, "meshcore")).to eq(1)
    end
  end

  describe ".federation_worker_pool" do
    it "delegates to ensure_federation_worker_pool!" do
      sentinel = Object.new
      allow(federation_helpers).to receive(:ensure_federation_worker_pool!).and_return(sentinel)

      expect(federation_helpers.federation_worker_pool).to equal(sentinel)
    end
  end

  describe ".self_instance_domain" do
    let(:application_class) { PotatoMesh::Application }

    it "returns the sanitized INSTANCE_DOMAIN when present" do
      allow(application_class).to receive(:app_constant).with(:INSTANCE_DOMAIN).and_return("Example.Mesh")

      expect(application_class.self_instance_domain).to eq("example.mesh")
    end

    it "logs and returns nil outside production when the domain is missing" do
      allow(application_class).to receive(:app_constant).with(:INSTANCE_DOMAIN).and_return(nil)
      allow(application_class).to receive(:app_constant).with(:INSTANCE_DOMAIN_SOURCE).and_return(:default)
      allow(application_class).to receive(:production_environment?).and_return(false)
      allow(application_class).to receive(:debug_log)

      expect(application_class.self_instance_domain).to be_nil
      expect(application_class).to have_received(:debug_log).with(
        a_string_including("INSTANCE_DOMAIN unavailable"),
        hash_including(context: "federation.instances"),
      )
    end

    it "raises in production when the domain cannot be determined" do
      allow(application_class).to receive(:app_constant).with(:INSTANCE_DOMAIN).and_return(nil)
      allow(application_class).to receive(:app_constant).with(:INSTANCE_DOMAIN_SOURCE).and_return(:environment)
      allow(application_class).to receive(:production_environment?).and_return(true)

      expect { application_class.self_instance_domain }.to raise_error(RuntimeError, /INSTANCE_DOMAIN/)
    end
  end

  describe ".self_instance_registration_decision" do
    let(:application_class) { PotatoMesh::Application }

    it "rejects domains that resolve to restricted IP addresses" do
      allow(application_class).to receive(:app_constant).with(:INSTANCE_DOMAIN_SOURCE).and_return(:environment)
      allow(application_class).to receive(:ip_from_domain).and_return(IPAddr.new("127.0.0.1"))
      allow(application_class).to receive(:restricted_ip_address?).and_return(true)

      allowed, reason = application_class.self_instance_registration_decision("loopback.mesh")

      expect(allowed).to be(false)
      expect(reason).to eq("INSTANCE_DOMAIN resolves to restricted IP")
    end
  end

  describe ".ensure_self_instance_record! (skip branch)" do
    let(:application_class) { PotatoMesh::Application }

    before do
      PotatoMesh::App::Federation.reset_self_registration_log_state!
    end

    it "logs without writing when registration is not allowed" do
      attributes = { id: "self", domain: "self.mesh" }
      allow(application_class).to receive(:self_instance_attributes).and_return(attributes)
      allow(application_class).to receive(:sign_instance_attributes).and_return("sig")
      allow(application_class).to receive(:self_instance_registration_decision).and_return([false, "blocked"])
      allow(application_class).to receive(:open_database)
      allow(application_class).to receive(:upsert_instance_record)
      allow(application_class).to receive(:debug_log)

      result_attrs, result_sig = application_class.ensure_self_instance_record!

      expect(result_attrs).to eq(attributes)
      expect(result_sig).to eq("sig")
      expect(application_class).not_to have_received(:open_database)
      expect(application_class).not_to have_received(:upsert_instance_record)
      expect(application_class).to have_received(:debug_log).with(
        "Skipped self instance registration",
        hash_including(reason: "blocked"),
      )
    end

    it "deduplicates the skip log when the decision does not change" do
      attributes = { id: "self", domain: "self.mesh" }
      allow(application_class).to receive(:self_instance_attributes).and_return(attributes)
      allow(application_class).to receive(:sign_instance_attributes).and_return("sig")
      allow(application_class).to receive(:self_instance_registration_decision).and_return([false, "blocked"])
      allow(application_class).to receive(:debug_log)

      3.times { application_class.ensure_self_instance_record! }

      expect(application_class).to have_received(:debug_log).with(
        "Skipped self instance registration",
        hash_including(reason: "blocked"),
      ).once
    end

    it "re-emits the log when the decision flips between calls" do
      attributes = { id: "self", domain: "self.mesh" }
      allow(application_class).to receive(:self_instance_attributes).and_return(attributes)
      allow(application_class).to receive(:sign_instance_attributes).and_return("sig")
      allow(application_class).to receive(:open_database)
      allow(application_class).to receive(:upsert_instance_record)
      allow(application_class).to receive(:debug_log)

      decisions = [
        [false, "blocked"],
        [false, "blocked"],
        [true, nil],
        [true, nil],
        [false, "blocked"],
      ]
      allow(application_class).to receive(:self_instance_registration_decision) do
        decisions.shift
      end

      5.times { application_class.ensure_self_instance_record! }

      expect(application_class).to have_received(:debug_log).with(
        "Skipped self instance registration",
        hash_including(reason: "blocked"),
      ).twice
      expect(application_class).to have_received(:debug_log).with(
        "Registered self instance record",
        hash_including(domain: "self.mesh"),
      ).once
    end
  end

  describe ".verify_instance_signature (failure path)" do
    let(:application_class) { PotatoMesh::Application }
    let(:attributes) { { id: "x", domain: "x.mesh" } }

    it "returns false when the signature is not valid base64" do
      result = application_class.verify_instance_signature(
        attributes,
        "not base64 !!!",
        application_class::INSTANCE_PUBLIC_KEY_PEM,
      )

      expect(result).to be(false)
    end

    it "returns false when the public key is malformed" do
      result = application_class.verify_instance_signature(
        attributes,
        Base64.strict_encode64("anything"),
        "-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----\n",
      )

      expect(result).to be(false)
    end
  end

  describe "instance signature v2 migration (FS1-FS4)" do
    let(:application_class) { PotatoMesh::Application }
    let(:keypair) { OpenSSL::PKey::RSA.new(2048) }
    let(:pubkey_pem) { keypair.public_key.to_pem }
    let(:attributes) do
      {
        id: "inst-1", domain: "a.mesh", pubkey: pubkey_pem, name: "A",
        version: "0.7.0", channel: "#x", frequency: "915MHz",
        latitude: 1.0, longitude: 2.0, last_update_time: 1_700_000_000,
        is_private: false, contact_link: "#a:x", nodes_count: 7,
        meshcore_nodes_count: 3, meshtastic_nodes_count: 4, reticulum_nodes_count: 0,
      }
    end

    def sign_canonical(canonical)
      Base64.strict_encode64(keypair.sign(OpenSSL::Digest::SHA256.new, canonical))
    end

    it "signs the v2 (snake_case) canonical with a signature_version marker and signed counts" do
      parsed = JSON.parse(application_class.canonical_instance_payload(attributes))
      expect(parsed).to include(
        "public_key", "last_update", "is_private", "contact_link",
        "nodes_count", "meshcore_nodes_count", "meshtastic_nodes_count",
        "reticulum_nodes_count", "signature_version"
      )
      expect(parsed["signature_version"]).to eq(2)
      expect(parsed).not_to have_key("publicKey")
      expect(parsed).not_to have_key("lastUpdateTime")
      expect(parsed).not_to have_key("isPrivate")
    end

    it "verifies a v2 signature" do
      sig = sign_canonical(application_class.canonical_instance_payload_v2(attributes))
      expect(application_class.verify_instance_signature(attributes, sig, pubkey_pem)).to be(true)
    end

    it "still verifies a legacy v1 (camelCase) signature — backward accept" do
      sig = sign_canonical(application_class.canonical_instance_payload_v1(attributes))
      expect(application_class.verify_instance_signature(attributes, sig, pubkey_pem)).to be(true)
    end

    it "rejects a tampered node count (counts are signed in v2)" do
      sig = sign_canonical(application_class.canonical_instance_payload_v2(attributes))
      tampered = attributes.merge(nodes_count: 999)
      expect(application_class.verify_instance_signature(tampered, sig, pubkey_pem)).to be(false)
    end
  end

  describe ".validate_well_known_document" do
    let(:application_class) { PotatoMesh::Application }
    let(:domain) { "remote.mesh" }
    let(:keypair) { OpenSSL::PKey::RSA.new(2048) }
    let(:pubkey_pem) { keypair.public_key.to_pem }

    def signed_payload_for(domain_value, pubkey_value)
      payload = JSON.generate({ "domain" => domain_value, "publicKey" => pubkey_value })
      signature = keypair.sign(OpenSSL::Digest::SHA256.new, payload)
      [Base64.strict_encode64(payload), Base64.strict_encode64(signature)]
    end

    it "rejects non-Hash documents" do
      ok, reason = application_class.validate_well_known_document([], domain, pubkey_pem)

      expect(ok).to be(false)
      expect(reason).to eq("document is not an object")
    end

    it "rejects unsupported signature algorithms" do
      document = {
        "publicKey" => pubkey_pem,
        "domain" => domain,
        "signatureAlgorithm" => "ed25519",
      }

      ok, reason = application_class.validate_well_known_document(document, domain, pubkey_pem)

      expect(ok).to be(false)
      expect(reason).to eq("unsupported signature algorithm")
    end

    it "rejects documents whose signature does not verify against the public key" do
      signed_b64, _ = signed_payload_for(domain, pubkey_pem)
      bogus_signature = Base64.strict_encode64("not a valid signature")
      document = {
        "publicKey" => pubkey_pem,
        "domain" => domain,
        "signatureAlgorithm" => PotatoMesh::Config.instance_signature_algorithm,
        "signedPayload" => signed_b64,
        "signature" => bogus_signature,
      }

      ok, reason = application_class.validate_well_known_document(document, domain, pubkey_pem)

      expect(ok).to be(false)
      expect(reason).to eq("invalid well-known signature")
    end

    it "rejects documents whose signed payload is not an object" do
      payload = JSON.generate(["not", "an", "object"])
      signature = keypair.sign(OpenSSL::Digest::SHA256.new, payload)
      document = {
        "publicKey" => pubkey_pem,
        "domain" => domain,
        "signatureAlgorithm" => PotatoMesh::Config.instance_signature_algorithm,
        "signedPayload" => Base64.strict_encode64(payload),
        "signature" => Base64.strict_encode64(signature),
      }

      ok, reason = application_class.validate_well_known_document(document, domain, pubkey_pem)

      expect(ok).to be(false)
      expect(reason).to eq("signed payload is not an object")
    end

    it "wraps ArgumentError raised from base64 decoding" do
      document = {
        "publicKey" => pubkey_pem,
        "domain" => domain,
        "signatureAlgorithm" => PotatoMesh::Config.instance_signature_algorithm,
        "signedPayload" => "not!base64!",
        "signature" => "still!not!base64!",
      }

      ok, reason = application_class.validate_well_known_document(document, domain, pubkey_pem)

      expect(ok).to be(false)
      expect(reason).to be_a(String)
    end

    it "wraps JSON::ParserError when the signed payload is not valid JSON" do
      payload = "not valid json"
      signature = keypair.sign(OpenSSL::Digest::SHA256.new, payload)
      document = {
        "publicKey" => pubkey_pem,
        "domain" => domain,
        "signatureAlgorithm" => PotatoMesh::Config.instance_signature_algorithm,
        "signedPayload" => Base64.strict_encode64(payload),
        "signature" => Base64.strict_encode64(signature),
      }

      ok, reason = application_class.validate_well_known_document(document, domain, pubkey_pem)

      expect(ok).to be(false)
      expect(reason).to include("signed payload JSON error")
    end

    # A document whose signed payload names +payload_domain+, served as the
    # well-known of +document_domain+.
    #
    # @param document_domain [String] the document's +domain+.
    # @param payload_domain [String] the signed payload's +domain+.
    # @return [Hash] the document.
    def well_known_document(document_domain, payload_domain)
      signed_b64, signature_b64 = signed_payload_for(payload_domain, pubkey_pem)
      {
        "publicKey" => pubkey_pem,
        "domain" => document_domain,
        "signatureAlgorithm" => PotatoMesh::Config.instance_signature_algorithm,
        "signedPayload" => signed_b64,
        "signature" => signature_b64,
      }
    end

    it "compares the document's and the signed payload's domain ignoring case and a default port (SPEC FL1)" do
      results = [["remote.mesh", "Remote.Mesh", "remote.mesh:443"], ["remote.mesh:80", "remote.mesh", "remote.mesh"]].map do |document_domain, payload_domain, expected|
        application_class.validate_well_known_document(well_known_document(document_domain, payload_domain), expected, pubkey_pem)
      end

      expect(results).to eq([[true, nil], [true, nil]])
    end

    it "rejects a document for another port of the domain" do
      result = application_class.validate_well_known_document(well_known_document("remote.mesh:8443", domain), domain, pubkey_pem)

      expect(result).to eq([false, "domain mismatch"])
    end

    it "rejects a document whose signed payload names another domain" do
      result = application_class.validate_well_known_document(well_known_document(domain, "other.mesh"), domain, pubkey_pem)

      expect(result).to eq([false, "signed payload domain mismatch"])
    end
  end

  describe ".validate_remote_nodes (rejection paths)" do
    it "rejects payloads that are not arrays" do
      ok, reason = federation_helpers.validate_remote_nodes("not an array")

      expect(ok).to be(false)
      expect(reason).to eq("node response is not an array")
    end

    it "rejects payloads with too few nodes" do
      allow(PotatoMesh::Config).to receive(:remote_instance_min_node_count).and_return(5)
      ok, reason = federation_helpers.validate_remote_nodes([{ "last_heard" => Time.now.to_i }])

      expect(ok).to be(false)
      expect(reason).to eq("insufficient nodes")
    end
  end
end
