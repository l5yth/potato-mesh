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
require "open3"
require "openssl"
require "rbconfig"

RSpec.describe PotatoMesh::App::Identity do
  let(:harness_class) do
    Class.new do
      extend PotatoMesh::App::Identity
    end
  end

  describe ".load_or_generate_instance_private_key" do
    it "loads an existing key without generating a new one" do
      Dir.mktmpdir do |dir|
        key_path = File.join(dir, "config", "potato-mesh", "keyfile")
        FileUtils.mkdir_p(File.dirname(key_path))
        key = OpenSSL::PKey::RSA.new(2048)
        File.write(key_path, key.export)

        allow(PotatoMesh::Config).to receive(:keyfile_path).and_return(key_path)

        loaded_key, generated = harness_class.load_or_generate_instance_private_key

        expect(generated).to be(false)
        expect(loaded_key.to_pem).to eq(key.to_pem)
      end
    ensure
      allow(PotatoMesh::Config).to receive(:keyfile_path).and_call_original
    end

    it "migrates a legacy keyfile before loading" do
      Dir.mktmpdir do |dir|
        key_path = File.join(dir, "config", "potato-mesh", "keyfile")
        legacy_key_path = File.join(dir, "legacy", "keyfile")
        FileUtils.mkdir_p(File.dirname(legacy_key_path))
        key = OpenSSL::PKey::RSA.new(2048)
        File.write(legacy_key_path, key.export)

        allow(PotatoMesh::Config).to receive(:keyfile_path).and_return(key_path)
        allow(PotatoMesh::Config).to receive(:legacy_keyfile_candidates).and_return([legacy_key_path])

        loaded_key, generated = harness_class.load_or_generate_instance_private_key

        expect(generated).to be(false)
        expect(loaded_key.to_pem).to eq(key.to_pem)
        expect(File.exist?(key_path)).to be(true)
        expect(File.binread(key_path)).to eq(key.export)
      end
    ensure
      allow(PotatoMesh::Config).to receive(:keyfile_path).and_call_original
      allow(PotatoMesh::Config).to receive(:legacy_keyfile_candidates).and_call_original
    end
  end

  describe ".load_or_generate_instance_private_key error paths" do
    it "re-raises Errno::EACCES when the keyfile exists but File.binread is denied" do
      Dir.mktmpdir do |dir|
        key_path = File.join(dir, "config", "potato-mesh", "keyfile")
        FileUtils.mkdir_p(File.dirname(key_path))
        # Write a placeholder so the file exists and File.exist? returns true.
        File.write(key_path, "placeholder")

        allow(PotatoMesh::Config).to receive(:keyfile_path).and_return(key_path)
        # Errno::EACCES is not in the rescued set (only OpenSSL::PKey::PKeyError
        # and ArgumentError are caught), so it propagates to the caller.
        allow(File).to receive(:binread).with(key_path).and_raise(Errno::EACCES, "Permission denied")

        expect do
          harness_class.load_or_generate_instance_private_key
        end.to raise_error(Errno::EACCES)
      end
    ensure
      allow(PotatoMesh::Config).to receive(:keyfile_path).and_call_original
      allow(File).to receive(:binread).and_call_original
    end

    # A keyfile that does not parse stops the boot: the error names the file,
    # the file keeps its bytes and no key is generated (SPEC FK3).
    {
      "corrupt" => "this is not a valid PEM key\n{corrupted}",
      "truncated" => OpenSSL::PKey::RSA.new(2048).export.byteslice(0, 300),
      "empty" => "",
    }.each do |label, contents|
      it "raises an error naming the keyfile and leaves it as it is when it is #{label}" do
        Dir.mktmpdir do |dir|
          key_path = File.join(dir, "config", "potato-mesh", "keyfile")
          FileUtils.mkdir_p(File.dirname(key_path))
          File.binwrite(key_path, contents)

          allow(PotatoMesh::Config).to receive(:keyfile_path).and_return(key_path)
          allow(PotatoMesh::Config).to receive(:legacy_keyfile_candidates).and_return([])
          allow(OpenSSL::PKey::RSA).to receive(:new).and_call_original

          outcome = begin
              harness_class.load_or_generate_instance_private_key
            rescue StandardError => e
              e
            end

          expect(File.binread(key_path)).to eq(contents.b)
          expect(OpenSSL::PKey::RSA).not_to have_received(:new)
          expect(outcome.class.name).to eq("PotatoMesh::App::InstanceKeyfileError")
          expect(outcome.message).to eq(
            "Instance private key file cannot be parsed: #{key_path} (OpenSSL::PKey::PKeyError: Could not parse PKey). " \
            "Restore it from a backup, or delete it to start with a new key and instance id.",
          )
        end
      ensure
        allow(PotatoMesh::Config).to receive(:keyfile_path).and_call_original
        allow(PotatoMesh::Config).to receive(:legacy_keyfile_candidates).and_call_original
      end
    end

    it "names a legacy keyfile it cannot parse, copies nothing, and generates a key once that file is deleted" do
      Dir.mktmpdir do |dir|
        key_path = File.join(dir, "config", "potato-mesh", "keyfile")
        legacy_key_path = File.join(dir, "web", ".config", "keyfile")
        FileUtils.mkdir_p(File.dirname(legacy_key_path))
        truncated = OpenSSL::PKey::RSA.new(2048).export.byteslice(0, 300)
        File.binwrite(legacy_key_path, truncated)

        allow(PotatoMesh::Config).to receive(:keyfile_path).and_return(key_path)
        allow(PotatoMesh::Config).to receive(:legacy_keyfile_candidates).and_return([legacy_key_path])

        outcome = begin
            harness_class.load_or_generate_instance_private_key
          rescue StandardError => e
            e
          end

        expect(File.exist?(key_path)).to be(false)
        expect(File.binread(legacy_key_path)).to eq(truncated)
        expect(outcome.class.name).to eq("PotatoMesh::App::InstanceKeyfileError")
        expect(outcome.message).to start_with(
          "Instance private key file cannot be parsed: #{legacy_key_path} (OpenSSL::PKey::PKeyError: Could not parse PKey).",
        )

        # The operator deletes the file the error names, as the docs say.
        File.delete(legacy_key_path)
        loaded_key, generated = harness_class.load_or_generate_instance_private_key

        expect(generated).to be(true)
        expect(OpenSSL::PKey.read(File.binread(key_path)).to_pem).to eq(loaded_key.to_pem)
      end
    ensure
      allow(PotatoMesh::Config).to receive(:keyfile_path).and_call_original
      allow(PotatoMesh::Config).to receive(:legacy_keyfile_candidates).and_call_original
    end

    it "generates and stores a key, readable by its owner only, when no keyfile exists" do
      Dir.mktmpdir do |dir|
        key_path = File.join(dir, "config", "potato-mesh", "keyfile")

        allow(PotatoMesh::Config).to receive(:keyfile_path).and_return(key_path)
        allow(PotatoMesh::Config).to receive(:legacy_keyfile_candidates).and_return([])

        loaded_key, generated = harness_class.load_or_generate_instance_private_key

        expect(generated).to be(true)
        expect(loaded_key).to be_a(OpenSSL::PKey::RSA)
        expect(File.stat(key_path).mode & 0o777).to eq(0o600)
        expect(OpenSSL::PKey.read(File.binread(key_path)).to_pem).to eq(loaded_key.to_pem)
      end
    ensure
      allow(PotatoMesh::Config).to receive(:keyfile_path).and_call_original
      allow(PotatoMesh::Config).to receive(:legacy_keyfile_candidates).and_call_original
    end
  end

  describe "a boot with a keyfile that does not parse (FK3)" do
    it "stops with the error on stderr and leaves the keyfile as it is" do
      Dir.mktmpdir do |dir|
        config_home = File.join(dir, "config")
        key_path = File.join(config_home, "potato-mesh", "keyfile")
        FileUtils.mkdir_p(File.dirname(key_path))
        truncated = OpenSSL::PKey::RSA.new(2048).export.byteslice(0, 300)
        File.binwrite(key_path, truncated)
        env = {
          "XDG_CONFIG_HOME" => config_home, "XDG_DATA_HOME" => File.join(dir, "data"),
          "FEDERATION" => "0", "RACK_ENV" => "test",
        }

        # The application loads in a child process, as app.rb loads it.
        _stdout, stderr, status = Open3.capture3(
          env, RbConfig.ruby, "-e", 'require "./lib/potato_mesh/application"',
          chdir: File.expand_path("..", __dir__),
        )

        expect(status.success?).to be(false)
        expect(stderr).to include("Instance private key file cannot be parsed: #{key_path} (OpenSSL::PKey::PKeyError")
        expect(stderr).to include("(PotatoMesh::App::InstanceKeyfileError)")
        expect(File.binread(key_path)).to eq(truncated)
      end
    end
  end

  describe ".log_instance_domain_resolution" do
    let(:logger) { instance_double(Logger, debug: nil, warn: nil) }

    before do
      allow(PotatoMesh::Logging).to receive(:logger_for).and_return(logger)
    end

    around do |example|
      original_app_env = ENV["APP_ENV"]
      original_rack_env = ENV["RACK_ENV"]
      example.run
    ensure
      if original_app_env
        ENV["APP_ENV"] = original_app_env
      else
        ENV.delete("APP_ENV")
      end
      ENV["RACK_ENV"] = original_rack_env if original_rack_env
    end

    it "warns in production when the instance domain is unset" do
      ENV["APP_ENV"] = "production"
      stub_const("PotatoMesh::Application::INSTANCE_DOMAIN", nil)
      stub_const("PotatoMesh::Application::INSTANCE_DOMAIN_SOURCE", :unconfigured)

      PotatoMesh::Application.log_instance_domain_resolution

      expect(logger).to have_received(:warn).with(/INSTANCE_DOMAIN is unset/)
    end

    it "stays quiet when the instance domain is configured" do
      ENV["APP_ENV"] = "production"
      stub_const("PotatoMesh::Application::INSTANCE_DOMAIN", "example.com")
      stub_const("PotatoMesh::Application::INSTANCE_DOMAIN_SOURCE", :env)

      PotatoMesh::Application.log_instance_domain_resolution

      expect(logger).not_to have_received(:warn)
    end

    it "stays quiet outside production even when the domain is unset" do
      ENV["APP_ENV"] = "test"
      ENV["RACK_ENV"] = "test"
      stub_const("PotatoMesh::Application::INSTANCE_DOMAIN", nil)
      stub_const("PotatoMesh::Application::INSTANCE_DOMAIN_SOURCE", :unconfigured)

      PotatoMesh::Application.log_instance_domain_resolution

      expect(logger).not_to have_received(:warn)
    end
  end

  describe ".refresh_well_known_document_if_stale" do
    let(:storage_dir) { Dir.mktmpdir }
    let(:well_known_path) do
      File.join(storage_dir, File.basename(PotatoMesh::Config.well_known_relative_path))
    end

    before do
      allow(PotatoMesh::Config).to receive(:well_known_storage_root).and_return(storage_dir)
      allow(PotatoMesh::Config).to receive(:well_known_relative_path).and_return(".well-known/potato-mesh")
      allow(PotatoMesh::Config).to receive(:well_known_refresh_interval).and_return(86_400)
      allow(PotatoMesh::Sanitizer).to receive(:sanitized_site_name).and_return("Test Instance")
      allow(PotatoMesh::Sanitizer).to receive(:sanitize_instance_domain).and_return("example.com")
    end

    after do
      FileUtils.remove_entry(storage_dir)
      allow(PotatoMesh::Config).to receive(:well_known_storage_root).and_call_original
      allow(PotatoMesh::Config).to receive(:well_known_relative_path).and_call_original
      allow(PotatoMesh::Config).to receive(:well_known_refresh_interval).and_call_original
      allow(PotatoMesh::Sanitizer).to receive(:sanitized_site_name).and_call_original
      allow(PotatoMesh::Sanitizer).to receive(:sanitize_instance_domain).and_call_original
    end

    it "writes a well-known document when none exists" do
      PotatoMesh::Application.refresh_well_known_document_if_stale

      expect(File.exist?(well_known_path)).to be(true)
      document = JSON.parse(File.read(well_known_path))
      expect(document.fetch("version")).to eq(PotatoMesh::Application::APP_VERSION)
      expect(document.fetch("domain")).to eq("example.com")
    end

    it "rewrites the document when configuration values change" do
      PotatoMesh::Application.refresh_well_known_document_if_stale
      original_contents = File.binread(well_known_path)

      stub_const("PotatoMesh::Application::APP_VERSION", "9.9.9-test")
      PotatoMesh::Application.refresh_well_known_document_if_stale

      rewritten_contents = File.binread(well_known_path)
      expect(rewritten_contents).not_to eq(original_contents)
      document = JSON.parse(rewritten_contents)
      expect(document.fetch("version")).to eq("9.9.9-test")
    end

    it "does not rewrite when content is current and within the refresh interval" do
      PotatoMesh::Application.refresh_well_known_document_if_stale
      original_contents = File.binread(well_known_path)

      PotatoMesh::Application.refresh_well_known_document_if_stale

      expect(File.binread(well_known_path)).to eq(original_contents)
    end
  end
end
