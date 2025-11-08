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
require "potato_mesh/logging"

describe PotatoMesh::Logging do
  describe ".formatter" do
    it "generates structured log entries" do
      timestamp = Time.utc(2024, 1, 2, 3, 4, 5, 678_000)
      formatted = described_class.formatter("DEBUG", timestamp, "potato-mesh", "hello")

      expect(formatted).to eq("[2024-01-02T03:04:05.678Z] [potato-mesh] [debug] hello\n")
    end
  end

  describe ".log" do
    it "passes structured metadata to the logger" do
      logger = instance_double(Logger)

      expect(logger).to receive(:debug).with("context=test foo=\"bar\" hello")

      described_class.log(logger, :debug, "hello", context: "test", foo: "bar")
    end
  end

  describe ".logger_for" do
    it "returns the logger from an object with settings" do
      container = Class.new do
        def settings
          Struct.new(:logger).new(:logger)
        end
      end

      expect(described_class.logger_for(container.new)).to eq(:logger)
    end
  end
end
