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
  describe ".data_directory" do
    it "uses the configured XDG data home when provided" do
      Dir.mktmpdir do |dir|
        data_home = File.join(dir, "xdg-data")
        within_env("XDG_DATA_HOME" => data_home) do
          expect(described_class.data_directory).to eq(File.join(data_home, "potato-mesh"))
        end
      end
    end

    it "falls back to the user home directory" do
      within_env("XDG_DATA_HOME" => nil) do
        allow(Dir).to receive(:home).and_return("/home/spec")
        expect(described_class.data_directory).to eq("/home/spec/.local/share/potato-mesh")
      end
    ensure
      allow(Dir).to receive(:home).and_call_original
    end

    it "falls back to the web root when the home directory is unavailable" do
      within_env("XDG_DATA_HOME" => nil) do
        allow(Dir).to receive(:home).and_raise(ArgumentError)
        expected = File.join(described_class.web_root, ".local", "share", "potato-mesh")
        expect(described_class.data_directory).to eq(expected)
      end
    ensure
      allow(Dir).to receive(:home).and_call_original
    end

    it "falls back to the web root when the home directory is nil" do
      within_env("XDG_DATA_HOME" => nil) do
        allow(Dir).to receive(:home).and_return(nil)
        expected = File.join(described_class.web_root, ".local", "share", "potato-mesh")
        expect(described_class.data_directory).to eq(expected)
      end
    ensure
      allow(Dir).to receive(:home).and_call_original
    end
  end

  describe ".config_directory" do
    it "uses the configured XDG config home when provided" do
      Dir.mktmpdir do |dir|
        config_home = File.join(dir, "xdg-config")
        within_env("XDG_CONFIG_HOME" => config_home) do
          expect(described_class.config_directory).to eq(File.join(config_home, "potato-mesh"))
        end
      end
    end

    it "falls back to the web root when the home directory is empty" do
      within_env("XDG_CONFIG_HOME" => nil) do
        allow(Dir).to receive(:home).and_return("")
        expected = File.join(described_class.web_root, ".config", "potato-mesh")
        expect(described_class.config_directory).to eq(expected)
      end
    ensure
      allow(Dir).to receive(:home).and_call_original
    end
  end

  describe ".legacy_config_directory" do
    it "returns the repository managed configuration directory" do
      expect(described_class.legacy_config_directory).to eq(
        File.join(described_class.web_root, ".config"),
      )
    end
  end

  describe ".legacy_keyfile_path" do
    it "returns the legacy keyfile location" do
      expect(described_class.legacy_keyfile_path).to eq(
        File.join(described_class.web_root, ".config", "keyfile"),
      )
    end

    it "prefers repository config keyfiles when present" do
      Dir.mktmpdir do |dir|
        web_root = File.join(dir, "web")
        legacy_key = File.join(web_root, "config", "potato-mesh", "keyfile")
        FileUtils.mkdir_p(File.dirname(legacy_key))
        File.write(legacy_key, "legacy")

        allow(described_class).to receive(:web_root).and_return(web_root)

        expect(described_class.legacy_keyfile_path).to eq(legacy_key)
      end
    ensure
      allow(described_class).to receive(:web_root).and_call_original
    end
  end

  describe ".legacy_db_path" do
    it "returns the bundled database location" do
      expect(described_class.legacy_db_path).to eq(
        File.expand_path("../data/mesh.db", described_class.web_root),
      )
    end
  end

  describe ".legacy_well_known_candidates" do
    it "includes repository config directories" do
      Dir.mktmpdir do |dir|
        web_root = File.join(dir, "web")
        allow(described_class).to receive(:web_root).and_return(web_root)

        candidates = described_class.legacy_well_known_candidates
        expect(candidates).to include(
          File.join(web_root, "config", "potato-mesh", "well-known", "potato-mesh"),
        )
      end
    ensure
      allow(described_class).to receive(:web_root).and_call_original
    end
  end

  describe ".federation_announcement_interval" do
    it "returns eight hours in seconds" do
      expect(described_class.federation_announcement_interval).to eq(8 * 60 * 60)
    end
  end

  describe ".db_path" do
    it "uses the environment override when available" do
      within_env("MESH_DB" => "/tmp/spec.db") do
        expect(described_class.db_path).to eq("/tmp/spec.db")
      end
    end

    it "falls back to the bundled database path" do
      within_env("MESH_DB" => nil) do
        expect(described_class.db_path).to eq(described_class.default_db_path)
      end
    end
  end

  describe ".max_json_body_bytes" do
    it "returns the default when the value is missing" do
      within_env("MAX_JSON_BODY_BYTES" => nil) do
        expect(described_class.max_json_body_bytes).to eq(
          described_class.default_max_json_body_bytes,
        )
      end
    end

    it "returns the parsed integer when valid" do
      within_env("MAX_JSON_BODY_BYTES" => "2048") do
        expect(described_class.max_json_body_bytes).to eq(2048)
      end
    end

    it "rejects invalid and non-positive values" do
      within_env("MAX_JSON_BODY_BYTES" => "potato") do
        expect(described_class.max_json_body_bytes).to eq(
          described_class.default_max_json_body_bytes,
        )
      end

      within_env("MAX_JSON_BODY_BYTES" => "0") do
        expect(described_class.max_json_body_bytes).to eq(
          described_class.default_max_json_body_bytes,
        )
      end
    end
  end

  describe ".refresh_interval_seconds" do
    it "returns the default when the configuration is invalid" do
      within_env("REFRESH_INTERVAL_SECONDS" => "invalid") do
        expect(described_class.refresh_interval_seconds).to eq(
          described_class.default_refresh_interval_seconds,
        )
      end
    end

    it "honours positive integer overrides" do
      within_env("REFRESH_INTERVAL_SECONDS" => "120") do
        expect(described_class.refresh_interval_seconds).to eq(120)
      end
    end

    it "rejects zero or negative overrides" do
      within_env("REFRESH_INTERVAL_SECONDS" => "0") do
        expect(described_class.refresh_interval_seconds).to eq(
          described_class.default_refresh_interval_seconds,
        )
      end
    end
  end

  describe ".prom_report_id_list" do
    it "splits and normalises identifiers" do
      within_env("PROM_REPORT_IDS" => " alpha , beta,, ") do
        expect(described_class.prom_report_id_list).to eq(%w[alpha beta])
      end
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
