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
require "tmpdir"
require_relative "../support/stub_interpreter"

# Bounds on the Meshtastic payload decoder (SPEC DB1-DB4, ACCEPTANCE DB-A1 to
# DB-A3): a 4 s deadline per decode that kills the decoder's process group,
# at most four decodes per ingest request, and at most two decoders in the
# process, each decode waiting at most 1 s for one.  A message past a bound
# is stored as a decode failure: still encrypted, without text.  The literal
# figures are SPEC DB1-DB3's; one example pins the constants to them.
RSpec.describe PotatoMesh::App::Meshtastic::PayloadDecoder do
  around do |example|
    Dir.mktmpdir("decoder-bounds-") do |dir|
      @dir = dir
      example.run
    end
  end

  # Point the decoder at a stub interpreter running +body+.
  #
  # @param body [String] shell commands of the stub.
  # @return [String] path of the stub.
  def use_interpreter(body)
    path = StubInterpreter.write(@dir, body)
    allow(described_class).to receive(:python_executable_path).and_return(path)
    path
  end

  # Point the decoder at a stub that marks itself running for 0.3 s (one
  # +run.<pid>+ file while it runs, one line in +runs.log+ per start) and
  # then replies with a decoded position.
  #
  # @param seconds [Numeric] how long the stub runs.
  # @return [String] path of the stub.
  def use_marking_interpreter(seconds = 0.3)
    use_interpreter(<<~SH)
      cat > /dev/null
      echo run >> "#{@dir}/runs.log"
      touch "#{@dir}/run.$$"
      sleep #{seconds}
      rm -f "#{@dir}/run.$$"
      printf '%s' '#{StubInterpreter::POSITION_REPLY}'
    SH
  end

  # @return [Integer] stub starts recorded in +runs.log+.
  def runs
    path = File.join(@dir, "runs.log")
    File.exist?(path) ? File.readlines(path).size : 0
  end

  # @return [Integer] stubs running now.
  def running
    Dir.glob(File.join(@dir, "run.*")).size
  end

  # Wait until +count+ stubs run at once.
  #
  # @param count [Integer] stubs expected to run.
  # @return [void]
  def wait_until_running(count)
    give_up = StubInterpreter.monotonic_now + 2
    sleep(0.005) until running >= count || StubInterpreter.monotonic_now > give_up
  end

  # Expect one debug line for a skipped decode.
  #
  # @param reason [String] the bound that skipped it.
  # @param message_id [Integer, nil] message the decode was for.
  # @return [void]
  def expect_skip_log(reason, message_id: nil)
    allow(PotatoMesh::Logging).to receive(:log).and_call_original
    expect(PotatoMesh::Logging).to receive(:log).with(
      anything,
      :debug,
      "Skipped Meshtastic payload decode",
      context: "meshtastic.payload_decoder",
      reason: reason,
      message_id: message_id,
      portnum: 3,
    ).and_call_original
  end

  describe "deadline (SPEC DB1)" do
    it "returns within the 4 s deadline from a decoder that sleeps 5 s, which is gone" do
      use_interpreter(%(echo $$ > "#{@dir}/child.pid"\nexec sleep 5))

      started = StubInterpreter.monotonic_now
      result = described_class.decode(portnum: 3, payload_b64: "AA==")
      elapsed = StubInterpreter.monotonic_now - started

      expect(result).to be_nil
      expect(elapsed).to be_between(3.9, 4.5)
      pid = StubInterpreter.read_pid(File.join(@dir, "child.pid"))
      expect { Process.kill(0, pid) }.to raise_error(Errno::ESRCH)
    end

    it "kills the decoder's whole process group, so no process it started runs on" do
      stub_const("#{described_class}::DECODE_DEADLINE_SECONDS", 0.3)
      beat = File.join(@dir, "beat")
      use_interpreter(<<~SH)
        echo $$ > "#{@dir}/child.pid"
        ( i=0; while [ $i -lt 200 ]; do i=$((i+1)); echo $i > "#{beat}"; sleep 0.05; done ) > /dev/null 2>&1 &
        echo $! > "#{@dir}/grandchild.pid"
        exec sleep 5
      SH

      begin
        expect(described_class.decode(portnum: 3, payload_b64: "AA==")).to be_nil
        child = StubInterpreter.read_pid(File.join(@dir, "child.pid"))
        expect(StubInterpreter.exists?(child)).to be(false)
        last_beat = File.read(beat)
        sleep 0.3
        expect(File.read(beat)).to eq(last_beat)
      ensure
        grandchild = StubInterpreter.read_pid(File.join(@dir, "grandchild.pid"))
        begin
          Process.kill(:KILL, grandchild)
        rescue Errno::ESRCH
          # Gone, as it should be.
        end
      end
    end

    it "logs a decode cut by the deadline" do
      stub_const("#{described_class}::DECODE_DEADLINE_SECONDS", 0.2)
      use_interpreter("exec sleep 5")
      expect_skip_log("deadline", message_id: 42)

      expect(described_class.decode(portnum: 3, payload_b64: "AA==", message_id: 42)).to be_nil
    end

    it "frees the slot of a decode cut by the deadline" do
      stub_const("#{described_class}::DECODE_DEADLINE_SECONDS", 0.2)
      use_interpreter("exec sleep 5")

      described_class.decode(portnum: 3, payload_b64: "AA==")

      expect(described_class::DECODE_SLOTS.size).to eq(2)
    end
  end

  describe "per-request cap (SPEC DB2)" do
    let(:app) { Sinatra::Application }
    let(:api_token) { "spec-token" }
    let(:auth_headers) do
      {
        "CONTENT_TYPE" => "application/json",
        "HTTP_AUTHORIZATION" => "Bearer #{api_token}",
      }
    end

    # Run the block with an open database handle.
    #
    # @yieldparam db [SQLite3::Database] open database handle.
    # @return [Object] the block's value.
    def with_db
      db = SQLite3::Database.new(PotatoMesh::Config.db_path)
      db.busy_timeout = PotatoMesh::Config.db_busy_timeout_ms
      yield db
    ensure
      db&.close
    end

    before do
      @original_token = ENV["API_TOKEN"]
      ENV["API_TOKEN"] = api_token
      with_db { |db| %w[positions messages nodes].each { |table| db.execute("DELETE FROM #{table}") } }
      PotatoMesh::App::ApiCache.invalidate_all
      # Every message decrypts to a POSITION_APP payload, as an encrypted
      # position on a default-key channel does.
      allow_any_instance_of(Sinatra::Application).to receive(:decrypt_meshtastic_message).and_return(
        { portnum: 3, payload: "position".b, text: nil, channel_name: nil },
      )
    end

    after do
      @original_token.nil? ? ENV.delete("API_TOKEN") : ENV["API_TOKEN"] = @original_token
      PotatoMesh::App::ApiCache.invalidate_all
    end

    it "decodes at most four messages of a 60-record batch and stores the rest still encrypted" do
      use_interpreter(%(echo run >> "#{@dir}/runs.log"\ncat > /dev/null\nprintf '%s' '#{StubInterpreter::POSITION_REPLY}'))
      now = Time.now.to_i
      batch = Array.new(60) do |index|
        {
          "id" => 970_001 + index,
          "rx_time" => now,
          "rx_iso" => Time.at(now).utc.iso8601,
          "from_id" => "!7c5b0920",
          "to_id" => "^all",
          "channel" => 0,
          "encrypted" => Base64.strict_encode64("cipher-#{index}"),
        }
      end

      post "/api/messages", batch.to_json, auth_headers

      expect(last_response.status).to eq(201)
      expect(runs).to eq(4)
      with_db do |db|
        expect(db.get_first_value("SELECT COUNT(*) FROM messages")).to eq(60)
        expect(db.get_first_value("SELECT COUNT(*) FROM messages WHERE encrypted IS NULL")).to eq(4)
        expect(db.get_first_value("SELECT COUNT(*) FROM messages WHERE encrypted IS NOT NULL AND text IS NULL")).to eq(56)
        expect(db.get_first_value("SELECT COUNT(*) FROM positions")).to eq(4)
      end
    end

    it "starts one cap per request" do
      use_interpreter(%(echo run >> "#{@dir}/runs.log"\ncat > /dev/null\nprintf '%s' '#{StubInterpreter::POSITION_REPLY}'))
      now = Time.now.to_i
      2.times do |request|
        batch = Array.new(6) do |index|
          {
            "id" => 971_001 + request * 10 + index,
            "rx_time" => now,
            "rx_iso" => Time.at(now).utc.iso8601,
            "from_id" => "!7c5b0920",
            "encrypted" => Base64.strict_encode64("cipher-#{index}"),
          }
        end
        post "/api/messages", batch.to_json, auth_headers
        expect(last_response.status).to eq(201)
      end

      expect(runs).to eq(8)
    end
  end

  describe "concurrency limit (SPEC DB3)" do
    it "never runs more than two decoders at once" do
      use_marking_interpreter
      peak = 0
      sampling = true
      sampler = Thread.new do
        while sampling
          now_running = running
          peak = now_running if now_running > peak
          sleep 0.002
        end
      end

      callers = Array.new(8) { Thread.new { described_class.decode(portnum: 3, payload_b64: "AA==") } }
      results = callers.map(&:value)
      sampling = false
      sampler.join

      expect(peak).to eq(2)
      expect(results.compact).to all(eq(JSON.parse(StubInterpreter::POSITION_REPLY)))
      expect(described_class::DECODE_SLOTS.size).to eq(2)
    end

    it "skips a decode that finds no slot within the wait, and logs it" do
      stub_const("#{described_class}::SLOT_WAIT_SECONDS", 0.1)
      use_marking_interpreter(1)
      holders = Array.new(2) { Thread.new { described_class.decode(portnum: 3, payload_b64: "AA==") } }
      wait_until_running(2)
      budget = described_class::Budget.new
      expect_skip_log("concurrency", message_id: 7)

      started = StubInterpreter.monotonic_now
      result = described_class.decode(portnum: 3, payload_b64: "AA==", budget: budget, message_id: 7)
      waited = StubInterpreter.monotonic_now - started

      expect(result).to be_nil
      expect(waited).to be_between(0.09, 0.6)
      expect(runs).to eq(2)
      # The skipped attempt counts against the request's cap (SPEC DB2).
      3.times { expect(budget.take).to be(true) }
      expect(budget.take).to be(false)
    ensure
      holders&.each(&:join)
    end

    it "keeps its slot when an exception from another thread lands right after the slot is taken" do
      use_marking_interpreter(5)
      spawned = []
      allow(Process).to receive(:spawn).and_wrap_original do |spawn, *args, **kwargs|
        spawn.call(*args, **kwargs).tap { |pid| spawned << pid }
      end
      # Thread#raise aimed at the current thread, as Puma's forced shutdown
      # aims one at a request thread, here the moment the token is out.
      allow(described_class::DECODE_SLOTS).to receive(:pop).and_wrap_original do |pop, *args, **kwargs|
        pop.call(*args, **kwargs).tap { Thread.current.raise(RuntimeError, "forced shutdown") }
      end

      expect { described_class.decode(portnum: 3, payload_b64: "AA==") }.to raise_error(RuntimeError, "forced shutdown")
      expect(described_class::DECODE_SLOTS.size).to eq(2)
      spawned.each { |pid| expect(StubInterpreter.exists?(pid)).to be(false) }
    ensure
      # The semaphore outlives the example: a lost slot must not starve the next.
      (2 - described_class::DECODE_SLOTS.size).times { described_class::DECODE_SLOTS.push(true) }
    end
  end

  describe "the per-request budget (SPEC DB2)" do
    it "allows four decodes by default" do
      budget = described_class::Budget.new

      expect(Array.new(5) { budget.take }).to eq([true, true, true, true, false])
    end

    it "takes the limit it is given" do
      budget = described_class::Budget.new(1)

      expect([budget.take, budget.take]).to eq([true, false])
    end

    it "skips a decode past the cap without starting the decoder, and logs it" do
      use_marking_interpreter(0)
      budget = described_class::Budget.new(1)

      expect(described_class.decode(portnum: 3, payload_b64: "AA==", budget: budget)).to eq(JSON.parse(StubInterpreter::POSITION_REPLY))
      expect_skip_log("cap", message_id: 9)
      expect(described_class.decode(portnum: 3, payload_b64: "AA==", budget: budget, message_id: 9)).to be_nil
      expect(runs).to eq(1)
    end

    it "takes nothing from the budget when nothing would start" do
      budget = described_class::Budget.new(1)
      allow(described_class).to receive(:python_executable_path).and_return(nil)

      expect(described_class.decode(portnum: 3, payload_b64: "AA==", budget: budget)).to be_nil
      expect(budget.take).to be(true)
    end
  end

  it "pins the bounds to SPEC DB1-DB3" do
    expect(described_class::DECODE_DEADLINE_SECONDS).to eq(4)
    expect(described_class::MAX_DECODES_PER_REQUEST).to eq(4)
    expect(described_class::MAX_CONCURRENT_DECODES).to eq(2)
    expect(described_class::SLOT_WAIT_SECONDS).to eq(1)
  end
end
