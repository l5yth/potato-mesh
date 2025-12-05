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
require "sqlite3"

RSpec.describe PotatoMesh::App::Cleanup do
  let(:harness_class) do
    Class.new do
      extend PotatoMesh::App::Database
      extend PotatoMesh::App::Cleanup
      extend PotatoMesh::App::Helpers

      class << self
        attr_reader :info_entries, :debug_entries, :warnings

        # Capture info log entries generated during cleanup.
        #
        # @param message [String] info message text.
        # @param context [String] logical source of the log entry.
        # @param metadata [Hash] structured metadata supplied by the caller.
        # @return [void]
        def info_log(message, context:, **metadata)
          @info_entries ||= []
          @info_entries << { message: message, context: context, metadata: metadata }
        end

        # Capture warning log entries generated during cleanup.
        #
        # @param message [String] warning message text.
        # @param context [String] logical source of the log entry.
        # @param metadata [Hash] structured metadata supplied by the caller.
        # @return [void]
        def warn_log(message, context:, **metadata)
          @warnings ||= []
          @warnings << { message: message, context: context, metadata: metadata }
        end

        # Capture debug log entries generated during cleanup.
        #
        # @param message [String] debug message text.
        # @param context [String] logical source of the log entry.
        # @param metadata [Hash] structured metadata supplied by the caller.
        # @return [void]
        def debug_log(message, context:, **metadata)
          @debug_entries ||= []
          @debug_entries << { message: message, context: context, metadata: metadata }
        end

        # Reset captured log entries between test examples.
        #
        # @return [void]
        def reset_logs!
          @info_entries = []
          @debug_entries = []
          @warnings = []
        end
      end
    end
  end

  # Execute the provided block with a configured SQLite connection.
  #
  # @param readonly [Boolean] whether the connection should be read-only.
  # @yieldparam db [SQLite3::Database] configured database handle.
  # @return [void]
  def with_db(readonly: false)
    db = SQLite3::Database.new(PotatoMesh::Config.db_path, readonly: readonly)
    db.busy_timeout = PotatoMesh::Config.db_busy_timeout_ms
    db.execute("PRAGMA foreign_keys = ON")
    yield db
  ensure
    db&.close
  end

  # Insert a test node into the database.
  #
  # @param node_id [String] unique node identifier.
  # @param long_name [String] human-readable node name.
  # @param hw_model [String, nil] hardware model string.
  # @param last_heard [Integer] Unix timestamp for last activity.
  # @return [void]
  def insert_node(node_id:, long_name:, hw_model:, last_heard:)
    with_db do |db|
      db.execute(
        "INSERT INTO nodes (node_id, long_name, hw_model, last_heard) VALUES (?, ?, ?, ?)",
        [node_id, long_name, hw_model, last_heard],
      )
    end
  end

  # Count the number of nodes currently in the database.
  #
  # @return [Integer] total node count.
  def node_count
    with_db(readonly: true) do |db|
      db.get_first_value("SELECT COUNT(*) FROM nodes").to_i
    end
  end

  # Retrieve all node IDs currently in the database.
  #
  # @return [Array<String>] list of node identifiers.
  def node_ids
    with_db(readonly: true) do |db|
      db.execute("SELECT node_id FROM nodes").flatten
    end
  end

  around do |example|
    harness_class.reset_logs!

    Dir.mktmpdir("cleanup-spec-") do |dir|
      db_path = File.join(dir, "mesh.db")

      RSpec::Mocks.with_temporary_scope do
        allow(PotatoMesh::Config).to receive(:db_path).and_return(db_path)
        allow(PotatoMesh::Config).to receive(:default_db_path).and_return(db_path)
        allow(PotatoMesh::Config).to receive(:legacy_db_path).and_return(db_path)
        allow(PotatoMesh::Config).to receive(:stale_node_min_age).and_return(7 * 24 * 60 * 60)

        FileUtils.mkdir_p(File.dirname(db_path))
        harness_class.init_db

        example.run
      end
    end
  ensure
    harness_class.reset_logs!
  end

  describe ".prune_stale_nodes" do
    let(:current_time) { Time.now.to_i }
    let(:old_time) { current_time - (8 * 24 * 60 * 60) }
    let(:recent_time) { current_time - (3 * 24 * 60 * 60) }

    it "removes incomplete nodes older than the minimum age" do
      insert_node(
        node_id: "!stale1",
        long_name: "Meshtastic 1234",
        hw_model: nil,
        last_heard: old_time,
      )
      insert_node(
        node_id: "!stale2",
        long_name: "Meshtastic abcd",
        hw_model: "",
        last_heard: old_time,
      )

      expect(node_count).to eq(2)
      deleted = harness_class.prune_stale_nodes
      expect(deleted).to eq(2)
      expect(node_count).to eq(0)
    end

    it "preserves nodes with complete hardware model" do
      insert_node(
        node_id: "!complete",
        long_name: "Meshtastic 1234",
        hw_model: "HELTEC_V3",
        last_heard: old_time,
      )

      deleted = harness_class.prune_stale_nodes
      expect(deleted).to eq(0)
      expect(node_ids).to include("!complete")
    end

    it "preserves nodes with custom names even if hw_model is missing" do
      insert_node(
        node_id: "!custom",
        long_name: "MyCustomNode",
        hw_model: nil,
        last_heard: old_time,
      )

      deleted = harness_class.prune_stale_nodes
      expect(deleted).to eq(0)
      expect(node_ids).to include("!custom")
    end

    it "preserves recent incomplete nodes" do
      insert_node(
        node_id: "!recent",
        long_name: "Meshtastic 5678",
        hw_model: nil,
        last_heard: recent_time,
      )

      deleted = harness_class.prune_stale_nodes
      expect(deleted).to eq(0)
      expect(node_ids).to include("!recent")
    end

    it "logs info message when nodes are deleted" do
      insert_node(
        node_id: "!todelete",
        long_name: "Meshtastic 9999",
        hw_model: "",
        last_heard: old_time,
      )

      harness_class.prune_stale_nodes
      expect(harness_class.info_entries).not_to be_empty
      expect(harness_class.info_entries.first[:context]).to eq("cleanup.nodes")
      expect(harness_class.info_entries.first[:metadata][:count]).to eq(1)
    end

    it "logs debug message when no nodes are deleted" do
      insert_node(
        node_id: "!complete",
        long_name: "MyNode",
        hw_model: "TBEAM",
        last_heard: old_time,
      )

      harness_class.prune_stale_nodes
      expect(harness_class.debug_entries).not_to be_empty
      expect(harness_class.debug_entries.first[:context]).to eq("cleanup.nodes")
    end

    it "accepts custom cutoff_time parameter" do
      insert_node(
        node_id: "!marginal",
        long_name: "Meshtastic 0001",
        hw_model: nil,
        last_heard: recent_time,
      )

      # Use a cutoff that makes the recent node appear old
      custom_cutoff = current_time
      deleted = harness_class.prune_stale_nodes(custom_cutoff)
      expect(deleted).to eq(1)
      expect(node_count).to eq(0)
    end

    it "handles mixed scenarios correctly" do
      # Should be deleted: default name + no hw_model + old
      insert_node(
        node_id: "!delete_me",
        long_name: "Meshtastic dcba",
        hw_model: nil,
        last_heard: old_time,
      )

      # Should be preserved: default name + no hw_model + recent
      insert_node(
        node_id: "!keep_recent",
        long_name: "Meshtastic 1111",
        hw_model: nil,
        last_heard: recent_time,
      )

      # Should be preserved: default name + has hw_model + old
      insert_node(
        node_id: "!keep_complete",
        long_name: "Meshtastic 2222",
        hw_model: "RAK4631",
        last_heard: old_time,
      )

      # Should be preserved: custom name + no hw_model + old
      insert_node(
        node_id: "!keep_named",
        long_name: "BaseStation01",
        hw_model: nil,
        last_heard: old_time,
      )

      expect(node_count).to eq(4)
      deleted = harness_class.prune_stale_nodes
      expect(deleted).to eq(1)
      expect(node_count).to eq(3)

      remaining = node_ids
      expect(remaining).not_to include("!delete_me")
      expect(remaining).to include("!keep_recent")
      expect(remaining).to include("!keep_complete")
      expect(remaining).to include("!keep_named")
    end
  end

  describe ".run_stale_node_cleanup" do
    it "delegates to prune_stale_nodes" do
      insert_node(
        node_id: "!old",
        long_name: "Meshtastic ffff",
        hw_model: "",
        last_heard: Time.now.to_i - (10 * 24 * 60 * 60),
      )

      deleted = harness_class.run_stale_node_cleanup
      expect(deleted).to eq(1)
    end
  end
