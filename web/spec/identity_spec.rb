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
require "openssl"

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
