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

require "sqlite3"
require "tmpdir"

# Shared helpers for specs that call +PotatoMesh::App::DataProcessing+ methods
# in isolation (+data_processing_spec.rb+, +meshcore_dedup_spec.rb+).
module DataProcessingHarness
  # Build a minimal host class so the module methods can be called in
  # isolation: logging, retry and privacy collaborators are stubbed,
  # and node references normalize to their canonical id without a lookup.
  #
  # @param protocol [String] value the stubbed +resolve_protocol+ returns.
  # @param stub_chat_nodes [Boolean] when true, +process_meshcore_chat_nodes+
  #   becomes a no-op that reports the sender as named, so an example drives
  #   +insert_message+ without the synthetic->real merge machinery (covered by
  #   its own specs).
  # @return [Class] the harness class; instantiate it with +.new+.
  def self.build(protocol: "meshtastic", stub_chat_nodes: false)
    Class.new do
      include PotatoMesh::App::DataProcessing
      include PotatoMesh::App::Helpers

      def debug_log(message, **); end

      def warn_log(message, **); end

      def with_busy_retry
        yield
      end

      def private_mode?
        false
      end

      def normalize_node_id(_db, node_ref)
        parts = canonical_node_parts(node_ref)
        parts ? parts[0] : nil
      end

      define_method(:resolve_protocol) { |_db, _ingestor, cache: nil| protocol }
      define_method(:process_meshcore_chat_nodes) { |*| true } if stub_chat_nodes
    end
  end
end

# Node-seeding helpers shared by the MeshCore specs
# (+data_processing_spec.rb+, +meshcore_ghost_nodes_spec.rb+).  The including
# group must define +dp+, an instance of a +DataProcessingHarness.build+ class.
module MeshcoreNodeSeeds
  # Store a keyed MeshCore contact (roster or advert record) last heard at
  # +heard+; its keyed evidence (+last_advert_heard+) is +heard+ as well.
  #
  # @param db [SQLite3::Database] open database handle.
  # @param node_id [String] canonical node id.
  # @param name [String] advertised long name.
  # @param key_byte [String] two hex digits repeated into the public key.
  # @param heard [Integer] unix seconds of the record.
  # @return [void]
  def seed_keyed_node(db, node_id, name, key_byte, heard)
    dp.upsert_node(db, node_id, {
      "lastHeard" => heard,
      "protocol" => "meshcore",
      "user" => { "longName" => name, "shortName" => key_byte, "role" => "COMPANION", "publicKey" => key_byte * 32 },
    }, protocol: "meshcore")
  end
end

# A fresh SQLite database per example, built by +init_db+ and
# +ensure_schema_upgrades+ like a booted deployment, with the timing knobs
# pinned.  +seed_node+ expects the including group to define +dp+.
RSpec.shared_context "with isolated db" do
  around do |example|
    Dir.mktmpdir("dp-spec-") do |dir|
      db_path = File.join(dir, "mesh.db")
      RSpec::Mocks.with_temporary_scope do
        allow(PotatoMesh::Config).to receive(:db_path).and_return(db_path)
        allow(PotatoMesh::Config).to receive(:db_busy_timeout_ms).and_return(5000)
        allow(PotatoMesh::Config).to receive(:week_seconds).and_return(604_800)
        allow(PotatoMesh::Config).to receive(:four_weeks_seconds).and_return(604_800)
        allow(PotatoMesh::Config).to receive(:debug?).and_return(false)
        db_helper = Object.new.extend(PotatoMesh::App::Database)
        db_helper.init_db
        db_helper.ensure_schema_upgrades
        example.run
      end
    end
  end

  # Open a handle on the example's isolated database that returns rows as
  # hashes keyed by column name.  The caller closes it.
  #
  # @return [SQLite3::Database] open database handle.
  def open_db
    db = SQLite3::Database.new(PotatoMesh::Config.db_path)
    db.results_as_hash = true
    db
  end

  # Force the INSERT race of +insert_message+ on +db+: the first stored-row
  # lookup of each message id misses, as when another ingestor's copy lands
  # between this copy's lookup and its INSERT.  The INSERT then trips the
  # primary key, and the race recovery's own lookup sees the row (SPEC KC3).
  #
  # @param db [SQLite3::Database] open database handle.
  # @return [void]
  def hide_stored_message_once(db)
    lookup = "SELECT #{PotatoMesh::App::DataProcessing::MESSAGE_MERGE_COLUMNS.join(", ")} FROM messages"
    looked_up = {}
    allow(db).to receive(:get_first_row).and_wrap_original do |original, sql, *args|
      if sql.start_with?(lookup) && !looked_up.key?(args.first)
        looked_up[args.first] = true
        nil
      else
        original.call(sql, *args)
      end
    end
  end

  # Return the full node row for the canonical test node ID.
  #
  # @param db [SQLite3::Database] open database handle.
  # @return [Hash, Array, nil] the +nodes+ row for +!aabbccdd+, or nil when it
  #   does not exist.
  def read_node(db)
    db.execute("SELECT * FROM nodes WHERE node_id = '!aabbccdd'").first
  end

  # Insert the canonical test node with full user info and CLIENT_BASE role.
  #
  # @param db [SQLite3::Database] open database handle.
  # @return [void]
  def seed_node(db)
    dp.upsert_node(db, "!aabbccdd", {
      "lastHeard" => now - 100,
      "num" => 0xaabbccdd,
      "user" => {
        "role" => "CLIENT_BASE",
        "longName" => "Real Long Name",
        "shortName" => "RLN",
        "macaddr" => "aa:bb:cc:dd:ee:ff",
        "hwModel" => "TBEAM",
        "publicKey" => "abc123",
      },
    })
  end

  let(:now) { Time.now.to_i }
end
