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

RSpec.describe PotatoMesh::Config do
  after do
    described_class.reset_overrides!
  end
  describe ".federation_announcement_interval" do
    it "returns eight hours in seconds" do
      expect(described_class.federation_announcement_interval).to eq(8 * 60 * 60)
    end
  end

  describe ".db_path" do
    it "uses the override when provided" do
      described_class.configure(db_path: "/tmp/spec.db")

      expect(described_class.db_path).to eq("/tmp/spec.db")
    end

    it "falls back to the bundled database path" do
      expect(described_class.db_path).to eq(described_class.default_db_path)
    end
  end

  describe ".max_json_body_bytes" do
    it "returns the default when the value is missing" do
      expect(described_class.max_json_body_bytes).to eq(
        described_class.default_max_json_body_bytes,
      )
    end

    it "returns the parsed integer when valid" do
      described_class.configure(max_json_body_bytes: "2048")

      expect(described_class.max_json_body_bytes).to eq(2048)
    end

    it "rejects invalid and non-positive values" do
      described_class.configure(max_json_body_bytes: "potato")

      expect(described_class.max_json_body_bytes).to eq(
        described_class.default_max_json_body_bytes,
      )

      described_class.configure(max_json_body_bytes: "0")

      expect(described_class.max_json_body_bytes).to eq(
        described_class.default_max_json_body_bytes,
      )
    end
  end

  describe ".refresh_interval_seconds" do
    it "returns the default when the configuration is invalid" do
      described_class.configure(refresh_interval_seconds: "invalid")

      expect(described_class.refresh_interval_seconds).to eq(
        described_class.default_refresh_interval_seconds,
      )
    end

    it "honours positive integer overrides" do
      described_class.configure(refresh_interval_seconds: "120")

      expect(described_class.refresh_interval_seconds).to eq(120)
    end

    it "rejects zero or negative overrides" do
      described_class.configure(refresh_interval_seconds: "0")

      expect(described_class.refresh_interval_seconds).to eq(
        described_class.default_refresh_interval_seconds,
      )
    end
  end

  describe ".prom_report_id_list" do
    it "splits and normalises identifiers" do
      described_class.configure(prom_report_ids: " alpha , beta,, ")

      expect(described_class.prom_report_id_list).to eq(%w[alpha beta])
    end

    it "returns arrays unchanged" do
      described_class.configure(prom_report_ids: %w[one two])

      expect(described_class.prom_report_id_list).to eq(%w[one two])
    end
  end

  describe ".fetch_string" do
    it "trims whitespace and falls back when blank" do
      within_env("SITE_NAME" => "  \t  ") do
        expect(described_class.site_name).to eq("PotatoMesh Demo")
      end

      within_env("SITE_NAME" => "  Spec Mesh  ") do
        expect(described_class.site_name).to eq("Spec Mesh")
      end
    end
  end

  describe ".debug?" do
    it "reflects the DEBUG environment variable" do
      within_env("DEBUG" => "1") do
        expect(described_class.debug?).to be(true)
      end

      within_env("DEBUG" => nil) do
        expect(described_class.debug?).to be(false)
      end
    end
  end

  describe ".tile_filters" do
    it "returns a frozen mapping" do
      filters = described_class.tile_filters

      expect(filters).to match(light: String, dark: String)
      expect(filters).to be_frozen
    end
  end

  describe ".map_center" do
    it "parses comma separated coordinates" do
      within_env("MAP_CENTER" => "10.5,-20.25") do
        expect(described_class.map_center).to eq([10.5, -20.25])
      end
    end

    it "falls back to defaults on invalid input" do
      within_env("MAP_CENTER" => "invalid") do
        expect(described_class.map_center).to eq(PotatoMesh::Config::DEFAULT_MAP_CENTER)
      end
    end
  end

  describe ".channel" do
    it "fetches trimmed channel values" do
      within_env("CHANNEL" => "  #Spec  ") do
        expect(described_class.channel).to eq("#Spec")
      end
    end
  end

  describe ".frequency" do
    it "fetches trimmed frequency values" do
      within_env("FREQUENCY" => " 915MHz ") do
        expect(described_class.frequency).to eq("915MHz")
      end
    end
  end

  describe ".contact_link" do
    it "returns a trimmed link" do
      within_env("CONTACT_LINK" => " https://chat.example.org ") do
        expect(described_class.contact_link).to eq("https://chat.example.org")
      end
    end
  end

  describe ".max_distance_km" do
    it "enforces a positive distance" do
      within_env("MAX_DISTANCE" => "-5") do
        expect(described_class.max_distance_km).to eq(42.0)
      end

      within_env("MAX_DISTANCE" => "120.5") do
        expect(described_class.max_distance_km).to eq(120.5)
      end
    end
  end

  describe ".http_port" do
    it "returns the default when unset" do
      expect(described_class.http_port).to eq(PotatoMesh::Config::DEFAULT_HTTP_PORT)
    end

    it "parses overrides and rejects invalid values" do
      described_class.configure(http_port: "51515")

      expect(described_class.http_port).to eq(51_515)

      described_class.configure(http_port: "potato")

      expect(described_class.http_port).to eq(PotatoMesh::Config::DEFAULT_HTTP_PORT)
    end
  end

  # Execute the provided block with temporary environment overrides.
  #
  # @param values [Hash{String=>String, nil}] key/value pairs to set in ENV.
  # @yield [] block executed while the overrides are active.
  # @return [void]
  def within_env(values)
    original = {}
    values.each do |key, value|
      original[key] = ENV.key?(key) ? ENV[key] : :__unset__
      if value.nil?
        ENV.delete(key)
      else
        ENV[key] = value
      end
    end

    yield
  ensure
    original.each do |key, value|
      if value == :__unset__
        ENV.delete(key)
      else
        ENV[key] = value
      end
    end
  end
end
