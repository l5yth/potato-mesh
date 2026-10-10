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

require_relative "spec_helper"
require_relative "support/data_processing_harness"

# Cases shared with tests/test_reticulum_interface_names.py, which checks each
# printed name against the real RNS class: +[case, printed, public]+.
INTERFACE_NAME_CASES = File.readlines(
  File.expand_path("../../tests/fixtures/reticulum_interface_names.tsv", __dir__),
  chomp: true,
).reject { |line| line.empty? || line.start_with?("#") }.map { |line| line.split("\t") }.freeze

# Reticulum interface names are stored and served without peer addresses
# (SPEC RI1-RI3).
RSpec.describe "Reticulum interface names without peer addresses" do
  # Name a TCP server prints for a peer that connected from 203.0.113.77.
  let(:tcp_peer) { "TCPInterface[Client on Public Hub/203.0.113.77:51234]" }
  # Name an AutoInterface prints for a LAN peer.
  let(:lan_peer) { "AutoInterfacePeer[wlan0/fe80::1c2b:3aff:fe4d:5e6f]" }
  # Name an I2PInterface prints for a peer it connects out to.
  let(:i2p_peer) { "I2PInterfacePeer[I2P Link to abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst.b32.i2p]" }

  # Return a Reticulum node record as the ingestor posts it.
  #
  # @param interface [String, nil] printed interface name.
  # @param dest_id [String] destination hash.
  # @param heard [Integer] unix seconds of the announce.
  # @return [Hash] node record.
  def announce_record(interface, dest_id: "a1b2c3d4e5f60718293a4b5c6d7e8f90", heard: Time.now.to_i - 30)
    record = {
      "lastHeard" => heard,
      "protocol" => "reticulum",
      "identityHash" => "a1b2c3d4762cfd2864141ef286c39940",
      "user" => { "longName" => "Argos Station", "shortName" => "a1b2", "role" => "PEER" },
      "destination" => { "id" => dest_id, "aspect" => "lxmf.delivery", "role" => "PEER" },
    }
    record["interface"] = interface if interface
    record
  end

  describe "the public name (SPEC RI1)" do
    let(:names) { PotatoMesh::App::DataProcessing::InterfaceNames }

    INTERFACE_NAME_CASES.each do |name, printed, public|
      it "gives #{name} its public name" do
        expect(names.public_name(printed)).to eq(public)
      end

      it "leaves the public name of #{name} unchanged" do
        expect(names.public_name(public)).to eq(public)
      end
    end

    it "passes a value that is no string through" do
      expect(names.public_name(nil)).to be_nil
      expect(names.public_name(7)).to eq(7)
    end

    it "keeps each class prefix in one rule" do
      groups = [names::ADDRESS_PREFIXES.keys, names::BARE_ADDRESS_PREFIXES, names::NAME_PREFIXES]
      expect(groups.flatten.uniq.length).to eq(groups.flatten.length)
    end
  end

  describe "writing a node record (SPEC RI2)" do
    include_context "with isolated db"

    let(:dp) { DataProcessingHarness.build(protocol: "reticulum").new }

    # Store +record+ for node !a1b2c3d4 and return its destination's interface.
    #
    # @param record [Hash] node record.
    # @return [String, nil] stored +destinations.interface+.
    def stored_interface(record)
      db = open_db
      dp.upsert_node(db, "!a1b2c3d4", record, protocol: "reticulum")
      db.get_first_value("SELECT interface FROM destinations WHERE id = ?", [record.dig("destination", "id")])
    ensure
      db&.close
    end

    it "stores an older ingestor's printed name without the peer's address" do
      expect(stored_interface(announce_record(tcp_peer))).to eq("TCPInterface[Client on Public Hub]")
      expect(stored_interface(announce_record(lan_peer))).to eq("AutoInterfacePeer[wlan0]")
      expect(stored_interface(announce_record(i2p_peer))).to eq("I2PInterfacePeer[I2P Link]")
    end

    it "stores a name the length cap cuts inside the address without the address" do
      # The cap keeps the name and the IP address and cuts the port and "]".
      cap = PotatoMesh::App::DataProcessing::FieldLimits::INTERFACE_BYTES
      name = "Public Hub".ljust(cap - "TCPInterface[".bytesize - "/203.0.113.77".bytesize, "+")
      record = announce_record("TCPInterface[#{name}/203.0.113.77:51234]")
      expect(stored_interface(record)).to eq("TCPInterface[#{name}]")
    end

    it "stores RNode and local names as printed" do
      ["RNodeInterface[RNode Reticulum Berlin]", "Multi Radio[868/915]", "LocalInterface[rns/default]"].each_with_index do |name, index|
        record = announce_record(name, dest_id: format("%032x", index + 1))
        expect(stored_interface(record)).to eq(name)
      end
    end

    it "does not change the record it was handed" do
      record = announce_record(tcp_peer)
      stored_interface(record)
      expect(record["interface"]).to eq(tcp_peer)
    end
  end

  describe "GET /api/destinations (SPEC RI2)" do
    let(:app) { Sinatra::Application }
    let(:headers) { { "CONTENT_TYPE" => "application/json", "HTTP_AUTHORIZATION" => "Bearer interface-names-token" } }

    # Delete the rows these examples write to the application database.
    #
    # @return [void]
    def clear_rows
      db = PotatoMesh::Application.open_database
      %w[destinations nodes].each { |table| db.execute("DELETE FROM #{table}") }
    ensure
      db&.close
    end

    around do |example|
      saved = ENV.to_h.slice("API_TOKEN", "PRIVATE")
      ENV["API_TOKEN"] = "interface-names-token"
      clear_rows
      PotatoMesh::App::ApiCache.invalidate_all
      example.run
    ensure
      clear_rows
      %w[API_TOKEN PRIVATE].each { |key| saved.key?(key) ? ENV[key] = saved[key] : ENV.delete(key) }
    end

    [nil, "1"].each do |private_value|
      it "serves no peer address to an unauthenticated reader (PRIVATE=#{private_value.inspect})" do
        private_value ? ENV["PRIVATE"] = private_value : ENV.delete("PRIVATE")
        payload = { "!a1b2c3d4" => announce_record(tcp_peer), "protocol" => "reticulum" }
        post "/api/nodes", payload.to_json, headers
        expect(last_response.status).to eq(201)

        get "/api/destinations"
        expect(last_response.status).to eq(200)
        rows = JSON.parse(last_response.body)
        expect(rows.map { |row| row["interface"] }).to eq(["TCPInterface[Client on Public Hub]"])
        expect(last_response.body).not_to include("203.0.113.77", "51234")
      end
    end
  end

  describe "#scrub_destination_interfaces (SPEC RI3)" do
    include_context "with isolated db"

    let(:booter) do
      Object.new.tap do |host|
        host.extend(PotatoMesh::App::Database, PotatoMesh::App::DataProcessing)
        host.define_singleton_method(:logs) { @logs ||= [] }
        host.define_singleton_method(:info_log) { |message, **fields| logs << [:info, message, fields] }
        host.define_singleton_method(:warn_log) { |message, **fields| logs << [:warn, message, fields] }
      end
    end

    # Store destination rows with the given interfaces, as releases before
    # this fix wrote them.
    #
    # @param interfaces [Array<String, nil>] one row per value.
    # @return [void]
    def seed(interfaces)
      db = open_db
      interfaces.each_with_index do |interface, index|
        db.execute(
          "INSERT INTO destinations(id, node_id, interface, first_heard, last_heard) VALUES (?, ?, ?, ?, ?)",
          [format("%032x", index + 1), "!a1b2c3d4", interface, now, now],
        )
      end
    ensure
      db&.close
    end

    # @return [Array<String, nil>] stored interfaces in row order.
    def stored
      db = open_db
      db.execute("SELECT interface FROM destinations ORDER BY id").map { |row| row["interface"] }
    ensure
      db&.close
    end

    it "rewrites every stored name that carries an address, and only those" do
      seed(INTERFACE_NAME_CASES.map { |_name, printed, _public| printed } + [nil])
      booter.scrub_destination_interfaces
      expect(stored).to eq(INTERFACE_NAME_CASES.map { |_name, _printed, public| public } + [nil])
      changed = INTERFACE_NAME_CASES.count { |_name, printed, public| printed != public }
      expect(booter.logs).to eq([[:info, "Removed peer addresses from stored interface names", { context: "database.schema", rows: changed }]])
    end

    it "changes nothing on the next boot" do
      seed([tcp_peer, lan_peer, i2p_peer, "Multi Radio[868/915]", "RNodeInterface[RNode Reticulum Berlin]"])
      booter.scrub_destination_interfaces
      first = stored
      booter.logs.clear
      booter.scrub_destination_interfaces
      expect(stored).to eq(first)
      expect(booter.logs).to eq([])
    end

    it "warns and lets the boot go on when the table is missing" do
      db = open_db
      db.execute("DROP TABLE destinations")
      db.close
      expect { booter.scrub_destination_interfaces }.not_to raise_error
      expect(booter.logs.map { |entry| entry.first(2) }).to eq([[:warn, "Failed to remove peer addresses from stored interface names"]])
      expect(booter.logs.first.last).to include(context: "database.schema", error_class: "SQLite3::SQLException")
    end

    it "warns and lets the boot go on when the database cannot be opened" do
      allow(booter).to receive(:open_database).and_raise(SQLite3::CantOpenException, "unable to open database file")
      expect(booter.scrub_destination_interfaces).to be_nil
      expect(booter.logs.map(&:first)).to eq([:warn])
      expect(booter.logs.first.last).to include(error_class: "SQLite3::CantOpenException")
    end
  end
end
