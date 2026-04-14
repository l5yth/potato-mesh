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
    # Thread-safe in-memory cache for serialised API responses.
    #
    # Each entry is stored with a monotonic expiration time.  Expired entries
    # are lazily evicted on the next +fetch+ for the same key.  The module is
    # designed to sit between the Sinatra route handler and the query layer so
    # that identical polling requests (same limit / protocol / parameters)
    # served within the TTL window return the previously computed JSON string
    # without touching SQLite.
    #
    # Invalidation is intentionally coarse-grained: any successful ingest POST
    # calls {invalidate_all} so the next GET rebuilds from the database.  This
    # is safe because ingestors typically post every few minutes, making the
    # rebuild cost negligible compared to the savings from serving cached
    # responses to multiple concurrent dashboard clients.
    module ApiCache
      @store = {}
      @mutex = Mutex.new

      class << self
        # Retrieve a cached value or compute and store it.
        #
        # @param key [String] cache key incorporating all relevant query
        #   parameters (limit, protocol, etc.).
        # @param ttl_seconds [Numeric] time-to-live for the cached entry.
        # @yield Computes the value to cache when the entry is missing or
        #   expired.  The block should return the serialised JSON string.
        # @return [Object] cached or freshly computed value.
        def fetch(key, ttl_seconds:)
          now = monotonic_now
          @mutex.synchronize do
            entry = @store[key]
            return entry[:value] if entry && now < entry[:expires_at]
          end

          value = yield

          @mutex.synchronize do
            @store[key] = { value: value, expires_at: monotonic_now + ttl_seconds }
          end
          value
        end

        # Remove all entries from the cache.
        #
        # Called after successful ingest POST operations so subsequent GET
        # requests pick up the newly written data.
        #
        # @return [void]
        def invalidate_all
          @mutex.synchronize { @store.clear }
        end

        # Remove specific entries by key.
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
        # Intended for testing and diagnostics only.
        #
        # @return [Integer] entry count.
        def size
          @mutex.synchronize { @store.size }
        end

        private

        # Use the monotonic clock so TTL calculations are immune to wall-clock
        # adjustments (NTP jumps, DST transitions, etc.).
        def monotonic_now
          Process.clock_gettime(Process::CLOCK_MONOTONIC)
        end
      end
    end
  end
end
