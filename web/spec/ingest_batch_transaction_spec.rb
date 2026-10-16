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
require "base64"
require "json"
require "sqlite3"
require_relative "support/ingest_spec_helpers"
require_relative "support/statement_pauses"
require_relative "support/stub_interpreter"

# One write transaction per ingest batch (SPEC BT1-BT6; ACCEPTANCE BT-A1 to
# BT-A6). Each batch POST writes its records between one BEGIN IMMEDIATE and
# its COMMIT; the writers that opened a transaction of their own join it as
# savepoints, and alone they run in BEGIN IMMEDIATE; a record that raises is
# rolled back to its savepoint and the rest of the batch is stored, while an
# error of the database, or an interrupt, rolls the whole batch back; the
# payloads are decoded before the write lock is taken; the cache and the
# live updates follow the commit; and a neighbour snapshot mints its
# placeholders inside its transaction.
RSpec.describe "Ingest batch transactions" do
  include IngestSpecHelpers
  include StatementPauses

  let(:app) { Sinatra::Application }
  let(:application) { PotatoMesh::Application }
  let(:api_token) { "ingest-batch-tx-token" }
  let(:auth_headers) do
    { "CONTENT_TYPE" => "application/json", "HTTP_AUTHORIZATION" => "Bearer #{api_token}" }
  end
  let(:now) { Time.now.to_i }

  before do
    @original_token = ENV["API_TOKEN"]
    ENV["API_TOKEN"] = api_token
    with_db do |db|
      %w[messages nodes positions telemetry neighbors traces trace_hops waypoints].each do |table|
        db.execute("DELETE FROM #{table}")
      end
    end
    PotatoMesh::App::ApiCache.invalidate_all
  end

  after do
    @original_token.nil? ? ENV.delete("API_TOKEN") : ENV["API_TOKEN"] = @original_token
    PotatoMesh::App::ApiCache.invalidate_all
  end

  # A channel text message from one of 40 senders.
  #
  # @param id [Integer] message id.
  # @param fields [Hash] fields to add or replace.
  # @return [Hash] the message record.
  def message(id, fields = {})
    from = format("!%08x", 0x5b000000 + (id % 40))
    {
      "id" => id, "rx_time" => now, "rx_iso" => Time.at(now).utc.iso8601, "from_id" => from,
      "to_id" => "^all", "channel" => 0, "portnum" => "TEXT_MESSAGE_APP", "text" => "batch message #{id}",
    }.merge(fields)
  end

  # Messages each sent by a node of its own, so every batch of them runs the
  # same statements, the sender's placeholder included.
  #
  # @param ids [Array<Integer>] message ids, also the senders' numbers.
  # @return [Array<Hash>] the message records.
  def fresh_messages(ids)
    ids.map { |id| message(id, "from_id" => format("!%08x", id)) }
  end

  # The ids among +ids+ that the messages table holds.
  #
  # @param ids [Array<Integer>] message ids.
  # @return [Array<Integer>] the stored ones, ascending.
  def stored_message_ids(ids)
    db_rows("SELECT id FROM messages WHERE id IN (#{ids.map { "?" }.join(",")}) ORDER BY id", ids).map { |row| row["id"] }
  end

  # POST +body+ as JSON to +path+ through +Rack::MockRequest+, which, unlike
  # Rack::Test's shared session, any thread may call.
  #
  # @param path [String] ingest route.
  # @param body [Object] request body.
  # @return [Rack::MockResponse] the response.
  def mock_post(path, body)
    Rack::MockRequest.new(app).post(path, input: body.to_json, **auth_headers.transform_keys(&:to_s))
  end

  # The salts and the commit frames of the WAL's current generation.
  #
  # @return [Array(Integer, Integer, Integer)] both salts and the commits.
  def wal_generation
    path = "#{PotatoMesh::Config.db_path}-wal"
    data = File.exist?(path) ? File.binread(path) : ""
    return [nil, nil, 0] if data.bytesize < 32

    page_size, _sequence, salt1, salt2 = data[8, 16].unpack("N4")
    frame_size = 24 + page_size
    commits = 0
    offset = 32
    while offset + frame_size <= data.bytesize
      _page, commit_size, frame_salt1, frame_salt2 = data[offset, 16].unpack("N4")
      break unless frame_salt1 == salt1 && frame_salt2 == salt2

      commits += 1 unless commit_size.zero?
      offset += frame_size
    end
    [salt1, salt2, commits]
  end

  # Commits the block appends to the WAL. A reader holds a snapshot
  # meanwhile, so no checkpoint restarts the WAL and every commit's frames
  # stay in the file; the block's first write may still start a new
  # generation when the WAL was checkpointed whole before it.
  #
  # @yield the writes to count.
  # @return [Integer] commits.
  def wal_commits
    reader = SQLite3::Database.new(PotatoMesh::Config.db_path, readonly: true)
    statement = reader.prepare("SELECT COUNT(*) FROM messages")
    statement.step
    salt1, salt2, before = wal_generation
    yield
    after_salt1, after_salt2, after = wal_generation
    [after_salt1, after_salt2] == [salt1, salt2] ? after - before : after
  ensure
    statement&.close
    reader&.close
  end

  # Run the block and list each statement prepared meanwhile, with whether
  # its connection held a transaction and the thread that prepared it.
  #
  # @yield the requests to record.
  # @return [Array<Array(String, Boolean, Thread)>] statement, transaction
  #   flag and thread, in order.
  def record_statements
    log = []
    allow_any_instance_of(SQLite3::Database).to receive(:prepare).and_wrap_original do |original, sql, *args, **options, &block|
      log << [sql.to_s.strip, original.receiver.transaction_active?, Thread.current]
      original.call(sql, *args, **options, &block)
    end
    yield
    allow_any_instance_of(SQLite3::Database).to receive(:prepare).and_call_original
    log
  end

  # Capture the warn and debug lines the app logs.
  #
  # @return [Array<Array(Symbol, String, Hash)>] level, message and metadata.
  def capture_logs
    lines = []
    %i[warn_log debug_log].each do |level|
      allow_any_instance_of(Sinatra::Application).to receive(level) { |_app, text, **meta| lines << [level, text, meta] }
      allow(application).to receive(level) { |text, **meta| lines << [level, text, meta] }
    end
    lines
  end

  # Make +writer+ raise a +TypeError+ after it ran, for the record
  # +poisoned+ picks from its arguments, so every row the record wrote has
  # to be rolled back.
  #
  # @param writer [Symbol] the route's writer.
  # @yieldparam args [Array] the writer's positional arguments.
  # @yieldreturn [Boolean] whether this call is the poisoned record.
  # @return [void]
  def poison_writer(writer, &poisoned)
    allow_any_instance_of(Sinatra::Application).to receive(writer).and_wrap_original do |original, *args, **options, &block|
      result = original.call(*args, **options, &block)
      raise TypeError, "spec: poisoned record" if poisoned.call(args)

      result
    end
  end

  # Make the +nth+ INSERT INTO messages raise +error+ instead of running,
  # after running +before+ on its connection.
  #
  # @param nth [Integer] which INSERT fails.
  # @param error [Exception] what it raises.
  # @param before [String, nil] statement run on the connection first.
  # @return [void]
  def fail_message_insert(nth, error, before: nil)
    inserts = 0
    allow_any_instance_of(SQLite3::Database).to receive(:execute).and_wrap_original do |original, sql, *args, **options, &block|
      if sql.to_s.start_with?("INSERT INTO messages")
        inserts += 1
        if inserts == nth
          original.receiver.execute(before) if before
          raise error
        end
      end
      original.call(sql, *args, **options, &block)
    end
  end

  # A batch for each ingest route: two good records around a poisoned one,
  # the writer the route calls, how to tell the poisoned call, and the rows
  # each record leaves.
  #
  # @return [Array<Hash>] +:path+, +:body+, +:writer+, +:poisoned+ and +:rows+
  #   (a lambda from a record's key to its rows' count).
  def batch_routes
    node = ->(key) { db_value("SELECT COUNT(*) FROM nodes WHERE node_id = ?", [key]) }
    [
      {
        path: "/api/nodes", writer: :upsert_node, keys: %w[!5b000101 !5b000102 !5b000103],
        body: ->(keys) { keys.to_h { |key| [key, { "user" => { "longName" => "node #{key}" }, "lastHeard" => now }] } },
        poisoned: ->(args) { args[1] == "!5b000102" }, rows: node,
      },
      {
        path: "/api/messages", writer: :insert_message, keys: [0x5b000201, 0x5b000202, 0x5b000203],
        body: ->(keys) { keys.map { |id| message(id, "from_id" => format("!%08x", id)) } },
        poisoned: ->(args) { args[1]["id"] == 0x5b000202 },
        rows: ->(id) { db_value("SELECT COUNT(*) FROM messages WHERE id = ?", [id]) + node.call(format("!%08x", id)) },
      },
      {
        path: "/api/positions", writer: :insert_position, keys: [0x5b000301, 0x5b000302, 0x5b000303],
        body: ->(keys) { keys.map { |id| { "id" => id, "node_id" => format("!%08x", id), "rx_time" => now, "latitude" => 1.5, "longitude" => 2.5 } } },
        poisoned: ->(args) { args[1]["id"] == 0x5b000302 },
        rows: ->(id) { db_value("SELECT COUNT(*) FROM positions WHERE id = ?", [id]) + node.call(format("!%08x", id)) },
      },
      {
        path: "/api/telemetry", writer: :insert_telemetry, keys: [0x5b000401, 0x5b000402, 0x5b000403],
        body: ->(keys) { keys.map { |id| { "id" => id, "node_id" => format("!%08x", id), "rx_time" => now, "battery_level" => 50 } } },
        poisoned: ->(args) { args[1]["id"] == 0x5b000402 },
        rows: ->(id) { db_value("SELECT COUNT(*) FROM telemetry WHERE id = ?", [id]) + node.call(format("!%08x", id)) },
      },
      {
        path: "/api/neighbors", writer: :insert_neighbors, keys: [0x5b000501, 0x5b000502, 0x5b000503],
        body: lambda do |keys|
          keys.map { |id| { "node_id" => format("!%08x", id), "rx_time" => now, "neighbors" => [{ "neighbor_id" => format("!%08x", id + 0x10), "snr" => 4.5 }] } }
        end,
        poisoned: ->(args) { args[1]["node_id"] == "!5b000502" },
        rows: lambda do |id|
          db_value("SELECT COUNT(*) FROM neighbors WHERE node_id = ?", [format("!%08x", id)]) +
            node.call(format("!%08x", id)) + node.call(format("!%08x", id + 0x10))
        end,
      },
      {
        path: "/api/traces", writer: :insert_trace, keys: [0x5b000601, 0x5b000602, 0x5b000603],
        body: ->(keys) { keys.map { |id| { "id" => id, "rx_time" => now, "src" => id, "dest" => id + 0x10, "hops" => [id + 0x20] } } },
        poisoned: ->(args) { args[1]["id"] == 0x5b000602 },
        rows: lambda do |id|
          db_value("SELECT COUNT(*) FROM traces WHERE id = ?", [id]) + db_value("SELECT COUNT(*) FROM trace_hops WHERE trace_id = ?", [id]) +
            node.call(format("!%08x", id)) + node.call(format("!%08x", id + 0x10)) + node.call(format("!%08x", id + 0x20))
        end,
      },
      {
        path: "/api/waypoints", writer: :insert_waypoint, keys: [0x5b000701, 0x5b000702, 0x5b000703],
        body: ->(keys) { keys.map { |id| { "id" => id, "node_id" => format("!%08x", id), "rx_time" => now, "name" => "wp #{id}", "latitude" => 1.0, "longitude" => 2.0 } } },
        poisoned: ->(args) { args[1]["id"] == 0x5b000702 },
        rows: ->(id) { db_value("SELECT COUNT(*) FROM waypoints WHERE id = ?", [id]) + node.call(format("!%08x", id)) },
      },
    ]
  end

  describe "one write transaction per batch POST (BT1)" do
    it "stores a 1000-message POST in one commit" do
      ids = Array.new(1000) { |index| 0x5c000000 + index }

      commits = wal_commits { post_ok("/api/messages", ids.map { |id| message(id) }) }

      expect(commits).to eq(1)
      expect(db_value("SELECT COUNT(*) FROM messages")).to eq(1000)
    end

    it "runs every statement of each batch route between one BEGIN IMMEDIATE and its COMMIT, on the request's thread" do
      batch_routes.each do |route|
        statements = record_statements { post_ok(route[:path], route[:body].call(route[:keys])) }
        texts = statements.map(&:first)
        frame = texts.index("BEGIN IMMEDIATE TRANSACTION")

        expect(frame).not_to be_nil, "#{route[:path]} opened no BEGIN IMMEDIATE: #{texts.first(8)}"
        expect(texts.first(frame)).to all(start_with("PRAGMA")), "#{route[:path]} ran #{texts.first(frame)} before BEGIN"
        expect(texts.grep(/\A(BEGIN|COMMIT|ROLLBACK)\b/i)).to eq(["BEGIN IMMEDIATE TRANSACTION", "COMMIT TRANSACTION"]), route[:path]
        writes = statements.select { |text, _in_tx, _thread| text.match?(/\A(INSERT|UPDATE|DELETE|REPLACE)\b/i) }
        expect(writes).not_to be_empty
        expect(writes.map { |text, in_tx, _thread| [text.split.first(3).join(" "), in_tx] }.uniq.reject(&:last)).to eq([]), route[:path]
        expect(statements.map(&:last).uniq).to eq([Thread.current])
      end
    end

    it "waits at BEGIN while another connection holds the write lock, then stores the batch" do
      ids = Array.new(50) { |index| 0x5c010000 + index }
      holder = SQLite3::Database.new(PotatoMesh::Config.db_path)
      holder.execute("BEGIN IMMEDIATE")
      started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      poster = Thread.new { mock_post("/api/messages", ids.map { |id| message(id) }) }
      sleep(0.3)
      holder.execute("COMMIT")

      response = poster.value
      expect(response.status).to eq(201)
      expect(Process.clock_gettime(Process::CLOCK_MONOTONIC) - started).to be >= 0.3
      expect(stored_message_ids(ids).size).to eq(50)
    ensure
      holder&.close
    end

    it "retries BEGIN after a wait for the write lock gives up, and stores the batch" do
      allow(PotatoMesh::Config).to receive(:db_busy_timeout_ms).and_return(50)
      ids = Array.new(5) { |index| 0x5c020000 + index }
      holder = SQLite3::Database.new(PotatoMesh::Config.db_path)
      holder.execute("BEGIN IMMEDIATE")
      poster = Thread.new { mock_post("/api/messages", ids.map { |id| message(id) }) }
      sleep(0.15)
      holder.execute("COMMIT")

      expect(poster.value.status).to eq(201)
      expect(stored_message_ids(ids).size).to eq(5)
    ensure
      holder&.close
    end

    it "holds an interrupt back while a batch waits at BEGIN, and lands it once BEGIN returns, storing none of the batch" do
      ids = [0x5c080001, 0x5c080002]
      holder = SQLite3::Database.new(PotatoMesh::Config.db_path)
      holder.execute("BEGIN IMMEDIATE")
      releaser = Thread.new do
        sleep(0.5)
        holder.execute("COMMIT")
      end
      started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      outcome = Thread.new do
        Timeout.timeout(0.1) { mock_post("/api/messages", fresh_messages(ids)) }
        :completed
      rescue Timeout::Error
        :timeout
      end.value
      elapsed = Process.clock_gettime(Process::CLOCK_MONOTONIC) - started
      releaser.join

      expect(outcome).to eq(:timeout)
      expect(elapsed).to be >= 0.45
      expect(stored_message_ids(ids)).to eq([])
    ensure
      holder&.close
    end

    it "stores one row for two copies of a MeshCore message that two POSTs carry at once under different ids" do
      stub_statement_pauses
      copy = lambda do |id, text|
        { "id" => id, "rx_time" => now, "rx_iso" => Time.at(now).utc.iso8601, "from_id" => format("!%08x", id),
          "to_id" => "^all", "channel" => 3, "channel_name" => "#bt", "portnum" => "TEXT_MESSAGE_APP",
          "text" => text, "protocol" => "meshcore" }
      end
      seen = statements_of { mock_post("/api/messages", [copy.call(0x62000001, "Bob: dry run")]) }
      # The first copy stops right after its content-dedup lookup found nothing.
      target = seen.index { |sql| sql.start_with?("SELECT id FROM messages") } + 2
      pause = StatementPauses::Pause.at(target)
      first = Thread.new do
        Thread.current[:statement_pause] = pause
        mock_post("/api/messages", [copy.call(0x62000002, "Alice: one message, two copies")]).status
      end
      expect(pause.reached.pop(timeout: 5)).to start_with("SELECT from_id, to_id, text")
      second = Thread.new { mock_post("/api/messages", [copy.call(0x62000003, "Alice: one message, two copies")]).status }
      # Committing per statement, the second copy is stored now; in a batch
      # transaction it waits for the first copy's write lock.
      second.join(0.5)
      pause.release << true

      expect([first.value, second.value]).to eq([201, 201])
      expect(db_value("SELECT COUNT(*) FROM messages WHERE text = 'Alice: one message, two copies'")).to eq(1)
    end

    it "answers 201 to three concurrent 300-message POSTs and stores all 900 rows" do
      batches = Array.new(3) { |writer| Array.new(300) { |index| message(0x5c030000 + writer * 1000 + index) } }

      statuses = batches.map { |batch| Thread.new { mock_post("/api/messages", batch).status } }.map(&:value)

      expect(statuses).to eq([201, 201, 201])
      expect(db_value("SELECT COUNT(*) FROM messages")).to eq(900)
    end

    %i[kill timeout].each do |kind|
      it "leaves a 3-message POST whole and the write lock free when a #{kind} lands before any of its statements" do
        stub_statement_pauses
        total = statements_of { mock_post("/api/messages", fresh_messages([0x5c040001, 0x5c040002, 0x5c040003])) }.size
        partial = []
        locked = []

        (1..total).each do |target|
          ids = Array.new(3) { |index| 0x5c050000 + target * 16 + index }
          paused_at = interrupt_at_statement(target, kind) { mock_post("/api/messages", fresh_messages(ids)) }
          expect(paused_at).not_to be_nil, "never reached statement #{target}"
          partial << [target, paused_at] unless [0, 3].include?(stored_message_ids(ids).size)
          locked << [target, paused_at] unless write_lock_free?
        end

        expect(total).to be > 20
        expect(partial).to eq([])
        expect(locked).to eq([])
      end
    end

    it "leaves no transaction open on its connection when a kill lands before any statement of ingest_batch" do
      stub_statement_pauses
      records = ->(base) { fresh_messages([base, base + 1]) }
      write = ->(db, batch) { application.ingest_batch(db, batch, context: "spec") { |record| application.insert_message(db, record) } }
      total = with_db { |db| statements_of { write.call(db, records.call(0x5c060000)) } }.size
      open_after = []

      (1..total).each do |target|
        with_db do |db|
          interrupt_at_statement(target, :kill) { write.call(db, records.call(0x5c070000 + target * 16)) }
          open_after << target if db.transaction_active?
        end
      end

      expect(total).to be > 10
      expect(open_after).to eq([])
    end
  end

  describe "the writers' own transactions are savepoints inside a batch (BT2)" do
    # A record for each writer that opens a transaction of its own.
    #
    # @param db [SQLite3::Database] open database handle.
    # @param base [Integer] first node number to use.
    # @return [void]
    def run_writers(db, base)
      application.upsert_node(db, format("!%08x", base), { "user" => { "longName" => "inner #{base}" }, "lastHeard" => now })
      application.insert_neighbors(db, { "node_id" => format("!%08x", base + 1), "rx_time" => now, "neighbors" => [{ "neighbor_id" => format("!%08x", base + 2) }] })
      placeholder = format("!%08x", base + 3)
      application.ensure_unknown_node(db, placeholder, heard_time: now, protocol: "meshcore")
      application.ensure_meshcore_chat_node(db, placeholder, "Chat #{base}", now)
    end

    it "joins the caller's transaction, whose rollback undoes every write" do
      with_db do |db|
        db.execute("BEGIN IMMEDIATE")
        run_writers(db, 0x5d000000)

        expect(db.transaction_active?).to be(true)
        expect(db.get_first_value("SELECT long_name FROM nodes WHERE node_id = '!5d000003'")).to eq("Chat #{0x5d000000}")
        db.execute("ROLLBACK")
      end

      expect(db_value("SELECT COUNT(*) FROM nodes")).to eq(0)
      expect(db_value("SELECT COUNT(*) FROM neighbors")).to eq(0)
    end

    it "runs each writer alone in BEGIN IMMEDIATE TRANSACTION and COMMIT TRANSACTION, never the gem's transaction block" do
      statements = record_statements { with_db { |db| run_writers(db, 0x5d000010) } }.map(&:first)

      expect(statements.grep(/\A(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i)).to eq(
        ["BEGIN IMMEDIATE TRANSACTION", "COMMIT TRANSACTION"] * 3,
      )
      expect(db_value("SELECT long_name FROM nodes WHERE node_id = '!5d000013'")).to eq("Chat #{0x5d000010}")
    end

    {
      "upsert_node" => {
        after: "INSERT INTO nodes(node_id,num",
        write: ->(spec, db, base) { spec.application.upsert_node(db, format("!%08x", base), { "user" => { "longName" => "killed", "publicKey" => "ab" * 32 }, "lastHeard" => spec.now }) },
        rows: ->(spec, base) { spec.db_value("SELECT COUNT(*) FROM nodes WHERE node_id = ?", [format("!%08x", base)]) },
      },
      "insert_neighbors" => {
        after: "INSERT INTO neighbors",
        write: lambda do |spec, db, base|
          spec.application.insert_neighbors(db, { "node_id" => format("!%08x", base), "rx_time" => spec.now,
                                                  "neighbors" => [{ "neighbor_id" => format("!%08x", base + 1) }, { "neighbor_id" => format("!%08x", base + 2) }] })
        end,
        rows: ->(spec, base) { spec.db_value("SELECT COUNT(*) FROM nodes WHERE node_id IN (?, ?, ?)", Array.new(3) { |index| format("!%08x", base + index) }) },
      },
      "ensure_meshcore_chat_node" => {
        after: "UPDATE nodes SET long_name = ?, synthetic = 1",
        prepare: ->(spec, db, base) { spec.application.ensure_unknown_node(db, format("!%08x", base), heard_time: spec.now, protocol: "meshcore") },
        write: ->(spec, db, base) { spec.application.ensure_meshcore_chat_node(db, format("!%08x", base), "Renamed #{base}", spec.now) },
        rows: ->(spec, base) { spec.db_value("SELECT COUNT(*) FROM nodes WHERE node_id = ? AND synthetic = 1", [format("!%08x", base)]) },
      },
    }.each do |writer, run|
      it "writes nothing of #{writer} when its thread is killed after its first write, or a throw leaves it" do
        stub_statement_pauses
        dry = 0x5d100000 + writer.length * 0x100
        with_db { |db| run[:prepare]&.call(self, db, dry) }
        seen = with_db { |db| statements_of { run[:write].call(self, db, dry) } }
        target = seen.index { |sql| sql.start_with?(run[:after]) } + 2

        killed = dry + 0x10
        with_db do |db|
          run[:prepare]&.call(self, db, killed)
          interrupt_at_statement(target, :kill) { run[:write].call(self, db, killed) }
          expect(db.transaction_active?).to be(false)
        end
        expect(run[:rows].call(self, killed)).to eq(0)

        thrown = dry + 0x20
        with_db do |db|
          run[:prepare]&.call(self, db, thrown)
          count = 0
          allow_any_instance_of(SQLite3::Database).to receive(:prepare).and_wrap_original do |original, sql, *args, **options, &block|
            count += 1
            throw :spec_leave if count == target
            original.call(sql, *args, **options, &block)
          end
          catch(:spec_leave) { run[:write].call(self, db, thrown) }
          allow_any_instance_of(SQLite3::Database).to receive(:prepare).and_call_original
          expect(db.transaction_active?).to be(false)
        end
        expect(run[:rows].call(self, thrown)).to eq(0)
      end
    end
  end

  describe "a record that raises is skipped through its savepoint (BT3)" do
    it "stores the good messages of [good, poison, good] and answers 201 when the poison's text is an object" do
      ids = [0x5e000001, 0x5e000002, 0x5e000003]

      post_ok("/api/messages", [message(ids[0]), message(ids[1], "text" => { "poison" => true }), message(ids[2])])

      expect(JSON.parse(last_response.body)).to eq("status" => "ok")
      expect(stored_message_ids(ids)).to eq([ids[0], ids[2]])
    end

    it "stores the good nodes of {good, poison, good} and answers 201 when the poison's long name is an object" do
      post_ok("/api/nodes", {
        "!5e000011" => { "user" => { "longName" => "good one" }, "lastHeard" => now },
        "!5e000012" => { "user" => { "longName" => { "poison" => true } }, "lastHeard" => now },
        "!5e000013" => { "user" => { "longName" => "good three" }, "lastHeard" => now },
      })

      expect(db_rows("SELECT node_id FROM nodes ORDER BY node_id").map { |row| row["node_id"] }).to eq(%w[!5e000011 !5e000013])
    end

    it "rolls back every row of a record whose writer raised after writing, on each batch route, and stores the rest" do
      batch_routes.each do |route|
        poison_writer(route[:writer], &route[:poisoned])
        post_ok(route[:path], route[:body].call(route[:keys]))
        allow_any_instance_of(Sinatra::Application).to receive(route[:writer]).and_call_original

        expect(route[:keys].map { |key| route[:rows].call(key).positive? }).to eq([true, false, true]), route[:path]
      end
    end

    it "logs one warn line naming the batch's skipped records, and one debug line for each" do
      logs = capture_logs
      ids = Array.new(4) { |index| 0x5e000101 + index }

      post_ok("/api/messages", [message(ids[0]), message(ids[1], "text" => [1, 2]), message(ids[2], "portnum" => { "x" => 1 }), message(ids[3])])

      expect(stored_message_ids(ids)).to eq([ids[0], ids[3]])
      expect(logs.select { |level, _text, _meta| level == :warn_log }).to eq([[
        :warn_log, "Skipped ingest records that failed to store",
        { context: "ingest.messages", records: 4, skipped: 2, index: 1,
          error_class: "SQLite3::RangeException", error_message: "column index out of range" },
      ]])
      skipped = logs.select { |_level, text, _meta| text == "Skipped an ingest record that failed to store" }
      expect(skipped.map { |level, _text, meta| [level, meta[:context], meta[:index], meta[:error_class]] }).to eq(
        [[:debug_log, "ingest.messages", 1, "SQLite3::RangeException"], [:debug_log, "ingest.messages", 2, "SQLite3::Exception"]],
      )
      expect(skipped.map { |_level, _text, meta| meta[:location] }).to all(match(/\.rb:\d+/))
    end

    it "stores none of a batch whose second record hits a database error, and raises that error" do
      ids = [0x5e000201, 0x5e000202, 0x5e000203]
      fail_message_insert(2, SQLite3::IOException.new("spec: disk I/O error"))

      expect { post "/api/messages", ids.map { |id| message(id) }.to_json, auth_headers }.to raise_error(SQLite3::IOException, "spec: disk I/O error")
      allow_any_instance_of(SQLite3::Database).to receive(:execute).and_call_original

      expect(stored_message_ids(ids)).to eq([])
      expect(write_lock_free?).to be(true)
    end

    it "raises a record's error, storing none of the batch, when SQLite ended the transaction with it" do
      ids = [0x5e000301, 0x5e000302, 0x5e000303]
      fail_message_insert(2, SQLite3::MismatchException.new("spec: datatype mismatch after rollback"), before: "ROLLBACK")

      expect { post "/api/messages", ids.map { |id| message(id) }.to_json, auth_headers }.to raise_error(SQLite3::MismatchException, "spec: datatype mismatch after rollback")
      allow_any_instance_of(SQLite3::Database).to receive(:execute).and_call_original

      expect(stored_message_ids(ids)).to eq([])
    end

    it "fails the whole batch, storing none of it, when another thread raises a StandardError into a record" do
      stub_statement_pauses
      seen = statements_of { mock_post("/api/messages", fresh_messages([0x5e000401, 0x5e000402, 0x5e000403])) }
      target = seen.each_index.select { |index| seen[index].start_with?("INSERT INTO messages") }[1] + 1
      ids = [0x5e000501, 0x5e000502, 0x5e000503]
      pause = StatementPauses::Pause.at(target)
      outcome = nil
      worker = Thread.new do
        Thread.current[:statement_pause] = pause
        Thread.current.report_on_exception = false
        mock_post("/api/messages", fresh_messages(ids))
        outcome = :completed
      rescue RuntimeError => e
        outcome = e.message
      end

      expect(pause.reached.pop(timeout: 5)).to start_with("INSERT INTO messages")
      worker.raise(RuntimeError, "spec: forced shutdown")
      pause.release << true
      worker.join(5)

      expect(outcome).to eq("spec: forced shutdown")
      expect(stored_message_ids(ids)).to eq([])
      expect(write_lock_free?).to be(true)
    end
  end

  describe "payloads are decoded before the write lock is taken (BT4)" do
    let(:sender) { "!7c5b0920" }

    before do
      allow_any_instance_of(Sinatra::Application).to receive(:decrypt_meshtastic_message).and_return(
        { portnum: 3, payload: "position".b, text: nil, channel_name: nil },
      )
      allow(application).to receive(:decrypt_meshtastic_message).and_return(
        { portnum: 3, payload: "position".b, text: nil, channel_name: nil },
      )
    end

    # An encrypted message, decrypting to a POSITION_APP payload.
    #
    # @param id [Integer] message id.
    # @return [Hash] the message record.
    def encrypted_message(id)
      message(id, "from_id" => sender, "text" => nil, "portnum" => nil, "encrypted" => Base64.strict_encode64("cipher #{id}"))
    end

    it "decodes each encrypted message once, with the write lock free, and stores the decoded position" do
      lock_free = []
      allow(PotatoMesh::App::Meshtastic::PayloadDecoder).to receive(:decode) do |**_request|
        lock_free << write_lock_free?
        JSON.parse(StubInterpreter::POSITION_REPLY)
      end
      ids = [0x5f000001, 0x5f000002]

      post_ok("/api/messages", ids.map { |id| encrypted_message(id) })

      expect(lock_free).to eq([true, true])
      expect(db_rows("SELECT id, encrypted FROM messages ORDER BY id")).to eq(ids.map { |id| { "id" => id, "encrypted" => nil } })
      expect(db_value("SELECT COUNT(*) FROM positions")).to eq(2)
    end

    it "starts no decode for a message whose decrypt raises, and skips that message in the batch" do
      allow(PotatoMesh::App::Meshtastic::PayloadDecoder).to receive(:decode).and_return(JSON.parse(StubInterpreter::POSITION_REPLY))
      allow_any_instance_of(Sinatra::Application).to receive(:decrypt_meshtastic_message).and_wrap_original do |_original, message, *_args, **_options|
        raise TypeError, "spec: decrypt failed" if message["id"] == 0x5f000012

        { portnum: 3, payload: "position".b, text: nil, channel_name: nil }
      end
      ids = [0x5f000011, 0x5f000012, 0x5f000013]

      post_ok("/api/messages", ids.map { |id| encrypted_message(id) })

      expect(PotatoMesh::App::Meshtastic::PayloadDecoder).to have_received(:decode).twice
      expect(stored_message_ids(ids)).to eq([ids[0], ids[2]])
    end

    it "does not decode, inside a transaction, a payload the batch did not decode before it" do
      logs = capture_logs
      expect(PotatoMesh::App::Meshtastic::PayloadDecoder).not_to receive(:decode)

      with_db do |db|
        db.execute("BEGIN IMMEDIATE")
        application.insert_message(db, encrypted_message(0x5f000021))
        db.execute("COMMIT")
      end

      expect(db_value("SELECT encrypted FROM messages WHERE id = ?", [0x5f000021])).not_to be_nil
      expect(logs).to include([:debug_log, "Left a Meshtastic payload undecoded under the write lock",
                               { context: "data_processing.store_decrypted_payload", message_id: 0x5f000021, portnum: 3 }])
    end

    it "starts no decode for a message that asks for none: no id, an id in no legitimate form, text, or no payload bytes" do
      allow(PotatoMesh::App::Meshtastic::PayloadDecoder).to receive(:decode).and_return(JSON.parse(StubInterpreter::POSITION_REPLY))
      allow_any_instance_of(Sinatra::Application).to receive(:decrypt_meshtastic_message).and_wrap_original do |_original, message, *_args, **_options|
        { portnum: 3, payload: message["id"] == 0x5f000044 ? nil : "position".b, text: nil, channel_name: nil }
      end
      records = [
        encrypted_message(0x5f000041).except("id"),
        encrypted_message(0x5f000042).merge("from_id" => "attacker"),
        encrypted_message(0x5f000043).merge("text" => "plain text"),
        encrypted_message(0x5f000044),
      ]

      post_ok("/api/messages", records)

      expect(PotatoMesh::App::Meshtastic::PayloadDecoder).not_to have_received(:decode)
      expect(stored_message_ids([0x5f000041, 0x5f000042, 0x5f000043, 0x5f000044])).to eq([0x5f000043, 0x5f000044])
      expect(db_value("SELECT encrypted FROM messages WHERE id = ?", [0x5f000044])).not_to be_nil
    end

    it "uses no decode of another payload, and decodes a payload alone outside a transaction" do
      decoded = JSON.parse(StubInterpreter::POSITION_REPLY)
      allow(PotatoMesh::App::Meshtastic::PayloadDecoder).to receive(:decode).and_return(decoded)
      other = PotatoMesh::App::DataProcessing::PredecodedPayload.new([3, Base64.strict_encode64("other")], decoded)

      with_db do |db|
        db.execute("BEGIN IMMEDIATE")
        application.insert_message(db, encrypted_message(0x5f000031), predecoded: other)
        db.execute("COMMIT")
        application.insert_message(db, encrypted_message(0x5f000032))
      end

      expect(PotatoMesh::App::Meshtastic::PayloadDecoder).to have_received(:decode).once
      expect(db_rows("SELECT id, encrypted IS NULL AS cleared FROM messages ORDER BY id")).to eq(
        [{ "id" => 0x5f000031, "cleared" => 0 }, { "id" => 0x5f000032, "cleared" => 1 }],
      )
    end
  end

  describe "the cache and the live updates follow the commit (BT5)" do
    it "invalidates the cache and publishes once the batch is committed" do
      ids = [0x60000001, 0x60000002, 0x60000003]
      seen = []
      allow(PotatoMesh::App::ApiCache).to receive(:invalidate_prefix).and_wrap_original do |original, *prefixes, **options|
        seen << [:invalidate, stored_message_ids(ids).size]
        original.call(*prefixes, **options)
      end
      allow(PotatoMesh::App::PubSub).to receive(:publish).and_wrap_original do |original, collection, **options|
        seen << [collection, stored_message_ids(ids).size]
        original.call(collection, **options)
      end

      post_ok("/api/messages", ids.map { |id| message(id) })

      expect(seen).to eq([[:invalidate, 3], ["messages", 3], ["nodes", 3]])
    end

    %i[kill timeout].each do |kind|
      it "invalidates and publishes a batch that committed while a #{kind} held back at COMMIT waited to land" do
        stub_statement_pauses
        seen = statements_of { mock_post("/api/messages", fresh_messages([0x60000101, 0x60000102])) }
        target = seen.index("COMMIT TRANSACTION") + 1
        invalidated = []
        published = []
        allow(PotatoMesh::App::ApiCache).to receive(:invalidate_prefix).and_wrap_original do |original, *prefixes, **options|
          invalidated << prefixes
          original.call(*prefixes, **options)
        end
        allow(PotatoMesh::App::PubSub).to receive(:publish).and_wrap_original do |original, collection, **options|
          published << collection
          original.call(collection, **options)
        end
        ids = [0x60000111, 0x60000112]

        paused_at = interrupt_at_statement(target, kind) { mock_post("/api/messages", fresh_messages(ids)) }

        expect(paused_at).to eq("COMMIT TRANSACTION")
        expect(stored_message_ids(ids)).to eq(ids)
        expect(invalidated).to eq([["api:messages:", "api:nodes:", "api:stats:"]])
        expect(published).to eq(%w[messages nodes])
      end
    end

    it "raises an error the route's committed work raises, after the commit, and writes the batch once" do
      ids = [0x60000121, 0x60000122]
      calls = 0
      allow(PotatoMesh::App::ApiCache).to receive(:invalidate_prefix).and_wrap_original do |original, *prefixes, **options|
        calls += 1
        raise SQLite3::BusyException, "spec: busy after the commit" if calls == 1

        original.call(*prefixes, **options)
      end
      commits = 0
      allow_any_instance_of(SQLite3::Database).to receive(:execute).and_wrap_original do |original, sql, *args, **options, &block|
        commits += 1 if sql.to_s == "COMMIT TRANSACTION"
        original.call(sql, *args, **options, &block)
      end

      expect { post "/api/messages", fresh_messages(ids).to_json, auth_headers }.to raise_error(SQLite3::BusyException, "spec: busy after the commit")

      expect(commits).to eq(1)
      expect(stored_message_ids(ids)).to eq(ids)
    end

    it "neither invalidates the cache nor publishes for a batch that rolled back" do
      fail_message_insert(2, SQLite3::FullException.new("spec: database or disk is full"))
      expect(PotatoMesh::App::ApiCache).not_to receive(:invalidate_prefix)
      expect(PotatoMesh::App::PubSub).not_to receive(:publish)

      expect { post "/api/messages", [message(0x60000011), message(0x60000012)].to_json, auth_headers }.to raise_error(SQLite3::FullException)
    end
  end

  describe "a neighbour snapshot mints its placeholders inside its transaction (BT6)" do
    it "stores the snapshot when another connection deletes its new placeholder between the check and the snapshot" do
      attempts = []
      allow_any_instance_of(Sinatra::Application).to receive(:ensure_unknown_node).and_wrap_original do |original, db, ref, *args, **options|
        result = original.call(db, ref, *args, **options)
        if ref == "!61000002" && attempts.empty?
          other = SQLite3::Database.new(PotatoMesh::Config.db_path)
          other.busy_timeout = 50
          begin
            other.execute("DELETE FROM nodes WHERE node_id = ?", [ref])
            attempts << :deleted
          rescue SQLite3::BusyException
            attempts << :waited
          ensure
            other.close
          end
        end
        result
      end

      post_ok("/api/neighbors", { "node_id" => "!61000001", "rx_time" => now, "neighbors" => [{ "neighbor_id" => "!61000002", "snr" => 4.5 }] })

      expect(attempts).to eq([:waited])
      expect(db_rows("SELECT node_id, neighbor_id FROM neighbors")).to eq([{ "node_id" => "!61000001", "neighbor_id" => "!61000002" }])
    end

    it "keeps the snapshot's own rules inside the transaction: a neighbour by number, a future time, a section that is no list" do
      with_db do |db|
        db.execute("INSERT INTO nodes(node_id, num, last_heard, first_heard) VALUES ('legacy-61', 6_100_042, ?, ?)", [now, now])
      end

      post_ok("/api/neighbors", {
        "node_id" => "!61000011", "rx_time" => now,
        "neighbors" => [{ "neighbor_id" => " ", "neighbor_num" => 6_100_042 }, { "neighbor_id" => "!61000012", "rx_time" => now + 3600 }],
      })
      expect(db_rows("SELECT neighbor_id, rx_time FROM neighbors WHERE node_id = '!61000011' ORDER BY neighbor_id")).to eq(
        [{ "neighbor_id" => "!61000012", "rx_time" => now }, { "neighbor_id" => "legacy-61", "rx_time" => now }],
      )

      post_ok("/api/neighbors", { "node_id" => "!61000011", "rx_time" => now, "neighbors" => { "neighbor_id" => "!61000012" } })
      expect(db_value("SELECT COUNT(*) FROM neighbors WHERE node_id = '!61000011'")).to eq(0)
    end
  end
end
