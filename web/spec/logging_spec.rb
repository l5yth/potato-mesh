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
