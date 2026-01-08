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

  describe ".private_mode_enabled?" do
    it "returns false when PRIVATE is unset" do
      within_env("PRIVATE" => nil) do
        expect(described_class.private_mode_enabled?).to be(false)
      end
    end

    it "returns false when PRIVATE=0" do
      within_env("PRIVATE" => "0") do
        expect(described_class.private_mode_enabled?).to be(false)
      end
    end

    it "returns true when PRIVATE=1" do
      within_env("PRIVATE" => "1") do
        expect(described_class.private_mode_enabled?).to be(true)
      end
    end

    it "ignores surrounding whitespace" do
      within_env("PRIVATE" => "  1  ") do
        expect(described_class.private_mode_enabled?).to be(true)
      end
    end
  end

  describe ".federation_enabled?" do
    it "returns true when FEDERATION is unset" do
      within_env("FEDERATION" => nil, "PRIVATE" => "0") do
        expect(described_class.federation_enabled?).to be(true)
      end
    end

    it "returns false when FEDERATION=0" do
      within_env("FEDERATION" => "0", "PRIVATE" => "0") do
        expect(described_class.federation_enabled?).to be(false)
      end
    end

    it "returns false when PRIVATE=1" do
      within_env("FEDERATION" => "1", "PRIVATE" => "1") do
        expect(described_class.federation_enabled?).to be(false)
      end
    end

    it "ignores surrounding whitespace" do
      within_env("FEDERATION" => " 0 ", "PRIVATE" => "0") do
        expect(described_class.federation_enabled?).to be(false)
      end
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

  describe ".remote_instance_http_timeout" do
    it "returns the baked-in connect timeout when unset" do
      within_env("REMOTE_INSTANCE_CONNECT_TIMEOUT" => nil) do
        expect(described_class.remote_instance_http_timeout).to eq(
          PotatoMesh::Config::DEFAULT_REMOTE_INSTANCE_CONNECT_TIMEOUT,
        )
      end
    end

    it "accepts positive environment overrides" do
      within_env("REMOTE_INSTANCE_CONNECT_TIMEOUT" => "27") do
        expect(described_class.remote_instance_http_timeout).to eq(27)
      end
    end

    it "rejects non-positive overrides" do
      within_env("REMOTE_INSTANCE_CONNECT_TIMEOUT" => "0") do
        expect(described_class.remote_instance_http_timeout).to eq(
          PotatoMesh::Config::DEFAULT_REMOTE_INSTANCE_CONNECT_TIMEOUT,
        )
      end
    end
  end

  describe ".remote_instance_read_timeout" do
    it "returns the baked-in read timeout when unset" do
      within_env("REMOTE_INSTANCE_READ_TIMEOUT" => nil) do
        expect(described_class.remote_instance_read_timeout).to eq(
          PotatoMesh::Config::DEFAULT_REMOTE_INSTANCE_READ_TIMEOUT,
        )
      end
    end

    it "accepts positive overrides" do
      within_env("REMOTE_INSTANCE_READ_TIMEOUT" => "20") do
        expect(described_class.remote_instance_read_timeout).to eq(20)
      end
    end

    it "rejects non-positive overrides" do
      within_env("REMOTE_INSTANCE_READ_TIMEOUT" => "-5") do
        expect(described_class.remote_instance_read_timeout).to eq(
          PotatoMesh::Config::DEFAULT_REMOTE_INSTANCE_READ_TIMEOUT,
        )
      end
    end
  end

  describe ".federation_max_instances_per_response" do
    it "returns the baked-in response limit when unset" do
      within_env("FEDERATION_MAX_INSTANCES_PER_RESPONSE" => nil) do
        expect(described_class.federation_max_instances_per_response).to eq(
          PotatoMesh::Config::DEFAULT_FEDERATION_MAX_INSTANCES_PER_RESPONSE,
        )
      end
    end

    it "accepts positive overrides" do
      within_env("FEDERATION_MAX_INSTANCES_PER_RESPONSE" => "7") do
        expect(described_class.federation_max_instances_per_response).to eq(7)
      end
    end

    it "rejects non-positive overrides" do
      within_env("FEDERATION_MAX_INSTANCES_PER_RESPONSE" => "0") do
        expect(described_class.federation_max_instances_per_response).to eq(
          PotatoMesh::Config::DEFAULT_FEDERATION_MAX_INSTANCES_PER_RESPONSE,
        )
      end
    end
  end

  describe ".federation_max_domains_per_crawl" do
    it "returns the baked-in crawl limit when unset" do
      within_env("FEDERATION_MAX_DOMAINS_PER_CRAWL" => nil) do
        expect(described_class.federation_max_domains_per_crawl).to eq(
          PotatoMesh::Config::DEFAULT_FEDERATION_MAX_DOMAINS_PER_CRAWL,
        )
      end
    end

    it "accepts positive overrides" do
      within_env("FEDERATION_MAX_DOMAINS_PER_CRAWL" => "11") do
        expect(described_class.federation_max_domains_per_crawl).to eq(11)
      end
    end

    it "rejects invalid overrides" do
      within_env("FEDERATION_MAX_DOMAINS_PER_CRAWL" => "-5") do
        expect(described_class.federation_max_domains_per_crawl).to eq(
          PotatoMesh::Config::DEFAULT_FEDERATION_MAX_DOMAINS_PER_CRAWL,
        )
      end
    end
  end

  describe ".federation_worker_pool_size" do
    it "returns the baked-in pool size when unset" do
      within_env("FEDERATION_WORKERS" => nil) do
        expect(described_class.federation_worker_pool_size).to eq(
          PotatoMesh::Config::DEFAULT_FEDERATION_WORKER_POOL_SIZE,
        )
      end
    end

    it "accepts positive overrides" do
      within_env("FEDERATION_WORKERS" => "9") do
        expect(described_class.federation_worker_pool_size).to eq(9)
      end
    end

    it "rejects invalid overrides" do
      within_env("FEDERATION_WORKERS" => "0") do
        expect(described_class.federation_worker_pool_size).to eq(
          PotatoMesh::Config::DEFAULT_FEDERATION_WORKER_POOL_SIZE,
        )
      end
    end
  end

  describe ".federation_worker_queue_capacity" do
    it "returns the baked-in queue capacity when unset" do
      within_env("FEDERATION_WORK_QUEUE" => nil) do
        expect(described_class.federation_worker_queue_capacity).to eq(
          PotatoMesh::Config::DEFAULT_FEDERATION_WORKER_QUEUE_CAPACITY,
        )
      end
    end

    it "accepts positive overrides" do
      within_env("FEDERATION_WORK_QUEUE" => "33") do
        expect(described_class.federation_worker_queue_capacity).to eq(33)
      end
    end

    it "rejects invalid overrides" do
      within_env("FEDERATION_WORK_QUEUE" => "-1") do
        expect(described_class.federation_worker_queue_capacity).to eq(
          PotatoMesh::Config::DEFAULT_FEDERATION_WORKER_QUEUE_CAPACITY,
        )
      end
    end
  end

  describe ".federation_task_timeout_seconds" do
    it "returns the baked-in timeout when unset" do
      within_env("FEDERATION_TASK_TIMEOUT" => nil) do
        expect(described_class.federation_task_timeout_seconds).to eq(
          PotatoMesh::Config::DEFAULT_FEDERATION_TASK_TIMEOUT_SECONDS,
        )
      end
    end

    it "accepts positive overrides" do
      within_env("FEDERATION_TASK_TIMEOUT" => "47") do
        expect(described_class.federation_task_timeout_seconds).to eq(47)
      end
    end

    it "rejects invalid overrides" do
      within_env("FEDERATION_TASK_TIMEOUT" => "-7") do
        expect(described_class.federation_task_timeout_seconds).to eq(
          PotatoMesh::Config::DEFAULT_FEDERATION_TASK_TIMEOUT_SECONDS,
        )
      end
    end
  end

  describe ".db_path" do
    it "returns the default path inside the data directory" do
      expect(described_class.db_path).to eq(described_class.default_db_path)
      expect(described_class.db_path).to eq(File.join(described_class.data_directory, "mesh.db"))
    end
  end

  describe ".max_json_body_bytes" do
    it "returns the baked-in default size" do
      expect(described_class.max_json_body_bytes).to eq(described_class.default_max_json_body_bytes)
    end
  end

  describe ".refresh_interval_seconds" do
    it "returns the baked-in refresh cadence" do
      expect(described_class.refresh_interval_seconds).to eq(described_class.default_refresh_interval_seconds)
    end
  end

  describe ".prom_report_id_list" do
    it "returns an empty collection when no identifiers are configured" do
      expect(described_class.prom_report_id_list).to eq([])
    end
  end

  describe ".channel" do
    it "returns the default channel when unset" do
      within_env("CHANNEL" => nil) do
        expect(described_class.channel).to eq(PotatoMesh::Config::DEFAULT_CHANNEL)
      end
    end

    it "trims whitespace from overrides" do
      within_env("CHANNEL" => "  #Spec  ") do
        expect(described_class.channel).to eq("#Spec")
      end
    end
  end

  describe ".frequency" do
    it "returns the default frequency when unset" do
      within_env("FREQUENCY" => nil) do
        expect(described_class.frequency).to eq(PotatoMesh::Config::DEFAULT_FREQUENCY)
      end
    end

    it "trims whitespace from overrides" do
      within_env("FREQUENCY" => " 915MHz  ") do
        expect(described_class.frequency).to eq("915MHz")
      end
    end
  end

  describe ".map_center" do
    it "parses latitude and longitude from the environment" do
      within_env("MAP_CENTER" => "10.5, -20.25") do
        expect(described_class.map_center).to eq({ lat: 10.5, lon: -20.25 })
      end
    end

    it "falls back to defaults when parsing fails" do
      within_env("MAP_CENTER" => "potato") do
        expect(described_class.map_center).to eq({ lat: PotatoMesh::Config::DEFAULT_MAP_CENTER_LAT, lon: PotatoMesh::Config::DEFAULT_MAP_CENTER_LON })
      end
    end
  end

  describe ".map_zoom" do
    it "returns nil when the override is not provided" do
      within_env("MAP_ZOOM" => nil) do
        expect(described_class.map_zoom).to be_nil
      end
    end

    it "parses positive numeric overrides" do
      within_env("MAP_ZOOM" => "11") do
        expect(described_class.map_zoom).to eq(11.0)
      end
    end

    it "rejects non-positive or invalid overrides" do
      within_env("MAP_ZOOM" => "0") do
        expect(described_class.map_zoom).to be_nil
      end

      within_env("MAP_ZOOM" => "potato") do
        expect(described_class.map_zoom).to be_nil
      end
    end
  end

  describe ".max_distance_km" do
    it "returns the default distance when unset" do
      within_env("MAX_DISTANCE" => nil) do
        expect(described_class.max_distance_km).to eq(PotatoMesh::Config::DEFAULT_MAX_DISTANCE_KM)
      end
    end

    it "parses positive numeric overrides" do
      within_env("MAX_DISTANCE" => "105.5") do
        expect(described_class.max_distance_km).to eq(105.5)
      end
    end

    it "rejects invalid overrides" do
      within_env("MAX_DISTANCE" => "-1") do
        expect(described_class.max_distance_km).to eq(PotatoMesh::Config::DEFAULT_MAX_DISTANCE_KM)
      end
    end
  end

  describe ".contact_link" do
    it "returns the default contact when unset" do
      within_env("CONTACT_LINK" => nil) do
        expect(described_class.contact_link).to eq(PotatoMesh::Config::DEFAULT_CONTACT_LINK)
      end
    end

    it "trims whitespace from overrides" do
      within_env("CONTACT_LINK" => "  https://example.org/chat  ") do
        expect(described_class.contact_link).to eq("https://example.org/chat")
      end
    end
  end

  describe ".contact_link_url" do
    it "builds a matrix.to URL for aliases" do
      within_env("CONTACT_LINK" => "#spec:example.org") do
        expect(described_class.contact_link_url).to eq("https://matrix.to/#/#spec:example.org")
      end
    end

    it "passes through existing URLs" do
      within_env("CONTACT_LINK" => "https://example.org/chat") do
        expect(described_class.contact_link_url).to eq("https://example.org/chat")
      end
    end

    it "returns nil for unrecognised values" do
      within_env("CONTACT_LINK" => "Community Portal") do
        expect(described_class.contact_link_url).to be_nil
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

  describe ".announcement" do
    it "returns nil when unset or blank" do
      within_env("ANNOUNCEMENT" => nil) do
        expect(described_class.announcement).to be_nil
      end

      within_env("ANNOUNCEMENT" => " \t ") do
        expect(described_class.announcement).to be_nil
      end
    end

    it "returns the trimmed announcement text" do
      within_env("ANNOUNCEMENT" => "  Next Meetup  ") do
        expect(described_class.announcement).to eq("Next Meetup")
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
