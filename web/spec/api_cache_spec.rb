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

RSpec.describe PotatoMesh::App::ApiCache do
  after { described_class.invalidate_all }

  describe ".fetch" do
    it "returns a hash with :value and :etag on cache miss" do
      result = described_class.fetch("test:key", ttl_seconds: 60) { "value_a" }
      expect(result).to be_a(Hash)
      expect(result[:value]).to eq("value_a")
      expect(result[:etag]).to match(/\A[0-9a-f]+\z/)
    end

    it "returns the cached value within the TTL" do
      described_class.fetch("test:ttl", ttl_seconds: 60) { "first" }
      result = described_class.fetch("test:ttl", ttl_seconds: 60) { "second" }
      expect(result[:value]).to eq("first")
    end

    it "recomputes the value after the TTL expires" do
      described_class.fetch("test:expired", ttl_seconds: 0) { "first" }
      sleep 0.01
      result = described_class.fetch("test:expired", ttl_seconds: 0) { "second" }
      expect(result[:value]).to eq("second")
    end

    it "caches different keys independently" do
      described_class.fetch("key:a", ttl_seconds: 60) { "alpha" }
      described_class.fetch("key:b", ttl_seconds: 60) { "beta" }

      a = described_class.fetch("key:a", ttl_seconds: 60) { "stale" }
      b = described_class.fetch("key:b", ttl_seconds: 60) { "stale" }
      expect(a[:value]).to eq("alpha")
      expect(b[:value]).to eq("beta")
    end

    it "stores a pre-computed weak ETag matching the value digest" do
      result = described_class.fetch("test:etag", ttl_seconds: 60) { '{"ok":true}' }
      expected_digest = Digest::MD5.hexdigest('{"ok":true}')
      expect(result[:etag]).to eq(expected_digest)
    end

    it "returns the same ETag on cache hit without recomputing" do
      first = described_class.fetch("test:etag-hit", ttl_seconds: 60) { "body" }
      second = described_class.fetch("test:etag-hit", ttl_seconds: 60) { "other" }
      expect(second[:etag]).to eq(first[:etag])
    end
  end

  describe ".invalidate_all" do
    it "clears all cached entries" do
      described_class.fetch("inv:x", ttl_seconds: 60) { "x" }
      described_class.fetch("inv:y", ttl_seconds: 60) { "y" }
      expect(described_class.size).to eq(2)

      described_class.invalidate_all
      expect(described_class.size).to eq(0)

      result = described_class.fetch("inv:x", ttl_seconds: 60) { "fresh" }
      expect(result[:value]).to eq("fresh")
    end
  end

  describe ".invalidate" do
    it "removes only the specified keys" do
      described_class.fetch("sel:a", ttl_seconds: 60) { "a" }
      described_class.fetch("sel:b", ttl_seconds: 60) { "b" }
      described_class.fetch("sel:c", ttl_seconds: 60) { "c" }

      described_class.invalidate("sel:a", "sel:c")
      expect(described_class.size).to eq(1)

      result = described_class.fetch("sel:b", ttl_seconds: 60) { "stale" }
      expect(result[:value]).to eq("b")

      result = described_class.fetch("sel:a", ttl_seconds: 60) { "new_a" }
      expect(result[:value]).to eq("new_a")
    end
  end

  describe ".invalidate_prefix" do
    it "removes entries whose keys start with any of the given prefixes" do
      described_class.fetch("api:nodes:200:", ttl_seconds: 60) { "n" }
      described_class.fetch("api:nodes:1000:", ttl_seconds: 60) { "n2" }
      described_class.fetch("api:messages:200:", ttl_seconds: 60) { "m" }
      described_class.fetch("api:stats:0", ttl_seconds: 60) { "s" }

      described_class.invalidate_prefix("api:nodes:", "api:stats:")
      expect(described_class.size).to eq(1)

      result = described_class.fetch("api:messages:200:", ttl_seconds: 60) { "stale" }
      expect(result[:value]).to eq("m")
    end

    it "is a no-op when no keys match" do
      described_class.fetch("api:nodes:x", ttl_seconds: 60) { "n" }
      described_class.invalidate_prefix("api:telemetry:")
      expect(described_class.size).to eq(1)
    end
  end

  describe "MAX_ENTRIES eviction" do
    it "evicts the oldest entry when the store exceeds MAX_ENTRIES" do
      max = described_class::MAX_ENTRIES
      # Fill the cache to capacity
      max.times do |i|
        described_class.fetch("fill:#{i}", ttl_seconds: 60) { "v#{i}" }
      end
      expect(described_class.size).to eq(max)

      # Adding one more should evict the oldest
      described_class.fetch("fill:overflow", ttl_seconds: 60) { "new" }
      expect(described_class.size).to eq(max)

      # The first entry should have been evicted
      result = described_class.fetch("fill:0", ttl_seconds: 60) { "recomputed" }
      expect(result[:value]).to eq("recomputed")
    end
  end

  describe ".size" do
    it "reports the number of cached entries" do
      expect(described_class.size).to eq(0)
      described_class.fetch("sz:1", ttl_seconds: 60) { "v" }
      expect(described_class.size).to eq(1)
    end
  end

  describe "error handling" do
    it "does not cache the value when the block raises" do
      expect {
        described_class.fetch("err:raise", ttl_seconds: 60) { raise "boom" }
      }.to raise_error(RuntimeError, "boom")

      expect(described_class.size).to eq(0)
    end

    it "allows a subsequent fetch after a block error" do
      begin
        described_class.fetch("err:retry", ttl_seconds: 60) { raise "first" }
      rescue RuntimeError
        # expected
      end

      result = described_class.fetch("err:retry", ttl_seconds: 60) { "recovered" }
      expect(result[:value]).to eq("recovered")
    end
  end
end
