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
require "sqlite3"
require "json"
require "time"
require "base64"
require "uri"
require "socket"

RSpec.describe "Potato Mesh Sinatra app" do
  let(:app) { Sinatra::Application }
  let(:application_class) { PotatoMesh::Application }

  describe "configuration" do
    it "sets the default HTTP port to the baked-in value" do
      expect(app.settings.port).to eq(PotatoMesh::Application::DEFAULT_PORT)
    end
  end

  describe ".resolve_port" do
    around do |example|
      original_port = ENV["PORT"]
      begin
        example.run
      ensure
        if original_port
          ENV["PORT"] = original_port
        else
          ENV.delete("PORT")
        end
      end
    end

    it "returns the baked-in default port when PORT is not provided" do
      ENV.delete("PORT")
      expect(application_class.resolve_port).to eq(PotatoMesh::Application::DEFAULT_PORT)
    end

    it "honours a valid PORT override" do
      ENV["PORT"] = "51515"
      expect(application_class.resolve_port).to eq(51_515)
    end

    it "falls back to the default for invalid PORT values" do
      ENV["PORT"] = "abc"
      expect(application_class.resolve_port).to eq(PotatoMesh::Application::DEFAULT_PORT)

      ENV["PORT"] = "70000"
      expect(application_class.resolve_port).to eq(PotatoMesh::Application::DEFAULT_PORT)

      ENV["PORT"] = "0"
      expect(application_class.resolve_port).to eq(PotatoMesh::Application::DEFAULT_PORT)
    end
  end

  # Return the absolute filesystem path to the requested fixture.
  #
  # @param name [String] fixture filename relative to the tests directory.
  # @return [String] absolute path to the fixture file.
  def fixture_path(name)
    File.expand_path("../../tests/#{name}", __dir__)
  end

  # Execute the provided block with a configured SQLite connection.
  #
  # @param readonly [Boolean] whether to open the database in read-only mode.
  # @yieldparam db [SQLite3::Database] open database handle.
  # @return [void]
  def with_db(readonly: false)
    db = SQLite3::Database.new(PotatoMesh::Config.db_path, readonly: readonly)
    db.busy_timeout = PotatoMesh::Config.db_busy_timeout_ms
    db.execute("PRAGMA foreign_keys = ON")
    yield db
  ensure
    db&.close
  end

  # Remove all rows from the tables used by the application under test.
  #
  # @return [void]
  def clear_database
    with_db do |db|
      db.execute("DELETE FROM instances")
      db.execute("DELETE FROM trace_hops")
      db.execute("DELETE FROM traces")
      db.execute("DELETE FROM neighbors")
      db.execute("DELETE FROM messages")
      db.execute("DELETE FROM nodes")
      db.execute("DELETE FROM positions")
      db.execute("DELETE FROM telemetry")
    end
    ensure_self_instance_record!
  end

  # Retrieve the number of rows stored in the instances table.
  #
  # @return [Integer] count of stored instance records.
  def instance_count
    with_db(readonly: true) do |db|
      db.get_first_value("SELECT COUNT(*) FROM instances").to_i
    end
  end

  # Build a hash excluding entries whose values are nil.
  #
  # @param hash [Hash] collection filtered for nil values.
  # @return [Hash] hash containing only keys with non-nil values.
  def reject_nil_values(hash)
    hash.reject { |_, value| value.nil? }
  end

  # Construct a request payload mirroring the structure produced by the daemon.
  #
  # @param node [Hash] node attributes from the fixture dataset.
  # @return [Hash] payload formatted for the API.
  def build_node_payload(node)
    payload = {
      "user" => reject_nil_values(
        "shortName" => node["short_name"],
        "longName" => node["long_name"],
        "hwModel" => node["hw_model"],
        "role" => node["role"],
      ),
      "hwModel" => node["hw_model"],
      "lastHeard" => node["last_heard"],
      "snr" => node["snr"],
    }

    metrics = reject_nil_values(
      "batteryLevel" => node["battery_level"],
      "voltage" => node["voltage"],
      "channelUtilization" => node["channel_utilization"],
      "airUtilTx" => node["air_util_tx"],
      "uptimeSeconds" => node["uptime_seconds"],
    )
    payload["deviceMetrics"] = metrics unless metrics.empty?

    position = reject_nil_values(
      "time" => node["position_time"],
      "latitude" => node["latitude"],
      "longitude" => node["longitude"],
      "altitude" => node["altitude"],
      "locationSource" => node["location_source"],
      "precisionBits" => node["precision_bits"],
    )
    payload["position"] = position unless position.empty?

    payload["lora_freq"] = node["lora_freq"] if node.key?("lora_freq")
    payload["modem_preset"] = node["modem_preset"] if node.key?("modem_preset")

    payload
  end

  # Determine the expected last heard timestamp for a node fixture.
  #
  # @param node [Hash] node attributes from the fixture dataset.
  # @return [Integer, nil] canonical last heard timestamp.
  def expected_last_heard(node)
    [node["last_heard"], node["position_time"]].compact.max
  end

  # Assemble the expected row persisted in the nodes table.
  #
  # @param node [Hash] node attributes from the fixture dataset.
  # @return [Hash] expected database row for assertions.
  def expected_node_row(node)
    final_last = expected_last_heard(node)
    {
      "node_id" => node["node_id"],
      "short_name" => node["short_name"],
      "long_name" => node["long_name"],
      "hw_model" => node["hw_model"],
      "role" => node["role"] || "CLIENT",
      "snr" => node["snr"],
      "battery_level" => node["battery_level"],
      "voltage" => node["voltage"],
      "last_heard" => final_last,
      "first_heard" => final_last,
      "uptime_seconds" => node["uptime_seconds"],
      "channel_utilization" => node["channel_utilization"],
      "air_util_tx" => node["air_util_tx"],
      "position_time" => node["position_time"],
      "location_source" => node["location_source"],
      "precision_bits" => node["precision_bits"],
      "latitude" => node["latitude"],
      "longitude" => node["longitude"],
      "altitude" => node["altitude"],
      "lora_freq" => node["lora_freq"],
      "modem_preset" => node["modem_preset"],
    }
  end

  # Assert equality while supporting tolerance for floating point comparisons.
  #
  # @param actual [Object] observed value.
  # @param expected [Object] expected value.
  # @param tolerance [Float] acceptable delta for floating point values.
  # @return [void]
  def expect_same_value(actual, expected, tolerance: 1e-6)
    if expected.nil?
      expect(actual).to be_nil
    elsif expected.is_a?(Float)
      expect(actual).to be_within(tolerance).of(expected)
    else
      expect(actual).to eq(expected)
    end
  end

  # Assert that an API response either omits blank values or matches the
  # expected non-blank value.
  #
  # @param row [Hash] API response payload.
  # @param key [String] attribute to inspect.
  # @param expected [Object] canonical value from fixtures.
  # @return [void]
  def expect_api_value(row, key, expected)
    if expected.is_a?(String) && expected.strip.empty?
      expect(row).not_to have_key(key), "expected #{key} to be omitted"
    elsif expected.nil?
      expect(row).not_to have_key(key), "expected #{key} to be omitted"
    else
      expect_same_value(row[key], expected)
    end
  end

  # Import all nodes defined in the fixture file via the HTTP API.
  #
  # @return [void]
  def import_nodes_fixture
    nodes_fixture.each do |node|
      payload = { node["node_id"] => build_node_payload(node) }
      post "/api/nodes", payload.to_json, auth_headers
      expect(last_response).to be_ok
      expect(JSON.parse(last_response.body)).to eq("status" => "ok")
    end
  end

  # Import all messages defined in the fixture file via the HTTP API.
  #
  # @return [void]
  def import_messages_fixture
    messages_fixture.each do |message|
      payload = message.reject { |key, _| key == "node" }
      post "/api/messages", payload.to_json, auth_headers
      expect(last_response).to be_ok
      expect(JSON.parse(last_response.body)).to eq("status" => "ok")
    end
  end

  let(:api_token) { "spec-token" }
  let(:auth_headers) do
    {
      "CONTENT_TYPE" => "application/json",
      "HTTP_AUTHORIZATION" => "Bearer #{api_token}",
    }
  end
  let(:nodes_fixture) { JSON.parse(File.read(fixture_path("nodes.json"))) }
  let(:messages_fixture) { JSON.parse(File.read(fixture_path("messages.json"))) }
  let(:telemetry_fixture) { JSON.parse(File.read(fixture_path("telemetry.json"))) }
  let(:trace_fixture) do
    [
      {
        "id" => 9_001,
        "request_id" => 17,
        "src" => 2_658_361_180,
        "dest" => 4_242_424_242,
        "rx_time" => reference_time.to_i - 2,
        "hops" => [2_658_361_180, 19_088_743, 4_242_424_242],
        "rssi" => -83,
        "snr" => 5.0,
        "elapsed_ms" => 842,
      },
      {
        "packet_id" => 9_002,
        "req" => 21,
        "from" => 19_088_743,
        "destination" => 2_658_361_180,
        "rx_time" => reference_time.to_i - 5,
        "path" => [{ "node_id" => "0xbeadf00d" }, { "node_id" => 19_088_743 }],
        "metrics" => { "snr" => 3.5, "latency_ms" => 1_020 },
      },
    ]
  end
  let(:reference_time) do
    latest = nodes_fixture.map { |node| node["last_heard"] }.compact.max
    Time.at((latest || Time.now.to_i) + 1000)
  end

  describe "federation announcers" do
    class DummyThread
      attr_accessor :name, :report_on_exception, :block

      def alive?
        false
      end
    end

    let(:dummy_thread) { DummyThread.new }

    before do
      app.set(:initial_federation_thread, nil)
      app.set(:federation_thread, nil)
    end

    it "stores and clears the initial federation thread" do
      delay = 3
      allow(PotatoMesh::Config).to receive(:initial_federation_delay_seconds).and_return(delay)
      expect(Kernel).to receive(:sleep).with(delay)
      expect(app).to receive(:announce_instance_to_all_domains)
      allow(Thread).to receive(:new) do |&block|
        dummy_thread.block = block
        dummy_thread
      end

      result = app.start_initial_federation_announcement!

      expect(result).to be(dummy_thread)
      expect(app.settings.initial_federation_thread).to be(dummy_thread)
      expect(dummy_thread.block).not_to be_nil

      expect { dummy_thread.block.call }.to change {
        app.settings.initial_federation_thread
      }.from(dummy_thread).to(nil)
    end

    it "stores the recurring federation announcer thread" do
      allow(Thread).to receive(:new) do |&block|
        dummy_thread.block = block
        dummy_thread
      end

      result = app.start_federation_announcer!

      expect(result).to be(dummy_thread)
      expect(app.settings.federation_thread).to be(dummy_thread)
    end

    context "when federation is disabled" do
      around do |example|
        original = ENV["FEDERATION"]
        begin
          ENV["FEDERATION"] = "0"
          example.run
        ensure
          if original.nil?
            ENV.delete("FEDERATION")
          else
            ENV["FEDERATION"] = original
          end
        end
      end

      it "does not start the initial announcement thread" do
        expect(Thread).not_to receive(:new)

        result = app.start_initial_federation_announcement!

        expect(result).to be_nil
        expect(app.settings.respond_to?(:initial_federation_thread) ? app.settings.initial_federation_thread : nil).to be_nil
      end

      it "does not start the recurring announcer thread" do
        expect(Thread).not_to receive(:new)

        result = app.start_federation_announcer!

        expect(result).to be_nil
        expect(app.settings.federation_thread).to be_nil
      end
    end
  end

  before do
    @original_token = ENV["API_TOKEN"]
    @original_private = ENV["PRIVATE"]
    ENV["API_TOKEN"] = api_token
    ENV.delete("PRIVATE")
    allow(Time).to receive(:now).and_return(reference_time)
    clear_database
  end

  after do
    ENV["API_TOKEN"] = @original_token
    if @original_private.nil?
      ENV.delete("PRIVATE")
    else
      ENV["PRIVATE"] = @original_private
    end
  end

  describe "helper utilities" do
    describe "#fetch_config_string" do
      around do |example|
        key = "SPEC_FETCH"
        original = ENV[key]
        begin
          ENV.delete(key)
          example.run
        ensure
          if original.nil?
            ENV.delete(key)
          else
            ENV[key] = original
          end
        end
      end

      it "returns the default when the environment variable is missing" do
        expect(fetch_config_string("SPEC_FETCH", "fallback")).to eq("fallback")
      end

      it "strips whitespace and rejects blank overrides" do
        ENV["SPEC_FETCH"] = "  \t  "
        expect(fetch_config_string("SPEC_FETCH", "fallback")).to eq("fallback")

        ENV["SPEC_FETCH"] = "  override  "
        expect(fetch_config_string("SPEC_FETCH", "fallback")).to eq("override")
      end
    end

    describe "#determine_instance_domain" do
      around do |example|
        original = ENV["INSTANCE_DOMAIN"]
        begin
          ENV.delete("INSTANCE_DOMAIN")
          example.run
        ensure
          if original.nil?
            ENV.delete("INSTANCE_DOMAIN")
          else
            ENV["INSTANCE_DOMAIN"] = original
          end
        end
      end

      it "uses the environment override when provided" do
        ENV["INSTANCE_DOMAIN"] = "  example.org  "

        domain, source = determine_instance_domain

        expect(domain).to eq("example.org")
        expect(source).to eq(:environment)
      end

      it "normalises scheme-based environment overrides" do
        ENV["INSTANCE_DOMAIN"] = " https://Example.Org "

        domain, source = determine_instance_domain

        expect(domain).to eq("example.org")
        expect(source).to eq(:environment)
      end

      it "allows IP addresses configured via the environment" do
        ENV["INSTANCE_DOMAIN"] = "http://127.0.0.1"

        domain, source = determine_instance_domain

        expect(domain).to eq("127.0.0.1")
        expect(source).to eq(:environment)
      end

      it "rejects instance domains containing path components" do
        ENV["INSTANCE_DOMAIN"] = "https://example.org/app"

        expect { determine_instance_domain }.to raise_error(
          RuntimeError,
          /must not include a path component/,
        )
      end

      it "falls back to reverse DNS when available" do
        address = Addrinfo.ip("203.0.113.10")
        allow(Socket).to receive(:ip_address_list).and_return([address])
        allow(Resolv).to receive(:getname).with("203.0.113.10").and_return("chara.htznr.fault.dev")

        domain, source = determine_instance_domain

        expect(domain).to eq("chara.htznr.fault.dev")
        expect(source).to eq(:reverse_dns)
      end

      it "falls back to a public IP address when reverse DNS is unavailable" do
        public_address = Addrinfo.ip("203.0.113.20")
        allow(Socket).to receive(:ip_address_list).and_return([public_address])
        allow(Resolv).to receive(:getname).and_raise(Resolv::ResolvError)

        domain, source = determine_instance_domain

        expect(domain).to eq("203.0.113.20")
        expect(source).to eq(:public_ip)
      end

      it "falls back to a protected IP address when only private networks exist" do
        private_address = Addrinfo.ip("10.0.0.5")
        allow(Socket).to receive(:ip_address_list).and_return([private_address])
        allow(Resolv).to receive(:getname).and_raise(Resolv::ResolvError)

        domain, source = determine_instance_domain

        expect(domain).to eq("10.0.0.5")
        expect(source).to eq(:protected_ip)
      end

      it "falls back to a local IP address when no other sources are available" do
        loopback_address = Addrinfo.ip("127.0.0.1")
        allow(Socket).to receive(:ip_address_list).and_return([loopback_address])
        allow(Resolv).to receive(:getname).and_raise(Resolv::ResolvError)

        domain, source = determine_instance_domain

        expect(domain).to eq("127.0.0.1")
        expect(source).to eq(:local_ip)
      end
    end

    describe ".locate_git_repo_root" do
      it "returns nil when a git directory cannot be found" do
        nested_dir = Dir.mktmpdir("potato-mesh-no-git-")
        begin
          deep_dir = File.join(nested_dir, "a", "b", "c")
          FileUtils.mkdir_p(deep_dir)

          result = application_class.send(:locate_git_repo_root, deep_dir)
          expect(result).to be_nil
        ensure
          FileUtils.remove_entry(nested_dir)
        end
      end

      it "locates a git directory" do
        nested_dir = Dir.mktmpdir("potato-mesh-with-git-")
        begin
          repo_root = File.join(nested_dir, "repo")
          FileUtils.mkdir_p(File.join(repo_root, ".git"))
          deep_dir = File.join(repo_root, "lib", "potato")
          FileUtils.mkdir_p(deep_dir)

          result = application_class.send(:locate_git_repo_root, deep_dir)
          expect(result).to eq(repo_root)
        ensure
          FileUtils.remove_entry(nested_dir)
        end
      end

      it "recognises git worktree files" do
        nested_dir = Dir.mktmpdir("potato-mesh-worktree-")
        begin
          repo_root = File.join(nested_dir, "worktree")
          FileUtils.mkdir_p(repo_root)
          File.write(File.join(repo_root, ".git"), "gitdir: /tmp/worktree")
          deep_dir = File.join(repo_root, "app", "lib")
          FileUtils.mkdir_p(deep_dir)

          result = application_class.send(:locate_git_repo_root, deep_dir)
          expect(result).to eq(repo_root)
        ensure
          FileUtils.remove_entry(nested_dir)
        end
      end
    end

    describe "#determine_app_version" do
      let(:repo_root) { File.expand_path("..", __dir__) }

      it "returns the fallback when the git directory is missing" do
        allow(application_class).to receive(:locate_git_repo_root).and_return(nil)

        expect(application_class.determine_app_version).to eq(PotatoMesh::Config.version_fallback)
      end

      it "returns the fallback when git describe fails" do
        allow(application_class).to receive(:locate_git_repo_root).and_return(repo_root)
        status = instance_double(Process::Status, success?: false)
        allow(Open3).to receive(:capture2).and_return(["ignored", status])

        expect(application_class.determine_app_version).to eq(PotatoMesh::Config.version_fallback)
      end

      it "returns the fallback when git describe output is empty" do
        allow(application_class).to receive(:locate_git_repo_root).and_return(repo_root)
        status = instance_double(Process::Status, success?: true)
        allow(Open3).to receive(:capture2).and_return(["\n", status])

        expect(application_class.determine_app_version).to eq(PotatoMesh::Config.version_fallback)
      end

      it "returns the original describe output when the format is unexpected" do
        allow(application_class).to receive(:locate_git_repo_root).and_return(repo_root)
        status = instance_double(Process::Status, success?: true)
        allow(Open3).to receive(:capture2).and_return(["weird-output", status])

        expect(application_class.determine_app_version).to eq("weird-output")
      end

      it "normalises the version when no commits are ahead of the tag" do
        allow(application_class).to receive(:locate_git_repo_root).and_return(repo_root)
        status = instance_double(Process::Status, success?: true)
        allow(Open3).to receive(:capture2).and_return(["v1.2.3-0-gabcdef1", status])

        expect(application_class.determine_app_version).to eq("v1.2.3")
      end

      it "includes commit metadata when ahead of the tag" do
        allow(application_class).to receive(:locate_git_repo_root).and_return(repo_root)
        status = instance_double(Process::Status, success?: true)
        allow(Open3).to receive(:capture2).and_return(["v1.2.3-5-gabcdef1", status])

        expect(application_class.determine_app_version).to eq("v1.2.3+5-abcdef1")
      end

      it "returns the fallback when git describe raises an error" do
        allow(application_class).to receive(:locate_git_repo_root).and_return(repo_root)
        allow(Open3).to receive(:capture2).and_raise(StandardError, "boom")

        expect(application_class.determine_app_version).to eq(PotatoMesh::Config.version_fallback)
      end
    end

    describe "string coercion helpers" do
      it "normalises strings and nil values" do
        expect(sanitized_string("  spaced  ")).to eq("spaced")
        expect(sanitized_string(nil)).to eq("")
      end

      it "returns nil for blank contact links" do
        allow(PotatoMesh::Config).to receive(:contact_link).and_return("  \t ")
        expect(sanitized_contact_link).to be_nil
      end

      it "coerces string_or_nil inputs" do
        expect(string_or_nil("  hello \n")).to eq("hello")
        expect(string_or_nil("   ")).to be_nil
        expect(string_or_nil(123)).to eq("123")
      end
    end

    describe "#coerce_integer" do
      it "coerces integers and floats" do
        expect(coerce_integer(5)).to eq(5)
        expect(coerce_integer(7.9)).to eq(7)
      end

      it "coerces numeric strings" do
        expect(coerce_integer(" 42 ")).to eq(42)
        expect(coerce_integer("0x1a")).to eq(26)
        expect(coerce_integer("12.8")).to eq(12)
      end

      it "returns nil for invalid values" do
        expect(coerce_integer("not-a-number")).to be_nil
        expect(coerce_integer(Float::INFINITY)).to be_nil
      end
    end

    describe "#coerce_float" do
      it "coerces numeric types" do
        expect(coerce_float(5)).to eq(5.0)
        expect(coerce_float(3.2)).to eq(3.2)
      end

      it "coerces numeric strings" do
        expect(coerce_float(" 8.5 ")).to eq(8.5)
      end

      it "returns nil for invalid inputs" do
        expect(coerce_float("bad")).to be_nil
        expect(coerce_float(Float::INFINITY)).to be_nil
      end
    end

    describe "JSON normalisation helpers" do
      it "normalises nested hashes" do
        input = { foo: { bar: 1, baz: [1, { qux: 2 }] } }
        result = normalize_json_value(input)
        expect(result).to eq("foo" => { "bar" => 1, "baz" => [1, { "qux" => 2 }] })
      end

      it "parses JSON strings into hashes" do
        json = '{"foo": {"bar": 1}}'
        expect(normalize_json_object(json)).to eq("foo" => { "bar" => 1 })
      end

      it "returns nil for invalid JSON objects" do
        expect(normalize_json_object("not json")).to be_nil
        expect(normalize_json_object(123)).to be_nil
      end
    end

    describe "distance helpers" do
      it "formats integers without trailing decimals" do
        expect(formatted_distance_km(120.0)).to eq("120")
        expect(formatted_distance_km(12.34)).to eq("12.3")
      end

      it "returns nil when the maximum distance is invalid" do
        allow(PotatoMesh::Config).to receive(:max_distance_km).and_return(-5)
        expect(sanitized_max_distance_km).to be_nil

        allow(PotatoMesh::Config).to receive(:max_distance_km).and_return("string")
        expect(sanitized_max_distance_km).to be_nil

        allow(PotatoMesh::Config).to receive(:max_distance_km).and_return(15.5)
        expect(sanitized_max_distance_km).to eq(15.5)
      end
    end

    describe "#secure_token_match?" do
      it "performs constant-time comparison for matching strings" do
        expect(secure_token_match?("abc", "abc")).to be(true)
      end

      it "returns false when inputs differ" do
        expect(secure_token_match?("abc", "xyz")).to be(false)
        expect(secure_token_match?("abc", nil)).to be(false)
      end

      it "handles secure compare errors" do
        stub_const("Rack::Utils::SecurityError", Class.new(StandardError))
        allow(Rack::Utils).to receive(:secure_compare).and_raise(Rack::Utils::SecurityError.new("boom"))
        expect(secure_token_match?("abc", "abc")).to be(false)
      end
    end

    describe "#with_busy_retry" do
      it "raises once the retry budget is exhausted" do
        attempts = 0

        expect do
          with_busy_retry(max_retries: 2, base_delay: 0.0) do
            attempts += 1
            raise SQLite3::BusyException if attempts <= 3
          end
        end.to raise_error(SQLite3::BusyException)

        expect(attempts).to eq(3)
      end
    end

    describe "#resolve_node_num" do
      it "reads numeric aliases from payloads" do
        expect(resolve_node_num(nil, "num" => 42)).to eq(42)
        expect(resolve_node_num(nil, "num" => 7.2)).to eq(7)
        expect(resolve_node_num(nil, "num" => " 123 ")).to eq(123)
        expect(resolve_node_num("!feedcafe", "num" => "feedcafe")).to eq(0xfeedcafe)
      end

      it "infers the numeric alias from the canonical identifier" do
        expect(resolve_node_num("!00ff00aa", {})).to eq(0x00ff00aa)
      end

      it "returns nil for invalid identifiers" do
        expect(resolve_node_num("!nothex", {})).to be_nil
        expect(resolve_node_num(nil, "num" => "")).to be_nil
        expect(resolve_node_num("", {})).to be_nil
      end
    end

    describe "#canonical_node_parts" do
      it "parses integers, strings, and fallbacks" do
        parts = canonical_node_parts(123, nil)
        expect(parts).to eq(["!0000007b", 123, "007B"])

        parts = canonical_node_parts("!feedcafe", nil)
        expect(parts).to eq(["!feedcafe", 0xfeedcafe, "CAFE"])

        parts = canonical_node_parts("0x10", nil)
        expect(parts).to eq(["!00000010", 16, "0010"])

        parts = canonical_node_parts(nil, 31)
        expect(parts).to eq(["!0000001f", 31, "001F"])
      end

      it "rejects invalid references" do
        expect(canonical_node_parts("", nil)).to be_nil
        expect(canonical_node_parts("not-valid", nil)).to be_nil
        expect(canonical_node_parts(-5, nil)).to be_nil
        expect(canonical_node_parts(Object.new, nil)).to be_nil
      end
    end

    describe "#ensure_unknown_node" do
      it "does not create duplicate placeholder nodes" do
        node_id = "!dupe0001"
        with_db do |db|
          db.execute("INSERT INTO nodes(node_id) VALUES (?)", [node_id])
          expect(ensure_unknown_node(db, node_id, nil, heard_time: reference_time.to_i)).to be_falsey
        end
      end
    end

    describe "#touch_node_last_seen" do
      it "updates nodes using fallback numeric identifiers" do
        node_id = "!12345678"
        node_num = 0x1234_5678
        rx_time = reference_time.to_i - 30

        with_db do |db|
          db.execute(
            "INSERT INTO nodes(node_id, num, last_heard, first_heard) VALUES (?,?,?,?)",
            [node_id, node_num, rx_time - 120, rx_time - 180],
          )

          updated = touch_node_last_seen(db, nil, node_num, rx_time: rx_time, source: :spec)
          expect(updated).to be_truthy
        end

        with_db(readonly: true) do |db|
          db.results_as_hash = true
          row = db.get_first_row(
            "SELECT last_heard, first_heard FROM nodes WHERE node_id = ?",
            [node_id],
          )
          expect(row["last_heard"]).to eq(rx_time)
          expect(row["first_heard"]).to eq(rx_time - 180)
        end
      end

      it "returns nil when the timestamp cannot be coerced" do
        with_db do |db|
          expect(touch_node_last_seen(db, "!unknown", nil, rx_time: " ")).to be_nil
        end
      end
    end

    describe "#normalize_node_id" do
      it "resolves numeric aliases to canonical identifiers" do
        node_id = "!alias000"
        with_db do |db|
          db.execute(
            "INSERT INTO nodes(node_id, num) VALUES (?, ?)",
            [node_id, 321],
          )
        end

        with_db(readonly: true) do |db|
          expect(normalize_node_id(db, "321")).to eq(node_id)
          expect(normalize_node_id(db, "!missing")).to be_nil
          expect(normalize_node_id(db, nil)).to be_nil
        end
      end
    end

    describe ".self_instance_domain" do
      around do |example|
        original_app_env = ENV["APP_ENV"]
        original_rack_env = ENV["RACK_ENV"]
        begin
          example.run
        ensure
          if original_app_env
            ENV["APP_ENV"] = original_app_env
          else
            ENV.delete("APP_ENV")
          end

          if original_rack_env
            ENV["RACK_ENV"] = original_rack_env
          else
            ENV.delete("RACK_ENV")
          end
        end
      end

      it "returns the sanitized domain when configuration is present" do
        ENV.delete("APP_ENV")
        stub_const("PotatoMesh::Application::INSTANCE_DOMAIN", " Example.Org ") do
          expect(application_class.self_instance_domain).to eq("example.org")
        end
      end

      it "returns nil when the domain is unavailable outside production" do
        ENV["APP_ENV"] = "development"
        stub_const("PotatoMesh::Application::INSTANCE_DOMAIN", nil) do
          expect(application_class.self_instance_domain).to be_nil
        end
      end

      it "raises when the domain is unavailable in production" do
        ENV["APP_ENV"] = "production"
        stub_const("PotatoMesh::Application::INSTANCE_DOMAIN", nil) do
          expect { application_class.self_instance_domain }.to raise_error(
            RuntimeError,
            "INSTANCE_DOMAIN could not be determined",
          )
        end
      end
    end

    describe ".self_instance_registration_decision" do
      let(:domain) { "spec.mesh.test" }

      it "rejects registration when the domain source is not the environment" do
        stub_const("PotatoMesh::Application::INSTANCE_DOMAIN_SOURCE", :reverse_dns) do
          allowed, reason = application_class.self_instance_registration_decision(domain)

          expect(allowed).to be(false)
          expect(reason).to eq("INSTANCE_DOMAIN source is reverse_dns")
        end
      end

      it "rejects registration when the domain is invalid" do
        stub_const("PotatoMesh::Application::INSTANCE_DOMAIN_SOURCE", :environment) do
          allowed, reason = application_class.self_instance_registration_decision(nil)

          expect(allowed).to be(false)
          expect(reason).to eq("INSTANCE_DOMAIN missing or invalid")
        end
      end

      it "rejects registration when the domain resolves to a restricted IP" do
        stub_const("PotatoMesh::Application::INSTANCE_DOMAIN_SOURCE", :environment) do
          allowed, reason = application_class.self_instance_registration_decision("127.0.0.1")

          expect(allowed).to be(false)
          expect(reason).to eq("INSTANCE_DOMAIN resolves to restricted IP")
        end
      end

      it "accepts registration when configuration is valid" do
        stub_const("PotatoMesh::Application::INSTANCE_DOMAIN_SOURCE", :environment) do
          allowed, reason = application_class.self_instance_registration_decision(domain)

          expect(allowed).to be(true)
          expect(reason).to be_nil
        end
      end
    end

    describe ".ensure_self_instance_record!" do
      it "persists the self instance when registration is allowed" do
        stub_const("PotatoMesh::Application::INSTANCE_DOMAIN_SOURCE", :environment) do
          stub_const("PotatoMesh::Application::INSTANCE_DOMAIN", "self.mesh") do
            with_db do |db|
              db.execute("DELETE FROM instances")
            end

            application_class.ensure_self_instance_record!

            expect(instance_count).to eq(1)
          end
        end
      end

      it "skips persistence when registration is not allowed" do
        stub_const("PotatoMesh::Application::INSTANCE_DOMAIN_SOURCE", :reverse_dns) do
          with_db do |db|
            db.execute("DELETE FROM instances")
          end

          application_class.ensure_self_instance_record!

          expect(instance_count).to eq(0)
        end
      end
    end
  end

  describe ".federation_target_domains" do
    it "prioritises seed domains before database records" do
      with_db do |db|
        db.execute(
          "INSERT INTO instances (id, domain, pubkey, name, version, channel, frequency, latitude, longitude, last_update_time, is_private, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            "remote-id",
            "Remote.Mesh",
            "pubkey",
            "Remote",
            "1.0.0",
            nil,
            nil,
            nil,
            nil,
            Time.now.to_i,
            0,
            "signature",
          ],
        )
      end

      targets = application_class.federation_target_domains("self.mesh")

      expect(targets.first).to eq("potatomesh.net")
      expect(targets).to include("remote.mesh")
      expect(targets).not_to include("self.mesh")
    end

    it "falls back to seeds when the database is unavailable" do
      allow(application_class).to receive(:open_database).and_raise(SQLite3::Exception.new("boom"))

      targets = application_class.federation_target_domains("self.mesh")

      expect(targets).to eq(["potatomesh.net"])
    end

    it "ignores remote instances that have not updated within a week" do
      with_db do |db|
        db.execute("DELETE FROM instances")
        stale_time = (Time.now.to_i - PotatoMesh::Config.week_seconds - 60)
        db.execute(
          "INSERT INTO instances (id, domain, pubkey, name, version, channel, frequency, latitude, longitude, last_update_time, is_private, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            "stale-id",
            "stale.mesh",
            "pubkey",
            "Stale",
            "1.0.0",
            nil,
            nil,
            nil,
            nil,
            stale_time,
            0,
            "signature",
          ],
        )
      end

      targets = application_class.federation_target_domains("self.mesh")

      expect(targets).to eq(["potatomesh.net"])
    end
  end

  describe ".latest_node_update_timestamp" do
    it "returns the maximum last_heard value" do
      with_db do |db|
        db.execute("DELETE FROM nodes")
        db.execute("INSERT INTO nodes (node_id, last_heard) VALUES (?, ?)", ["node-a", 100])
        db.execute("INSERT INTO nodes (node_id, last_heard) VALUES (?, ?)", ["node-b", 200])
      end

      expect(application_class.latest_node_update_timestamp).to eq(200)
    end

    it "returns nil when no nodes contain last_heard values" do
      with_db do |db|
        db.execute("DELETE FROM nodes")
      end

      expect(application_class.latest_node_update_timestamp).to be_nil
    end
  end

  describe ".build_well_known_document" do
    it "signs the payload and normalises the domain" do
      with_db do |db|
        db.execute("DELETE FROM nodes")
        db.execute("INSERT INTO nodes (node_id, last_heard) VALUES (?, ?)", ["node-z", 321])
      end

      stub_const("PotatoMesh::Application::INSTANCE_DOMAIN", "Example.NET") do
        json_output, signature = application_class.build_well_known_document
        document = JSON.parse(json_output)

        expect(document["domain"]).to eq("example.net")
        expect(document["lastUpdate"]).to eq(321)
        expect(document["signatureAlgorithm"]).to eq("rsa-sha256")
        expect(signature).to be_a(String)
        expect(signature).not_to be_empty
      end
    end
  end

  describe ".upsert_instance_record" do
    it "rejects restricted domains" do
      attributes = {
        id: "restricted",
        domain: "127.0.0.1",
        pubkey: application_class::INSTANCE_PUBLIC_KEY_PEM,
        name: nil,
        version: nil,
        channel: nil,
        frequency: nil,
        latitude: nil,
        longitude: nil,
        last_update_time: Time.now.to_i,
        is_private: false,
      }

      expect do
        with_db do |db|
          application_class.upsert_instance_record(db, attributes, "sig")
        end
      end.to raise_error(ArgumentError, "restricted domain")
    end
  end

  describe "logging configuration" do
    before do
      Sinatra::Application.apply_logger_level!
    end

    after do
      Sinatra::Application.apply_logger_level!
    end

    it "defaults to WARN when debug logging is disabled" do
      expect(Sinatra::Application.settings.logger.level).to eq(Logger::WARN)
    end

    it "switches to DEBUG when debug logging is enabled" do
      allow(PotatoMesh::Config).to receive(:debug?).and_return(true)
      Sinatra::Application.apply_logger_level!

      expect(Sinatra::Application.settings.logger.level).to eq(Logger::DEBUG)
    end
  end

  describe "GET /favicon.ico" do
    it "serves the bundled favicon when available" do
      get "/favicon.ico"
      expect(last_response).to be_ok
      expect(last_response.headers["Content-Type"]).to eq("image/vnd.microsoft.icon")
    end

    it "falls back to the SVG logo when the favicon is missing" do
      ico_path = File.join(Sinatra::Application.settings.public_folder, "favicon.ico")
      allow(File).to receive(:file?).and_call_original
      allow(File).to receive(:file?).with(ico_path).and_return(false)

      get "/favicon.ico"

      expect(last_response).to be_ok
      expect(last_response.headers["Content-Type"]).to eq("image/svg+xml")
    end
  end

  describe "GET /potatomesh-logo.svg" do
    it "serves the cached SVG asset when present" do
      get "/potatomesh-logo.svg"
      expect(last_response).to be_ok
      expect(last_response.headers["Content-Type"]).to eq("image/svg+xml")
    end

    it "returns 404 when the asset is missing" do
      svg_path = File.expand_path("potatomesh-logo.svg", Sinatra::Application.settings.public_folder)
      allow(File).to receive(:exist?).and_return(false)
      allow(File).to receive(:readable?).and_return(false)

      get "/potatomesh-logo.svg"

      expect(last_response.status).to eq(404)
    end
  end

  describe "GET /" do
    it "responds successfully" do
      get "/"
      expect(last_response).to be_ok
    end

    it "includes the application version in the footer" do
      get "/"
      expected = APP_VERSION.to_s.start_with?("v") ? APP_VERSION : "v#{APP_VERSION}"
      expect(last_response.body).to include(expected)
    end

    it "renders the responsive footer container" do
      get "/"

      expect(last_response.body).to include('<footer class="app-footer">')
      expect(last_response.body).to include('class="footer-content"')
    end

    it "renders the federation instance selector when federation is enabled" do
      get "/"

      expect(last_response.body).to include('id="instanceSelect"')
      expect(last_response.body).to include("Select region ...")
    end

    it "omits the instance selector when private mode is active" do
      allow(PotatoMesh::Config).to receive(:private_mode_enabled?).and_return(true)

      get "/"

      expect(last_response.body).not_to include('id="instanceSelect"')
    end

    it "omits the instance selector when federation is disabled" do
      allow(PotatoMesh::Config).to receive(:federation_enabled?).and_return(false)

      get "/"

      expect(last_response.body).not_to include('id="instanceSelect"')
    end

    it "includes SEO metadata from configuration" do
      allow(PotatoMesh::Config).to receive(:site_name).and_return("Spec Mesh Title")
      allow(PotatoMesh::Config).to receive(:channel).and_return("#SpecChannel")
      allow(PotatoMesh::Config).to receive(:frequency).and_return("915MHz")
      allow(PotatoMesh::Config).to receive(:max_distance_km).and_return(120.5)
      allow(PotatoMesh::Config).to receive(:contact_link).and_return(" #spec-room:example.org ")

      expected_description = "Live Meshtastic mesh map for Spec Mesh Title on #SpecChannel (915MHz). Track nodes, messages, and coverage in real time. Shows nodes within roughly 120.5 km of the map center. Join the community in #spec-room:example.org via chat."

      get "/"

      expect(last_response.body).to include(%(meta name="description" content="#{expected_description}" />))
      expect(last_response.body).to include('<meta property="og:title" content="Spec Mesh Title" />')
      expect(last_response.body).to include('<meta property="og:site_name" content="Spec Mesh Title" />')
      expect(last_response.body).to include('<meta name="twitter:image" content="http://example.org/potatomesh-logo.svg" />')
    end

    it "disables the auto-fit toggle when a map zoom override is configured" do
      allow(PotatoMesh::Config).to receive(:map_zoom).and_return(11.0)

      get "/"

      expect(last_response.body).to include('id="fitBounds" disabled="disabled"')
      expect(last_response.body).not_to include('id="fitBounds" checked="checked"')
    end
  end

  describe "GET /map" do
    it "renders the map in full-screen mode with filter controls" do
      get "/map"

      expect(last_response).to be_ok
      expect(last_response.body).to include('class="map-panel map-panel--full"')
      expect(last_response.body).to include('id="map"')
      expect(last_response.body).to include('id="filterInput"')
      expect(last_response.body).to include('id="autoRefresh"')
      expect(last_response.body).to include('id="refreshBtn"')
      expect(last_response.body).to include('id="status"')
      expect(last_response.body).to include('id="fitBounds"')
      expect(last_response.body).not_to include('<footer class="app-footer">')
    end

    it "disables the auto-fit toggle when a map zoom override is configured" do
      allow(PotatoMesh::Config).to receive(:map_zoom).and_return(9.5)

      get "/map"

      expect(last_response.body).to include('id="fitBounds" disabled="disabled"')
      expect(last_response.body).not_to include('id="fitBounds" checked="checked"')
    end
  end

  describe "GET /chat" do
    it "renders the chat container when chat is enabled" do
      get "/chat"

      expect(last_response).to be_ok
      expect(last_response.body).to include('class="chat-panel chat-panel--full"')
      expect(last_response.body).to include('id="filterInput"')
      expect(last_response.body).to include('id="autoRefresh"')
      expect(last_response.body).to include('id="refreshBtn"')
      expect(last_response.body).to include('id="status"')
      expect(last_response.body).not_to include('<footer class="app-footer">')
    end

    it "shows a disabled message when private mode is active" do
      allow(PotatoMesh::Config).to receive(:private_mode_enabled?).and_return(true)

      get "/chat"

      expect(last_response).to be_ok
      expect(last_response.body).to include("Chat is unavailable while private mode is enabled.")
    end
  end

  describe "GET /nodes" do
    it "renders the nodes table in full-screen mode" do
      get "/nodes"

      expect(last_response).to be_ok
      expect(last_response.body).to include('class="nodes-table-wrapper"')
      expect(last_response.body).to include('id="nodes"')
      expect(last_response.body).to include('id="filterInput"')
      expect(last_response.body).to include('id="autoRefresh"')
      expect(last_response.body).to include('id="refreshBtn"')
      expect(last_response.body).to include('id="status"')
      expect(last_response.body).not_to include('<footer class="app-footer">')
    end
  end

  describe "database initialization" do
    it "creates the schema when booting" do
      expect(File).to exist(PotatoMesh::Config.db_path)

      db = SQLite3::Database.new(PotatoMesh::Config.db_path, readonly: true)
      tables = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('nodes','messages')").flatten

      expect(tables).to include("nodes")
      expect(tables).to include("messages")
    ensure
      db&.close
    end
  end

  describe "authentication" do
    it "rejects requests without a matching bearer token" do
      post "/api/nodes", {}.to_json, { "CONTENT_TYPE" => "application/json" }

      expect(last_response.status).to eq(403)
      expect(JSON.parse(last_response.body)).to eq("error" => "Forbidden")
    end

    it "rejects requests when the API token is not configured" do
      ENV["API_TOKEN"] = nil

      post "/api/messages", {}.to_json, { "CONTENT_TYPE" => "application/json" }

      expect(last_response.status).to eq(403)
      expect(JSON.parse(last_response.body)).to eq("error" => "Forbidden")
    ensure
      ENV["API_TOKEN"] = api_token
    end

    it "rejects requests with the wrong bearer token" do
      headers = auth_headers.merge("HTTP_AUTHORIZATION" => "Bearer wrong-token")

      post "/api/messages", {}.to_json, headers

      expect(last_response.status).to eq(403)
      expect(JSON.parse(last_response.body)).to eq("error" => "Forbidden")
    end

    it "does not accept alternate authorization schemes" do
      basic = Base64.strict_encode64("attacker:password")
      headers = auth_headers.merge("HTTP_AUTHORIZATION" => "Basic #{basic}")

      post "/api/nodes", {}.to_json, headers

      expect(last_response.status).to eq(403)
      expect(JSON.parse(last_response.body)).to eq("error" => "Forbidden")
    end

    it "rejects tokens with unexpected trailing characters" do
      headers = auth_headers.merge("HTTP_AUTHORIZATION" => "Bearer #{api_token} ")

      post "/api/messages", {}.to_json, headers

      expect(last_response.status).to eq(403)
      expect(JSON.parse(last_response.body)).to eq("error" => "Forbidden")
    end
  end

  describe "POST /api/instances" do
    let(:instance_key) { OpenSSL::PKey::RSA.new(2048) }
    let(:domain) { "mesh.example" }
    let(:pubkey) { instance_key.public_key.export }
    let(:last_update_time) { Time.now.to_i }
    let(:instance_attributes) do
      {
        id: "mesh-instance-1",
        domain: domain,
        pubkey: pubkey,
        name: "Example Mesh",
        version: "1.2.3",
        channel: "#MeshNet",
        frequency: "915MHz",
        latitude: 52.5,
        longitude: 13.4,
        last_update_time: last_update_time,
        is_private: false,
      }
    end
    let(:instance_signature_payload) do
      canonical_instance_payload(instance_attributes)
    end
    let(:instance_signature) do
      Base64.strict_encode64(
        instance_key.sign(OpenSSL::Digest::SHA256.new, instance_signature_payload),
      )
    end
    let(:instance_payload) do
      {
        "id" => instance_attributes[:id],
        "domain" => domain,
        "pubkey" => pubkey,
        "name" => instance_attributes[:name],
        "version" => instance_attributes[:version],
        "channel" => instance_attributes[:channel],
        "frequency" => instance_attributes[:frequency],
        "latitude" => instance_attributes[:latitude],
        "longitude" => instance_attributes[:longitude],
        "lastUpdateTime" => instance_attributes[:last_update_time],
        "isPrivate" => instance_attributes[:is_private],
        "signature" => instance_signature,
      }
    end
    let(:remote_signed_payload) do
      JSON.generate(
        {
          "publicKey" => pubkey,
          "name" => instance_attributes[:name],
          "version" => instance_attributes[:version],
          "domain" => domain,
          "lastUpdate" => last_update_time,
        },
        sort_keys: true,
      )
    end
    let(:well_known_document) do
      {
        "publicKey" => pubkey,
        "domain" => domain,
        "name" => instance_attributes[:name],
        "version" => instance_attributes[:version],
        "lastUpdate" => last_update_time,
        "signatureAlgorithm" => "rsa-sha256",
        "signedPayload" => Base64.strict_encode64(remote_signed_payload),
        "signature" => Base64.strict_encode64(
          instance_key.sign(OpenSSL::Digest::SHA256.new, remote_signed_payload),
        ),
      }
    end
    let(:remote_nodes) do
      now = Time.now.to_i
      Array.new(PotatoMesh::Config.remote_instance_min_node_count) do |index|
        {
          "node_id" => "remote-node-#{index}",
          "last_heard" => now - index,
        }
      end
    end

    before do
      fetch_stub = lambda do |host, path|
        case path
        when "/.well-known/potato-mesh"
          [well_known_document, URI("https://#{host}#{path}")]
        when "/api/nodes"
          [remote_nodes, URI("https://#{host}#{path}")]
        else
          [nil, []]
        end
      end

      allow_any_instance_of(Sinatra::Application).to receive(:fetch_instance_json) do |_instance, host, path|
        fetch_stub.call(host, path)
      end

      allow(PotatoMesh::Application).to receive(:fetch_instance_json) do |host, path|
        fetch_stub.call(host, path)
      end

      allow_any_instance_of(Sinatra::Application).to receive(:enqueue_federation_crawl) do |instance, domain, per_response_limit:, overall_limit:|
        db = instance.open_database
        begin
          instance.ingest_known_instances_from!(
            db,
            domain,
            per_response_limit: per_response_limit,
            overall_limit: overall_limit,
          )
        ensure
          db&.close
        end
        true
      end
    end

    it "stores a federated instance when validation succeeds" do
      post "/api/instances", instance_payload.to_json, { "CONTENT_TYPE" => "application/json" }

      expect(last_response.status).to eq(201)
      expect(JSON.parse(last_response.body)).to eq("status" => "registered")

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        row = db.get_first_row(
          "SELECT * FROM instances WHERE id = ?",
          [instance_attributes[:id]],
        )

        expect(row).not_to be_nil
        expect(row["domain"]).to eq(domain)
        expect(row["pubkey"]).to eq(pubkey)
        expect(row["signature"]).to eq(instance_signature)
        expect(row["is_private"]).to eq(0)
      end
    end

    it "rejects registrations with invalid domains" do
      invalid_payload = instance_payload.merge("domain" => "mesh-instance")

      warning_calls = []
      allow_any_instance_of(Sinatra::Application).to receive(:warn_log).and_wrap_original do |method, *args, **kwargs|
        warning_calls << [args, kwargs]
        method.call(*args, **kwargs)
      end

      post "/api/instances", invalid_payload.to_json, { "CONTENT_TYPE" => "application/json" }

      expect(last_response.status).to eq(400)
      expect(JSON.parse(last_response.body)).to eq("error" => "invalid domain")

      expect(warning_calls).to include(
        [
          ["Instance registration rejected"],
          hash_including(
            context: "ingest.register",
            domain: "mesh-instance",
            reason: "invalid domain",
          ),
        ],
      )

      with_db(readonly: true) do |db|
        stored = db.get_first_value(
          "SELECT COUNT(*) FROM instances WHERE id = ?",
          [instance_attributes[:id]],
        )
        expect(stored).to eq(0)
      end
    end

    it "rejects registrations with invalid signatures" do
      invalid_payload = instance_payload.merge("signature" => Base64.strict_encode64("invalid"))

      warning_calls = []
      allow_any_instance_of(Sinatra::Application).to receive(:warn_log).and_wrap_original do |method, *args, **kwargs|
        warning_calls << [args, kwargs]
        method.call(*args, **kwargs)
      end

      post "/api/instances", invalid_payload.to_json, { "CONTENT_TYPE" => "application/json" }

      expect(last_response.status).to eq(400)
      expect(JSON.parse(last_response.body)).to eq("error" => "invalid signature")

      expect(warning_calls).to include(
        [
          ["Instance registration rejected"],
          hash_including(
            context: "ingest.register",
            domain: domain,
            reason: "invalid signature",
          ),
        ],
      )

      with_db(readonly: true) do |db|
        count = db.get_first_value("SELECT COUNT(*) FROM instances")
        expect(count).to eq(1)
      end
    end

    it "rejects registrations when DNS resolves to restricted addresses" do
      restricted_addrinfo = Addrinfo.ip("127.0.0.1")
      allow(Addrinfo).to receive(:getaddrinfo).and_return([restricted_addrinfo])

      warning_calls = []
      allow_any_instance_of(Sinatra::Application).to receive(:warn_log).and_wrap_original do |method, *args, **kwargs|
        warning_calls << [args, kwargs]
        method.call(*args, **kwargs)
      end

      allow_any_instance_of(Sinatra::Application).to receive(:fetch_instance_json) do
        raise "fetch_instance_json should not be called for restricted domains"
      end

      post "/api/instances", instance_payload.to_json, { "CONTENT_TYPE" => "application/json" }

      expect(last_response.status).to eq(400)
      expect(JSON.parse(last_response.body)).to eq("error" => "restricted domain")

      expect(warning_calls).to include(
        [
          ["Instance registration rejected"],
          hash_including(
            context: "ingest.register",
            domain: domain,
            reason: "restricted domain",
          ),
        ],
      )

      with_db(readonly: true) do |db|
        stored = db.get_first_value(
          "SELECT COUNT(*) FROM instances WHERE id = ?",
          [instance_attributes[:id]],
        )
        expect(stored).to eq(0)
      end
    end

    it "accepts bracketed IPv6 domains" do
      ipv6_domain = "[2001:db8::1]"
      ipv6_attributes = instance_attributes.merge(domain: ipv6_domain)
      ipv6_signature_payload = canonical_instance_payload(ipv6_attributes)
      ipv6_signature = Base64.strict_encode64(
        instance_key.sign(OpenSSL::Digest::SHA256.new, ipv6_signature_payload),
      )
      ipv6_payload = instance_payload.merge(
        "domain" => ipv6_domain,
        "signature" => ipv6_signature,
      )

      ipv6_remote_payload = JSON.generate(
        {
          "publicKey" => pubkey,
          "name" => instance_attributes[:name],
          "version" => instance_attributes[:version],
          "domain" => ipv6_domain,
          "lastUpdate" => last_update_time,
        },
        sort_keys: true,
      )

      ipv6_document = well_known_document.merge(
        "domain" => ipv6_domain,
        "signedPayload" => Base64.strict_encode64(ipv6_remote_payload),
        "signature" => Base64.strict_encode64(
          instance_key.sign(OpenSSL::Digest::SHA256.new, ipv6_remote_payload),
        ),
      )

      allow_any_instance_of(Sinatra::Application).to receive(:fetch_instance_json) do |_instance, host, path|
        case path
        when "/.well-known/potato-mesh"
          [ipv6_document, URI("https://#{host}#{path}")]
        when "/api/nodes"
          [remote_nodes, URI("https://#{host}#{path}")]
        else
          [nil, []]
        end
      end

      post "/api/instances", ipv6_payload.to_json, { "CONTENT_TYPE" => "application/json" }

      expect(last_response.status).to eq(201)
      expect(JSON.parse(last_response.body)).to eq("status" => "registered")

      with_db(readonly: true) do |db|
        stored_domain = db.get_first_value(
          "SELECT domain FROM instances WHERE id = ?",
          [ipv6_attributes[:id]],
        )
        expect(stored_domain).to eq(ipv6_domain.downcase)
      end
    end

    it "rejects registrations targeting restricted literal IPs when a port is supplied" do
      restricted_domain = "127.0.0.1:8080"
      restricted_attributes = instance_attributes.merge(domain: restricted_domain)
      restricted_signature_payload = canonical_instance_payload(restricted_attributes)
      restricted_signature = Base64.strict_encode64(
        instance_key.sign(OpenSSL::Digest::SHA256.new, restricted_signature_payload),
      )
      restricted_payload = instance_payload.merge(
        "domain" => restricted_domain,
        "signature" => restricted_signature,
      )

      warning_calls = []
      allow_any_instance_of(Sinatra::Application).to receive(:warn_log).and_wrap_original do |method, *args, **kwargs|
        warning_calls << [args, kwargs]
        method.call(*args, **kwargs)
      end

      post "/api/instances", restricted_payload.to_json, { "CONTENT_TYPE" => "application/json" }

      expect(last_response.status).to eq(400)
      expect(JSON.parse(last_response.body)).to eq("error" => "restricted domain")

      expect(warning_calls).to include(
        [
          ["Instance registration rejected"],
          hash_including(
            context: "ingest.register",
            domain: restricted_domain,
            reason: "restricted IP address",
            resolved_ip: an_instance_of(IPAddr),
          ),
        ],
      )

      with_db(readonly: true) do |db|
        count = db.get_first_value("SELECT COUNT(*) FROM instances")
        expect(count).to eq(1)
      end
    end

    it "ingests federation instances advertised by remote peers" do
      ally_key = OpenSSL::PKey::RSA.new(2048)
      ally_domain = "ally.mesh"
      ally_attributes = {
        id: "ally-instance-1",
        domain: ally_domain,
        pubkey: ally_key.public_key.export,
        name: "Ally Mesh",
        version: "2.0.0",
        channel: "#Allies",
        frequency: "433MHz",
        latitude: 40.1,
        longitude: -74.0,
        last_update_time: Time.now.to_i,
        is_private: false,
      }
      ally_signature_payload = canonical_instance_payload(ally_attributes)
      ally_signature = Base64.strict_encode64(
        ally_key.sign(OpenSSL::Digest::SHA256.new, ally_signature_payload),
      )
      ally_payload = {
        "id" => ally_attributes[:id],
        "domain" => ally_domain,
        "pubkey" => ally_attributes[:pubkey],
        "name" => ally_attributes[:name],
        "version" => ally_attributes[:version],
        "channel" => ally_attributes[:channel],
        "frequency" => ally_attributes[:frequency],
        "latitude" => ally_attributes[:latitude],
        "longitude" => ally_attributes[:longitude],
        "lastUpdateTime" => ally_attributes[:last_update_time],
        "isPrivate" => ally_attributes[:is_private],
        "signature" => ally_signature,
      }

      ally_nodes = Array.new(PotatoMesh::Config.remote_instance_min_node_count) do |index|
        { "node_id" => "ally-node-#{index}", "last_heard" => Time.now.to_i - index }
      end

      allow_any_instance_of(Sinatra::Application).to receive(:fetch_instance_json) do |_instance, host, path|
        case [host, path]
        when [domain, "/.well-known/potato-mesh"]
          [well_known_document, URI("https://#{host}#{path}")]
        when [domain, "/api/nodes"]
          [remote_nodes, URI("https://#{host}#{path}")]
        when [domain, "/api/instances"]
          [[ally_payload], URI("https://#{host}#{path}")]
        when [ally_domain, "/api/nodes"]
          [ally_nodes, URI("https://#{host}#{path}")]
        when [ally_domain, "/api/instances"]
          [[instance_payload], URI("https://#{host}#{path}")]
        else
          [nil, []]
        end
      end

      post "/api/instances", instance_payload.to_json, { "CONTENT_TYPE" => "application/json" }

      expect(last_response.status).to eq(201)

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        ally_row = db.get_first_row(
          "SELECT domain, signature FROM instances WHERE domain = ?",
          [ally_domain],
        )
        remote_row = db.get_first_row(
          "SELECT domain, signature FROM instances WHERE domain = ?",
          [domain],
        )

        expect(ally_row).not_to be_nil
        expect(ally_row["signature"]).to eq(ally_signature)
        expect(remote_row).not_to be_nil
        expect(remote_row["signature"]).to eq(instance_signature)
      end
    end

    it "skips remote federation entries that fail validation" do
      stale_key = OpenSSL::PKey::RSA.new(2048)
      stale_domain = "stale.mesh"
      stale_attributes = {
        id: "stale-instance",
        domain: stale_domain,
        pubkey: stale_key.public_key.export,
        name: "Stale Mesh",
        version: "0.1.0",
        channel: "#Stale",
        frequency: "868MHz",
        latitude: 10.0,
        longitude: 20.0,
        last_update_time: Time.now.to_i,
        is_private: false,
      }
      stale_signature_payload = canonical_instance_payload(stale_attributes)
      stale_signature = Base64.strict_encode64(
        stale_key.sign(OpenSSL::Digest::SHA256.new, stale_signature_payload),
      )
      stale_payload = {
        "id" => stale_attributes[:id],
        "domain" => stale_domain,
        "pubkey" => stale_attributes[:pubkey],
        "name" => stale_attributes[:name],
        "version" => stale_attributes[:version],
        "channel" => stale_attributes[:channel],
        "frequency" => stale_attributes[:frequency],
        "latitude" => stale_attributes[:latitude],
        "longitude" => stale_attributes[:longitude],
        "lastUpdateTime" => stale_attributes[:last_update_time],
        "isPrivate" => false,
        "signature" => stale_signature,
      }

      private_key = OpenSSL::PKey::RSA.new(2048)
      private_domain = "private.mesh"
      private_attributes = {
        id: "private-instance",
        domain: private_domain,
        pubkey: private_key.public_key.export,
        name: "Private Mesh",
        version: "3.0.0",
        channel: "#Private",
        frequency: "915MHz",
        latitude: 0.0,
        longitude: 0.0,
        last_update_time: Time.now.to_i,
        is_private: true,
      }
      private_signature_payload = canonical_instance_payload(private_attributes)
      private_signature = Base64.strict_encode64(
        private_key.sign(OpenSSL::Digest::SHA256.new, private_signature_payload),
      )
      private_payload = {
        "id" => private_attributes[:id],
        "domain" => private_domain,
        "pubkey" => private_attributes[:pubkey],
        "name" => private_attributes[:name],
        "version" => private_attributes[:version],
        "channel" => private_attributes[:channel],
        "frequency" => private_attributes[:frequency],
        "latitude" => private_attributes[:latitude],
        "longitude" => private_attributes[:longitude],
        "lastUpdateTime" => private_attributes[:last_update_time],
        "isPrivate" => true,
        "signature" => private_signature,
      }

      invalid_key = OpenSSL::PKey::RSA.new(2048)
      invalid_payload = {
        "id" => "invalid-instance",
        "domain" => "invalid.mesh",
        "pubkey" => invalid_key.public_key.export,
        "name" => "Invalid Mesh",
        "version" => "1.0.0",
        "channel" => "#Invalid",
        "frequency" => "915MHz",
        "latitude" => 1.0,
        "longitude" => 2.0,
        "lastUpdateTime" => Time.now.to_i,
        "isPrivate" => false,
        "signature" => Base64.strict_encode64("bogus"),
      }

      unreachable_key = OpenSSL::PKey::RSA.new(2048)
      unreachable_domain = "unreachable.mesh"
      unreachable_attributes = {
        id: "unreachable-instance",
        domain: unreachable_domain,
        pubkey: unreachable_key.public_key.export,
        name: "Unreachable Mesh",
        version: "6.0.0",
        channel: "#Offline",
        frequency: "915MHz",
        latitude: 12.0,
        longitude: 24.0,
        last_update_time: Time.now.to_i,
        is_private: false,
      }
      unreachable_signature_payload = canonical_instance_payload(unreachable_attributes)
      unreachable_signature = Base64.strict_encode64(
        unreachable_key.sign(OpenSSL::Digest::SHA256.new, unreachable_signature_payload),
      )
      unreachable_payload = {
        "id" => unreachable_attributes[:id],
        "domain" => unreachable_domain,
        "pubkey" => unreachable_attributes[:pubkey],
        "name" => unreachable_attributes[:name],
        "version" => unreachable_attributes[:version],
        "channel" => unreachable_attributes[:channel],
        "frequency" => unreachable_attributes[:frequency],
        "latitude" => unreachable_attributes[:latitude],
        "longitude" => unreachable_attributes[:longitude],
        "lastUpdateTime" => unreachable_attributes[:last_update_time],
        "isPrivate" => false,
        "signature" => unreachable_signature,
      }

      offline_domain = "offline.mesh"
      offline_key = OpenSSL::PKey::RSA.new(2048)
      offline_attributes = {
        id: "offline-instance",
        domain: offline_domain,
        pubkey: offline_key.public_key.export,
        name: "Offline Mesh",
        version: "4.0.0",
        channel: "#Offline",
        frequency: "915MHz",
        latitude: 5.0,
        longitude: 6.0,
        last_update_time: Time.now.to_i,
        is_private: false,
      }
      offline_signature_payload = canonical_instance_payload(offline_attributes)
      offline_signature = Base64.strict_encode64(
        offline_key.sign(OpenSSL::Digest::SHA256.new, offline_signature_payload),
      )
      offline_payload = {
        "id" => offline_attributes[:id],
        "domain" => offline_domain,
        "pubkey" => offline_attributes[:pubkey],
        "name" => offline_attributes[:name],
        "version" => offline_attributes[:version],
        "channel" => offline_attributes[:channel],
        "frequency" => offline_attributes[:frequency],
        "latitude" => offline_attributes[:latitude],
        "longitude" => offline_attributes[:longitude],
        "lastUpdateTime" => offline_attributes[:last_update_time],
        "isPrivate" => false,
        "signature" => offline_signature,
      }

      restricted_domain = "127.0.0.1"
      restricted_key = OpenSSL::PKey::RSA.new(2048)
      restricted_attributes = {
        id: "restricted-instance",
        domain: restricted_domain,
        pubkey: restricted_key.public_key.export,
        name: "Restricted Mesh",
        version: "5.0.0",
        channel: "#Restricted",
        frequency: "915MHz",
        latitude: 9.0,
        longitude: 9.0,
        last_update_time: Time.now.to_i,
        is_private: false,
      }
      restricted_signature_payload = canonical_instance_payload(restricted_attributes)
      restricted_signature = Base64.strict_encode64(
        restricted_key.sign(OpenSSL::Digest::SHA256.new, restricted_signature_payload),
      )
      restricted_payload = {
        "id" => restricted_attributes[:id],
        "domain" => restricted_domain,
        "pubkey" => restricted_attributes[:pubkey],
        "name" => restricted_attributes[:name],
        "version" => restricted_attributes[:version],
        "channel" => restricted_attributes[:channel],
        "frequency" => restricted_attributes[:frequency],
        "latitude" => restricted_attributes[:latitude],
        "longitude" => restricted_attributes[:longitude],
        "lastUpdateTime" => restricted_attributes[:last_update_time],
        "isPrivate" => false,
        "signature" => restricted_signature,
      }

      stale_nodes = Array.new(PotatoMesh::Config.remote_instance_min_node_count) do |index|
        { "node_id" => "stale-node-#{index}", "last_heard" => (Time.now.to_i - PotatoMesh::Config.remote_instance_max_node_age) - index - 1 }
      end

      allow_any_instance_of(Sinatra::Application).to receive(:fetch_instance_json) do |_instance, host, path|
        case [host, path]
        when [domain, "/.well-known/potato-mesh"]
          [well_known_document, URI("https://#{host}#{path}")]
        when [domain, "/api/nodes"]
          [remote_nodes, URI("https://#{host}#{path}")]
        when [domain, "/api/instances"]
          [
            [
              "unexpected",
              private_payload,
              invalid_payload,
              offline_payload,
              stale_payload,
              restricted_payload,
              unreachable_payload,
            ],
            URI("https://#{host}#{path}"),
          ]
        when [offline_domain, "/api/nodes"]
          [nil, ["timeout"]]
        when [stale_domain, "/api/nodes"]
          [stale_nodes, URI("https://#{host}#{path}")]
        when [restricted_domain, "/api/nodes"]
          [remote_nodes, URI("https://#{host}#{path}")]
        when [unreachable_domain, "/api/nodes"]
          [remote_nodes, URI("https://#{host}#{path}")]
        when [unreachable_domain, "/api/instances"]
          [nil, ["connection refused"]]
        else
          [nil, []]
        end
      end

      warning_calls = []
      allow_any_instance_of(Sinatra::Application).to receive(:warn_log).and_wrap_original do |method, *args, **kwargs|
        warning_calls << [args, kwargs]
        method.call(*args, **kwargs)
      end

      post "/api/instances", instance_payload.to_json, { "CONTENT_TYPE" => "application/json" }

      expect(last_response.status).to eq(201)

      with_db(readonly: true) do |db|
        domains = db.execute("SELECT domain FROM instances ORDER BY domain").flatten
        expect(domains).to include(domain, unreachable_domain)
        expect(domains).not_to include(stale_domain, private_domain, "invalid.mesh", offline_domain, restricted_domain)
        expect(domains.count { |value| value == domain }).to eq(1)
      end

      expect(warning_calls).to include(
        [
          ["Failed to load remote federation instances"],
          hash_including(context: "federation.instances", domain: unreachable_domain),
        ],
      )
      expect(warning_calls).to include(
        [
          ["Discarded remote instance entry"],
          hash_including(domain: stale_domain, reason: "node data is stale"),
        ],
      )
      expect(warning_calls).to include(
        [
          ["Failed to persist remote instance"],
          hash_including(domain: restricted_domain, error_class: "ArgumentError"),
        ],
      )
    end

    it "accepts signatures when the optional isPrivate field is omitted" do
      unsigned_attributes = instance_attributes.merge(is_private: nil)
      unsigned_payload_json = canonical_instance_payload(unsigned_attributes)
      unsigned_signature = Base64.strict_encode64(
        instance_key.sign(OpenSSL::Digest::SHA256.new, unsigned_payload_json),
      )
      payload_without_private = instance_payload.reject { |key, _| key == "isPrivate" }
      payload_without_private["signature"] = unsigned_signature

      post "/api/instances", payload_without_private.to_json, { "CONTENT_TYPE" => "application/json" }

      expect(last_response.status).to eq(201)
      expect(JSON.parse(last_response.body)).to eq("status" => "registered")

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        row = db.get_first_row(
          "SELECT * FROM instances WHERE id = ?",
          [instance_attributes[:id]],
        )

        expect(row).not_to be_nil
        expect(row["is_private"]).to eq(0)
      end
    end

    it "replaces an existing record when the domain is reused" do
      with_db do |db|
        db.execute(
          <<~SQL,
          INSERT INTO instances (
            id, domain, pubkey, name, version, channel, frequency,
            latitude, longitude, last_update_time, is_private, signature
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        SQL
          [
            "legacy-id",
            domain,
            "legacy-pubkey",
            "Legacy Instance",
            "0.9.0",
            nil,
            nil,
            nil,
            nil,
            last_update_time - 100,
            0,
            "legacy-signature",
          ],
        )
      end

      debug_calls = []
      allow_any_instance_of(Sinatra::Application).to receive(:debug_log).and_wrap_original do |method, *args, **kwargs|
        debug_calls << [args, kwargs]
        method.call(*args, **kwargs)
      end

      post "/api/instances", instance_payload.to_json, { "CONTENT_TYPE" => "application/json" }

      expect(last_response.status).to eq(201)

      with_db(readonly: true) do |db|
        ids = db.execute("SELECT id FROM instances WHERE domain = ?", [domain]).flatten

        expect(ids).to eq([instance_attributes[:id]])
      end

      expect(debug_calls).to include(
        [
          ["Removed conflicting instance by domain"],
          hash_including(
            context: "federation.instances",
            domain: domain,
            replaced_id: "legacy-id",
            incoming_id: instance_attributes[:id],
          ),
        ],
      )
    end

    it "normalises stored domains to lowercase" do
      uppercase_payload = instance_payload.merge("domain" => "Mesh.Example")

      post "/api/instances", uppercase_payload.to_json, { "CONTENT_TYPE" => "application/json" }

      expect(last_response.status).to eq(201)

      with_db(readonly: true) do |db|
        stored = db.get_first_value("SELECT domain FROM instances WHERE id = ?", [instance_attributes[:id]])
        expect(stored).to eq(domain)
      end
    end

    it "rejects registrations missing last_heard data" do
      missing_nodes = Array.new(PotatoMesh::Config.remote_instance_min_node_count) do |index|
        { "node_id" => "remote-#{index}", "first_heard" => Time.now.to_i - index }
      end

      allow_any_instance_of(Sinatra::Application).to receive(:fetch_instance_json) do |_instance, host, path|
        case path
        when "/.well-known/potato-mesh"
          [well_known_document, URI("https://#{host}#{path}")]
        when "/api/nodes"
          [missing_nodes, URI("https://#{host}#{path}")]
        else
          [nil, []]
        end
      end

      warning_calls = []
      allow_any_instance_of(Sinatra::Application).to receive(:warn_log).and_wrap_original do |method, *args, **kwargs|
        warning_calls << [args, kwargs]
        method.call(*args, **kwargs)
      end

      post "/api/instances", instance_payload.to_json, { "CONTENT_TYPE" => "application/json" }

      expect(last_response.status).to eq(400)
      expect(JSON.parse(last_response.body)).to eq("error" => "missing last_heard data")

      expect(warning_calls).to include(
        [
          ["Instance registration rejected"],
          hash_including(
            context: "ingest.register",
            domain: domain,
            reason: "missing last_heard data",
          ),
        ],
      )
    end
  end

  describe "GET /api/instances" do
    let(:remote_key) { OpenSSL::PKey::RSA.new(2048) }

    it "returns the self instance record" do
      get "/api/instances"

      expect(last_response).to be_ok
      payload = JSON.parse(last_response.body)
      self_entry = payload.find { |entry| entry["id"] == SELF_INSTANCE_ID }

      expect(self_entry).not_to be_nil
      expect(self_entry["domain"]).not_to be_nil
      expect(self_entry["isPrivate"]).to eq(false)
      expect(self_entry["signature"]).not_to be_nil
    end

    it "includes previously stored remote registrations" do
      remote_attributes = {
        id: "remote-instance-1",
        domain: "remote.example",
        pubkey: remote_key.public_key.export,
        name: "Remote Mesh",
        version: "9.8.7",
        channel: "#Remote",
        frequency: "915MHz",
        latitude: 51.5,
        longitude: -0.1,
        last_update_time: Time.now.to_i,
        is_private: false,
      }
      remote_signature_payload = canonical_instance_payload(remote_attributes)
      remote_signature = Base64.strict_encode64(
        remote_key.sign(OpenSSL::Digest::SHA256.new, remote_signature_payload),
      )

      with_db do |db|
        upsert_instance_record(db, remote_attributes, remote_signature)
      end

      get "/api/instances"

      expect(last_response).to be_ok
      payload = JSON.parse(last_response.body)
      remote_entry = payload.find { |entry| entry["id"] == remote_attributes[:id] }

      expect(remote_entry).not_to be_nil
      expect(remote_entry["domain"]).to eq("remote.example")
      expect(remote_entry["isPrivate"]).to eq(false)
      expect(remote_entry["signature"]).to eq(remote_signature)
    end

    it "skips malformed rows without failing" do
      with_db do |db|
        sql = <<~SQL
          INSERT INTO instances (
            id, domain, pubkey, name, version, channel, frequency,
            latitude, longitude, last_update_time, is_private, signature
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        SQL
        db.execute(
          sql,
          [
            "broken-instance",
            "invalid domain name",
            remote_key.public_key.export,
            "Broken",
            "0.0.0",
            nil,
            nil,
            "not-a-number",
            nil,
            "not-a-timestamp",
            "not-a-bool",
            nil,
          ],
        )
      end

      get "/api/instances"

      expect(last_response).to be_ok
      payload = JSON.parse(last_response.body)
      broken_entry = payload.find { |entry| entry["id"] == "broken-instance" }

      expect(broken_entry).to be_nil
      expect(payload).not_to be_empty
    end

    it "deduplicates records by domain keeping the newest entry" do
      newer_time = Time.now.to_i
      older_time = newer_time - 60

      with_db do |db|
        insert_sql = <<~SQL
          INSERT INTO instances (
            id, domain, pubkey, name, version, channel, frequency,
            latitude, longitude, last_update_time, is_private, signature
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        SQL
        db.execute(
          insert_sql,
          [
            "duplicate-old",
            "duplicate.example ",
            remote_key.public_key.export,
            "Duplicate Old",
            "1.0.0",
            nil,
            nil,
            nil,
            nil,
            older_time,
            0,
            "sig-old",
          ],
        )

        db.execute(
          insert_sql,
          [
            "duplicate-new",
            "Duplicate.Example",
            remote_key.public_key.export,
            "Duplicate New",
            "2.0.0",
            nil,
            nil,
            nil,
            nil,
            newer_time,
            0,
            "sig-new",
          ],
        )
      end

      get "/api/instances"

      expect(last_response).to be_ok
      payload = JSON.parse(last_response.body)
      duplicate_entries = payload.select { |entry| entry["domain"] == "duplicate.example" }

      expect(duplicate_entries.size).to eq(1)
      expect(duplicate_entries.first["id"]).to eq("duplicate-new")

      with_db(readonly: true) do |db|
        domains = db.execute(
          "SELECT domain FROM instances WHERE domain LIKE ? ORDER BY domain",
          ["duplicate.example%"],
        ).flatten

        expect(domains).to eq(["duplicate.example"])
      end
    end

    context "when federation is disabled" do
      around do |example|
        original = ENV["FEDERATION"]
        begin
          ENV["FEDERATION"] = "0"
          example.run
        ensure
          if original.nil?
            ENV.delete("FEDERATION")
          else
            ENV["FEDERATION"] = original
          end
        end
      end

      it "returns 404" do
        get "/api/instances"

        expect(last_response.status).to eq(404)
      end
    end
  end

  describe "POST /api/nodes" do
    it "imports nodes from fixture data into the database" do
      import_nodes_fixture

      expected_nodes = nodes_fixture.map do |node|
        [node["node_id"], expected_node_row(node)]
      end.to_h

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        rows = db.execute(<<~SQL)
          SELECT node_id, short_name, long_name, hw_model, role, snr,
                 battery_level, voltage, last_heard, first_heard,
                 uptime_seconds, channel_utilization, air_util_tx,
                 position_time, location_source, precision_bits,
                 latitude, longitude, altitude, lora_freq, modem_preset
          FROM nodes
          ORDER BY node_id
        SQL

        expect(rows.size).to eq(expected_nodes.size)

        rows.each do |row|
          expected = expected_nodes.fetch(row["node_id"])
          expect(row["short_name"]).to eq(expected["short_name"])
          expect(row["long_name"]).to eq(expected["long_name"])
          expect(row["hw_model"]).to eq(expected["hw_model"])
          expect(row["role"]).to eq(expected["role"])
          expect_same_value(row["snr"], expected["snr"])
          expect_same_value(row["battery_level"], expected["battery_level"])
          expect_same_value(row["voltage"], expected["voltage"])
          expect(row["last_heard"]).to eq(expected["last_heard"])
          expect(row["first_heard"]).to eq(expected["first_heard"])
          expect_same_value(row["uptime_seconds"], expected["uptime_seconds"])
          expect_same_value(row["channel_utilization"], expected["channel_utilization"])
          expect_same_value(row["air_util_tx"], expected["air_util_tx"])
          expect_same_value(row["position_time"], expected["position_time"])
          expect(row["location_source"]).to eq(expected["location_source"])
          expect_same_value(row["precision_bits"], expected["precision_bits"])
          expect_same_value(row["latitude"], expected["latitude"])
          expect_same_value(row["longitude"], expected["longitude"])
          expect_same_value(row["altitude"], expected["altitude"])
          expect_same_value(row["lora_freq"], expected["lora_freq"])
          expect(row["modem_preset"]).to eq(expected["modem_preset"])
        end
      end
    end

    it "returns 400 when the payload is not valid JSON" do
      post "/api/nodes", "{", auth_headers

      expect(last_response.status).to eq(400)
      expect(JSON.parse(last_response.body)).to eq("error" => "invalid JSON")
    end

    it "updates timestamps when the payload omits lastHeard" do
      node_id = "!spectime01"
      payload = {
        node_id => {
          "user" => { "shortName" => "Spec Time" },
        },
      }

      post "/api/nodes", payload.to_json, auth_headers

      expect(last_response).to be_ok

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        row = db.get_first_row(
          "SELECT last_heard, first_heard FROM nodes WHERE node_id = ?",
          [node_id],
        )

        expect(row["last_heard"]).to eq(reference_time.to_i)
        expect(row["first_heard"]).to eq(reference_time.to_i)
      end
    end

    it "preserves the original first_heard when updating nodes" do
      node_id = "!spectime02"
      initial_first = reference_time.to_i - 600
      initial_last = reference_time.to_i - 300

      with_db do |db|
        db.execute(
          "INSERT INTO nodes(node_id, last_heard, first_heard) VALUES (?,?,?)",
          [node_id, initial_last, initial_first],
        )
      end

      payload = {
        node_id => {
          "user" => { "shortName" => "Spec Update" },
          "lastHeard" => reference_time.to_i,
        },
      }

      post "/api/nodes", payload.to_json, auth_headers

      expect(last_response).to be_ok

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        row = db.get_first_row(
          "SELECT last_heard, first_heard FROM nodes WHERE node_id = ?",
          [node_id],
        )

        expect(row["last_heard"]).to eq(reference_time.to_i)
        expect(row["first_heard"]).to eq(initial_first)
      end
    end

    it "returns 400 when more than 1000 nodes are provided" do
      payload = (0..1000).each_with_object({}) do |i, acc|
        acc["node-#{i}"] = {}
      end

      post "/api/nodes", payload.to_json, auth_headers

      expect(last_response.status).to eq(400)
      expect(JSON.parse(last_response.body)).to eq("error" => "too many nodes")

      with_db(readonly: true) do |db|
        count = db.get_first_value("SELECT COUNT(*) FROM nodes")
        expect(count).to eq(0)
      end
    end

    it "returns 413 when the request body exceeds the configured byte limit" do
      limit = 64
      allow(PotatoMesh::Config).to receive(:max_json_body_bytes).and_return(limit)
      payload = { "huge-node" => { "user" => { "shortName" => "A" * (limit + 50) } } }.to_json
      expect(payload.bytesize).to be > limit

      post "/api/nodes", payload, auth_headers

      expect(last_response.status).to eq(413)
      expect(JSON.parse(last_response.body)).to eq("error" => "payload too large")

      with_db(readonly: true) do |db|
        count = db.get_first_value("SELECT COUNT(*) FROM nodes")
        expect(count).to eq(0)
      end
    end

    it "treats SQL-looking node identifiers as plain data" do
      malicious_id = "spec-node'); DROP TABLE nodes;--"
      payload = {
        malicious_id => {
          "user" => { "shortName" => "Spec Attack" },
          "lastHeard" => reference_time.to_i,
        },
      }

      post "/api/nodes", payload.to_json, auth_headers

      expect(last_response).to be_ok
      expect(JSON.parse(last_response.body)).to eq("status" => "ok")

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        row = db.get_first_row(
          "SELECT node_id, short_name FROM nodes WHERE node_id = ?",
          [malicious_id],
        )

        expect(row["node_id"]).to eq(malicious_id)
        expect(row["short_name"]).to eq("Spec Attack")

        tables = db.get_first_value(
          "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='nodes'",
        )
        expect(tables).to eq(1)
      end
    end

    it "retries node upserts when the database reports it is locked" do
      node = nodes_fixture.first
      payload = { node["node_id"] => build_node_payload(node) }

      call_count = 0
      allow_any_instance_of(SQLite3::Database).to receive(:execute).and_wrap_original do |method, sql, *args|
        if sql.include?("INSERT INTO nodes")
          call_count += 1
          raise SQLite3::BusyException, "database is locked" if call_count == 1
        end
        method.call(sql, *args)
      end

      post "/api/nodes", payload.to_json, auth_headers

      expect(last_response).to be_ok
      expect(JSON.parse(last_response.body)).to eq("status" => "ok")
      expect(call_count).to be >= 2

      with_db(readonly: true) do |db|
        count = db.get_first_value("SELECT COUNT(*) FROM nodes WHERE node_id = ?", [node["node_id"]])
        expect(count).to eq(1)

        last_heard = db.get_first_value("SELECT last_heard FROM nodes WHERE node_id = ?", [node["node_id"]])
        expect(last_heard).to eq(expected_last_heard(node))
      end
    end
  end

  describe "#ensure_unknown_node" do
    it "creates a hidden placeholder with timestamps for chat notifications" do
      with_db do |db|
        created = ensure_unknown_node(db, "!1234abcd", nil, heard_time: reference_time.to_i)
        expect(created).to be_truthy
      end

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        row = db.get_first_row(
          <<~SQL,
          SELECT short_name, long_name, role, last_heard, first_heard
          FROM nodes
          WHERE node_id = ?
        SQL
          ["!1234abcd"],
        )

        expect(row["short_name"]).to eq("ABCD")
        expect(row["long_name"]).to eq("Meshtastic ABCD")
        expect(row["role"]).to eq("CLIENT_HIDDEN")
        expect(row["last_heard"]).to eq(reference_time.to_i)
        expect(row["first_heard"]).to eq(reference_time.to_i)
      end
    end

    it "leaves timestamps nil when no receive time is provided" do
      with_db do |db|
        created = ensure_unknown_node(db, "!1111beef", nil)
        expect(created).to be_truthy
      end

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        row = db.get_first_row(
          <<~SQL,
          SELECT last_heard, first_heard
          FROM nodes
          WHERE node_id = ?
        SQL
          ["!1111beef"],
        )

        expect(row["last_heard"]).to be_nil
        expect(row["first_heard"]).to be_nil
      end
    end

    it "returns false when the node already exists" do
      with_db do |db|
        expect(ensure_unknown_node(db, "!0000c0de", nil)).to be_truthy
        expect(ensure_unknown_node(db, "!0000c0de", nil)).to be_falsey
      end
    end
  end

  describe "POST /api/messages" do
    it "persists messages from fixture data" do
      import_nodes_fixture
      import_messages_fixture

      expected_messages = messages_fixture.map do |message|
        [message["id"], message.reject { |key, _| key == "node" }]
      end.to_h

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        rows = db.execute(<<~SQL)
          SELECT id, rx_time, rx_iso, from_id, to_id, channel,
                 portnum, text, snr, rssi, hop_limit,
                 lora_freq, modem_preset, channel_name,
                 reply_id, emoji
          FROM messages
          ORDER BY id
        SQL

        expect(rows.size).to eq(expected_messages.size)

        rows.each do |row|
          expected = expected_messages.fetch(row["id"])
          expect(row["rx_time"]).to eq(expected["rx_time"])
          expect(row["rx_iso"]).to eq(expected["rx_iso"])
          expect(row["from_id"]).to eq(expected["from_id"])
          expect(row["to_id"]).to eq(expected["to_id"])
          expect(row["channel"]).to eq(expected["channel"])
          expect(row["portnum"]).to eq(expected["portnum"])
          expect(row["text"]).to eq(expected["text"])
          expect_same_value(row["snr"], expected["snr"])
          expect(row["rssi"]).to eq(expected["rssi"])
          expect(row["hop_limit"]).to eq(expected["hop_limit"])
          expect(row["lora_freq"]).to eq(expected["lora_freq"])
          expect(row["modem_preset"]).to eq(expected["modem_preset"])
          expect(row["channel_name"]).to eq(expected["channel_name"])
          expect(row["reply_id"]).to eq(expected["reply_id"])
          expect(row["emoji"]).to eq(expected["emoji"])
        end
      end
    end

    it "persists reply metadata and emoji reactions" do
      parent_payload = {
        "id" => 42,
        "rx_time" => reference_time.to_i - 10,
        "from_id" => "!parent",
        "channel" => 0,
        "portnum" => "TEXT_MESSAGE_APP",
        "text" => "source message",
      }

      reaction_payload = {
        "id" => 108,
        "rx_time" => reference_time.to_i,
        "from_id" => "!reactor",
        "channel" => 0,
        "portnum" => "REACTION_APP",
        "reply_id" => parent_payload["id"],
        "emoji" => " 🔥 ",
      }

      post "/api/messages", parent_payload.to_json, auth_headers
      expect(last_response).to be_ok
      post "/api/messages", reaction_payload.to_json, auth_headers
      expect(last_response).to be_ok

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        row = db.get_first_row("SELECT reply_id, emoji FROM messages WHERE id = ?", [reaction_payload["id"]])
        expect(row["reply_id"]).to eq(parent_payload["id"])
        expect(row["emoji"]).to eq("🔥")
      end

      get "/api/messages"
      expect(last_response).to be_ok
      body = JSON.parse(last_response.body)
      reaction_row = body.find { |entry| entry["id"] == reaction_payload["id"] }
      expect(reaction_row).not_to be_nil
      expect(reaction_row["reply_id"]).to eq(parent_payload["id"])
      expect(reaction_row["emoji"]).to eq("🔥")
    end

    it "creates hidden nodes for unknown message senders" do
      payload = {
        "id" => 9_999,
        "rx_time" => reference_time.to_i,
        "rx_iso" => reference_time.iso8601,
        "from_id" => "!feedf00d",
        "to_id" => "^all",
        "channel" => 0,
        "portnum" => "TEXT_MESSAGE_APP",
        "text" => "Spec placeholder message",
      }

      post "/api/messages", payload.to_json, auth_headers

      expect(last_response).to be_ok
      expect(JSON.parse(last_response.body)).to eq("status" => "ok")

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        row = db.get_first_row(
          "SELECT node_id, num, short_name, long_name, role, last_heard, first_heard FROM nodes WHERE node_id = ?",
          ["!feedf00d"],
        )

        expect(row).not_to be_nil
        expect(row["node_id"]).to eq("!feedf00d")
        expect(row["num"]).to eq(0xfeedf00d)
        expect(row["short_name"]).to eq("F00D")
        expect(row["long_name"]).to eq("Meshtastic F00D")
        expect(row["role"]).to eq("CLIENT_HIDDEN")
        expect(row["last_heard"]).to eq(payload["rx_time"])
        expect(row["first_heard"]).to eq(payload["rx_time"])
      end
    end

    it "returns 400 when the payload is not valid JSON" do
      post "/api/messages", "{", auth_headers

      expect(last_response.status).to eq(400)
      expect(JSON.parse(last_response.body)).to eq("error" => "invalid JSON")
    end

    it "rejects message payloads that are larger than the configured byte limit" do
      limit = 64
      allow(PotatoMesh::Config).to receive(:max_json_body_bytes).and_return(limit)
      payload = [{ "id" => "m1", "text" => "A" * (limit + 50) }].to_json
      expect(payload.bytesize).to be > limit

      post "/api/messages", payload, auth_headers

      expect(last_response.status).to eq(413)
      expect(JSON.parse(last_response.body)).to eq("error" => "payload too large")

      with_db(readonly: true) do |db|
        count = db.get_first_value("SELECT COUNT(*) FROM messages")
        expect(count).to eq(0)
      end
    end

    describe "POST /api/positions" do
      it "stores position packets and updates node metadata" do
        node_id = "!specpos01"
        node_num = 0x1234_5678
        initial_last_heard = reference_time.to_i - 600
        node_payload = {
          node_id => {
            "num" => node_num,
            "user" => { "shortName" => "SpecPos" },
            "lastHeard" => initial_last_heard,
            "position" => {
              "time" => initial_last_heard - 60,
              "latitude" => 52.0,
              "longitude" => 13.0,
            },
          },
        }

        post "/api/nodes", node_payload.to_json, auth_headers
        expect(last_response).to be_ok

        rx_time = reference_time.to_i - 120
        position_time = rx_time - 30
        raw_payload = { "time" => position_time, "latitude_i" => (52.5 * 1e7).to_i }
        position_payload = {
          "id" => 9_001,
          "node_id" => node_id,
          "node_num" => node_num,
          "rx_time" => rx_time,
          "rx_iso" => Time.at(rx_time).utc.iso8601,
          "to_id" => "^all",
          "latitude" => 52.5,
          "longitude" => 13.4,
          "altitude" => 42.0,
          "position_time" => position_time,
          "location_source" => "LOC_INTERNAL",
          "precision_bits" => 15,
          "sats_in_view" => 6,
          "pdop" => 2.5,
          "ground_speed" => 3.2,
          "ground_track" => 180.0,
          "snr" => -8.5,
          "rssi" => -90,
          "hop_limit" => 3,
          "bitfield" => 1,
          "payload_b64" => "AQI=",
          "raw" => raw_payload,
        }

        post "/api/positions", position_payload.to_json, auth_headers

        expect(last_response).to be_ok
        expect(JSON.parse(last_response.body)).to eq("status" => "ok")

        with_db(readonly: true) do |db|
          db.results_as_hash = true
          row = db.get_first_row("SELECT * FROM positions WHERE id = ?", [9_001])
          expect(row["node_id"]).to eq(node_id)
          expect(row["node_num"]).to eq(node_num)
          expect(row["rx_time"]).to eq(rx_time)
          expect(row["rx_iso"]).to eq(Time.at(rx_time).utc.iso8601)
          expect(row["position_time"]).to eq(position_time)
          expect_same_value(row["latitude"], 52.5)
          expect_same_value(row["longitude"], 13.4)
          expect_same_value(row["altitude"], 42.0)
          expect(row["location_source"]).to eq("LOC_INTERNAL")
          expect(row["precision_bits"]).to eq(15)
          expect(row["sats_in_view"]).to eq(6)
          expect_same_value(row["pdop"], 2.5)
          expect_same_value(row["ground_speed"], 3.2)
          expect_same_value(row["ground_track"], 180.0)
          expect_same_value(row["snr"], -8.5)
          expect(row["rssi"]).to eq(-90)
          expect(row["hop_limit"]).to eq(3)
          expect(row["bitfield"]).to eq(1)
          expect(row["payload_b64"]).to eq("AQI=")
        end

        with_db(readonly: true) do |db|
          db.results_as_hash = true
          node_row = db.get_first_row(
            "SELECT last_heard, position_time, latitude, longitude, altitude, location_source, precision_bits, snr FROM nodes WHERE node_id = ?",
            [node_id],
          )
          expect(node_row["last_heard"]).to eq(rx_time)
          expect(node_row["position_time"]).to eq(position_time)
          expect_same_value(node_row["latitude"], 52.5)
          expect_same_value(node_row["longitude"], 13.4)
          expect_same_value(node_row["altitude"], 42.0)
          expect(node_row["location_source"]).to eq("LOC_INTERNAL")
          expect(node_row["precision_bits"]).to eq(15)
          expect_same_value(node_row["snr"], -8.5)
        end
      end

      it "creates node records when none exist" do
        node_id = "!specnew01"
        node_num = 0xfeed_cafe
        rx_time = reference_time.to_i - 60
        position_time = rx_time - 10
        payload = {
          "id" => 9_002,
          "node_id" => node_id,
          "node_num" => node_num,
          "rx_time" => rx_time,
          "rx_iso" => Time.at(rx_time).utc.iso8601,
          "latitude" => 52.1,
          "longitude" => 13.1,
          "altitude" => 33.0,
          "position_time" => position_time,
          "location_source" => "LOC_EXTERNAL",
        }

        post "/api/positions", payload.to_json, auth_headers

        expect(last_response).to be_ok

        with_db(readonly: true) do |db|
          db.results_as_hash = true
          node_row = db.get_first_row("SELECT * FROM nodes WHERE node_id = ?", [node_id])
          expect(node_row).not_to be_nil
          expect(node_row["num"]).to eq(node_num)
          expect(node_row["last_heard"]).to eq(rx_time)
          expect(node_row["first_heard"]).to eq(rx_time)
          expect(node_row["position_time"]).to eq(position_time)
          expect_same_value(node_row["latitude"], 52.1)
          expect_same_value(node_row["longitude"], 13.1)
          expect_same_value(node_row["altitude"], 33.0)
          expect(node_row["location_source"]).to eq("LOC_EXTERNAL")
        end
      end

      it "creates hidden nodes for unknown position senders" do
        payload = {
          "id" => 42,
          "node_id" => "!0badc0de",
          "rx_time" => reference_time.to_i,
          "rx_iso" => reference_time.iso8601,
          "latitude" => 52.1,
          "longitude" => 13.1,
        }

        post "/api/positions", payload.to_json, auth_headers

        expect(last_response).to be_ok
        expect(JSON.parse(last_response.body)).to eq("status" => "ok")

        with_db(readonly: true) do |db|
          db.results_as_hash = true
          row = db.get_first_row(
            "SELECT node_id, num, short_name, long_name, role FROM nodes WHERE node_id = ?",
            ["!0badc0de"],
          )

          expect(row).not_to be_nil
          expect(row["node_id"]).to eq("!0badc0de")
          expect(row["num"]).to eq(0x0badc0de)
          expect(row["short_name"]).to eq("C0DE")
          expect(row["long_name"]).to eq("Meshtastic C0DE")
          expect(row["role"]).to eq("CLIENT_HIDDEN")
        end
      end

      it "fills first_heard when updating an existing node without one" do
        node_id = "!specposfh"
        rx_time = reference_time.to_i - 90

        with_db do |db|
          db.execute(
            "INSERT INTO nodes(node_id, last_heard, first_heard) VALUES (?,?,?)",
            [node_id, nil, nil],
          )
        end

        payload = {
          "id" => 51,
          "node_id" => node_id,
          "rx_time" => rx_time,
          "latitude" => 51.5,
          "longitude" => -0.12,
        }

        post "/api/positions", payload.to_json, auth_headers

        expect(last_response).to be_ok

        with_db(readonly: true) do |db|
          db.results_as_hash = true
          row = db.get_first_row(
            "SELECT last_heard, first_heard FROM nodes WHERE node_id = ?",
            [node_id],
          )

          expect(row["last_heard"]).to eq(rx_time)
          expect(row["first_heard"]).to eq(rx_time)
        end
      end

      it "returns 400 when the payload is not valid JSON" do
        post "/api/positions", "{", auth_headers

        expect(last_response.status).to eq(400)
        expect(JSON.parse(last_response.body)).to eq("error" => "invalid JSON")
      end

      it "returns 400 when more than 1000 positions are provided" do
        payload = Array.new(1001) { |i| { "id" => i + 1, "rx_time" => reference_time.to_i - i } }

        post "/api/positions", payload.to_json, auth_headers

        expect(last_response.status).to eq(400)
        expect(JSON.parse(last_response.body)).to eq("error" => "too many positions")

        with_db(readonly: true) do |db|
          count = db.get_first_value("SELECT COUNT(*) FROM positions")
          expect(count).to eq(0)
        end
      end
    end

    describe "POST /api/neighbors" do
      it "stores neighbor tuples and updates node metadata" do
        rx_time = reference_time.to_i - 120
        neighbor_rx_time = rx_time - 30
        payload = {
          "node_id" => "!abc123ef",
          "node_num" => 0xabc123ef,
          "rx_time" => rx_time,
          "neighbors" => [
            { "node_id" => "!00ff0011", "snr" => -7.5 },
            { "node_id" => 0x11223344, "snr" => 3.25, "rx_time" => neighbor_rx_time },
          ],
        }

        post "/api/neighbors", payload.to_json, auth_headers

        expect(last_response).to be_ok
        expect(JSON.parse(last_response.body)).to eq("status" => "ok")

        with_db(readonly: true) do |db|
          db.results_as_hash = true
          rows = db.execute(
            "SELECT node_id, neighbor_id, snr, rx_time FROM neighbors ORDER BY neighbor_id",
          )

          expect(rows.size).to eq(2)
          expect(rows[0]["node_id"]).to eq("!abc123ef")
          expect(rows[0]["neighbor_id"]).to eq("!00ff0011")
          expect_same_value(rows[0]["snr"], -7.5)
          expect(rows[0]["rx_time"]).to eq(rx_time)

          expect(rows[1]["node_id"]).to eq("!abc123ef")
          expect(rows[1]["neighbor_id"]).to eq("!11223344")
          expect_same_value(rows[1]["snr"], 3.25)
          expect(rows[1]["rx_time"]).to eq(neighbor_rx_time)
        end

        get "/api/neighbors"

        expect(last_response).to be_ok
        neighbors = JSON.parse(last_response.body)
        expect(neighbors.map { |row| row["neighbor_id"] }).to contain_exactly("!00ff0011", "!11223344")
        expect(neighbors.first).to include("node_id" => "!abc123ef")
        expect(neighbors.first["rx_iso"]).to be_a(String)

        with_db(readonly: true) do |db|
          db.results_as_hash = true
          node_rows = db.execute(
            "SELECT node_id, last_heard FROM nodes ORDER BY node_id",
          )

          expect(node_rows.size).to eq(3)
          origin = node_rows.find { |row| row["node_id"] == "!abc123ef" }
          expect(origin["last_heard"]).to eq(rx_time)
          neighbor_one = node_rows.find { |row| row["node_id"] == "!00ff0011" }
          expect(neighbor_one["last_heard"]).to eq(rx_time)
          neighbor_two = node_rows.find { |row| row["node_id"] == "!11223344" }
          expect(neighbor_two["last_heard"]).to eq(neighbor_rx_time)
        end
      end

      it "handles broadcasts with no neighbors" do
        rx_time = reference_time.to_i - 60
        payload = {
          "node_id" => "!cafebabe",
          "rx_time" => rx_time,
          "neighbors" => [],
        }

        post "/api/neighbors", payload.to_json, auth_headers

        expect(last_response).to be_ok
        expect(JSON.parse(last_response.body)).to eq("status" => "ok")

        with_db(readonly: true) do |db|
          count = db.get_first_value("SELECT COUNT(*) FROM neighbors")
          expect(count).to eq(0)

          db.results_as_hash = true
          row = db.get_first_row(
            "SELECT node_id, last_heard FROM nodes WHERE node_id = ?",
            ["!cafebabe"],
          )
          expect(row).not_to be_nil
          expect(row["last_heard"]).to eq(rx_time)
        end

        get "/api/neighbors"
        expect(last_response).to be_ok
        expect(JSON.parse(last_response.body)).to be_empty
      end

      it "returns 400 when more than 1000 neighbor packets are provided" do
        payload = Array.new(1001) do |i|
          { "node_id" => format("!%08x", i), "rx_time" => reference_time.to_i - i }
        end

        post "/api/neighbors", payload.to_json, auth_headers

        expect(last_response.status).to eq(400)
        expect(JSON.parse(last_response.body)).to eq("error" => "too many neighbor packets")

        with_db(readonly: true) do |db|
          count = db.get_first_value("SELECT COUNT(*) FROM neighbors")
          expect(count).to eq(0)
        end
      end
    end

    describe "POST /api/telemetry" do
      it "stores telemetry packets and updates node metrics" do
        payload = telemetry_fixture

        post "/api/telemetry", payload.to_json, auth_headers

        expect(last_response).to be_ok
        expect(JSON.parse(last_response.body)).to eq("status" => "ok")

        with_db(readonly: true) do |db|
          db.results_as_hash = true
          rows = db.execute(
            "SELECT * FROM telemetry ORDER BY id",
          )

          expect(rows.size).to eq(payload.size)

          first = rows.find { |row| row["id"] == payload[0]["id"] }
          expect(first).not_to be_nil
          expect(first["node_id"]).to eq(payload[0]["node_id"])
          expect(first["rx_time"]).to eq(payload[0]["rx_time"])
          expect_same_value(first["battery_level"], payload[0]["battery_level"])
          expect_same_value(first["voltage"], payload[0].dig("device_metrics", "voltage"))
          expect_same_value(first["channel_utilization"], payload[0].dig("device_metrics", "channelUtilization"))
          expect_same_value(first["air_util_tx"], payload[0].dig("device_metrics", "airUtilTx"))
          expect(first["uptime_seconds"]).to eq(payload[0].dig("device_metrics", "uptimeSeconds"))
          expect_same_value(first["current"], payload[0]["current"])
          expect_same_value(first["gas_resistance"], payload[0]["gas_resistance"])
          expect_same_value(first["iaq"], payload[0]["iaq"])
          expect_same_value(first["distance"], payload[0]["distance"])
          expect_same_value(first["lux"], payload[0]["lux"])
          expect_same_value(first["white_lux"], payload[0]["white_lux"])
          expect_same_value(first["ir_lux"], payload[0]["ir_lux"])
          expect_same_value(first["uv_lux"], payload[0]["uv_lux"])
          expect_same_value(first["wind_direction"], payload[0]["wind_direction"])
          expect_same_value(first["wind_speed"], payload[0]["wind_speed"])
          expect_same_value(first["wind_gust"], payload[0]["wind_gust"])
          expect_same_value(first["wind_lull"], payload[0]["wind_lull"])
          expect_same_value(first["weight"], payload[0]["weight"])
          expect_same_value(first["radiation"], payload[0]["radiation"])
          expect_same_value(first["rainfall_1h"], payload[0]["rainfall_1h"])
          expect_same_value(first["rainfall_24h"], payload[0]["rainfall_24h"])
          expect_same_value(first["soil_moisture"], payload[0]["soil_moisture"])
          expect_same_value(first["soil_temperature"], payload[0]["soil_temperature"])

          environment_row = rows.find { |row| row["id"] == payload[1]["id"] }
          expect(environment_row["temperature"]).to be_within(1e-6).of(payload[1].dig("environment_metrics", "temperature"))
          expect(environment_row["relative_humidity"]).to be_within(1e-6).of(payload[1].dig("environment_metrics", "relativeHumidity"))
          expect(environment_row["barometric_pressure"]).to be_within(1e-6).of(payload[1].dig("environment_metrics", "barometricPressure"))
          expect_same_value(environment_row["gas_resistance"], payload[1].dig("environment_metrics", "gasResistance"))
          expect_same_value(environment_row["iaq"], payload[1].dig("environment_metrics", "iaq"))
          expect_same_value(environment_row["distance"], payload[1].dig("environment_metrics", "distance"))
          expect_same_value(environment_row["lux"], payload[1].dig("environment_metrics", "lux"))
          expect_same_value(environment_row["white_lux"], payload[1].dig("environment_metrics", "whiteLux"))
          expect_same_value(environment_row["ir_lux"], payload[1].dig("environment_metrics", "irLux"))
          expect_same_value(environment_row["uv_lux"], payload[1].dig("environment_metrics", "uvLux"))
          expect_same_value(environment_row["wind_direction"], payload[1].dig("environment_metrics", "windDirection"))
          expect_same_value(environment_row["wind_speed"], payload[1].dig("environment_metrics", "windSpeed"))
          expect_same_value(environment_row["wind_gust"], payload[1].dig("environment_metrics", "windGust"))
          expect_same_value(environment_row["wind_lull"], payload[1].dig("environment_metrics", "windLull"))
          expect_same_value(environment_row["weight"], payload[1].dig("environment_metrics", "weight"))
          expect_same_value(environment_row["radiation"], payload[1].dig("environment_metrics", "radiation"))
          expect_same_value(environment_row["rainfall_1h"], payload[1].dig("environment_metrics", "rainfall1h"))
          expect_same_value(environment_row["rainfall_24h"], payload[1].dig("environment_metrics", "rainfall24h"))
          expect_same_value(environment_row["soil_moisture"], payload[1].dig("environment_metrics", "soilMoisture"))
          expect_same_value(environment_row["soil_temperature"], payload[1].dig("environment_metrics", "soilTemperature"))

          third_row = rows.find { |row| row["id"] == payload[2]["id"] }
          expect_same_value(third_row["current"], payload[2].dig("device_metrics", "current"))
          expect_same_value(third_row["distance"], payload[2].dig("environment_metrics", "distance"))
          expect_same_value(third_row["lux"], payload[2].dig("environment_metrics", "lux"))
          expect_same_value(third_row["wind_direction"], payload[2].dig("environment_metrics", "windDirection"))
          expect_same_value(third_row["wind_speed"], payload[2].dig("environment_metrics", "windSpeed"))
          expect_same_value(third_row["weight"], payload[2].dig("environment_metrics", "weight"))
          expect_same_value(third_row["rainfall_24h"], payload[2].dig("environment_metrics", "rainfall24h"))
          expect_same_value(third_row["soil_moisture"], payload[2].dig("environment_metrics", "soilMoisture"))
          expect_same_value(third_row["soil_temperature"], payload[2].dig("environment_metrics", "soilTemperature"))
        end

        with_db(readonly: true) do |db|
          db.results_as_hash = true

          metrics_node = db.get_first_row(
            "SELECT battery_level, voltage, channel_utilization, air_util_tx, uptime_seconds, last_heard, first_heard FROM nodes WHERE node_id = ?",
            [payload[0]["node_id"]],
          )
          expect_same_value(metrics_node["battery_level"], payload[0]["battery_level"])
          expect_same_value(metrics_node["voltage"], payload[0]["device_metrics"]["voltage"])
          expect_same_value(metrics_node["channel_utilization"], payload[0]["device_metrics"]["channelUtilization"])
          expect_same_value(metrics_node["air_util_tx"], payload[0]["device_metrics"]["airUtilTx"])
          expect(metrics_node["uptime_seconds"]).to eq(payload[0]["device_metrics"]["uptimeSeconds"])
          expect(metrics_node["last_heard"]).to eq(payload[0]["rx_time"])
          expect(metrics_node["first_heard"]).to eq(payload[0]["rx_time"])

          env_node = db.get_first_row(
            "SELECT last_heard, battery_level, voltage FROM nodes WHERE node_id = ?",
            [payload[1]["node_id"]],
          )
          expect(env_node["last_heard"]).to eq(payload[1]["rx_time"])
          expect(env_node["battery_level"]).to be_nil
          expect(env_node["voltage"]).to be_nil

          local_node = db.get_first_row(
            "SELECT battery_level, uptime_seconds, last_heard FROM nodes WHERE node_id = ?",
            [payload[2]["node_id"]],
          )
          expect_same_value(local_node["battery_level"], payload[2]["device_metrics"]["battery_level"])
          expect(local_node["uptime_seconds"]).to eq(payload[2]["device_metrics"]["uptime_seconds"])
          expect(local_node["last_heard"]).to eq(payload[2]["rx_time"])
        end
      end

      it "returns 400 when the payload is not valid JSON" do
        post "/api/telemetry", "{", auth_headers

        expect(last_response.status).to eq(400)
        expect(JSON.parse(last_response.body)).to eq("error" => "invalid JSON")
      end

      it "returns 400 when more than 1000 telemetry packets are provided" do
        payload = Array.new(1001) { |i| { "id" => i + 1, "rx_time" => reference_time.to_i - i } }

        post "/api/telemetry", payload.to_json, auth_headers

        expect(last_response.status).to eq(400)
        expect(JSON.parse(last_response.body)).to eq("error" => "too many telemetry packets")

        with_db(readonly: true) do |db|
          count = db.get_first_value("SELECT COUNT(*) FROM telemetry")
          expect(count).to eq(0)
        end
      end
    end

    describe "POST /api/traces" do
      it "stores traces with hop paths and updates last heard timestamps" do
        payload = trace_fixture

        post "/api/traces", payload.to_json, auth_headers

        expect(last_response).to be_ok
        expect(JSON.parse(last_response.body)).to eq("status" => "ok")

        with_db(readonly: true) do |db|
          db.results_as_hash = true

          traces = db.execute("SELECT * FROM traces ORDER BY rx_time DESC")
          expect(traces.size).to eq(payload.size)

          primary = traces.find { |row| row["id"] == payload.first["id"] }
          expect(primary["request_id"]).to eq(payload.first["request_id"])
          expect(primary["src"]).to eq(payload.first["src"])
          expect(primary["dest"]).to eq(payload.first["dest"])
          expect(primary["rx_time"]).to eq(payload.first["rx_time"])
          expect(primary["rx_iso"]).to eq(Time.at(payload.first["rx_time"]).utc.iso8601)
          expect(primary["rssi"]).to eq(payload.first["rssi"])
          expect(primary["snr"]).to eq(payload.first["snr"])
          expect(primary["elapsed_ms"]).to eq(payload.first["elapsed_ms"])

          primary_hops = db.execute(
            "SELECT hop_index, node_id FROM trace_hops WHERE trace_id = ? ORDER BY hop_index",
            [primary["id"]],
          )
          expect(primary_hops.map { |row| row["node_id"] }).to eq(payload.first["hops"])

          secondary = traces.find { |row| row["id"] == payload.last["packet_id"] }
          expect(secondary["request_id"]).to eq(payload.last["req"])
          expect(secondary["src"]).to eq(payload.last["from"])
          expect(secondary["dest"]).to eq(payload.last["destination"])
          expect(secondary["rssi"]).to be_nil
          expect(secondary["snr"]).to eq(payload.last.dig("metrics", "snr"))
          expect(secondary["elapsed_ms"]).to eq(payload.last.dig("metrics", "latency_ms"))

          secondary_hops = db.execute(
            "SELECT hop_index, node_id FROM trace_hops WHERE trace_id = ? ORDER BY hop_index",
            [secondary["id"]],
          )
          expect(secondary_hops.map { |row| row["node_id"] }).to eq([0xBEADF00D, 19_088_743])

          node_ids = [
            payload.first["src"],
            payload.first["dest"],
            payload.first["hops"][1],
            0xBEADF00D,
          ].map { |num| format("!%08x", num & 0xFFFFFFFF) }

          placeholders = node_ids.map { "?" }.join(",")
          rows = db.execute("SELECT node_id, last_heard FROM nodes WHERE node_id IN (#{placeholders})", node_ids)
          expect(rows.size).to eq(node_ids.size)
          latest_last_heard = rows.map { |row| row["last_heard"] }.max
          expect(latest_last_heard).to eq(payload.first["rx_time"])
        end
      end

      it "returns 400 when the payload is not valid JSON" do
        post "/api/traces", "{", auth_headers

        expect(last_response.status).to eq(400)
        expect(JSON.parse(last_response.body)).to eq("error" => "invalid JSON")
      end

      it "returns 400 when more than 1000 traces are provided" do
        payload = Array.new(1001) { |i| { "id" => i + 1, "rx_time" => reference_time.to_i - i } }

        post "/api/traces", payload.to_json, auth_headers

        expect(last_response.status).to eq(400)
        expect(JSON.parse(last_response.body)).to eq("error" => "too many traces")

        with_db(readonly: true) do |db|
          count = db.get_first_value("SELECT COUNT(*) FROM traces")
          expect(count).to eq(0)
        end
      end
    end

    it "returns 400 when more than 1000 messages are provided" do
      payload = Array.new(1001) { |i| { "packet_id" => i + 1 } }

      post "/api/messages", payload.to_json, auth_headers

      expect(last_response.status).to eq(400)
      expect(JSON.parse(last_response.body)).to eq("error" => "too many messages")

      with_db(readonly: true) do |db|
        count = db.get_first_value("SELECT COUNT(*) FROM messages")
        expect(count).to eq(0)
      end
    end

    it "accepts array payloads, normalizes node references, and skips messages without an id" do
      node_id = "!spec-normalized"
      node_payload = {
        node_id => {
          "num" => 123,
          "user" => { "shortName" => "Spec" },
          "lastHeard" => reference_time.to_i - 60,
          "position" => { "time" => reference_time.to_i - 120 },
        },
      }

      post "/api/nodes", node_payload.to_json, auth_headers
      expect(last_response).to be_ok

      messages_payload = [
        {
          "packet_id" => 101,
          "from_id" => "123",
          "text" => "normalized",
        },
        {
          "packet_id" => 102,
          "from_id" => " ",
          "text" => "blank",
        },
        {
          "text" => "missing id",
        },
      ]

      post "/api/messages", messages_payload.to_json, auth_headers

      expect(last_response).to be_ok
      expect(JSON.parse(last_response.body)).to eq("status" => "ok")

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        rows = db.execute(
          "SELECT id, from_id, to_id, rx_time, rx_iso, text, encrypted FROM messages ORDER BY id",
        )

        expect(rows.size).to eq(2)

        first, second = rows

        expect(first["id"]).to eq(101)
        expect(first["from_id"]).to eq(node_id)
        expect(first).not_to have_key("from_node_id")
        expect(first).not_to have_key("from_node_num")
        expect(first["rx_time"]).to eq(reference_time.to_i)
        expect(first["rx_iso"]).to eq(reference_time.utc.iso8601)
        expect(first["text"]).to eq("normalized")
        expect(first).not_to have_key("to_node_id")
        expect(first).not_to have_key("to_node_num")
        expect(first["encrypted"]).to be_nil

        expect(second["id"]).to eq(102)
        expect(second["from_id"]).to be_nil
        expect(second).not_to have_key("from_node_id")
        expect(second).not_to have_key("from_node_num")
        expect(second["rx_time"]).to eq(reference_time.to_i)
        expect(second["rx_iso"]).to eq(reference_time.utc.iso8601)
        expect(second["text"]).to eq("blank")
        expect(second).not_to have_key("to_node_id")
        expect(second).not_to have_key("to_node_num")
        expect(second["encrypted"]).to be_nil
      end
    end

    it "stores encrypted messages and resolves node references" do
      sender_id = "!feedc0de"
      sender_num = 0xfeedc0de
      receiver_id = "!c0ffee99"
      receiver_num = 0xc0ffee99

      sender_node = {
        "node_id" => sender_id,
        "short_name" => "EncS",
        "long_name" => "Encrypted Sender",
        "hw_model" => "TEST",
        "role" => "CLIENT",
        "snr" => 5.5,
        "battery_level" => 80.0,
        "voltage" => 3.9,
        "last_heard" => reference_time.to_i - 30,
        "position_time" => reference_time.to_i - 60,
        "latitude" => 52.1,
        "longitude" => 13.1,
        "altitude" => 42.0,
      }
      sender_payload = build_node_payload(sender_node)
      sender_payload["num"] = sender_num

      receiver_node = {
        "node_id" => receiver_id,
        "short_name" => "EncR",
        "long_name" => "Encrypted Receiver",
        "hw_model" => "TEST",
        "role" => "CLIENT",
        "snr" => 4.25,
        "battery_level" => 75.0,
        "voltage" => 3.8,
        "last_heard" => reference_time.to_i - 40,
        "position_time" => reference_time.to_i - 70,
        "latitude" => 52.2,
        "longitude" => 13.2,
        "altitude" => 35.0,
      }
      receiver_payload = build_node_payload(receiver_node)
      receiver_payload["num"] = receiver_num

      post "/api/nodes", { sender_id => sender_payload }.to_json, auth_headers
      expect(last_response).to be_ok
      post "/api/nodes", { receiver_id => receiver_payload }.to_json, auth_headers
      expect(last_response).to be_ok

      encrypted_b64 = Base64.strict_encode64("secret message")
      payload = {
        "packet_id" => 777_001,
        "rx_time" => reference_time.to_i,
        "rx_iso" => reference_time.utc.iso8601,
        "from_id" => sender_num.to_s,
        "to_id" => receiver_id,
        "channel" => 8,
        "portnum" => "TEXT_MESSAGE_APP",
        "encrypted" => encrypted_b64,
        "snr" => -12.5,
        "rssi" => -109,
        "hop_limit" => 3,
      }

      post "/api/messages", payload.to_json, auth_headers

      expect(last_response).to be_ok
      expect(JSON.parse(last_response.body)).to eq("status" => "ok")

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        row = db.get_first_row(
          "SELECT from_id, to_id, text, encrypted FROM messages WHERE id = ?",
          [777_001],
        )

        expect(row["from_id"]).to eq(sender_id)
        expect(row["to_id"]).to eq(receiver_id)
        expect(row["text"]).to be_nil
        expect(row["encrypted"]).to eq(encrypted_b64)

        node_row = db.get_first_row(
          "SELECT last_heard FROM nodes WHERE node_id = ?",
          [sender_id],
        )

        expect(node_row["last_heard"]).to eq(payload["rx_time"])
      end

      get "/api/messages"
      expect(last_response).to be_ok

      default_messages = JSON.parse(last_response.body)
      expect(default_messages).to be_an(Array)
      expect(default_messages.map { |row| row["id"] }).not_to include(payload["packet_id"])

      get "/api/messages?encrypted=1"
      expect(last_response).to be_ok

      messages = JSON.parse(last_response.body)
      expect(messages).to be_an(Array)

      encrypted_entry = messages.find { |row| row["id"] == payload["packet_id"] }
      expect(encrypted_entry).not_to be_nil
      expect(encrypted_entry["encrypted"]).to eq(encrypted_b64)
      expect(encrypted_entry["text"]).to be_nil
      expect(encrypted_entry["from_id"]).to eq(sender_id)
      expect(encrypted_entry["to_id"]).to eq(receiver_id)

      get "/api/messages/#{receiver_id}"
      expect(last_response).to be_ok

      node_default = JSON.parse(last_response.body)
      expect(node_default.map { |row| row["id"] }).not_to include(payload["packet_id"])

      get "/api/messages/#{receiver_id}?encrypted=1"
      expect(last_response).to be_ok

      node_messages = JSON.parse(last_response.body)
      node_entry = node_messages.find { |row| row["id"] == payload["packet_id"] }
      expect(node_entry).not_to be_nil
      expect(node_entry["encrypted"]).to eq(encrypted_b64)
      expect(node_entry["text"]).to be_nil
      expect(node_entry["from_id"]).to eq(sender_id)
      expect(node_entry["to_id"]).to eq(receiver_id)
    end

    it "updates node last_heard for plaintext messages" do
      node_id = "!plainmsg01"
      initial_first = reference_time.to_i - 600
      initial_last = reference_time.to_i - 300

      with_db do |db|
        db.execute(
          "INSERT INTO nodes(node_id, last_heard, first_heard) VALUES (?,?,?)",
          [node_id, initial_last, initial_first],
        )
      end

      rx_time = reference_time.to_i - 120
      payload = {
        "packet_id" => 888_001,
        "rx_time" => rx_time,
        "rx_iso" => Time.at(rx_time).utc.iso8601,
        "from_id" => node_id,
        "text" => "plaintext update",
      }

      post "/api/messages", payload.to_json, auth_headers

      expect(last_response).to be_ok
      expect(JSON.parse(last_response.body)).to eq("status" => "ok")

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        row = db.get_first_row(
          "SELECT last_heard, first_heard FROM nodes WHERE node_id = ?",
          [node_id],
        )

        expect(row["last_heard"]).to eq(rx_time)
        expect(row["first_heard"]).to eq(initial_first)
      end
    end

    it "stores messages containing SQL control characters without executing them" do
      payload = {
        "packet_id" => 404,
        "from_id" => "attacker",
        "text" => "'); DROP TABLE nodes;--",
      }

      post "/api/messages", payload.to_json, auth_headers

      expect(last_response).to be_ok
      expect(JSON.parse(last_response.body)).to eq("status" => "ok")

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        row = db.get_first_row(
          "SELECT id, text FROM messages WHERE id = ?",
          [404],
        )

        expect(row["id"]).to eq(404)
        expect(row["text"]).to eq("'); DROP TABLE nodes;--")

        tables = db.get_first_value(
          "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='nodes'",
        )
        expect(tables).to eq(1)
      end
    end

    it "updates existing messages only when sender information is provided" do
      message_id = 9001
      initial_time = reference_time.to_i - 120
      initial_iso = Time.at(initial_time).utc.iso8601
      base_payload = {
        "packet_id" => message_id,
        "rx_time" => initial_time,
        "rx_iso" => initial_iso,
        "to_id" => "^all",
        "channel" => 1,
        "portnum" => "TEXT_MESSAGE_APP",
        "text" => "initial payload",
        "snr" => 7.25,
        "rssi" => -58,
        "hop_limit" => 2,
      }

      post "/api/messages", base_payload.merge("from_id" => nil).to_json, auth_headers

      expect(last_response).to be_ok
      expect(JSON.parse(last_response.body)).to eq("status" => "ok")

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        row = db.get_first_row("SELECT id, from_id, rx_time, rx_iso, text FROM messages WHERE id = ?", [message_id])

        expect(row["from_id"]).to be_nil
        expect(row["rx_time"]).to eq(initial_time)
        expect(row["rx_iso"]).to eq(initial_iso)
        expect(row["text"]).to eq("initial payload")
      end

      updated_time = initial_time + 60
      updated_iso = Time.at(updated_time).utc.iso8601
      post "/api/messages", base_payload.merge(
        "rx_time" => updated_time,
        "rx_iso" => updated_iso,
        "text" => "overwritten without sender",
        "from_id" => " ",
      ).to_json, auth_headers

      expect(last_response).to be_ok
      expect(JSON.parse(last_response.body)).to eq("status" => "ok")

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        row = db.get_first_row("SELECT id, from_id, rx_time, rx_iso, text FROM messages WHERE id = ?", [message_id])

        expect(row["from_id"]).to be_nil
        expect(row["rx_time"]).to eq(initial_time)
        expect(row["rx_iso"]).to eq(initial_iso)
        expect(row["text"]).to eq("initial payload")
      end

      final_time = updated_time + 30
      final_iso = Time.at(final_time).utc.iso8601
      post "/api/messages", base_payload.merge(
        "rx_time" => final_time,
        "rx_iso" => final_iso,
        "from" => "!spec-sender",
      ).to_json, auth_headers

      expect(last_response).to be_ok
      expect(JSON.parse(last_response.body)).to eq("status" => "ok")

      with_db(readonly: true) do |db|
        db.results_as_hash = true
        row = db.get_first_row("SELECT id, from_id, rx_time, rx_iso, text FROM messages WHERE id = ?", [message_id])

        expect(row["from_id"]).to eq("!spec-sender")
        expect(row["rx_time"]).to eq(initial_time)
        expect(row["rx_iso"]).to eq(initial_iso)
        expect(row["text"]).to eq("initial payload")
      end
    end
  end

  describe "GET /api/nodes" do
    it "returns the stored nodes with derived timestamps" do
      import_nodes_fixture

      get "/api/nodes"
      expect(last_response).to be_ok

      actual = JSON.parse(last_response.body)
      expect(actual.size).to eq(nodes_fixture.size)

      actual_by_id = actual.each_with_object({}) do |row, acc|
        acc[row["node_id"]] = row
      end

      nodes_fixture.each do |node|
        expected = expected_node_row(node)
        actual_row = actual_by_id.fetch(node["node_id"])

        expected.each do |key, value|
          expect_api_value(actual_row, key, value)
        end

        if expected["last_heard"]
          expected_last_seen_iso = Time.at(expected["last_heard"]).utc.iso8601
          expect(actual_row["last_seen_iso"]).to eq(expected_last_seen_iso)
        else
          expect(actual_row).not_to have_key("last_seen_iso")
        end

        if node["position_time"]
          expected_pos_iso = Time.at(node["position_time"]).utc.iso8601
          expect(actual_row["pos_time_iso"]).to eq(expected_pos_iso)
        else
          expect(actual_row).not_to have_key("pos_time_iso")
        end
      end
    end

    it "excludes nodes whose last activity is older than a week" do
      clear_database
      allow(Time).to receive(:now).and_return(reference_time)
      now = reference_time.to_i
      stale_last = now - (PotatoMesh::Config.week_seconds + 60)
      fresh_last = now - 30

      with_db do |db|
        db.execute(
          "INSERT INTO nodes(node_id, short_name, long_name, hw_model, role, snr, last_heard, first_heard) VALUES(?,?,?,?,?,?,?,?)",
          ["!stale-node", "stal", "Stale", "TBEAM", "CLIENT", 0.0, stale_last, stale_last],
        )
        db.execute(
          "INSERT INTO nodes(node_id, short_name, long_name, hw_model, role, snr, last_heard, first_heard) VALUES(?,?,?,?,?,?,?,?)",
          ["!fresh-node", "frsh", "Fresh", "TBEAM", "CLIENT", 0.0, fresh_last, fresh_last],
        )
      end

      get "/api/nodes"

      expect(last_response).to be_ok
      ids = JSON.parse(last_response.body).map { |row| row["node_id"] }
      expect(ids).to include("!fresh-node")
      expect(ids).not_to include("!stale-node")

      get "/api/nodes/!stale-node"
      expect(last_response.status).to eq(404)

      get "/api/nodes/!fresh-node"
      expect(last_response).to be_ok
      payload = JSON.parse(last_response.body)
      expect(payload["node_id"]).to eq("!fresh-node")
    end

    it "omits blank values from node responses" do
      clear_database
      allow(Time).to receive(:now).and_return(reference_time)
      now = reference_time.to_i

      with_db do |db|
        db.execute(
          "INSERT INTO nodes(node_id, short_name, long_name, hw_model, role, snr, battery_level, voltage, last_heard, first_heard, uptime_seconds, channel_utilization, air_util_tx, position_time, location_source, precision_bits, latitude, longitude, altitude) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          [
            "!blank",
            " ",
            nil,
            "",
            nil,
            nil,
            nil,
            nil,
            now,
            now,
            nil,
            nil,
            nil,
            nil,
            " ",
            nil,
            nil,
            nil,
            nil,
          ],
        )
      end

      get "/api/nodes"

      expect(last_response).to be_ok
      nodes = JSON.parse(last_response.body)
      expect(nodes.length).to eq(1)
      entry = nodes.first
      expect(entry["node_id"]).to eq("!blank")
      %w[short_name long_name hw_model snr battery_level voltage uptime_seconds channel_utilization air_util_tx position_time location_source precision_bits latitude longitude altitude].each do |attribute|
        expect(entry).not_to have_key(attribute), "expected #{attribute} to be omitted"
      end

      expect(entry["role"]).to eq("CLIENT")
      expect(entry["last_heard"]).to eq(now)
      expect(entry["first_heard"]).to eq(now)
      expect(entry["last_seen_iso"]).to eq(Time.at(now).utc.iso8601)
      expect(entry).not_to have_key("pos_time_iso")

      get "/api/nodes/!blank"

      expect(last_response).to be_ok
      payload = JSON.parse(last_response.body)
      expect(payload["node_id"]).to eq("!blank")
      expect(payload).not_to have_key("short_name")
      expect(payload).not_to have_key("hw_model")
    end
  end

  describe "GET /api/messages" do
    it "returns the stored messages with canonical node references when encrypted messages are included" do
      import_nodes_fixture
      import_messages_fixture

      get "/api/messages?encrypted=1"
      expect(last_response).to be_ok

      actual = JSON.parse(last_response.body)
      expect(actual.size).to eq(messages_fixture.size)

      actual_by_id = actual.each_with_object({}) do |row, acc|
        acc[row["id"]] = row
      end

      node_aliases = {}

      nodes_fixture.each do |node|
        if (num = node["num"])
          node_aliases[num.to_s] = node["node_id"]
        end
      end

      messages_fixture.each do |message|
        expected = message.reject { |key, _| key == "node" }
        actual_row = actual_by_id.fetch(message["id"])

        expected_from_id = expected["from_id"]
        if expected_from_id.is_a?(String)
          trimmed = expected_from_id.strip
          if trimmed.match?(/\A[0-9]+\z/)
            expected_from_id = node_aliases[trimmed] || message.dig("node", "node_id") || trimmed
          else
            expected_from_id = trimmed
          end
        elsif expected_from_id.nil?
          expected_from_id = message.dig("node", "node_id")
        end
        expect(actual_row["from_id"]).to eq(expected_from_id)

        expected_node_id = if expected_from_id.is_a?(String)
            expected_from_id
          else
            node_id = message.dig("node", "node_id")
            if node_id.nil?
              num = message.dig("node", "num")
              node_id = node_aliases[num.to_s] if num
            end
            node_id
          end

        if expected_node_id
          expect(actual_row["node_id"]).to eq(expected_node_id)
        else
          expect(actual_row).not_to have_key("node_id")
        end

        expected_to_id = expected["to_id"]
        if expected_to_id.is_a?(String)
          trimmed_to = expected_to_id.strip
          if trimmed_to.match?(/\A[0-9]+\z/)
            expected_to_id = node_aliases[trimmed_to] || trimmed_to
          else
            expected_to_id = trimmed_to
          end
        end
        expect(actual_row["to_id"]).to eq(expected_to_id)

        %w[channel portnum text encrypted].each do |attribute|
          expect_api_value(actual_row, attribute, expected[attribute])
        end

        expect_api_value(actual_row, "snr", expected["snr"])
        expect_api_value(actual_row, "rssi", expected["rssi"])
        expect_api_value(actual_row, "hop_limit", expected["hop_limit"])
        expect_api_value(actual_row, "lora_freq", expected["lora_freq"])
        expect_api_value(actual_row, "modem_preset", expected["modem_preset"])
        expect_api_value(actual_row, "channel_name", expected["channel_name"])
        expect_api_value(actual_row, "reply_id", expected["reply_id"])
        expect_api_value(actual_row, "emoji", expected["emoji"])
        expect(actual_row["rx_time"]).to eq(expected["rx_time"])
        expect(actual_row["rx_iso"]).to eq(expected["rx_iso"])
        expect(actual_row).not_to have_key("node")
      end
    end
    context "when DEBUG logging is enabled" do
      it "logs diagnostics for messages missing a sender" do
        allow(PotatoMesh::Config).to receive(:debug?).and_return(true)
        allow(PotatoMesh::Logging).to receive(:log).and_call_original

        message_id = 987_654
        payload = {
          "packet_id" => message_id,
          "from_id" => " ",
          "text" => "debug logging",
        }

        post "/api/messages", payload.to_json, auth_headers
        expect(last_response).to be_ok
        expect(JSON.parse(last_response.body)).to eq("status" => "ok")

        get "/api/messages"
        expect(last_response).to be_ok

        expect(PotatoMesh::Logging).to have_received(:log).with(
          kind_of(Logger),
          :debug,
          "Message query produced empty sender",
          context: "queries.messages",
          stage: "raw_row",
          row: a_hash_including("id" => message_id),
        )
        expect(PotatoMesh::Logging).to have_received(:log).with(
          kind_of(Logger),
          :debug,
          "Message query produced empty sender",
          context: "queries.messages",
          stage: "after_normalization",
          row: a_hash_including("id" => message_id),
        )
        messages = JSON.parse(last_response.body)
        expect(messages.size).to eq(1)
        expect(messages.first["from_id"]).to be_nil
      end
    end

    it "omits messages received more than seven days ago" do
      clear_database
      allow(Time).to receive(:now).and_return(reference_time)
      now = reference_time.to_i
      stale_rx = now - (PotatoMesh::Config.week_seconds + 120)
      fresh_rx = now - 15

      with_db do |db|
        db.execute(
          "INSERT INTO nodes(node_id, short_name, long_name, hw_model, role, snr, last_heard, first_heard) VALUES(?,?,?,?,?,?,?,?)",
          ["!fresh", "frsh", "Fresh", "TBEAM", "CLIENT", 0.0, fresh_rx, fresh_rx],
        )
        db.execute(
          "INSERT INTO messages(id, rx_time, rx_iso, from_id, to_id, channel, portnum, text, snr, rssi, hop_limit) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          [1, stale_rx, Time.at(stale_rx).utc.iso8601, "!old", "!fresh", 0, "TEXT_MESSAGE_APP", "stale", 1.0, -70, 3],
        )
        db.execute(
          "INSERT INTO messages(id, rx_time, rx_iso, from_id, to_id, channel, portnum, text, snr, rssi, hop_limit) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          [2, fresh_rx, Time.at(fresh_rx).utc.iso8601, "!fresh", "!old", 0, "TEXT_MESSAGE_APP", "fresh", 2.0, -60, 3],
        )
      end

      get "/api/messages"

      expect(last_response).to be_ok
      payload = JSON.parse(last_response.body)
      ids = payload.map { |row| row["id"] }
      expect(ids).to include(2)
      expect(ids).not_to include(1)

      get "/api/messages/!old"

      expect(last_response).to be_ok
      filtered = JSON.parse(last_response.body)
      expect(filtered.map { |row| row["id"] }).to eq([2])
    end
  end

  context "when private mode is enabled" do
    before do
      ENV["PRIVATE"] = "1"
    end

    it "returns 404 for GET /api/messages" do
      get "/api/messages"
      expect(last_response.status).to eq(404)
    end

    it "returns 404 for HEAD /api/messages" do
      head "/api/messages"
      expect(last_response.status).to eq(404)
    end

    it "returns 404 for POST /api/messages" do
      post "/api/messages", {}.to_json, auth_headers
      expect(last_response.status).to eq(404)
    end

    it "excludes hidden clients from the nodes API" do
      now = reference_time.to_i
      with_db do |db|
        db.execute(
          "INSERT INTO nodes(node_id, short_name, long_name, hw_model, role, snr, last_heard, first_heard) VALUES(?,?,?,?,?,?,?,?)",
          ["!hidden", "hidn", "Hidden", "TBEAM", "CLIENT_HIDDEN", 0.0, now, now],
        )
        db.execute(
          "INSERT INTO nodes(node_id, short_name, long_name, hw_model, role, snr, last_heard, first_heard) VALUES(?,?,?,?,?,?,?,?)",
          ["!visible", "vis", "Visible", "TBEAM", "CLIENT", 1.0, now, now],
        )
      end

      get "/api/nodes?limit=10"

      expect(last_response).to be_ok
      nodes = JSON.parse(last_response.body)
      ids = nodes.map { |node| node["node_id"] }
      expect(ids).to include("!visible")
      expect(ids).not_to include("!hidden")
    end

    it "removes the chat interface from the homepage" do
      get "/"

      expect(last_response).to be_ok
      body = last_response.body
      expect(body).not_to include('<div id="chat"')
      expect(body).to include("const CHAT_ENABLED = false;")
      expect(body).not_to include("Track nodes, messages, and coverage in real time.")
      expect(body).to include("Track nodes and coverage in real time.")
    end
  end

  describe "GET /api/positions" do
    it "returns stored positions ordered by receive time" do
      node_id = "!specfetch"
      rx_times = [reference_time.to_i - 50, reference_time.to_i - 10]
      rx_times.each_with_index do |rx_time, idx|
        payload = {
          "id" => 20_000 + idx,
          "node_id" => node_id,
          "rx_time" => rx_time,
          "rx_iso" => Time.at(rx_time).utc.iso8601,
          "position_time" => rx_time - 5,
          "latitude" => 52.0 + idx,
          "longitude" => 13.0 + idx,
          "location_source" => "LOC_TEST",
          "precision_bits" => 7 + idx,
          "payload_b64" => "AQI=",
        }
        post "/api/positions", payload.to_json, auth_headers
        expect(last_response).to be_ok
      end

      get "/api/positions?limit=1"

      expect(last_response).to be_ok
      data = JSON.parse(last_response.body)
      expect(data.length).to eq(1)
      entry = data.first
      expect(entry["id"]).to eq(20_001)
      expect(entry["node_id"]).to eq(node_id)
      expect(entry["rx_time"]).to eq(rx_times.last)
      expect(entry["rx_iso"]).to eq(Time.at(rx_times.last).utc.iso8601)
      expect(entry["position_time"]).to eq(rx_times.last - 5)
      expect(entry["position_time_iso"]).to eq(Time.at(rx_times.last - 5).utc.iso8601)
      expect(entry["latitude"]).to eq(53.0)
      expect(entry["longitude"]).to eq(14.0)
      expect(entry["location_source"]).to eq("LOC_TEST")
      expect(entry["precision_bits"]).to eq(8)
      expect(entry["payload_b64"]).to eq("AQI=")
    end

    it "excludes position entries older than seven days" do
      clear_database
      allow(Time).to receive(:now).and_return(reference_time)
      now = reference_time.to_i
      stale_rx = now - (PotatoMesh::Config.week_seconds + 10)
      fresh_rx = now - 20

      with_db do |db|
        db.execute(
          "INSERT INTO positions(id, node_id, node_num, rx_time, rx_iso, position_time, latitude, longitude) VALUES(?,?,?,?,?,?,?,?)",
          [1, "!pos", 42, stale_rx, Time.at(stale_rx).utc.iso8601, stale_rx - 5, 52.0, 13.0],
        )
        db.execute(
          "INSERT INTO positions(id, node_id, node_num, rx_time, rx_iso, position_time, latitude, longitude) VALUES(?,?,?,?,?,?,?,?)",
          [2, "!pos", 42, fresh_rx, Time.at(fresh_rx).utc.iso8601, fresh_rx - 5, 53.0, 14.0],
        )
      end

      get "/api/positions"

      expect(last_response).to be_ok
      payload = JSON.parse(last_response.body)
      ids = payload.map { |row| row["id"] }
      expect(ids).to eq([2])

      get "/api/positions/!pos"

      expect(last_response).to be_ok
      filtered = JSON.parse(last_response.body)
      expect(filtered.map { |row| row["id"] }).to eq([2])
    end

    it "omits blank values from position responses" do
      clear_database
      allow(Time).to receive(:now).and_return(reference_time)
      now = reference_time.to_i

      with_db do |db|
        db.execute(
          "INSERT INTO positions(id, node_id, node_num, rx_time, rx_iso, position_time, latitude, longitude, altitude, location_source, precision_bits, sats_in_view, pdop, payload_b64) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          [
            7,
            "!pos-blank",
            nil,
            now,
            " ",
            nil,
            nil,
            nil,
            nil,
            " ",
            nil,
            nil,
            nil,
            "",
          ],
        )
      end

      get "/api/positions"

      expect(last_response).to be_ok
      rows = JSON.parse(last_response.body)
      expect(rows.length).to eq(1)
      entry = rows.first
      expect(entry["node_id"]).to eq("!pos-blank")
      expect(entry["rx_time"]).to eq(now)
      expect(entry["rx_iso"]).to eq(Time.at(now).utc.iso8601)
      %w[node_num position_time latitude longitude altitude location_source precision_bits sats_in_view pdop payload_b64].each do |attribute|
        expect(entry).not_to have_key(attribute), "expected #{attribute} to be omitted"
      end

      get "/api/positions/!pos-blank"

      expect(last_response).to be_ok
      filtered = JSON.parse(last_response.body)
      expect(filtered.length).to eq(1)
      expect(filtered.first).not_to have_key("payload_b64")
      expect(filtered.first).not_to have_key("location_source")
    end
  end

  describe "GET /api/neighbors" do
    it "excludes neighbor records older than seven days" do
      clear_database
      allow(Time).to receive(:now).and_return(reference_time)
      now = reference_time.to_i
      stale_rx = now - (PotatoMesh::Config.week_seconds + 45)
      fresh_rx = now - 10

      with_db do |db|
        db.execute(
          "INSERT INTO nodes(node_id, short_name, long_name, hw_model, role, snr, last_heard, first_heard) VALUES(?,?,?,?,?,?,?,?)",
          ["!root", "root", "Root", "TBEAM", "CLIENT", 0.0, fresh_rx, fresh_rx],
        )
        db.execute(
          "INSERT INTO nodes(node_id, short_name, long_name, hw_model, role, snr, last_heard, first_heard) VALUES(?,?,?,?,?,?,?,?)",
          ["!neighbor-old", "oldn", "Neighbor Old", "TBEAM", "CLIENT", 0.0, fresh_rx, fresh_rx],
        )
        db.execute(
          "INSERT INTO nodes(node_id, short_name, long_name, hw_model, role, snr, last_heard, first_heard) VALUES(?,?,?,?,?,?,?,?)",
          ["!neighbor-new", "newn", "Neighbor New", "TBEAM", "CLIENT", 0.0, fresh_rx, fresh_rx],
        )
        db.execute(
          "INSERT INTO neighbors(node_id, neighbor_id, snr, rx_time) VALUES(?,?,?,?)",
          ["!root", "!neighbor-old", 1.0, stale_rx],
        )
        db.execute(
          "INSERT INTO neighbors(node_id, neighbor_id, snr, rx_time) VALUES(?,?,?,?)",
          ["!root", "!neighbor-new", 8.0, fresh_rx],
        )
      end

      get "/api/neighbors"

      expect(last_response).to be_ok
      payload = JSON.parse(last_response.body)
      expect(payload.length).to eq(1)
      expect(payload.first["neighbor_id"]).to eq("!neighbor-new")
      expect(payload.first["rx_time"]).to eq(fresh_rx)

      get "/api/neighbors/!root"

      expect(last_response).to be_ok
      filtered = JSON.parse(last_response.body)
      expect(filtered.length).to eq(1)
      expect(filtered.first["neighbor_id"]).to eq("!neighbor-new")
      expect(filtered.first["rx_time"]).to eq(fresh_rx)
    end

    it "omits blank values from neighbor responses" do
      clear_database
      allow(Time).to receive(:now).and_return(reference_time)
      now = reference_time.to_i

      with_db do |db|
        db.execute(
          "INSERT INTO nodes(node_id, short_name, long_name, hw_model, role, snr, last_heard, first_heard) VALUES(?,?,?,?,?,?,?,?)",
          ["!origin", "orig", "Origin", "TBEAM", "CLIENT", 0.0, now, now],
        )
        db.execute(
          "INSERT INTO nodes(node_id, short_name, long_name, hw_model, role, snr, last_heard, first_heard) VALUES(?,?,?,?,?,?,?,?)",
          ["!neighbor", "neig", "Neighbor", "TBEAM", "CLIENT", 0.0, now, now],
        )
        db.execute(
          "INSERT INTO neighbors(node_id, neighbor_id, snr, rx_time) VALUES(?,?,?,?)",
          ["!origin", "!neighbor", nil, now],
        )
      end

      get "/api/neighbors"

      expect(last_response).to be_ok
      payload = JSON.parse(last_response.body)
      expect(payload.length).to eq(1)
      entry = payload.first
      expect(entry["node_id"]).to eq("!origin")
      expect(entry["neighbor_id"]).to eq("!neighbor")
      expect(entry["rx_time"]).to eq(now)
      expect(entry).not_to have_key("snr")

      get "/api/neighbors/!origin"

      expect(last_response).to be_ok
      filtered = JSON.parse(last_response.body)
      expect(filtered.length).to eq(1)
      expect(filtered.first).not_to have_key("snr")
    end
  end

  describe "GET /api/telemetry" do
    it "returns stored telemetry ordered by receive time" do
      post "/api/telemetry", telemetry_fixture.to_json, auth_headers
      expect(last_response).to be_ok

      get "/api/telemetry?limit=2"

      expect(last_response).to be_ok
      data = JSON.parse(last_response.body)
      expect(data.length).to eq(2)

      latest = telemetry_fixture.max_by { |entry| entry["rx_time"] }
      second_latest = telemetry_fixture.sort_by { |entry| entry["rx_time"] }[-2]

      first_entry = data.first
      expect(first_entry["id"]).to eq(latest["id"])
      expect(first_entry["node_id"]).to eq(latest["node_id"])
      expect(first_entry["rx_time"]).to eq(latest["rx_time"])
      expect(first_entry["telemetry_time"]).to eq(latest["telemetry_time"])
      expect(first_entry["telemetry_time_iso"]).to eq(Time.at(latest["telemetry_time"]).utc.iso8601)
      expect(first_entry).not_to have_key("device_metrics")
      expect_same_value(first_entry["battery_level"], latest.dig("device_metrics", "battery_level") || latest.dig("device_metrics", "batteryLevel"))
      expect_same_value(first_entry["current"], latest.dig("device_metrics", "current"))
      expect_same_value(first_entry["distance"], latest.dig("environment_metrics", "distance"))
      expect_same_value(first_entry["lux"], latest.dig("environment_metrics", "lux"))
      expect_same_value(first_entry["wind_direction"], latest.dig("environment_metrics", "windDirection"))
      expect_same_value(first_entry["wind_speed"], latest.dig("environment_metrics", "windSpeed"))
      expect_same_value(first_entry["weight"], latest.dig("environment_metrics", "weight"))
      expect_same_value(first_entry["rainfall_24h"], latest.dig("environment_metrics", "rainfall24h"))
      expect_same_value(first_entry["soil_moisture"], latest.dig("environment_metrics", "soilMoisture"))
      expect_same_value(first_entry["soil_temperature"], latest.dig("environment_metrics", "soilTemperature"))

      second_entry = data.last
      expect(second_entry["id"]).to eq(second_latest["id"])
      expect(second_entry).not_to have_key("environment_metrics")
      expect(second_entry["temperature"]).to be_within(1e-6).of(second_latest["environment_metrics"]["temperature"])
      expect(second_entry["relative_humidity"]).to be_within(1e-6).of(second_latest["environment_metrics"]["relativeHumidity"])
      expect(second_entry["barometric_pressure"]).to be_within(1e-6).of(second_latest["environment_metrics"]["barometricPressure"])
      expect_same_value(second_entry["gas_resistance"], second_latest.dig("environment_metrics", "gasResistance"))
      expect_same_value(second_entry["iaq"], second_latest.dig("environment_metrics", "iaq"))
      expect_same_value(second_entry["distance"], second_latest.dig("environment_metrics", "distance"))
      expect_same_value(second_entry["lux"], second_latest.dig("environment_metrics", "lux"))
      expect_same_value(second_entry["white_lux"], second_latest.dig("environment_metrics", "whiteLux"))
      expect_same_value(second_entry["ir_lux"], second_latest.dig("environment_metrics", "irLux"))
      expect_same_value(second_entry["uv_lux"], second_latest.dig("environment_metrics", "uvLux"))
      expect_same_value(second_entry["wind_direction"], second_latest.dig("environment_metrics", "windDirection"))
      expect_same_value(second_entry["wind_speed"], second_latest.dig("environment_metrics", "windSpeed"))
      expect_same_value(second_entry["wind_gust"], second_latest.dig("environment_metrics", "windGust"))
      expect_same_value(second_entry["wind_lull"], second_latest.dig("environment_metrics", "windLull"))
      expect_same_value(second_entry["weight"], second_latest.dig("environment_metrics", "weight"))
      expect_same_value(second_entry["radiation"], second_latest.dig("environment_metrics", "radiation"))
      expect_same_value(second_entry["rainfall_1h"], second_latest.dig("environment_metrics", "rainfall1h"))
      expect_same_value(second_entry["rainfall_24h"], second_latest.dig("environment_metrics", "rainfall24h"))
      expect_same_value(second_entry["soil_moisture"], second_latest.dig("environment_metrics", "soilMoisture"))
      expect_same_value(second_entry["soil_temperature"], second_latest.dig("environment_metrics", "soilTemperature"))
    end

    it "excludes telemetry entries older than seven days" do
      clear_database
      allow(Time).to receive(:now).and_return(reference_time)
      now = reference_time.to_i
      stale_rx = now - (PotatoMesh::Config.week_seconds + 30)
      fresh_rx = now - 5

      with_db do |db|
        db.execute(
          "INSERT INTO telemetry(id, node_id, node_num, rx_time, rx_iso, telemetry_time, battery_level, voltage) VALUES(?,?,?,?,?,?,?,?)",
          [1, "!tele", 7, stale_rx, Time.at(stale_rx).utc.iso8601, stale_rx - 60, 10.0, 3.9],
        )
        db.execute(
          "INSERT INTO telemetry(id, node_id, node_num, rx_time, rx_iso, telemetry_time, battery_level, voltage) VALUES(?,?,?,?,?,?,?,?)",
          [2, "!tele", 7, fresh_rx, Time.at(fresh_rx).utc.iso8601, fresh_rx - 60, 90.0, 4.1],
        )
      end

      get "/api/telemetry"

      expect(last_response).to be_ok
      payload = JSON.parse(last_response.body)
      ids = payload.map { |row| row["id"] }
      expect(ids).to eq([2])

      get "/api/telemetry/!tele"

      expect(last_response).to be_ok
      filtered = JSON.parse(last_response.body)
      expect(filtered.map { |row| row["id"] }).to eq([2])
    end

    it "omits blank values from telemetry responses" do
      clear_database
      allow(Time).to receive(:now).and_return(reference_time)
      now = reference_time.to_i

      with_db do |db|
        db.execute(
          "INSERT INTO telemetry(id, node_id, node_num, rx_time, rx_iso, telemetry_time, channel, portnum, hop_limit, snr, rssi, bitfield, payload_b64, battery_level, voltage, channel_utilization, air_util_tx, uptime_seconds, temperature, relative_humidity) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          [
            77,
            "!tele-blank",
            nil,
            now,
            " ",
            nil,
            nil,
            "",
            nil,
            nil,
            nil,
            nil,
            "",
            nil,
            nil,
            nil,
            nil,
            nil,
            nil,
            nil,
          ],
        )
      end

      get "/api/telemetry"

      expect(last_response).to be_ok
      rows = JSON.parse(last_response.body)
      expect(rows.length).to eq(1)
      entry = rows.first
      expect(entry["node_id"]).to eq("!tele-blank")
      expect(entry["rx_time"]).to eq(now)
      expect(entry["rx_iso"]).to eq(Time.at(now).utc.iso8601)
      %w[node_num telemetry_time channel portnum hop_limit snr rssi bitfield payload_b64 battery_level voltage channel_utilization air_util_tx uptime_seconds temperature relative_humidity].each do |attribute|
        expect(entry).not_to have_key(attribute), "expected #{attribute} to be omitted"
      end

      get "/api/telemetry/!tele-blank"

      expect(last_response).to be_ok
      filtered = JSON.parse(last_response.body)
      expect(filtered.length).to eq(1)
      expect(filtered.first).not_to have_key("battery_level")
      expect(filtered.first).not_to have_key("portnum")
    end
  end

  describe "GET /api/telemetry/aggregated" do
    it "returns aggregated telemetry buckets for the requested interval" do
      post "/api/telemetry", telemetry_fixture.to_json, auth_headers
      expect(last_response).to be_ok

      get "/api/telemetry/aggregated?windowSeconds=86400&bucketSeconds=300"

      expect(last_response).to be_ok
      buckets = JSON.parse(last_response.body)
      expect(buckets).not_to be_empty
      a_bucket = buckets.first
      expect(a_bucket["bucket_seconds"]).to eq(300)
      expect(a_bucket["sample_count"]).to be >= 1
      expect(a_bucket["bucket_start"]).to be_a(Integer)
      expect(a_bucket["bucket_end"]).to be_a(Integer)
      expect(a_bucket["aggregates"]).to be_a(Hash)
      expect(a_bucket["aggregates"]).to have_key("battery_level")
      expect(a_bucket["aggregates"]["battery_level"]).to include("avg")
      expect(a_bucket).not_to have_key("device_metrics")
    end

    it "applies default window and bucket sizes when parameters are omitted" do
      post "/api/telemetry", telemetry_fixture.to_json, auth_headers
      expect(last_response).to be_ok

      get "/api/telemetry/aggregated"

      expect(last_response).to be_ok
      buckets = JSON.parse(last_response.body)
      expect(buckets.length).to be >= 1
      expect(buckets.first["bucket_seconds"]).to eq(PotatoMesh::App::Queries::DEFAULT_TELEMETRY_BUCKET_SECONDS)
    end

    it "rejects invalid bucket and window parameters" do
      get "/api/telemetry/aggregated?windowSeconds=0&bucketSeconds=300"
      expect(last_response.status).to eq(400)
      expect(JSON.parse(last_response.body)).to eq("error" => "windowSeconds must be positive")

      get "/api/telemetry/aggregated?windowSeconds=86400&bucketSeconds=0"
      expect(last_response.status).to eq(400)
      expect(JSON.parse(last_response.body)).to eq("error" => "bucketSeconds must be positive")

      get "/api/telemetry/aggregated?windowSeconds=86400&bucketSeconds=1"
      expect(last_response.status).to eq(400)
      expect(JSON.parse(last_response.body)).to eq("error" => "bucketSeconds too small for requested window")
    end
  end

  describe "GET /api/traces" do
    it "returns stored traces ordered by receive time" do
      clear_database
      post "/api/traces", trace_fixture.to_json, auth_headers
      expect(last_response).to be_ok

      get "/api/traces"

      expect(last_response).to be_ok
      payload = JSON.parse(last_response.body)
      expect(payload.length).to eq(trace_fixture.length)
      expect(payload.map { |row| row["id"] }).to eq([trace_fixture.first["id"], trace_fixture.last["packet_id"]])

      latest = payload.first
      expect(latest["request_id"]).to eq(trace_fixture.first["request_id"])
      expect(latest["src"]).to eq(trace_fixture.first["src"])
      expect(latest["dest"]).to eq(trace_fixture.first["dest"])
      expect(latest["hops"]).to eq(trace_fixture.first["hops"])
      expect(latest["rx_iso"]).to eq(Time.at(trace_fixture.first["rx_time"]).utc.iso8601)

      earlier = payload.last
      expect(earlier["request_id"]).to eq(trace_fixture.last["req"])
      expect(earlier["hops"]).to eq([0xBEADF00D, 19_088_743])
      expect(earlier["elapsed_ms"]).to eq(trace_fixture.last.dig("metrics", "latency_ms"))
    end

    it "filters traces by node reference across sources" do
      clear_database
      post "/api/traces", trace_fixture.to_json, auth_headers
      expect(last_response).to be_ok

      get "/api/traces/#{trace_fixture.first["src"]}"

      expect(last_response).to be_ok
      filtered = JSON.parse(last_response.body)
      expect(filtered.map { |row| row["id"] }).to include(trace_fixture.first["id"], trace_fixture.last["packet_id"])

      get "/api/traces/!beadf00d"

      expect(last_response).to be_ok
      bead_filtered = JSON.parse(last_response.body)
      expect(bead_filtered.map { |row| row["id"] }).to eq([trace_fixture.last["packet_id"]])
      expect(bead_filtered.first["hops"]).to eq([0xBEADF00D, 19_088_743])
    end

    it "returns an empty list when no traces are stored" do
      clear_database
      get "/api/traces"

      expect(last_response).to be_ok
      expect(JSON.parse(last_response.body)).to eq([])
    end
  end

  describe "GET /nodes/:id" do
    before do
      import_nodes_fixture
    end

    it "renders the node detail page with embedded reference data" do
      node = nodes_fixture.first
      get "/nodes/#{node["node_id"]}"
      expect(last_response).to be_ok
      expect(last_response.body).to include("data-node-reference=")
      expect(last_response.body).to include(node["node_id"])
    end

    it "returns 404 when the node cannot be located" do
      get "/nodes/!deadbeef"
      expect(last_response.status).to eq(404)
    end
  end
end