end

RSpec.describe PotatoMesh::Config do
  describe ".stale_node_cleanup_interval" do
    around do |example|
      original = ENV["STALE_NODE_CLEANUP_INTERVAL"]
      example.run
    ensure
      if original
        ENV["STALE_NODE_CLEANUP_INTERVAL"] = original
      else
        ENV.delete("STALE_NODE_CLEANUP_INTERVAL")
      end
    end

    it "returns 0 (disabled) when ENV is not set" do
      ENV.delete("STALE_NODE_CLEANUP_INTERVAL")
      expect(PotatoMesh::Config.stale_node_cleanup_interval).to eq(0)
    end

    it "returns custom interval when ENV is set to positive value" do
      ENV["STALE_NODE_CLEANUP_INTERVAL"] = "86400"
      expect(PotatoMesh::Config.stale_node_cleanup_interval).to eq(86400)
    end

    it "returns 0 when ENV is explicitly set to 0" do
      ENV["STALE_NODE_CLEANUP_INTERVAL"] = "0"
      expect(PotatoMesh::Config.stale_node_cleanup_interval).to eq(0)
    end

    it "returns 0 (default) when ENV contains invalid value" do
      ENV["STALE_NODE_CLEANUP_INTERVAL"] = "invalid"
      expect(PotatoMesh::Config.stale_node_cleanup_interval).to eq(0)
    end
  end

  describe ".stale_node_cleanup_enabled?" do
    around do |example|
      original = ENV["STALE_NODE_CLEANUP_INTERVAL"]
      example.run
    ensure
      if original
        ENV["STALE_NODE_CLEANUP_INTERVAL"] = original
      else
        ENV.delete("STALE_NODE_CLEANUP_INTERVAL")
      end
    end

    it "returns false when interval is not set (default)" do
      ENV.delete("STALE_NODE_CLEANUP_INTERVAL")
      expect(PotatoMesh::Config.stale_node_cleanup_enabled?).to be(false)
    end

    it "returns true when interval is set to positive value" do
      ENV["STALE_NODE_CLEANUP_INTERVAL"] = "3600"
      expect(PotatoMesh::Config.stale_node_cleanup_enabled?).to be(true)
    end

    it "returns false when interval is 0" do
      ENV["STALE_NODE_CLEANUP_INTERVAL"] = "0"
      expect(PotatoMesh::Config.stale_node_cleanup_enabled?).to be(false)
    end
  end

  describe ".stale_node_min_age" do
    around do |example|
      original = ENV["STALE_NODE_MIN_AGE"]
      example.run
    ensure
      if original
        ENV["STALE_NODE_MIN_AGE"] = original
      else
        ENV.delete("STALE_NODE_MIN_AGE")
      end
    end

    it "returns default value when ENV is not set" do
      ENV.delete("STALE_NODE_MIN_AGE")
      expect(PotatoMesh::Config.stale_node_min_age).to eq(7 * 24 * 60 * 60)
    end

    it "returns custom age when ENV is set" do
      ENV["STALE_NODE_MIN_AGE"] = "86400"
      expect(PotatoMesh::Config.stale_node_min_age).to eq(86400)
    end
  end
end
