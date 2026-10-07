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
require "json"
require_relative "support/data_processing_harness"

# MeshCore sender-verified flag (SPEC SV1/SV2; ACCEPTANCE SV-A1).  A MeshCore
# channel message carries no sender key, only the typed "Name:" prefix of its
# text: the ingestor matches that name against its roster or derives an id
# from it, and the web app may re-map the id by name again (GN3, the
# placeholder merge).  GET /api/messages and GET /api/messages/:id serve such a
# row with `sender_verified: false` and omit the key on every other row.
RSpec.describe "MeshCore sender-verified flag" do
  include_context "with isolated db"
  include MeshcoreNodeSeeds

  let(:app) { Sinatra::Application }
  let(:harness_class) { DataProcessingHarness.build }

  subject(:dp) { harness_class.new }

  let(:day) { 86_400 }
  # Alice: a keyed MeshCore contact, live (heard three days ago).
  let(:alice) { "!a11ce001" }
  # The id the ingestor derives from the name "Alice" when its roster lacks
  # her (the SHA-256 prefix of +_derive_synthetic_node_id+).
  let(:alice_derived_id) { "!3bc51062" }
  # The MeshCore host whose ingestor posts the lines.
  let(:host) { "!634069bc" }
  let(:api_token) { "sender-verified-spec-token" }
  let(:auth_headers) do
    { "CONTENT_TYPE" => "application/json", "HTTP_AUTHORIZATION" => "Bearer #{api_token}" }
  end

  before do
    @original_token = ENV["API_TOKEN"]
    ENV["API_TOKEN"] = api_token
    PotatoMesh::App::ApiCache.invalidate_all
  end

  after do
    @original_token.nil? ? ENV.delete("API_TOKEN") : ENV["API_TOKEN"] = @original_token
    PotatoMesh::App::ApiCache.invalidate_all
  end

  # A MeshCore channel message as the ingestor posts it.
  #
  # @param id [Integer] message id.
  # @param from_id [String, nil] sender id; nil leaves the key out.
  # @param text [String] message text.
  # @return [Hash] POST /api/messages payload.
  def channel_message(id, from_id, text)
    {
      "id" => id, "rx_time" => now - 60, "from_id" => from_id, "to_id" => "^all",
      "channel" => 0, "channel_name" => "Public", "text" => text,
      "portnum" => "TEXT_MESSAGE_APP", "protocol" => "meshcore", "ingestor" => host,
    }.compact
  end

  # POST one message through the authenticated ingest route.
  #
  # @param payload [Hash] message payload.
  # @return [void]
  def post_message(payload)
    post "/api/messages", payload.to_json, auth_headers
    expect(last_response.status).to eq(201)
  end

  # Fetch +path+ and return the served row with +id+.
  #
  # @param path [String] GET route.
  # @param id [Integer] message id.
  # @return [Hash, nil] the served row.
  def served_row(path, id)
    get path
    expect(last_response).to be_ok
    JSON.parse(last_response.body).find { |row| row["id"] == id }
  end

  # Store a keyed MeshCore contact named "Alice".
  #
  # @param node_id [String] canonical node id.
  # @param key_byte [String] two hex digits repeated into the public key.
  # @param heard [Integer] unix seconds of the contact record.
  # @return [void]
  def seed_alice(node_id, key_byte, heard)
    db = open_db
    seed_keyed_node(db, node_id, "Alice", key_byte, heard)
  ensure
    db&.close
  end

  describe "a MeshCore channel line whose sender is named only in its text" do
    before { seed_alice(alice, "a1", now - 3 * day) }

    # Both routes serve the line as Alice's, flagged.
    #
    # @param id [Integer] message id.
    # @return [void]
    def expect_flagged_as_alice(id)
      [served_row("/api/messages", id), served_row("/api/messages/#{alice}", id)].each do |row|
        expect(row).to include("node_id" => alice, "sender_verified" => false)
      end
    end

    it "is served with sender_verified false when posted with the key id the roster matched" do
      post_message(channel_message(101, alice, "Alice: see you at the hut"))
      expect_flagged_as_alice(101)
    end

    it "is served with sender_verified false when posted with the name-derived id" do
      post_message(channel_message(102, alice_derived_id, "Alice: unrostered"))
      expect_flagged_as_alice(102)
    end

    it "is served with sender_verified false when posted with a positively stale same-name key" do
      seed_alice("!a11ce0ff", "af", now - 40 * day)
      post_message(channel_message(103, "!a11ce0ff", "Alice: via a stale roster"))
      expect_flagged_as_alice(103)
    end
  end

  describe "a line whose sender comes from an id the packet carries" do
    it "a Meshtastic message has no sender_verified key on either route" do
      post_message(
        "id" => 201, "rx_time" => now - 60, "from_id" => "!0badc0de", "to_id" => "^all",
        "channel" => 0, "text" => "Alice: hello", "portnum" => "TEXT_MESSAGE_APP", "protocol" => "meshtastic",
      )
      [served_row("/api/messages", 201), served_row("/api/messages/!0badc0de", 201)].each do |row|
        expect(row).to include("node_id" => "!0badc0de")
        expect(row).not_to have_key("sender_verified")
      end
    end

    it "a MeshCore direct message has no sender_verified key on either route" do
      seed_alice(alice, "a1", now - 3 * day)
      post_message(channel_message(202, alice, "hello from my own key").merge("to_id" => host).except("channel_name"))
      [served_row("/api/messages", 202), served_row("/api/messages/#{alice}", 202)].each do |row|
        expect(row).to include("node_id" => alice, "to_id" => host)
        expect(row).not_to have_key("sender_verified")
      end
    end
  end

  describe "a MeshCore channel line without a sender" do
    it "has no sender_verified key" do
      post_message(channel_message(301, nil, "no sender prefix"))
      row = served_row("/api/messages", 301)
      expect(row).not_to have_key("from_id")
      expect(row).not_to have_key("sender_verified")
    end
  end

  describe "#meshcore_sender_name_attributed?" do
    let(:channel_row) { { "protocol" => "meshcore", "to_id" => "^all", "from_id" => alice } }

    it "is true for a MeshCore channel row with a sender" do
      expect(dp.meshcore_sender_name_attributed?(channel_row)).to be(true)
    end

    {
      "another protocol" => { "protocol" => "meshtastic" },
      "no protocol" => { "protocol" => nil },
      "a direct message" => { "to_id" => "!634069bc" },
      "no recipient" => { "to_id" => nil },
      "no sender" => { "from_id" => nil },
      "a blank sender" => { "from_id" => "  " },
    }.each do |label, overrides|
      it "is false for #{label}" do
        expect(dp.meshcore_sender_name_attributed?(channel_row.merge(overrides))).to be(false)
      end
    end
  end
end
