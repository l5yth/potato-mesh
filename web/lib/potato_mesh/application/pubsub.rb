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
    # In-process publish/subscribe registry that powers live dashboard updates.
    #
    # An ingest +POST+ publishes a thin "this collection changed" event; browser
    # clients subscribe over Server-Sent Events ({Routes::Events}) and react by
    # re-running their existing delta fetch against the +/api/*+ endpoints. The
    # registry therefore carries **no row data** — only the name of the changed
    # collection plus an optional numeric +hint+ (the newest +rx_time+ /
    # +last_heard+) the client may use to skip a redundant fetch.
    #
    # The fan-out is deliberately **local and in-process** (Ruby +Mutex+ /
    # +ConditionVariable+ only): there is no broker, socket, or cloud message
    # bus, honouring the PotatoMesh apex invariant (SPEC.md §1, +PS1+). Because
    # the registry lives in one process, fan-out is per-process; a clustered
    # multi-worker deployment is out of scope and is covered by the client's slow
    # safety poll (+PS5+).
    #
    # Coalescing is structural rather than timer-based: each {Subscriber} keeps a
    # pending map keyed by collection, so a burst of writes to one collection
    # collapses to a single pending entry (at most {COLLECTIONS}.size entries per
    # subscriber). This bounds memory and the emitted event rate without a
    # background thread (+PS4+), and keeps the unit tests deterministic.
    #
    # Privacy: {publish} drops +"messages"+ events when +private_mode+ is true,
    # mirroring the +/api/messages+ 404 in private mode (+PS6+, Invariant II).
    module PubSub
      # Collections that may be published. Mirrors the dashboard ingest routes
      # whose writes drive a re-fetch; an unknown collection is ignored by
      # {publish} so a future caller typo can never crash ingest.
      COLLECTIONS = %w[nodes messages positions telemetry neighbors traces].freeze

      # Upper bound on concurrently registered subscribers. Each open SSE stream
      # occupies one subscriber **and, under the threaded server, one request
      # thread for its whole lifetime**, so the effective ceiling is clamped to
      # the request-thread budget by {effective_max_subscribers}: a flood of
      # +/api/events+ connections can never consume the threads reserved for
      # non-SSE traffic (+PS8+ / +PS9+). The route maps {CapacityError} to an
      # HTTP 503, after which the client falls back to its safety poll.
      MAX_SUBSCRIBERS = 64

      # Raised by {PubSub.subscribe} when {MAX_SUBSCRIBERS} is already reached.
      class CapacityError < StandardError; end

      # A single connected client's mailbox.
      #
      # A subscriber holds a pending map keyed by collection. {deliver} merges a
      # change into the map (coalescing repeated writes to the same collection);
      # {drain} blocks until at least one change is pending or the timeout
      # elapses, then returns and clears the pending set. The blocking drain lets
      # the SSE route emit a heartbeat on timeout without busy-looping.
      class Subscriber
        # Default settle-window sleeper (real time). Injectable so a test can
        # drive the LV6 cooldown deterministically without actually sleeping.
        DEFAULT_SLEEPER = ->(seconds) { sleep(seconds) }

        # Initialize an empty, open subscriber.
        def initialize
          @pending = {}
          @mutex = Mutex.new
          @condition = ConditionVariable.new
          @closed = false
        end

        # Record a change for +collection+, coalescing with any unsent change.
        #
        # When a +hint+ for the same collection is already pending the larger
        # (newest) value is kept, so the client always learns the freshest
        # high-water mark even across coalesced writes. A no-op once {close}d.
        #
        # @param collection [String] the changed collection name.
        # @param hint [Integer, nil] optional newest +rx_time+ / +last_heard+.
        # @return [void]
        def deliver(collection, hint)
          @mutex.synchronize do
            return if @closed

            @pending[collection] = merge_hint(@pending[collection], hint)
            @condition.signal
          end
        end

        # Wait for pending changes, then return and clear them.
        #
        # Blocks up to +timeout+ seconds while nothing is pending and the
        # subscriber is open. Returns an array of +{ collection:, hint: }+ hashes
        # ordered by collection name (deterministic SSE ordering); an empty array
        # signals a timeout/heartbeat tick or a closed, drained subscriber.
        #
        # @param timeout [Numeric] maximum seconds to block when idle.
        # @param settle [Numeric] LV6 cooldown: seconds to hold after a change
        #   lands so a burst coalesces into one batch (0 disables it).
        # @param sleeper [#call] settle-window sleeper (injected by tests).
        # @return [Array<Hash{Symbol => Object}>] coalesced pending changes.
        def drain(timeout:, settle: 0, sleeper: DEFAULT_SLEEPER)
          @mutex.synchronize do
            @condition.wait(@mutex, timeout) if @pending.empty? && !@closed
          end

          # Hold a brief settle window so a burst of writes to the same collection
          # (e.g. N ingestors relaying one packet) coalesces into a single event
          # rather than N (SPEC LV6 cooldown). The sleep runs OUTSIDE the lock so
          # concurrent deliver() calls merge into @pending during the window; it
          # is skipped on an idle heartbeat tick (nothing pending) and once closed.
          if settle.positive? && !closed? && pending_count.positive?
            sleeper.call(settle)
          end

          @mutex.synchronize do
            events = @pending.keys.sort.map do |collection|
              { collection: collection, hint: @pending[collection] }
            end
            @pending.clear
            events
          end
        end

        # Permanently close the subscriber, waking any blocked {drain}.
        #
        # @return [void]
        def close
          @mutex.synchronize do
            @closed = true
            @condition.broadcast
          end
        end

        # @return [Boolean] true once {close} has been called.
        def closed?
          @mutex.synchronize { @closed }
        end

        # @return [Integer] number of distinct collections currently pending.
        def pending_count
          @mutex.synchronize { @pending.size }
        end

        private

        # Combine two optional numeric hints, keeping the larger (newest) one.
        #
        # @param current [Integer, nil] hint already pending for the collection.
        # @param incoming [Integer, nil] hint from the new {deliver} call.
        # @return [Integer, nil] the newest available hint, or nil when neither.
        def merge_hint(current, incoming)
          [current, incoming].compact.max
        end
      end

      @subscribers = []
      @mutex = Mutex.new

      class << self
        # Register a new subscriber and return its mailbox.
        #
        # @return [Subscriber] the freshly registered subscriber.
        # @raise [CapacityError] when {effective_max_subscribers} is reached.
        def subscribe
          @mutex.synchronize do
            cap = effective_max_subscribers
            if @subscribers.size >= cap
              raise CapacityError, "subscriber limit (#{cap}) reached"
            end

            subscriber = Subscriber.new
            @subscribers << subscriber
            subscriber
          end
        end

        # Effective concurrent-subscriber ceiling, clamped so SSE never consumes
        # the request threads reserved for non-SSE traffic. Equal to
        # +min(MAX_SUBSCRIBERS, Config.puma_max_threads - Config.sse_thread_reserve)+,
        # which reconciles to {MAX_SUBSCRIBERS} at the default pool size
        # (96 - 32 = 64) and shrinks automatically when the pool is configured
        # smaller (SPEC PS9). Never negative: a pool at or below the reserve
        # yields 0, so every {subscribe} is refused (503) and the client falls
        # back to its safety poll (+PS8+) rather than the server starving.
        #
        # @return [Integer] the effective subscriber limit (>= 0).
        def effective_max_subscribers
          budget = PotatoMesh::Config.puma_max_threads - PotatoMesh::Config.sse_thread_reserve
          [MAX_SUBSCRIBERS, [budget, 0].max].min
        end

        # Remove and close a subscriber. Safe to call more than once.
        #
        # @param subscriber [Subscriber] the subscriber to remove.
        # @return [void]
        def unsubscribe(subscriber)
          @mutex.synchronize { @subscribers.delete(subscriber) }
          subscriber&.close
        end

        # Publish a change event for +collection+ to every subscriber.
        #
        # Unknown collections (outside {COLLECTIONS}) are ignored so a caller
        # typo cannot break ingest. +"messages"+ events are suppressed when
        # +private_mode+ is true (+PS6+, Invariant II). The subscriber list is
        # snapshotted under the registry lock and delivered to outside it, so a
        # slow subscriber never blocks publication or the ingest request.
        #
        # @param collection [String] the changed collection name.
        # @param hint [Integer, nil] optional newest +rx_time+ / +last_heard+.
        # @param private_mode [Boolean] when true, +"messages"+ is dropped.
        # @return [Integer] the number of subscribers the event was delivered to.
        def publish(collection, hint: nil, private_mode: false)
          return 0 unless COLLECTIONS.include?(collection)
          return 0 if private_mode && collection == "messages"

          targets = @mutex.synchronize { @subscribers.dup }
          targets.each { |subscriber| subscriber.deliver(collection, hint) }
          targets.size
        end

        # @return [Integer] number of currently registered subscribers.
        def subscriber_count
          @mutex.synchronize { @subscribers.size }
        end

        # Remove and close every subscriber. Intended for test isolation and
        # application shutdown.
        #
        # @return [void]
        def reset!
          drained = @mutex.synchronize do
            current = @subscribers.dup
            @subscribers.clear
            current
          end
          drained.each(&:close)
        end
      end
    end
  end
end
