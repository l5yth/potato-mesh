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
require "tmpdir"
require_relative "../support/stub_interpreter"

# One decoder child under a hard deadline (SPEC DB1): the request goes to its
# stdin, its stdout comes back with its exit status, and past the deadline its
# process group is killed and the child reaped before the call returns.
RSpec.describe PotatoMesh::App::Meshtastic::DecoderProcess do
  around do |example|
    Dir.mktmpdir("decoder-process-") do |dir|
      @dir = dir
      example.run
    end
  end

  # Run a stub interpreter with +body+ through +DecoderProcess.run+.
  #
  # @param body [String] shell commands of the stub.
  # @param input [String] bytes for the stub's stdin.
  # @param deadline [Numeric] seconds the run may take.
  # @return [Array(String, Process::Status), nil] the result of +run+.
  def run_stub(body, input: "{}", deadline: 2)
    described_class.run(
      [StubInterpreter.write(@dir, body), "/tmp/decoder.py"],
      input: input,
      deadline_seconds: deadline,
    )
  end

  # @return [Integer] the pid the stub wrote to +child.pid+.
  def child_pid
    StubInterpreter.read_pid(File.join(@dir, "child.pid"))
  end

  it "returns the child's stdout as UTF-8 and its exit status" do
    output, status = run_stub("cat > /dev/null\nprintf '%s' 'reply'")

    expect(output).to eq("reply")
    expect(output.encoding).to eq(Encoding::UTF_8)
    expect(status).to be_success
  end

  it "hands the input to the child's stdin and then closes it" do
    output, status = run_stub("cat", input: "request")

    expect(output).to eq("request")
    expect(status).to be_success
  end

  it "writes an input larger than the pipe in parts to a child that reads it late" do
    input = "x" * (1024 * 1024)

    output, status = run_stub("sleep 0.1\nwc -c | tr -d ' '", input: input)

    expect(output.strip).to eq(input.bytesize.to_s)
    expect(status).to be_success
  end

  it "reports a failing child's exit status with its output" do
    output, status = run_stub("cat > /dev/null\nprintf '%s' 'partial'\nexit 3")

    expect(output).to eq("partial")
    expect(status.exitstatus).to eq(3)
  end

  it "stops writing to a child that closes its stdin unread, and reaps it" do
    # The child keeps its stdout open past the close, so a write meets the
    # broken pipe before the reply ends; the pipe never holds 1 MiB.
    output, status = run_stub("exec 0<&-\nsleep 0.2\nexit 0", input: "x" * (1024 * 1024))

    expect(output).to eq("")
    expect(status).to be_success
  end

  it "discards the child's stderr" do
    output, = run_stub("cat > /dev/null\necho noise >&2\nprintf '%s' 'reply'")

    expect(output).to eq("reply")
  end

  it "waits for a child that closed its stdout to exit" do
    output, status = run_stub("exec >&-\nsleep 0.1\nexit 4")

    expect(output).to eq("")
    expect(status.exitstatus).to eq(4)
  end

  it "returns nil past the deadline and leaves no child behind" do
    started = StubInterpreter.monotonic_now
    result = run_stub(%(echo $$ > "#{@dir}/child.pid"\nexec sleep 5), deadline: 0.3)

    expect(result).to be_nil
    expect(StubInterpreter.monotonic_now - started).to be < 1.5
    expect(StubInterpreter.exists?(child_pid)).to be(false)
  end

  it "kills a child that closed its stdout but runs past the deadline" do
    result = run_stub(%(echo $$ > "#{@dir}/child.pid"\nexec sleep 5 >&-), deadline: 0.3)

    expect(result).to be_nil
    expect(StubInterpreter.exists?(child_pid)).to be(false)
  end

  it "kills and reaps a child when an exception from another thread lands as it starts" do
    spawned = nil
    # Thread#raise aimed at the current thread, as Puma's forced shutdown
    # aims one at a request thread, here the moment the child exists.
    allow(Process).to receive(:spawn).and_wrap_original do |spawn, *args, **kwargs|
      spawned = spawn.call(*args, **kwargs)
      Thread.current.raise(RuntimeError, "forced shutdown")
      spawned
    end

    begin
      expect { run_stub("exec sleep 5") }.to raise_error(RuntimeError, "forced shutdown")
      expect(StubInterpreter.exists?(spawned)).to be(false)
    ensure
      begin
        Process.kill(:KILL, spawned) if spawned
        Process.wait(spawned) if spawned
      rescue Errno::ESRCH, Errno::ECHILD
        # Killed and reaped by the run, as it should be.
      end
    end
  end

  it "raises when the child cannot start, with every pipe closed" do
    open_fds = Dir.children("/dev/fd").size

    expect do
      described_class.run(["/missing/python"], input: "{}", deadline_seconds: 1)
    end.to raise_error(Errno::ENOENT)
    expect(Dir.children("/dev/fd").size).to eq(open_fds)
  end

  describe "writing the request" do
    it "keeps the bytes a full pipe does not take" do
      reader, writer = IO.pipe
      begin
        loop { break if writer.write_nonblock("x" * 65_536, exception: false) == :wait_writable }

        expect(described_class.send(:feed, writer, "rest")).to eq("rest")
        expect(writer).not_to be_closed
      ensure
        reader.close
        writer.close
      end
    end
  end

  describe "killing and reaping" do
    it "reaps a child even when its group takes no signal" do
      pid = Process.spawn("true", pgroup: true)
      allow(Process).to receive(:kill).and_raise(Errno::ESRCH)

      described_class.send(:kill_and_reap, pid)

      expect(StubInterpreter.exists?(pid)).to be(false)
    end

    it "tolerates a child that was reaped already" do
      pid = Process.spawn("true", pgroup: true)
      Process.wait(pid)

      expect { described_class.send(:kill_and_reap, pid) }.not_to raise_error
    end
  end
end
