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
require "timeout"

RSpec.describe PotatoMesh::App::Routes::Events do
  after { PotatoMesh::App::PubSub.reset! }

  describe ".format_event" do
    it "encodes the collection and omits a nil hint" do
      expect(described_class.format_event(collection: "nodes", hint: nil)).to eq(
        "event: change\ndata: {\"collection\":\"nodes\"}\n\n",
      )
    end

    it "includes the hint when present" do
      expect(described_class.format_event(collection: "messages", hint: 42)).to eq(
        "event: change\ndata: {\"collection\":\"messages\",\"hint\":42}\n\n",
      )
    end
  end

  describe ".write_batch" do
    it "writes a single keepalive comment for an empty batch" do
      out = []
      described_class.write_batch(out, [])
      expect(out).to eq([": keepalive\n\n"])
    end

    it "writes one SSE frame per change" do
      out = []
      described_class.write_batch(
        out, [{ collection: "nodes", hint: nil }, { collection: "traces", hint: 7 }]
      )
      expect(out.length).to eq(2)
      expect(out[0]).to include("\"collection\":\"nodes\"")
      expect(out[1]).to include("\"hint\":7")
    end
  end

  describe ".pump" do
    # Minimal SSE sink: records writes, optionally closing after N of them.
    let(:fake_out_class) do
      Class.new do
        attr_reader :writes

        def initialize(close_after: nil)
          @writes = []
          @close_after = close_after
          @closed = false
        end

        def <<(chunk)
          @writes << chunk
          @closed = true if @close_after && @writes.length >= @close_after
          self
        end

        def closed?
          @closed
        end
      end
    end

    it "writes pending changes then stops once the client closes" do
      out = fake_out_class.new(close_after: 1)
      subscriber = PotatoMesh::App::PubSub::Subscriber.new
      subscriber.deliver("nodes", 5)

      Timeout.timeout(5) do
        described_class.pump(out, subscriber, heartbeat: 0.01, deadline_at: 1_000, clock: -> { 0 })
      end

      expect(out.writes).to eq([described_class.format_event(collection: "nodes", hint: 5)])
    end

    it "stops at the lifetime deadline, emitting a heartbeat while idle" do
      out = fake_out_class.new
      subscriber = PotatoMesh::App::PubSub::Subscriber.new
      remaining = [0] # first condition check is before the deadline...
      clock = -> { remaining.empty? ? 1_000 : remaining.shift } # ...then past it.

      Timeout.timeout(5) do
        described_class.pump(out, subscriber, heartbeat: 0.01, deadline_at: 500, clock: clock)
      end

      expect(out.writes).to eq([": keepalive\n\n"])
    end

    it "swallows a write error from a vanished client" do
      raising_out = Object.new
      def raising_out.<<(_chunk)
        raise IOError, "stream closed"
      end

      def raising_out.closed?
        false
      end

      subscriber = PotatoMesh::App::PubSub::Subscriber.new

      expect do
        Timeout.timeout(5) do
          described_class.pump(
            raising_out, subscriber, heartbeat: 0.01, deadline_at: 1_000, clock: -> { 0 },
          )
        end
      end.not_to raise_error
    end

    it "passes the settle cooldown through to drain (LV6)" do
      out = fake_out_class.new(close_after: 1)
      recorded = {}
      subscriber = Object.new
      subscriber.define_singleton_method(:drain) do |timeout:, settle: 0|
        recorded[:timeout] = timeout
        recorded[:settle] = settle
        [{ collection: "nodes", hint: nil }]
      end

      Timeout.timeout(5) do
        described_class.pump(
          out, subscriber, heartbeat: 0.01, deadline_at: 1_000, settle: 0.25, clock: -> { 0 },
        )
      end

      expect(recorded[:timeout]).to eq(0.01)
      expect(recorded[:settle]).to eq(0.25)
    end
  end

  describe "GET /api/events route" do
    include Rack::Test::Methods

    def app
      PotatoMesh::Application
    end

    around do |example|
      original_events = ENV["EVENTS"]
      original_private = ENV["PRIVATE"]
      ENV.delete("PRIVATE")
      example.run
      original_events.nil? ? ENV.delete("EVENTS") : ENV["EVENTS"] = original_events
      original_private.nil? ? ENV.delete("PRIVATE") : ENV["PRIVATE"] = original_private
    end

    it "streams text/event-stream and an initial comment, then cleans up" do
      # Stub the long-lived pump so the request returns immediately.
      allow(described_class).to receive(:pump)

      Timeout.timeout(5) { get "/api/events" }

      expect(last_response.status).to eq(200)
      expect(last_response.content_type).to include("text/event-stream")
      expect(last_response.headers["Cache-Control"]).to include("no-cache")
      expect(last_response.body).to include(": connected")
      expect(PotatoMesh::App::PubSub.subscriber_count).to eq(0)
    end

    it "returns 404 when live updates are disabled (EVENTS=0)" do
      ENV["EVENTS"] = "0"
      get "/api/events"
      expect(last_response.status).to eq(404)
    end

    it "returns 503 when the subscriber cap is reached" do
      allow(PotatoMesh::App::PubSub).to receive(:subscribe)
                                          .and_raise(PotatoMesh::App::PubSub::CapacityError)

      get "/api/events"
      expect(last_response.status).to eq(503)
    end

    it "does not accept POST (read-only, never an ingest path)" do
      post "/api/events", "{}", "CONTENT_TYPE" => "application/json"
      expect([404, 405]).to include(last_response.status)
    end
  end
end
