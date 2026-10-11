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

require "json"
require_relative "decoder_process"

module PotatoMesh
  module App
    module Meshtastic
      # Decode Meshtastic protobuf payloads via the Python helper script.
      #
      # Every decode starts one interpreter (+decode_payload.py+), so three
      # bounds hold the cost (SPEC DB1-DB3): a deadline per decode, a cap per
      # ingest request and a limit on decoders running at once.  A decode a
      # bound stops returns nil, as a failed decode does, and logs one debug
      # line naming the bound.  Measured 2026-10-09 on an Intel Core Ultra 9
      # 185H (8 CPUs) with the pinned venv: median 157 ms per decode, slowest
      # of 40 201 ms, slowest of 8 at once 379 ms, 43.6 MiB peak RSS; with the
      # CPU capped at 12% of one core, about a Raspberry Pi 4 core, median
      # 1.98 s and slowest 2.19 s.
      module PayloadDecoder
        module_function

        PYTHON_ENV_KEY = "MESHTASTIC_PYTHON"
        DEFAULT_PYTHON_RELATIVE = File.join("data", ".venv", "bin", "python")
        DEFAULT_DECODER_RELATIVE = File.join("data", "mesh_ingestor", "decode_payload.py")
        FALLBACK_PYTHON_NAMES = ["python3", "python"].freeze

        # Seconds one decode may take, from start to reap (SPEC DB1): 20
        # times the slowest decode measured here and 1.8 times the slowest at
        # the Pi 4 figure.  Past it the decoder's process group is killed.
        DECODE_DEADLINE_SECONDS = 4

        # Decodes one ingest request may start (SPEC DB2).  Four take about
        # 0.6 s here and 8 s at the Pi 4 figure, inside the ingestor's 10 s
        # POST timeout; the shipped ingestor posts one message per request.
        MAX_DECODES_PER_REQUEST = 4

        # Decoders the web process runs at once (SPEC DB3): about 87 MiB and
        # two of a Raspberry Pi's four cores.
        MAX_CONCURRENT_DECODES = 2

        # Seconds a decode waits for a free decoder slot (SPEC DB3).  With the
        # deadline, one message spends at most 5 s on decoding, half the
        # ingestor's POST timeout.
        SLOT_WAIT_SECONDS = 1

        # Free decoder slots of the process, one token each (SPEC DB3).
        DECODE_SLOTS = Thread::Queue.new(Array.new(MAX_CONCURRENT_DECODES, true))

        # The decodes one ingest request may still start (SPEC DB2).
        #
        # A route builds one per request and hands it down through
        # +insert_message+ and +store_decrypted_payload+.  Every decode that
        # would start takes one, whether it then gets a slot or not, so one
        # request spends at most +MAX_DECODES_PER_REQUEST+ slot waits and
        # deadlines on decoding.  A request runs on one thread; the budget is
        # not shared between threads.
        class Budget
          # @param limit [Integer] decodes the request may start.
          def initialize(limit = MAX_DECODES_PER_REQUEST)
            @remaining = limit
          end

          # Take one decode from the budget.
          #
          # @return [Boolean] true when the request may start one more decode.
          def take
            return false unless @remaining.positive?

            @remaining -= 1
            true
          end
        end

        # Decode a protobuf payload using the Meshtastic helper.
        #
        # @param portnum [Integer] Meshtastic port number.
        # @param payload_b64 [String] base64-encoded payload bytes.
        # @param budget [Budget, nil] the ingest request's decodes (SPEC DB2);
        #   nil sets no per-request cap.
        # @param message_id [Integer, nil] message the payload belongs to, for
        #   the log line of a skipped decode.
        # @return [Hash, nil] decoded payload hash or nil when decoding fails
        #   or a bound skips it.
        def decode(portnum:, payload_b64:, budget: nil, message_id: nil)
          return nil unless portnum && payload_b64

          decoder_path = decoder_script_path
          python_path = python_executable_path
          return nil unless decoder_path && python_path

          # The request's cap first: it never waits (SPEC DB2).
          return skip_decode("cap", portnum, message_id) if budget && !budget.take

          input = JSON.generate({ portnum: portnum, payload_b64: payload_b64 })
          # Then a short wait for one of the process's slots (SPEC DB3).
          result = run_in_slot([python_path, decoder_path], input)
          return skip_decode("concurrency", portnum, message_id) if result == :no_slot
          return skip_decode("deadline", portnum, message_id) unless result

          stdout, status = result
          return nil unless status.success?

          parsed = JSON.parse(stdout)
          return nil unless parsed.is_a?(Hash)
          return nil if parsed["error"]

          parsed
        rescue JSON::ParserError
          nil
        rescue Errno::ENOENT
          nil
        rescue ArgumentError
          nil
        end

        # Run the decoder under one of the process's slots (SPEC DB3).
        #
        # The slot is taken inside the region whose +ensure+ gives it back,
        # and interrupts from other threads, such as Puma's forced shutdown,
        # are held back there: one can land only while +DecoderProcess.run+
        # waits on the child, and the slot still goes back.
        #
        # @param argv [Array<String>] interpreter and decoder script.
        # @param input [String] the decoder's request.
        # @return [Array(String, Process::Status), Symbol, nil] the decoder's
        #   stdout and exit status; +:no_slot+ when no slot freed within
        #   +SLOT_WAIT_SECONDS+; nil when the deadline passed.
        def run_in_slot(argv, input)
          Thread.handle_interrupt(Object => :never) do
            slot = nil
            begin
              slot = DECODE_SLOTS.pop(timeout: SLOT_WAIT_SECONDS)
              return :no_slot unless slot

              DecoderProcess.run(argv, input: input, deadline_seconds: DECODE_DEADLINE_SECONDS)
            ensure
              DECODE_SLOTS.push(slot) if slot
            end
          end
        end

        # Log a decode a bound skipped and report it as a failed decode.
        #
        # @param reason [String] the bound: +cap+, +concurrency+ or +deadline+.
        # @param portnum [Integer] Meshtastic port number of the payload.
        # @param message_id [Integer, nil] message the payload belongs to.
        # @return [nil]
        def skip_decode(reason, portnum, message_id)
          PotatoMesh::Logging.log(
            PotatoMesh::Logging.logger_for,
            :debug,
            "Skipped Meshtastic payload decode",
            context: "meshtastic.payload_decoder",
            reason: reason,
            message_id: message_id,
            portnum: portnum,
          )
          nil
        end

        # Resolve the configured Python executable for Meshtastic decoding.
        #
        # @return [String, nil] python path or nil when missing.
        def python_executable_path
          configured = ENV[PYTHON_ENV_KEY]
          return configured if configured && !configured.strip.empty?

          candidate = File.expand_path(DEFAULT_PYTHON_RELATIVE, repo_root)
          return candidate if File.exist?(candidate)

          FALLBACK_PYTHON_NAMES.each do |name|
            found = find_executable(name)
            return found if found
          end

          nil
        end

        # Resolve the Meshtastic payload decoder script path.
        #
        # @return [String, nil] script path or nil when missing.
        def decoder_script_path
          repo_candidate = File.expand_path(DEFAULT_DECODER_RELATIVE, repo_root)
          return repo_candidate if File.exist?(repo_candidate)

          web_candidate = File.expand_path(DEFAULT_DECODER_RELATIVE, web_root)
          return web_candidate if File.exist?(web_candidate)

          nil
        end

        # Resolve the repository root directory from the application config.
        #
        # @return [String] absolute path to the repository root.
        def repo_root
          PotatoMesh::Config.repo_root
        end

        def web_root
          PotatoMesh::Config.web_root
        end

        def find_executable(name)
          # Locate an executable in PATH without invoking a subshell.
          #
          # @param name [String] executable name to resolve.
          # @return [String, nil] full path when found.
          ENV.fetch("PATH", "").split(File::PATH_SEPARATOR).each do |path|
            candidate = File.join(path, name)
            return candidate if File.file?(candidate) && File.executable?(candidate)
          end

          nil
        end

        private_class_method :find_executable, :skip_decode, :run_in_slot
      end
    end
  end
end
