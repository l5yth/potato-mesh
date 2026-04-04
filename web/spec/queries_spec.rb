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

RSpec.describe PotatoMesh::App::Queries do
  # Build a lightweight host class that mixes in the module under test plus
  # the helpers required by several query helpers (coerce_integer, string_or_nil,
  # canonical_node_parts, etc.).
  let(:harness_class) do
    Class.new do
      include PotatoMesh::App::Queries
      include PotatoMesh::App::Helpers
      include PotatoMesh::App::DataProcessing

      # Stub private_mode? so tests do not need env configuration.
      def private_mode?
        false
      end

      # Stub prom_report_ids so tests do not depend on prometheus env.
      def prom_report_ids
        []
      end

      # No-op for debug_log calls inside query helpers.
      def debug_log(message, **); end

      # No-op for warn_log calls inside query helpers.
      def warn_log(message, **); end

      # Expose the current db path for tests that need to open a handle.
      def open_database(readonly: false)
        db = SQLite3::Database.new(PotatoMesh::Config.db_path, readonly: readonly)
        db.results_as_hash = true
        db.busy_timeout = PotatoMesh::Config.db_busy_timeout_ms
        db
      end

      def normalize_node_id(db, node_ref)
        return nil unless node_ref
        parts = canonical_node_parts(node_ref)
        parts ? parts[0] : nil
      end

      def with_busy_retry
        yield
      end

      def update_prometheus_metrics(*); end

      def resolve_protocol(_db, _ingestor, cache: nil)
        "meshtastic"
      end
    end
  end

  subject(:queries) { harness_class.new }

  # ---------------------------------------------------------------------------
  # compact_api_row
  # ---------------------------------------------------------------------------
  describe "#compact_api_row" do
    it "returns an empty hash for a non-Hash argument" do
      expect(queries.compact_api_row(nil)).to eq({})
      expect(queries.compact_api_row("string")).to eq({})
      expect(queries.compact_api_row(42)).to eq({})
    end

    it "removes nil values" do
      expect(queries.compact_api_row({ "a" => nil, "b" => "x" })).to eq({ "b" => "x" })
    end

    it "removes blank string values (whitespace-only)" do
      expect(queries.compact_api_row({ "a" => "  ", "b" => "ok" })).to eq({ "b" => "ok" })
    end

    it "removes empty string values" do
      expect(queries.compact_api_row({ "a" => "", "b" => "y" })).to eq({ "b" => "y" })
    end

    it "retains non-blank string values" do
      result = queries.compact_api_row({ "k" => "  value  " })
      expect(result["k"]).to eq("  value  ")
    end

    it "retains zero numeric values" do
      expect(queries.compact_api_row({ "count" => 0 })).to eq({ "count" => 0 })
    end

    it "removes integer keys (SQLite row-index artifacts)" do
      row = { 0 => "x", "name" => "node" }
      expect(queries.compact_api_row(row)).to eq({ "name" => "node" })
    end

    it "removes empty arrays" do
      expect(queries.compact_api_row({ "hops" => [], "id" => 1 })).to eq({ "id" => 1 })
    end

    it "retains non-empty arrays" do
      row = { "hops" => [1, 2] }
      expect(queries.compact_api_row(row)).to eq({ "hops" => [1, 2] })
    end

    it "retains false booleans" do
      expect(queries.compact_api_row({ "flag" => false })).to eq({ "flag" => false })
    end
  end

  # ---------------------------------------------------------------------------
  # nil_if_zero
  # ---------------------------------------------------------------------------
  describe "#nil_if_zero" do
    it "returns nil when value is integer zero" do
      expect(queries.nil_if_zero(0)).to be_nil
    end

    it "returns nil when value is float zero" do
      expect(queries.nil_if_zero(0.0)).to be_nil
    end

    it "returns the value unchanged for non-zero integers" do
      expect(queries.nil_if_zero(5)).to eq(5)
    end

    it "returns the value unchanged for non-zero floats" do
      expect(queries.nil_if_zero(3.14)).to eq(3.14)
    end

    it "passes nil through unchanged" do
      expect(queries.nil_if_zero(nil)).to be_nil
    end

    it "passes strings through unchanged (no zero? method behaviour)" do
      expect(queries.nil_if_zero("0")).to eq("0")
    end
  end

  # ---------------------------------------------------------------------------
  # append_protocol_filter
  # ---------------------------------------------------------------------------
  describe "#append_protocol_filter" do
    it "appends a clause and param when protocol is given" do
      clauses = []
      params = []
      queries.append_protocol_filter(clauses, params, "meshtastic")
      expect(clauses).to eq(["protocol = ?"])
      expect(params).to eq(["meshtastic"])
    end

    it "is a no-op when protocol is nil" do
      clauses = []
      params = []
      queries.append_protocol_filter(clauses, params, nil)
      expect(clauses).to be_empty
      expect(params).to be_empty
    end

    it "includes a table alias prefix when provided" do
      clauses = []
      params = []
      queries.append_protocol_filter(clauses, params, "meshcore", table_alias: "m")
      expect(clauses).to eq(["m.protocol = ?"])
      expect(params).to eq(["meshcore"])
    end
  end

  # ---------------------------------------------------------------------------
  # coerce_query_limit
  # ---------------------------------------------------------------------------
  describe "#coerce_query_limit" do
    it "returns the value when within range" do
      expect(queries.coerce_query_limit(50)).to eq(50)
    end

    it "caps the value at MAX_QUERY_LIMIT" do
      expect(queries.coerce_query_limit(5000)).to eq(PotatoMesh::App::Queries::MAX_QUERY_LIMIT)
    end

    it "returns the default when nil is supplied" do
      expect(queries.coerce_query_limit(nil)).to eq(200)
    end

    it "returns the default for a non-numeric string" do
      expect(queries.coerce_query_limit("abc")).to eq(200)
    end

    it "accepts an integer given as string" do
      expect(queries.coerce_query_limit("100")).to eq(100)
    end

    it "returns the default for zero or negative values" do
      expect(queries.coerce_query_limit(0)).to eq(200)
      expect(queries.coerce_query_limit(-10)).to eq(200)
    end

    it "honours a custom default" do
      expect(queries.coerce_query_limit(nil, default: 42)).to eq(42)
    end
  end

  # ---------------------------------------------------------------------------
  # normalize_since_threshold
  # ---------------------------------------------------------------------------
  describe "#normalize_since_threshold" do
    it "passes a valid integer through" do
      t = Time.now.to_i - 3600
      expect(queries.normalize_since_threshold(t)).to eq(t)
    end

    it "returns zero when nil is supplied and floor is 0" do
      expect(queries.normalize_since_threshold(nil)).to eq(0)
    end

    it "returns zero for invalid string input" do
      expect(queries.normalize_since_threshold("bad")).to eq(0)
    end

    it "applies the floor when the computed value is below it" do
      floor = 1_000_000
      expect(queries.normalize_since_threshold(0, floor: floor)).to eq(floor)
    end

    it "clamps negative values to zero before comparing floor" do
      expect(queries.normalize_since_threshold(-99, floor: 0)).to eq(0)
    end
  end

  # ---------------------------------------------------------------------------
  # node_reference_tokens
  # ---------------------------------------------------------------------------
  describe "#node_reference_tokens" do
    it "handles an !hex string" do
      result = queries.node_reference_tokens("!aabbccdd")
      expect(result[:string_values]).to include("!aabbccdd")
      expect(result[:numeric_values]).to include(0xaabbccdd)
    end

    it "handles a 0x-prefixed hex string" do
      result = queries.node_reference_tokens("0xaabbccdd")
      expect(result[:numeric_values]).to include(0xaabbccdd)
    end

    it "handles a decimal integer" do
      result = queries.node_reference_tokens(12345)
      expect(result[:numeric_values]).to include(12345)
      expect(result[:string_values]).to include("12345")
    end

    it "returns empty collections for nil" do
      result = queries.node_reference_tokens(nil)
      expect(result[:string_values]).to be_empty
      expect(result[:numeric_values]).to be_empty
    end

    it "handles a plain decimal string" do
      result = queries.node_reference_tokens("67890")
      expect(result[:numeric_values]).to include(67890)
    end
  end

  # ---------------------------------------------------------------------------
  # node_lookup_clause
  # ---------------------------------------------------------------------------
  describe "#node_lookup_clause" do
    it "returns nil when no tokens match any column" do
      # A nil node_ref produces empty tokens → nil clause
      result = queries.node_lookup_clause(nil, string_columns: ["node_id"])
      expect(result).to be_nil
    end

    it "returns a clause and params for a single token" do
      clause, params = queries.node_lookup_clause("!aabbccdd", string_columns: ["node_id"])
      expect(clause).to include("node_id IN (")
      expect(params).not_to be_empty
    end

    it "includes multiple columns joined with OR" do
      clause, _params = queries.node_lookup_clause(
        "!aabbccdd",
        string_columns: ["from_id", "to_id"],
      )
      expect(clause).to include("from_id IN (")
      expect(clause).to include("to_id IN (")
      expect(clause).to include(" OR ")
    end

    it "includes numeric column clauses when numeric tokens are present" do
      clause, params = queries.node_lookup_clause(
        12345,
        string_columns: [],
        numeric_columns: ["num"],
      )
      expect(clause).to include("num IN (")
      expect(params).to include(12345)
    end
  end

  # ---------------------------------------------------------------------------
  # sanitize_zero_invalid_metric
  # ---------------------------------------------------------------------------
  describe "#sanitize_zero_invalid_metric" do
    it "returns nil when value is zero for a ZERO_INVALID column" do
      expect(queries.sanitize_zero_invalid_metric("battery_level", 0.0)).to be_nil
      expect(queries.sanitize_zero_invalid_metric("voltage", 0.0)).to be_nil
    end

    it "returns the value when non-zero for a ZERO_INVALID column" do
      expect(queries.sanitize_zero_invalid_metric("battery_level", 80.0)).to eq(80.0)
    end

    it "keeps zero for a column not in ZERO_INVALID list" do
      expect(queries.sanitize_zero_invalid_metric("temperature", 0.0)).to eq(0.0)
    end

    it "passes nil through unchanged" do
      expect(queries.sanitize_zero_invalid_metric("battery_level", nil)).to be_nil
    end
  end

  # ---------------------------------------------------------------------------
  # telemetry_aggregate_source
  # ---------------------------------------------------------------------------
  describe "#telemetry_aggregate_source" do
    it "wraps zero-invalid columns in NULLIF" do
      expect(queries.telemetry_aggregate_source("battery_level")).to eq("NULLIF(battery_level, 0)")
      expect(queries.telemetry_aggregate_source("voltage")).to eq("NULLIF(voltage, 0)")
    end

    it "returns the column name unchanged for valid-zero columns" do
      expect(queries.telemetry_aggregate_source("temperature")).to eq("temperature")
    end
  end

  # ---------------------------------------------------------------------------
  # Database-backed query methods (query_nodes, query_messages, etc.)
  # ---------------------------------------------------------------------------

  around do |example|
    Dir.mktmpdir("queries-spec-") do |dir|
      db_path = File.join(dir, "mesh.db")

      RSpec::Mocks.with_temporary_scope do
        allow(PotatoMesh::Config).to receive(:db_path).and_return(db_path)
        allow(PotatoMesh::Config).to receive(:db_busy_timeout_ms).and_return(5000)
        allow(PotatoMesh::Config).to receive(:week_seconds).and_return(604_800)
        allow(PotatoMesh::Config).to receive(:trace_neighbor_window_seconds).and_return(604_800)
        allow(PotatoMesh::Config).to receive(:debug?).and_return(false)

        # Initialise schema so query methods can execute real SQL.
        db_helper = Object.new.extend(PotatoMesh::App::Database)
        db_helper.init_db
        db_helper.ensure_schema_upgrades

        example.run
      end
    end
  end

  let(:now) { Time.now.to_i }

  # Convenience helper: open an in-spec db handle.
  def with_db
    db = SQLite3::Database.new(PotatoMesh::Config.db_path)
    db.results_as_hash = true
    yield db
  ensure
    db&.close
  end

  describe "#query_nodes" do
    before do
      with_db do |db|
        db.execute(
          "INSERT INTO nodes(node_id, num, short_name, last_heard, first_heard, role) VALUES (?,?,?,?,?,?)",
          ["!aabbccdd", 0xaabbccdd, "TEST", now, now, "CLIENT"],
        )
      end
    end

    it "returns nodes from the database" do
      rows = queries.query_nodes(10)
      expect(rows).to be_an(Array)
      expect(rows.length).to be >= 1
      ids = rows.map { |r| r["node_id"] }
      expect(ids).to include("!aabbccdd")
    end

    it "filters by node_id when node_ref is supplied" do
      with_db do |db|
        db.execute(
          "INSERT INTO nodes(node_id, num, short_name, last_heard, first_heard, role) VALUES (?,?,?,?,?,?)",
          ["!11223344", 0x11223344, "OTHER", now, now, "CLIENT"],
        )
      end

      rows = queries.query_nodes(10, node_ref: "!aabbccdd")
      ids = rows.map { |r| r["node_id"] }
      expect(ids).to include("!aabbccdd")
      expect(ids).not_to include("!11223344")
    end

    it "respects since_time filter" do
      rows = queries.query_nodes(10, since: now + 9999)
      expect(rows).to be_empty
    end
  end

  describe "#query_messages" do
    before do
      with_db do |db|
        rx_iso = Time.at(now).utc.iso8601
        db.execute(
          "INSERT INTO messages(id, rx_time, rx_iso, from_id, to_id, channel, text) VALUES (?,?,?,?,?,?,?)",
          [1, now, rx_iso, "!aabbccdd", "!ffffffff", 0, "hello"],
        )
      end
    end

    it "returns messages" do
      rows = queries.query_messages(10)
      expect(rows).to be_an(Array)
      texts = rows.map { |r| r["text"] }
      expect(texts).to include("hello")
    end

    it "filters by since_time" do
      rows = queries.query_messages(10, since: now + 9999)
      expect(rows).to be_empty
    end

    it "filters by node_ref" do
      with_db do |db|
        rx_iso = Time.at(now).utc.iso8601
        db.execute(
          "INSERT INTO messages(id, rx_time, rx_iso, from_id, to_id, channel, text) VALUES (?,?,?,?,?,?,?)",
          [2, now, rx_iso, "!deadbeef", "!ffffffff", 0, "other message"],
        )
      end

      rows = queries.query_messages(10, node_ref: "!aabbccdd")
      texts = rows.map { |r| r["text"] }
      expect(texts).to include("hello")
      expect(texts).not_to include("other message")
    end
  end

  describe "#query_telemetry" do
    before do
      with_db do |db|
        rx_iso = Time.at(now).utc.iso8601
        db.execute(
          "INSERT INTO telemetry(id, rx_time, rx_iso, node_id, telemetry_type) VALUES (?,?,?,?,?)",
          [1, now, rx_iso, "!aabbccdd", "device"],
        )
      end
    end

    it "returns telemetry rows" do
      rows = queries.query_telemetry(10)
      expect(rows).to be_an(Array)
      expect(rows.length).to be >= 1
    end

    it "filters by node_ref" do
      rows = queries.query_telemetry(10, node_ref: "!aabbccdd")
      expect(rows.length).to be >= 1
    end
  end

  describe "#query_positions" do
    before do
      with_db do |db|
        rx_iso = Time.at(now).utc.iso8601
        db.execute(
          "INSERT INTO positions(id, rx_time, rx_iso, node_id, latitude, longitude) VALUES (?,?,?,?,?,?)",
          [1, now, rx_iso, "!aabbccdd", 52.0, 13.0],
        )
      end
    end

    it "returns position rows" do
      rows = queries.query_positions(10)
      expect(rows).to be_an(Array)
      expect(rows.length).to be >= 1
    end

    it "filters by node_ref" do
      rows = queries.query_positions(10, node_ref: "!aabbccdd")
      expect(rows.length).to be >= 1
    end
  end

  describe "#query_neighbors" do
    before do
      with_db do |db|
        # neighbors has a composite primary key (node_id, neighbor_id) and
        # foreign keys referencing nodes; insert required node rows first.
        db.execute(
          "INSERT OR IGNORE INTO nodes(node_id, num, last_heard, first_heard, role) VALUES (?,?,?,?,?)",
          ["!aabbccdd", 0xaabbccdd, now, now, "CLIENT"],
        )
        db.execute(
          "INSERT OR IGNORE INTO nodes(node_id, num, last_heard, first_heard, role) VALUES (?,?,?,?,?)",
          ["!11223344", 0x11223344, now, now, "CLIENT"],
        )
        db.execute(
          "INSERT INTO neighbors(node_id, neighbor_id, snr, rx_time) VALUES (?,?,?,?)",
          ["!aabbccdd", "!11223344", 5.0, now],
        )
      end
    end

    it "returns neighbor rows" do
      rows = queries.query_neighbors(10)
      expect(rows).to be_an(Array)
      expect(rows.length).to be >= 1
    end
  end

  describe "#query_traces" do
    before do
      with_db do |db|
        rx_iso = Time.at(now).utc.iso8601
        db.execute(
          "INSERT INTO traces(id, rx_time, rx_iso, src, dest) VALUES (?,?,?,?,?)",
          [1, now, rx_iso, 0xaabbccdd, 0x11223344],
        )
      end
    end

    it "returns trace rows" do
      rows = queries.query_traces(10)
      expect(rows).to be_an(Array)
      expect(rows.length).to be >= 1
    end
  end
end
