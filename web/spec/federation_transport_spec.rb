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
require_relative "support/local_federation_peers"

# The federation transport against peers on 127.0.0.1 (SPEC FT1-FT5): the
# plain-http fallback, the counts of a v1 record, the request timeout and
# its socket, the worker pool's task timeout, and the pool itself.
RSpec.describe "Federation transport" do
  # The application under test, whose class runs the crawl and the announcer.
  #
  # @return [Class] the application class.
  def application
    FederationFakePeers::APP
  end

  # Seconds on the monotonic clock that the block took.
  #
  # @return [Float] elapsed seconds.
  def seconds_taken
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    yield
    Process.clock_gettime(Process::CLOCK_MONOTONIC) - started
  end

  # Wait up to a second for the block to hold: a listener notes what it
  # saw on its own thread.
  #
  # @return [void]
  def wait_for
    50.times do
      break if yield

      sleep 0.02
    end
  end

  # Wait until +listener+ accepted +count+ connections.
  #
  # @param listener [LocalFederationPeers::Listener] the listener.
  # @param count [Integer] connections expected.
  # @return [Array<IO>] its connections.
  def accepted(listener, count = 1)
    wait_for { listener.connections.size >= count }
    listener.connections
  end

  context "with local peers" do
    include_context "local federation peers"

    let(:http_peer) { listen(LocalFederationPeers.fed_handler(fed, "http")) }
    let(:certificate) { LocalFederationPeers.self_signed_certificate("peer.invalid", "relayer.invalid", "origin.invalid", "garbled.invalid") }
    let(:tls_peer) { listen(LocalFederationPeers.fed_handler(fed, "https"), tls: certificate) }
    let(:stalled_peer) { listen(LocalFederationPeers.stall_handler) }
    let(:payload_json) { JSON.generate(FederationFakePeers.payload("self.invalid")) }
    let(:peer_key_pem) { FederationFakePeers::KEYS["peer.invalid"].public_key.to_pem }

    # Trust +certificate+ as if a CA had issued it.
    #
    # @return [void]
    def trust_certificate!
      store = OpenSSL::X509::Store.new
      store.add_cert(certificate.last)
      allow(application).to receive(:remote_instance_cert_store).and_return(store)
      allow_any_instance_of(application).to receive(:remote_instance_cert_store).and_return(store)
    end

    describe "https falls back to plain http only on a refused connection or a port of the domain's own (FT1)" do
      it "keeps the node list, the identity check and the announcement on https after a self-signed certificate" do
        ports["https"] = tls_peer.port
        ports["http"] = http_peer.port

        nodes, errors = application.fetch_instance_json("peer.invalid", "/api/nodes?limit=10")
        application.clear_federation_crawl_state!
        identity = application.verify_well_known_identity("peer.invalid", peer_key_pem)
        application.clear_federation_crawl_state!
        announced = application.announce_instance_to_domain("peer.invalid", payload_json)

        expect(nodes).to be_nil
        expect(errors).to eq(errors.grep(/\Ahttps:/))
        expect(errors.join).to include("certificate verify failed (self-signed certificate)")
        expect(identity.first(2)).to eq([false, :fetch_failed])
        expect(identity.last).not_to include("http://")
        expect(announced).to be(false)
        wait_for { tls_peer.tls_errors.size >= 3 }
        expect(tls_peer.tls_errors.size).to eq(3)
        expect(tls_peer.tls_errors).to all(include("unknown ca"))
        expect(served_over("http")).to eq([])
      end

      it "fetches over https from the same peer once its certificate is trusted" do
        trust_certificate!
        ports["https"] = tls_peer.port
        ports["http"] = http_peer.port

        nodes, uri = application.fetch_instance_json("peer.invalid", "/api/nodes?limit=10")

        expect(nodes.size).to eq(10)
        expect(uri.to_s).to eq("https://peer.invalid/api/nodes?limit=10")
        expect(served_over("https")).to eq([["peer.invalid", :nodes_acceptance]])
        expect(served_over("http")).to eq([])
      end

      it "falls back to plain http when the https connection is refused" do
        ports["https"] = LocalFederationPeers.refused_port
        ports["http"] = http_peer.port

        nodes, uri = application.fetch_instance_json("peer.invalid", "/api/nodes?limit=10")
        application.clear_federation_crawl_state!
        identity = application.verify_well_known_identity("peer.invalid", peer_key_pem)
        application.clear_federation_crawl_state!
        announced = application.announce_instance_to_domain("peer.invalid", payload_json)

        expect(nodes.size).to eq(10)
        expect(uri.to_s).to eq("http://peer.invalid/api/nodes?limit=10")
        expect(identity).to eq([true, nil, nil])
        expect(announced).to be(true)
        expect(served_over("http")).to eq([
          ["peer.invalid", :nodes_acceptance], ["peer.invalid", :well_known], ["peer.invalid", :instances],
        ])
      end

      # The peer resolves to 127.0.0.1 and ::1. Its https port refuses on one
      # address and is unreachable on the other, as on an instance without an
      # IPv6 route; IPv4 is always tried first.
      {
        "first" => { v6: Errno::ENETUNREACH },
        "last" => { v4: Errno::ENETUNREACH, v6: Errno::ECONNREFUSED },
      }.each do |order, failures|
        it "falls back to plain http after a refusal on the #{order} of the peer's two addresses" do
          https_port = LocalFederationPeers.refused_port
          ports["https"] = https_port
          ports["http"] = http_peer.port
          dual = [IPAddr.new(LocalFederationPeers::LOOPBACK), IPAddr.new("::1")]
          allow(application).to receive(:resolve_remote_ip_addresses).and_return(dual)
          # Ruby 4.0's Net::HTTP passes +open_timeout:+ as a keyword, so the
          # keywords are passed on as keywords.
          allow(TCPSocket).to receive(:open).and_wrap_original do |original, host, port, *rest, **options|
            failure = port == https_port && failures[host.to_s.include?(":") ? :v6 : :v4]
            raise failure, "spec: connect(2) for #{host} port #{port}" if failure

            original.call(host, port, *rest, **options)
          end

          nodes, uri = application.fetch_instance_json("peer.invalid", "/api/nodes?limit=10")
          application.clear_federation_crawl_state!
          announced = application.announce_instance_to_domain("peer.invalid", payload_json)

          expect(nodes.size).to eq(10)
          expect(uri.to_s).to eq("http://peer.invalid/api/nodes?limit=10")
          expect(announced).to be(true)
          expect(served_over("http")).to eq([["peer.invalid", :nodes_acceptance], ["peer.invalid", :instances]])
        end
      end

      it "falls back to plain http for a domain with a port of its own that answers plain http there" do
        ports[["peer.invalid", "https"]] = http_peer.port
        ports[["peer.invalid", "http"]] = http_peer.port

        nodes, uri = application.fetch_instance_json("peer.invalid:8443", "/api/nodes?limit=10")
        application.clear_federation_crawl_state!
        announced = application.announce_instance_to_domain("peer.invalid:8443", payload_json)

        expect(nodes.size).to eq(10)
        expect(uri.to_s).to eq("http://peer.invalid:8443/api/nodes?limit=10")
        expect(announced).to be(true)
        expect(served_over("http")).to eq([["peer.invalid", :nodes_acceptance], ["peer.invalid", :instances]])
      end

      it "stays on https after an https timeout or an https answer that is not JSON" do
        allow(PotatoMesh::Config).to receive(:remote_instance_request_timeout).and_return(0.5)
        ports[["stall.invalid", "https"]] = stalled_peer.port
        ports[["garbled.invalid", "https"]] = listen(lambda { |socket|
          LocalFederationPeers.read_request(socket)
          LocalFederationPeers.write_response(socket, 200, {}, "<html>not json</html>")
          socket.close
        }, tls: certificate).port
        ports["http"] = http_peer.port
        trust_certificate!

        stalled, stalled_errors = application.fetch_instance_json("stall.invalid", "/api/nodes?limit=10")
        garbled, garbled_errors = application.fetch_instance_json("garbled.invalid", "/api/nodes?limit=10")

        expect(stalled).to be_nil
        expect(stalled_errors).to eq(["https://stall.invalid/api/nodes?limit=10: Timeout::Error: execution expired"])
        expect(garbled).to be_nil
        expect(garbled_errors.size).to eq(1)
        expect(garbled_errors.first).to start_with("https://garbled.invalid/api/nodes?limit=10: invalid JSON")
        expect(served_over("http")).to eq([])
      end
    end

    describe "a v1 record's node counts come from its origin (FT2)" do
      let(:rewritten) { { nodes_count: 99_999, meshcore_nodes_count: 50_000, meshtastic_nodes_count: 49_999 } }
      let(:origin_pem) { FederationFakePeers::KEYS["origin.invalid"].public_key.to_pem }

      before do
        trust_certificate!
        ports["https"] = tls_peer.port
        ports["http"] = http_peer.port
        fed.stats["origin.invalid"] = {
          "total" => { "nodes" => { "hour" => 3, "day" => 12, "week" => 20, "month" => 30 } },
          "meshcore" => { "nodes" => { "day" => 0 } },
          "meshtastic" => { "nodes" => { "day" => 12 } },
          "reticulum" => { "nodes" => { "day" => 0 } },
        }
      end

      it "stores and lists the origin's counts for a v1 record whose counts a relayer rewrote" do
        fed.lists["relayer.invalid"] = [LocalFederationPeers.v1_record("origin.invalid", **rewritten)]

        crawl("relayer.invalid")
        get "/api/instances"
        listed = JSON.parse(last_response.body).find { |entry| entry["domain"] == "origin.invalid" }

        expect(stored_rows).to eq([["origin.invalid", origin_pem, 12, 0, 12, 0]])
        expect(served_over("https")).to include(["origin.invalid", :stats])
        expect(listed).to include(
          "nodes_count" => 12, "meshcore_nodes_count" => 0, "meshtastic_nodes_count" => 12,
          "reticulum_nodes_count" => 0, "signature_version" => 2,
        )
        expect(last_response.body).not_to include("99999")
      end

      it "stores the origin's counts for a v1 announcement replayed with rewritten counts" do
        post "/api/instances", JSON.generate(LocalFederationPeers.v1_record("origin.invalid", **rewritten)), json_headers

        expect(last_response.status).to eq(201)
        expect(stored_rows).to eq([["origin.invalid", origin_pem, 12, 0, 12, 0]])
        expect(served_over("https")).to include(["origin.invalid", :stats])
      end

      it "stores the origin's counts when a v1 announcement verifies only without its contact link" do
        record = LocalFederationPeers.v1_record("origin.invalid", **rewritten).merge("contactLink" => "#unsigned:example.org")

        post "/api/instances", JSON.generate(record), json_headers

        expect(last_response.status).to eq(201)
        expect(stored_rows).to eq([["origin.invalid", origin_pem, 12, 0, 12, 0]])
      end

      it "stores the origin's counts for a v1 announcement that verifies only under its domain's own casing" do
        record = LocalFederationPeers.v1_record("Origin.invalid", FederationFakePeers::KEYS["origin.invalid"], **rewritten)

        post "/api/instances", JSON.generate(record), json_headers

        expect(last_response.status).to eq(201)
        expect(stored_rows).to eq([["origin.invalid", origin_pem, 12, 0, 12, 0]])
      end

      it "stores the origin's counts for a v1 announcement that verifies only under its own casing and without its contact link" do
        record = LocalFederationPeers.v1_record("Origin.invalid", FederationFakePeers::KEYS["origin.invalid"], **rewritten)
        record["contactLink"] = "#unsigned:example.org"

        post "/api/instances", JSON.generate(record), json_headers

        expect(last_response.status).to eq(201)
        expect(stored_rows).to eq([["origin.invalid", origin_pem, 12, 0, 12, 0]])
      end

      it "verifies nothing and clears no count without a signature or a key" do
        attributes = FederationFakePeers.attrs("origin.invalid")

        expect(application.verify_instance_signature(attributes, nil, attributes[:pubkey])).to be(false)
        expect(application.verify_instance_signature(attributes, FederationFakePeers.sign(FederationFakePeers::KEYS["origin.invalid"], attributes), nil)).to be(false)
        expect(attributes.values_at(*PotatoMesh::App::Federation::INSTANCE_COUNT_KEYS)).to eq([12, 4, 8, 0])
      end

      it "keeps the signed counts of a v2 record without reading the origin's stats" do
        fed.lists["relayer.invalid"] = [FederationFakePeers.record("origin.invalid")]

        crawl("relayer.invalid")

        expect(stored_rows).to eq([["origin.invalid", origin_pem, 12, 4, 8, 0]])
        expect(served_over("https")).not_to include(["origin.invalid", :stats])
      end
    end

    describe "a request's timeout closes its socket (FT3)" do
      before do
        allow(PotatoMesh::Config).to receive(:remote_instance_request_timeout).and_return(0.5)
        allow(PotatoMesh::Config).to receive(:remote_instance_http_timeout).and_return(5)
        ports["https"] = stalled_peer.port
        ports["http"] = LocalFederationPeers.refused_port
      end

      # Run the block with the garbage collector off, so a socket left open
      # stays open, then report whether the stalled peer's one connection
      # was closed by the client within half a second.
      #
      # @return [Array(Float, Boolean)] seconds the block took and whether
      #   the connection was closed.
      def stall_and_check
        GC.disable
        elapsed = seconds_taken { yield }
        connection = accepted(stalled_peer).first
        [elapsed, LocalFederationPeers::Listener.closed_by_client?(connection, within: 0.5)]
      ensure
        GC.enable
      end

      it "closes a stalled TLS handshake at the deadline of a fetch" do
        result = nil
        elapsed, closed = stall_and_check { result = application.fetch_instance_json("stall.invalid", "/api/nodes?limit=10") }

        expect(result.first).to be_nil
        expect(result.last.first).to eq("https://stall.invalid/api/nodes?limit=10: Timeout::Error: execution expired")
        expect(elapsed).to be < 2.5
        expect(stalled_peer.connections.size).to eq(1)
        expect(closed).to be(true)
      end

      it "closes a stalled TLS handshake at the deadline of an announcement" do
        announced = nil
        elapsed, closed = stall_and_check { announced = application.announce_instance_to_domain("stall.invalid", payload_json) }

        expect(announced).to be(false)
        expect(elapsed).to be < 2.5
        expect(stalled_peer.connections.size).to eq(1)
        expect(closed).to be(true)
      end

      it "sends a GET whose answer never comes once and ends it at the deadline" do
        allow(PotatoMesh::Config).to receive(:remote_instance_read_timeout).and_return(3)
        ports["https"] = LocalFederationPeers.refused_port
        ports["http"] = stalled_peer.port

        result = nil
        elapsed = seconds_taken { result = application.fetch_instance_json("quiet.invalid", "/api/nodes?limit=10") }
        accepted(stalled_peer)

        expect(result.first).to be_nil
        expect(result.last.last).to eq("http://quiet.invalid/api/nodes?limit=10: Timeout::Error: execution expired")
        expect(elapsed).to be < 2.5
        expect(stalled_peer.connections.size).to eq(1)
      end
    end

    describe "the worker pool's task timeout ends its task (FT4)" do
      it "never sends an announcement over http after its task timed out on https" do
        allow(PotatoMesh::Config).to receive(:remote_instance_request_timeout).and_return(5)
        allow(PotatoMesh::Config).to receive(:remote_instance_http_timeout).and_return(5)
        ports[["peer.invalid", "https"]] = stalled_peer.port
        ports[["peer.invalid", "http"]] = http_peer.port
        pool = PotatoMesh::App::WorkerPool.new(size: 1, max_queue: 4, task_timeout: 0.3, name: "spec-ft4")

        begin
          task = pool.schedule { application.announce_instance_to_domain("peer.invalid:8443", payload_json) }
          outcome = begin
              task.wait(timeout: 4)
            rescue PotatoMesh::App::WorkerPool::TaskTimeoutError => e
              e
            end
          sleep 0.3
        ensure
          pool.shutdown(timeout: 1, force_kill_after: 1)
        end

        expect(outcome).to be_a(PotatoMesh::App::WorkerPool::TaskTimeoutError)
        expect(outcome.message).to eq("task exceeded timeout")
        expect(served_over("http")).to eq([])
        # A non-default port variant backs off its own bucket, not the host's
        # default-port endpoint (SPEC PV1).
        expect(application.federation_peer_backoff.backoff_seconds("peer.invalid")).to eq(0)
        variant_key = application.federation_backoff_key("peer.invalid:8443")
        expect(application.federation_peer_backoff.backoff_seconds(variant_key)).to be_between(1, 60)
      end

      context "when the task timeout fires before the request timeout" do
        let(:pool) { PotatoMesh::App::WorkerPool.new(size: 1, max_queue: 4, task_timeout: 0.3, name: "spec-ft4-cycle") }

        before do
          allow(PotatoMesh::Config).to receive(:remote_instance_request_timeout).and_return(5)
          allow(PotatoMesh::Config).to receive(:remote_instance_http_timeout).and_return(5)
          allow(PotatoMesh::Config).to receive(:federation_task_timeout_seconds).and_return(0.3)
          # Cycles here are a second apart; in production the 8-hour cycle
          # outlasts the fetch cooldown, so only the backoff holds a host.
          allow(PotatoMesh::Config).to receive(:federation_peer_fetch_cooldown_seconds).and_return(0)
          allow(application).to receive(:federation_worker_pool).and_return(pool)
          ports[["stall.invalid", "https"]] = stalled_peer.port
          ports[["stall.invalid", "http"]] = stalled_peer.port
          ports[["good.invalid", "https"]] = LocalFederationPeers.refused_port
          ports[["good.invalid", "http"]] = http_peer.port
        end

        after { pool.shutdown(timeout: 1, force_kill_after: 1) }

        # Seconds +host+ still backs off once the worker has recorded it.
        #
        # @param host [String] peer host.
        # @return [Numeric] seconds of backoff left.
        def backoff_of(host)
          wait_for { application.federation_peer_backoff.backoff_seconds(host).positive? }
          application.federation_peer_backoff.backoff_seconds(host)
        end

        it "backs a peer whose announcement outlives its task off, so the next cycle sends it nothing" do
          allow(application).to receive(:federation_target_domains).and_return(["stall.invalid"])

          application.announce_instance_to_all_domains
          backoff = backoff_of("stall.invalid")
          application.announce_instance_to_all_domains

          expect(backoff).to be_between(1, 60)
          expect(stalled_peer.connections.size).to eq(1)
        end

        it "backs a crawl root whose fetch outlives the task off, so the next crawl goes on with the next root" do
          allow(application).to receive(:federation_target_domains).and_return(["stall.invalid", "good.invalid"])
          good_lists = -> { served_over("http").count(["good.invalid", :instances]) }

          first = application.run_federation_crawl_cycle
          backoff = backoff_of("stall.invalid")
          lists_after_first = good_lists.call
          second = application.run_federation_crawl_cycle

          expect(first).to be(false)
          expect(backoff).to be_between(1, 60)
          expect(lists_after_first).to eq(0)
          expect(second).to be(true)
          expect(good_lists.call).to eq(1)
          expect(stalled_peer.connections.size).to eq(1)
        end
      end

      it "is raised out of the announcement's address loop, a refusal as its cause included" do
        allow(application).to receive(:resolve_remote_ip_addresses).and_return([IPAddr.new("192.0.2.1"), IPAddr.new("192.0.2.2")])
        tried = []
        allow(application).to receive(:perform_single_announce_request) do |_uri, _payload, ip_address:|
          tried << ip_address
          raise PotatoMesh::App::WorkerPool::TaskTimeoutError, "task exceeded timeout", cause: Errno::ECONNREFUSED.new("refused") if tried.size == 1

          Net::HTTPOK.new("1.1", "200", "OK")
        end

        expect do
          application.perform_announce_request(URI.parse("https://peer.invalid/api/instances"), payload_json)
        end.to raise_error(PotatoMesh::App::WorkerPool::TaskTimeoutError, "task exceeded timeout")
        expect(tried).to eq(["192.0.2.1"])
      end

      it "is raised out of a record's parse, not taken as the record's fault" do
        timeout = PotatoMesh::App::WorkerPool::TaskTimeoutError
        allow(PotatoMesh::App::DataProcessing::FieldLimits).to receive(:instance_field_violation).and_raise(timeout, "task exceeded timeout")

        expect do
          application.remote_instance_attributes_from_payload(FederationFakePeers.record("peer.invalid"))
        end.to raise_error(PotatoMesh::App::WorkerPool::TaskTimeoutError, "task exceeded timeout")
      end
    end
  end

  describe "one federation worker pool (FT5)" do
    let(:helpers) do
      Class.new do
        extend PotatoMesh::App::Federation

        class << self
          def settings
            @settings ||= Struct.new(:federation_worker_pool, :federation_shutdown_requested, :federation_shutdown_hook_installed)
              .new(nil, false, true)
          end

          def set(key, value)
            settings.public_send("#{key}=", value)
          end

          def federation_enabled?
            true
          end
        end
      end
    end

    it "creates one pool when two threads ask for it at once" do
      allow(PotatoMesh::Config).to receive(:federation_worker_pool_size).and_return(1)
      created = Queue.new
      allow(PotatoMesh::App::WorkerPool).to receive(:new).and_wrap_original do |original, **options|
        # Both callers are past the check before either stores its pool.
        sleep 0.2
        original.call(**options).tap { |pool| created << pool }
      end

      pools = Array.new(2) { Thread.new { helpers.ensure_federation_worker_pool! } }.map(&:value)
      made = Array.new(created.size) { created.pop }
      made.each { |pool| pool.shutdown(timeout: 1, force_kill_after: 1) }

      expect(made.size).to eq(1)
      expect(pools.uniq).to eq(made)
      expect(helpers.settings.federation_worker_pool).to equal(made.first)
    end

    it "gives a caller whose settings keep no pool a new one each time" do
      allow(PotatoMesh::Config).to receive(:federation_worker_pool_size).and_return(1)
      # Every Object answers the application's module methods, the pool
      # lookup included, so settings without a pool slot are a BasicObject.
      slotless = Class.new(BasicObject) do
        def respond_to?(*)
          false
        end
      end
      bare = Class.new do
        extend PotatoMesh::App::Federation
        @federation_shutdown_hook_installed = true
        @slotless = slotless

        class << self
          def settings
            @slotless.new
          end

          def federation_enabled?
            true
          end
        end
      end

      pools = Array.new(2) { bare.ensure_federation_worker_pool! }
      pools.each { |pool| pool.shutdown(timeout: 1, force_kill_after: 1) }

      expect(pools.map(&:class)).to eq([PotatoMesh::App::WorkerPool] * 2)
      expect(pools.first).not_to equal(pools.last)
    end
  end
end
