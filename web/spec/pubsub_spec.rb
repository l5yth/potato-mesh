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

RSpec.describe PotatoMesh::App::PubSub do
  # Drop any globally registered subscribers so examples never leak state.
  # Reference the module explicitly: nested groups rebind +described_class+.
  after { PotatoMesh::App::PubSub.reset! }

  describe "COLLECTIONS" do
    it "lists exactly the six dashboard ingest collections" do
      expect(described_class::COLLECTIONS).to eq(
        %w[nodes messages positions telemetry neighbors traces],
      )
    end
  end

  describe ".subscribe" do
    it "returns a Subscriber and tracks it" do
      subscriber = described_class.subscribe
      expect(subscriber).to be_a(described_class::Subscriber)
      expect(described_class.subscriber_count).to eq(1)
    end

    it "raises CapacityError once MAX_SUBSCRIBERS is reached" do
      described_class::MAX_SUBSCRIBERS.times { described_class.subscribe }
      expect(described_class.subscriber_count).to eq(described_class::MAX_SUBSCRIBERS)
      expect { described_class.subscribe }.to raise_error(described_class::CapacityError)
    end
  end

  describe ".unsubscribe" do
    it "removes and closes the subscriber" do
      subscriber = described_class.subscribe
      described_class.unsubscribe(subscriber)
      expect(described_class.subscriber_count).to eq(0)
      expect(subscriber.closed?).to be(true)
    end

    it "is idempotent and nil-safe" do
      subscriber = described_class.subscribe
      described_class.unsubscribe(subscriber)
      expect { described_class.unsubscribe(subscriber) }.not_to raise_error
      expect { described_class.unsubscribe(nil) }.not_to raise_error
    end
  end

  describe ".publish" do
    it "delivers a change to every subscriber and returns the delivery count" do
      a = described_class.subscribe
      b = described_class.subscribe

      expect(described_class.publish("nodes")).to eq(2)
      expect(a.pending_count).to eq(1)
      expect(b.pending_count).to eq(1)
    end

    it "ignores unknown collections without delivering" do
      subscriber = described_class.subscribe
      expect(described_class.publish("bogus")).to eq(0)
      expect(subscriber.pending_count).to eq(0)
    end

    it "suppresses messages events in private mode (PS6)" do
      subscriber = described_class.subscribe
      expect(described_class.publish("messages", private_mode: true)).to eq(0)
      expect(subscriber.pending_count).to eq(0)
    end

    it "still delivers non-message collections in private mode" do
      subscriber = described_class.subscribe
      expect(described_class.publish("nodes", private_mode: true)).to eq(1)
      expect(subscriber.pending_count).to eq(1)
    end

    it "delivers messages events when not private" do
      subscriber = described_class.subscribe
      expect(described_class.publish("messages")).to eq(1)
      expect(subscriber.pending_count).to eq(1)
    end

    it "returns 0 when there are no subscribers" do
      expect(described_class.publish("nodes")).to eq(0)
    end

    it "forwards the newest rx_time hint to subscribers" do
      subscriber = described_class.subscribe
      described_class.publish("messages", hint: 1_700_000_000)
      expect(subscriber.drain(timeout: 0).first).to eq(
        collection: "messages", hint: 1_700_000_000,
      )
    end
  end

  describe ".reset!" do
    it "closes and clears every subscriber" do
      a = described_class.subscribe
      b = described_class.subscribe
      described_class.reset!
      expect(described_class.subscriber_count).to eq(0)
      expect(a.closed?).to be(true)
      expect(b.closed?).to be(true)
    end
  end

  describe PotatoMesh::App::PubSub::Subscriber do
    subject(:subscriber) { described_class.new }

    describe "#deliver / #drain coalescing" do
      it "collapses repeated writes to one collection into a single event" do
        5.times { subscriber.deliver("messages", nil) }
        expect(subscriber.pending_count).to eq(1)

        events = subscriber.drain(timeout: 0)
        expect(events).to eq([{ collection: "messages", hint: nil }])
      end

      it "keeps the newest (largest) hint across coalesced writes" do
        subscriber.deliver("nodes", 5)
        subscriber.deliver("nodes", 3)
        subscriber.deliver("nodes", 9)
        expect(subscriber.drain(timeout: 0)).to eq([{ collection: "nodes", hint: 9 }])
      end

      it "fills a missing hint from a later write" do
        subscriber.deliver("nodes", nil)
        subscriber.deliver("nodes", 7)
        expect(subscriber.drain(timeout: 0)).to eq([{ collection: "nodes", hint: 7 }])
      end

      it "returns pending collections sorted by name, then clears them" do
        subscriber.deliver("traces", nil)
        subscriber.deliver("nodes", nil)
        subscriber.deliver("messages", nil)

        expect(subscriber.drain(timeout: 0).map { |e| e[:collection] }).to eq(
          %w[messages nodes traces],
        )
        expect(subscriber.drain(timeout: 0.01)).to eq([])
      end
    end

    describe "#drain blocking" do
      it "returns an empty array after the timeout when idle" do
        expect(subscriber.drain(timeout: 0.02)).to eq([])
      end

      it "wakes as soon as a change is delivered from another thread" do
        producer = Thread.new do
          sleep 0.02
          subscriber.deliver("positions", 42)
        end

        events = subscriber.drain(timeout: 5)
        producer.join
        expect(events).to eq([{ collection: "positions", hint: 42 }])
      end
    end

    describe "#close" do
      it "ignores deliveries and drains immediately once closed" do
        subscriber.close
        expect(subscriber.closed?).to be(true)

        subscriber.deliver("nodes", 1)
        expect(subscriber.pending_count).to eq(0)
        expect(subscriber.drain(timeout: 5)).to eq([])
      end

      it "flushes already-pending events after close" do
        subscriber.deliver("nodes", 1)
        subscriber.close
        expect(subscriber.drain(timeout: 0)).to eq([{ collection: "nodes", hint: 1 }])
      end
    end
  end

  describe "publish-on-change from ingest routes (integration)" do
    include Rack::Test::Methods

    def app
      PotatoMesh::Application
    end

    let(:auth) do
      { "CONTENT_TYPE" => "application/json", "HTTP_AUTHORIZATION" => "Bearer spec-token" }
    end

    around do |example|
      original_token = ENV["API_TOKEN"]
      original_private = ENV["PRIVATE"]
      ENV["API_TOKEN"] = "spec-token"
      ENV.delete("PRIVATE")
      example.run
      original_token.nil? ? ENV.delete("API_TOKEN") : ENV["API_TOKEN"] = original_token
      original_private.nil? ? ENV.delete("PRIVATE") : ENV["PRIVATE"] = original_private
      PotatoMesh::App::PubSub.reset!
    end

    # collection => [route, minimal valid body that writes no rows]
    def ingest_routes
      {
        "nodes" => ["/api/nodes", "{}"],
        "messages" => ["/api/messages", "[]"],
        "positions" => ["/api/positions", "[]"],
        "telemetry" => ["/api/telemetry", "[]"],
        "neighbors" => ["/api/neighbors", "[]"],
        "traces" => ["/api/traces", "[]"],
      }
    end

    it "publishes a thin per-collection event (PS3)" do
      subscriber = PotatoMesh::App::PubSub.subscribe
      post "/api/messages", "[]", auth
      expect(last_response.status).to eq(201)
      expect(subscriber.drain(timeout: 0.1)).to eq([{ collection: "messages", hint: nil }])
    end

    it "publishes on every ingest route" do
      allow(PotatoMesh::App::PubSub).to receive(:publish).and_call_original

      ingest_routes.each_value do |(route, body)|
        post route, body, auth
        expect(last_response.status).to eq(201)
      end

      ingest_routes.each_key do |collection|
        expect(PotatoMesh::App::PubSub).to have_received(:publish)
                                             .with(collection, private_mode: false)
      end
    end

    it "coalesces bursts of one collection into a single pending event" do
      subscriber = PotatoMesh::App::PubSub.subscribe
      5.times do
        post "/api/messages", "[]", auth
        expect(last_response.status).to eq(201)
      end
      expect(subscriber.pending_count).to eq(1)
      expect(subscriber.drain(timeout: 0.1)).to eq([{ collection: "messages", hint: nil }])
    end
  end
end
