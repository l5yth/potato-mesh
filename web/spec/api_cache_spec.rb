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
    it "stores and returns the block value on cache miss" do
      result = described_class.fetch("test:key", ttl_seconds: 60) { "value_a" }
      expect(result).to eq("value_a")
    end

    it "returns the cached value within the TTL" do
      described_class.fetch("test:ttl", ttl_seconds: 60) { "first" }
      result = described_class.fetch("test:ttl", ttl_seconds: 60) { "second" }
      expect(result).to eq("first")
    end

    it "recomputes the value after the TTL expires" do
      described_class.fetch("test:expired", ttl_seconds: 0) { "first" }
      # TTL of 0 means the entry expires immediately
      sleep 0.01
      result = described_class.fetch("test:expired", ttl_seconds: 0) { "second" }
      expect(result).to eq("second")
    end

    it "caches different keys independently" do
      described_class.fetch("key:a", ttl_seconds: 60) { "alpha" }
      described_class.fetch("key:b", ttl_seconds: 60) { "beta" }

      a = described_class.fetch("key:a", ttl_seconds: 60) { "stale" }
      b = described_class.fetch("key:b", ttl_seconds: 60) { "stale" }
      expect(a).to eq("alpha")
      expect(b).to eq("beta")
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
      expect(result).to eq("fresh")
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
      expect(result).to eq("b")

      result = described_class.fetch("sel:a", ttl_seconds: 60) { "new_a" }
      expect(result).to eq("new_a")
    end
  end

  describe ".size" do
    it "reports the number of cached entries" do
      expect(described_class.size).to eq(0)
      described_class.fetch("sz:1", ttl_seconds: 60) { "v" }
      expect(described_class.size).to eq(1)
    end
  end
end
