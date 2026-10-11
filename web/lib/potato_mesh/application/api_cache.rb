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

require "digest"

module PotatoMesh
  module App
    # Thread-safe in-memory cache for serialised API responses.
    #
    # Each entry is stored with a monotonic expiration time and a pre-computed
    # ETag so the route handler can skip recomputing the digest on cache hits.
    #
    # Entries come in two tiers (SPEC RC3).  A *fixed* entry is one of a
    # finite set the routes name: +/api/stats+, +/api/instances+, the
    # canonical bucketed series and each collection's page without a
    # +protocol+ filter at a limit of {CACHEABLE_LIMITS}.  Every other cached
    # page, one filtered by +protocol+, is a *variant*.  Each tier holds at
    # most {MAX_ENTRIES} entries, evicting its own oldest entry by insertion
    # order, so no number of variants can evict a fixed entry.  A route serves
    # a request whose limit is outside {CACHEABLE_LIMITS} uncached, so free
    # query parameters never reach the keys.
    #
    # Invalidation can target a specific prefix (e.g. +"api:nodes:"+) so that an
    # ingest POST to +/api/messages+ does not flush the neighbors cache.
    # A single-flight guard coalesces concurrent misses for the same key so only
    # one thread computes the value while others wait for the result.
    module ApiCache
      # Cap on the entries of each tier, to bound memory.  The fixed tier
      # names at most 55 keys, both private-flag values counted, so it never
      # evicts in practice; variants evict each other.
      MAX_ENTRIES = 64

      # The collection limits the app itself requests, the only ones whose
      # pages are cached: 10, the federation node list peers fetch
      # (+remote_instance_min_node_count+, SPEC FL2) and the Matrix bridge's
      # fallback; 200, the default when +limit+ is absent and the trace page;
      # 1000, +MAX_QUERY_LIMIT+, the dashboard's pages.
      CACHEABLE_LIMITS = [10, 200, 1000].freeze

      @store = {}
      @inflight = {}
      @mutex = Mutex.new

      class << self
        # Retrieve a cached value or compute and store it.
        #
        # When multiple threads request the same cold key concurrently only one
        # executes the block; the others wait for the result (single-flight).
        #
        # The returned hash contains both +:value+ (the JSON string) and +:etag+
        # (pre-computed weak ETag) so callers can set the header without
        # re-hashing the body.
        #
        # @param key [String] cache key incorporating all relevant query
        #   parameters (limit, protocol, etc.).
        # @param ttl_seconds [Numeric] time-to-live for the cached entry.
        # @param fixed [Boolean] whether +key+ belongs to the finite set of
        #   fixed entries that no variant evicts (SPEC RC3).
        # @yield Computes the value to cache when the entry is missing or
        #   expired.  The block should return the serialised JSON string.
        # @return [Hash{Symbol => String}] +:value+ and +:etag+ of the response.
        def fetch(key, ttl_seconds:, fixed: false)
          now = monotonic_now

          @mutex.synchronize do
            entry = @store[key]
            if entry && now < entry[:expires_at]
              return { value: entry[:value], etag: entry[:etag] }
            end

            # Single-flight: if another thread is already computing this key,
            # wait for it to finish and use its result.  The loop guards
            # against spurious wakeups from ConditionVariable#wait.
            while @inflight.key?(key)
              cv = @inflight[key]
              cv.wait(@mutex)
              entry = @store[key]
              if entry && monotonic_now < entry[:expires_at]
                return { value: entry[:value], etag: entry[:etag] }
              end
            end

            # Mark this key as in-flight so concurrent requests wait.
            @inflight[key] = ConditionVariable.new
          end

          value = yield
          etag = Digest::MD5.hexdigest(value)

          @mutex.synchronize do
            # A recomputed key replaces its expired entry, which leaves its
            # tier first, so it evicts no other entry.
            @store.delete(key)
            evict_oldest_if_full(fixed)
            @store[key] = { value: value, etag: etag, expires_at: monotonic_now + ttl_seconds, fixed: fixed }
            cv = @inflight.delete(key)
            cv&.broadcast
          end

          { value: value, etag: etag }
        rescue => e
          # On error, unblock any waiters and re-raise.
          @mutex.synchronize do
            cv = @inflight.delete(key)
            cv&.broadcast
          end
          raise e
        end

        # Remove entries whose keys start with any of the given prefixes.
        #
        # Targeted invalidation so that e.g. a messages POST does not flush the
        # neighbors or telemetry caches.
        #
        # @param prefixes [Array<String>] key prefixes to match.
        # @return [void]
        def invalidate_prefix(*prefixes)
          @mutex.synchronize do
            @store.reject! do |key, _|
              prefixes.any? { |p| key.start_with?(p) }
            end
          end
        end

        # Remove all entries from the cache.
        #
        # @return [void]
        def invalidate_all
          @mutex.synchronize { @store.clear }
        end

        # Remove specific entries by exact key.
        #
        # @param keys [Array<String>] cache keys to evict.
        # @return [void]
        def invalidate(*keys)
          @mutex.synchronize do
            keys.each { |k| @store.delete(k) }
          end
        end

        # Return the number of entries currently held in the cache.
        #
        # @return [Integer] entry count.
        def size
          @mutex.synchronize { @store.size }
        end

        # Whether a collection page at +limit+ may be cached: only the limits
        # the app requests are, so a client cannot mint keys (SPEC RC3).
        #
        # @param limit [Integer] the coerced request limit.
        # @return [Boolean] true when +limit+ is one of {CACHEABLE_LIMITS}.
        def cacheable_limit?(limit)
          CACHEABLE_LIMITS.include?(limit)
        end

        private

        # Use the monotonic clock so TTL calculations are immune to wall-clock
        # adjustments (NTP jumps, DST transitions, etc.).
        def monotonic_now
          Process.clock_gettime(Process::CLOCK_MONOTONIC)
        end

        # Evict the oldest entries of one tier until it has room for one more.
        # Ruby hashes preserve insertion order, so the first keys are the
        # oldest; the other tier is never touched (SPEC RC3).
        #
        # @param fixed [Boolean] the tier of the entry about to be stored.
        # @return [void]
        def evict_oldest_if_full(fixed)
          tier = @store.each_key.select { |key| @store[key][:fixed] == fixed }
          excess = tier.size - MAX_ENTRIES + 1
          tier.first(excess).each { |key| @store.delete(key) } if excess.positive?
        end
      end
    end
  end
end
