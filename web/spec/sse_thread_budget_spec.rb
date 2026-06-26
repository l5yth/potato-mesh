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
require "socket"
require "net/http"
require "timeout"
require "rack/handler/puma"

# Integration regression guard for the SSE thread-pool starvation outage.
#
# A +GET /api/events+ stream pins one Puma request thread for its whole lifetime
# (the +pump+ loop runs synchronously on that thread). Before the fix the
# subscriber cap (+MAX_SUBSCRIBERS+ = 64) sat far above Puma's pool (MRI default
# 5), so a handful of dashboard clients could occupy every worker thread and the
# instance returned nothing (502 to every other request, including its own
# federation self-fetch). This boots a real Puma with a small, fixed pool and
# proves SSE can never consume the whole pool — at least +sse_thread_reserve+
# threads always remain for non-SSE traffic (SPEC PS8/PS9).
RSpec.describe "SSE request-thread budget" do
  # A small pool keeps the test fast; the reserve is set so the clamped SSE cap
  # (max_threads - reserve) is a small positive number we can saturate quickly.
  POOL = 6
  RESERVE = 4
  HOST = "127.0.0.1"

  # Read from +sock+ until +needle+ (String or Regexp) appears or +timeout+
  # elapses, returning whatever was read. Uses IO.select so a stalled socket
  # cannot hang the suite.
  def read_until(sock, needle, timeout)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    buf = +""
    until (needle.is_a?(Regexp) ? buf.match?(needle) : buf.include?(needle))
      remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
      break if remaining <= 0
      break unless IO.select([sock], nil, nil, remaining)
      begin
        chunk = sock.read_nonblock(512)
      rescue IO::WaitReadable
        next
      rescue EOFError, Errno::ECONNRESET
        break
      end
      buf << chunk
    end
    buf
  end

  # Issue a plain (non-SSE) request and return its status code as a string, or
  # "ERROR:<Class>" when it cannot be served (the starvation symptom).
  def status_of(path, timeout:)
    http = Net::HTTP.new(HOST, @port)
    http.open_timeout = timeout
    http.read_timeout = timeout
    http.max_retries = 0
    http.start
    http.get(path).code
  rescue => e
    "ERROR:#{e.class}"
  ensure
    http&.finish if http&.started?
  end

  # Env keys this spec mutates; saved and restored verbatim around the run.
  ENV_KEYS = %w[MAX_THREADS SSE_THREAD_RESERVE EVENTS PRIVATE SSE_HEARTBEAT_SECONDS].freeze

  before(:all) do
    @saved_env = ENV_KEYS.to_h { |k| [k, ENV[k]] }
    ENV["MAX_THREADS"] = POOL.to_s
    ENV["SSE_THREAD_RESERVE"] = RESERVE.to_s
    ENV["EVENTS"] = "1"
    ENV.delete("PRIVATE")
    ENV["SSE_HEARTBEAT_SECONDS"] = "1" # snappy detection + teardown

    server = TCPServer.new(HOST, 0)
    @port = server.addr[1]
    server.close

    @launcher = nil
    handler = if Object.const_defined?(:Rackup) && defined?(Rackup::Handler::Puma)
        Rackup::Handler::Puma
      else
        Rack::Handler::Puma
      end
    @server_thread = Thread.new do
      handler.run(PotatoMesh::Application,
                  Host: HOST, Port: @port,
                  Threads: "#{POOL}:#{POOL}", Silent: true) do |l|
        @launcher = l
      end
    end

    Timeout.timeout(20) do
      loop do
        begin
          TCPSocket.new(HOST, @port).close
          break
        rescue Errno::ECONNREFUSED
          sleep 0.05
        end
      end
    end
    # Let the launcher finish wiring its thread pool before probing.
    sleep 0.3
  end

  after(:all) do
    @launcher&.stop
    @server_thread&.join(5)
    @saved_env.each { |k, v| v.nil? ? ENV.delete(k) : ENV[k] = v }
  end

  # Closing subscribers server-side unwinds every parked pump (the #827
  # subscriber-closed exit), freeing the worker threads between examples.
  after do
    PotatoMesh::App::PubSub.reset!
    sleep 0.2
  end

  it "never lets SSE subscribers consume the whole request-thread pool" do
    held = []
    accepted = 0

    POOL.times do
      sock = TCPSocket.new(HOST, @port)
      sock.write("GET /api/events HTTP/1.1\r\nHost: #{HOST}\r\nConnection: keep-alive\r\n\r\n")
      sock.flush
      resp = read_until(sock, /\r\n\r\n/, 3)
      if resp.start_with?("HTTP/1.1 200")
        # Confirm the stream is committed: the worker thread is now parked in
        # Events.pump and will not service any other request. The ": connected"
        # comment is usually flushed with the headers; read on only if not.
        resp = read_until(sock, ": connected", 3) unless resp.include?(": connected")
        accepted += 1 if resp.include?(": connected")
        held << sock
      else
        # 503 capacity: the client falls back to its safety poll (PS8). Good —
        # the server refused rather than cannibalising a reserved thread.
        sock.close
      end
    end

    # The clamp keeps concurrent SSE strictly below the pool, preserving a
    # reserve for non-SSE traffic. (Unfixed: all POOL connections are accepted.)
    expect(accepted).to be <= (POOL - RESERVE)

    # With the reserve intact, an ordinary request is still served promptly —
    # the instance is responsive even while live-update clients are connected.
    # (Unfixed: every thread is held by SSE, so this times out.)
    expect(status_of("/version", timeout: 4)).to eq("200")
  ensure
    held.each { |s| s.close rescue nil }
  end
end
