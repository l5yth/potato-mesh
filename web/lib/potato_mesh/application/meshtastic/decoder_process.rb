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

module PotatoMesh
  module App
    module Meshtastic
      # Run one decoder child process under a hard deadline (SPEC DB1).
      #
      # The child starts in a process group of its own, with its stdin and
      # stdout on pipes and its stderr discarded.  Writing the request,
      # reading the reply and reaping the child share one monotonic deadline,
      # checked with +IO.select+ and non-blocking waits; no +Timeout+ is
      # involved, so no timer raises into the cleanup.  When the deadline
      # passes, the whole group is killed with +SIGKILL+ and the child is
      # reaped before the call returns: no zombie and no orphan.
      module DecoderProcess
        module_function

        # Seconds between two checks for the exit of a child that has closed
        # its stdout.
        REAP_POLL_SECONDS = 0.002

        # Bytes read from the child's stdout per read.
        READ_CHUNK_BYTES = 16_384

        # Run +argv+ with +input+ on its stdin.
        #
        # @param argv [Array<String>] executable and arguments, run without a
        #   shell.
        # @param input [String] bytes written to the child's stdin, which is
        #   then closed.
        # @param deadline_seconds [Numeric] seconds the whole run may take.
        # @return [Array(String, Process::Status), nil] the child's stdout,
        #   as UTF-8, and its exit status; nil when the deadline passed, after
        #   its process group was killed and the child reaped.
        # @raise [SystemCallError] when the child cannot be started.
        # @raise [ArgumentError] when +argv+ cannot be passed to the system.
        def run(argv, input:, deadline_seconds:)
          # Interrupts from other threads, such as Puma's forced shutdown,
          # wait while the child starts and while it is cleaned up, and land
          # only while the run waits on it: none can leave a child behind.
          Thread.handle_interrupt(Object => :never) do
            deadline = monotonic_now + deadline_seconds
            pid = nil
            begin
              stdin_r, stdin_w = IO.pipe
              stdout_r, stdout_w = IO.pipe
              # +[command, argv0]+ keeps a one-word command off the shell too.
              pid = Process.spawn(
                [argv.first, argv.first],
                *argv.drop(1),
                in: stdin_r,
                out: stdout_w,
                err: File::NULL,
                pgroup: true,
              )
              # The child holds its own copies of these two ends.
              stdin_r.close
              stdout_w.close

              output, status = Thread.handle_interrupt(Object => :immediate) do
                reply = exchange(stdin_w, stdout_r, input, deadline)
                [reply, reply && reap_by(pid, deadline)]
              end
              return nil unless status

              # Reaped: nothing is left to kill.
              pid = nil
              [output, status]
            ensure
              [stdin_r, stdin_w, stdout_r, stdout_w].each { |io| io.close if io && !io.closed? }
              kill_and_reap(pid) if pid
            end
          end
        end

        # Write +input+ to the child and read its stdout to the end, both by
        # +deadline+.
        #
        # @param stdin_w [IO] write end of the child's stdin.
        # @param stdout_r [IO] read end of the child's stdout.
        # @param input [String] bytes for the child's stdin.
        # @param deadline [Float] monotonic time the exchange must end by.
        # @return [String, nil] the child's stdout, nil when the deadline passed.
        def exchange(stdin_w, stdout_r, input, deadline)
          pending = input.b
          output = String.new(encoding: Encoding::BINARY)
          loop do
            remaining = deadline - monotonic_now
            return nil unless remaining.positive?

            writers = stdin_w.closed? ? nil : [stdin_w]
            readable, writable = IO.select([stdout_r], writers, nil, remaining)
            # A select that times out returns nil; the loop then finds the
            # deadline passed.
            next unless readable

            pending = feed(stdin_w, pending) unless writable.empty?
            next if readable.empty?

            # The pipe has data or its end, so this read does not block.
            begin
              output << stdout_r.readpartial(READ_CHUNK_BYTES)
            rescue EOFError
              return output.force_encoding(Encoding::UTF_8)
            end
          end
        end

        # Write what the child's stdin takes of +pending+, and close it once
        # the whole request is written.
        #
        # @param stdin_w [IO] write end of the child's stdin.
        # @param pending [String] request bytes not yet written.
        # @return [String] the bytes still to write.
        def feed(stdin_w, pending)
          written = stdin_w.write_nonblock(pending, exception: false)
          return pending if written == :wait_writable

          rest = pending.byteslice(written..)
          stdin_w.close if rest.empty?
          rest
        rescue Errno::EPIPE
          # The child closed its stdin before it read the whole request.
          stdin_w.close
          ""
        end

        # Reap +pid+ once it exits, checking until +deadline+.
        #
        # @param pid [Integer] the child's pid.
        # @param deadline [Float] monotonic time to give up at.
        # @return [Process::Status, nil] its exit status, nil when it still
        #   runs at the deadline.
        def reap_by(pid, deadline)
          loop do
            _, status = Process.wait2(pid, Process::WNOHANG)
            return status if status

            remaining = deadline - monotonic_now
            return nil unless remaining.positive?

            sleep([REAP_POLL_SECONDS, remaining].min)
          end
        end

        # Kill the child's process group with +SIGKILL+, then reap the child.
        #
        # The child is reaped only after the signal, so its pid, which names
        # the group, cannot be reused by an unrelated process in between.
        #
        # @param pid [Integer] the child's pid, which is also its group id.
        # @return [void]
        def kill_and_reap(pid)
          begin
            Process.kill(:KILL, -pid)
          rescue Errno::ESRCH
            # No process of the group is left to signal.
          end
          Process.wait(pid)
        rescue Errno::ECHILD
          # The child was reaped already.
        end

        # @return [Float] seconds on the monotonic clock.
        def monotonic_now
          Process.clock_gettime(Process::CLOCK_MONOTONIC)
        end

        private_class_method :exchange, :feed, :reap_by, :kill_and_reap, :monotonic_now
      end
    end
  end
end
