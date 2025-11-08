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

RSpec.describe PotatoMesh::App::Filesystem do
  let(:harness_class) do
    Class.new do
      extend PotatoMesh::App::Filesystem

      class << self
        def debug_entries
          @debug_entries ||= []
        end

        def warning_entries
          @warning_entries ||= []
        end

        def debug_log(message, context:, **metadata)
          debug_entries << { message: message, context: context, metadata: metadata }
        end

        def warn_log(message, context:, **metadata)
          warning_entries << { message: message, context: context, metadata: metadata }
        end

        def reset_logs!
          @debug_entries = []
          @warning_entries = []
        end
      end
    end
  end

  around do |example|
    harness_class.reset_logs!
    example.run
    harness_class.reset_logs!
  end

  describe "#perform_initial_filesystem_setup!" do
    it "migrates the legacy database and keyfile" do
      Dir.mktmpdir do |dir|
        legacy_db = File.join(dir, "legacy", "mesh.db")
        legacy_key = File.join(dir, "legacy-config", "keyfile")
        new_db = File.join(dir, "data", "potato-mesh", "mesh.db")
        new_key = File.join(dir, "config", "potato-mesh", "keyfile")

        FileUtils.mkdir_p(File.dirname(legacy_db))
        File.write(legacy_db, "db")
        FileUtils.mkdir_p(File.dirname(legacy_key))
        File.write(legacy_key, "key")

        allow(PotatoMesh::Config).to receive_messages(
          legacy_db_path: legacy_db,
          db_path: new_db,
          default_db_path: new_db,
          keyfile_path: new_key,
        )
        allow(PotatoMesh::Config).to receive(:legacy_keyfile_candidates).and_return([legacy_key])

        harness_class.perform_initial_filesystem_setup!

        expect(File).to exist(new_db)
        expect(File).to exist(new_key)
        expect(File.read(new_db)).to eq("db")
        expect(File.read(new_key)).to eq("key")
        expect(File.stat(new_key).mode & 0o777).to eq(0o600)
        expect(File.stat(new_db).mode & 0o777).to eq(0o600)
        expect(harness_class.debug_entries.size).to eq(2)
        expect(harness_class.warning_entries).to be_empty
      end
    end

    it "migrates repository configuration assets from web/config" do
      Dir.mktmpdir do |dir|
        web_root = File.join(dir, "web")
        legacy_key = File.join(web_root, "config", "potato-mesh", "keyfile")
        legacy_well_known = File.join(web_root, "config", "potato-mesh", "well-known", "potato-mesh")
        destination_root = File.join(dir, "xdg-config", "potato-mesh")
        new_key = File.join(destination_root, "keyfile")
        new_well_known = File.join(destination_root, "well-known", "potato-mesh")

        FileUtils.mkdir_p(File.dirname(legacy_key))
        File.write(legacy_key, "legacy-key")
        FileUtils.mkdir_p(File.dirname(legacy_well_known))
        File.write(legacy_well_known, "{\"legacy\":true}")

        allow(PotatoMesh::Config).to receive(:web_root).and_return(web_root)
        allow(PotatoMesh::Config).to receive(:keyfile_path).and_return(new_key)
        allow(PotatoMesh::Config).to receive(:well_known_storage_root).and_return(File.dirname(new_well_known))
        allow(PotatoMesh::Config).to receive(:well_known_relative_path).and_return(".well-known/potato-mesh")
        allow(PotatoMesh::Config).to receive(:legacy_db_path).and_return(File.join(dir, "legacy", "mesh.db"))
        allow(PotatoMesh::Config).to receive(:db_path).and_return(File.join(dir, "data", "potato-mesh", "mesh.db"))
        allow(PotatoMesh::Config).to receive(:default_db_path).and_return(File.join(dir, "data", "potato-mesh", "mesh.db"))

        harness_class.perform_initial_filesystem_setup!

        expect(File).to exist(new_key)
        expect(File.read(new_key)).to eq("legacy-key")
        expect(File.stat(new_key).mode & 0o777).to eq(0o600)
        expect(File).to exist(new_well_known)
        expect(File.read(new_well_known)).to eq("{\"legacy\":true}")
        expect(File.stat(new_well_known).mode & 0o777).to eq(0o644)
        expect(harness_class.debug_entries.map { |entry| entry[:context] }).to include("filesystem.keys", "filesystem.well_known")
      end
    end

    it "skips database migration when using a custom destination" do
      Dir.mktmpdir do |dir|
        legacy_db = File.join(dir, "legacy", "mesh.db")
        new_db = File.join(dir, "custom", "database.db")

        FileUtils.mkdir_p(File.dirname(legacy_db))
        File.write(legacy_db, "db")

        allow(PotatoMesh::Config).to receive_messages(
          legacy_db_path: legacy_db,
          db_path: new_db,
          default_db_path: File.join(dir, "default", "mesh.db"),
          legacy_keyfile_path: File.join(dir, "old", "keyfile"),
          keyfile_path: File.join(dir, "config", "keyfile"),
        )

        harness_class.perform_initial_filesystem_setup!

        expect(File).not_to exist(new_db)
      end
    end
  end

  describe "private migration helpers" do
    it "does not migrate when the source is missing" do
      Dir.mktmpdir do |dir|
        destination = File.join(dir, "target", "file")
        harness_class.send(
          :migrate_legacy_file,
          File.join(dir, "missing"),
          destination,
          chmod: 0o600,
          context: "spec.context",
        )

        expect(File).not_to exist(destination)
        expect(harness_class.debug_entries).to be_empty
      end
    end

    it "does not overwrite existing destinations" do
      Dir.mktmpdir do |dir|
        source = File.join(dir, "source")
        destination = File.join(dir, "destination")

        File.write(source, "alpha")
        FileUtils.mkdir_p(File.dirname(destination))
        File.write(destination, "beta")

        harness_class.send(
          :migrate_legacy_file,
          source,
          destination,
          chmod: 0o600,
          context: "spec.context",
        )

        expect(File.read(destination)).to eq("beta")
      end
    end

    it "ignores migrations when the source and destination are identical" do
      Dir.mktmpdir do |dir|
        path = File.join(dir, "shared")
        File.write(path, "same")

        harness_class.send(
          :migrate_legacy_file,
          path,
          path,
          chmod: 0o600,
          context: "spec.context",
        )

        expect(harness_class.debug_entries).to be_empty
      end
    end

    it "logs warnings when the migration fails" do
      Dir.mktmpdir do |dir|
        source = File.join(dir, "source")
        destination = File.join(dir, "destination")
        File.write(source, "data")

        allow(FileUtils).to receive(:mkdir_p).and_raise(Errno::EACCES)

        harness_class.send(
          :migrate_legacy_file,
          source,
          destination,
          chmod: 0o600,
          context: "spec.context",
        )

        expect(harness_class.warning_entries.size).to eq(1)
        expect(harness_class.debug_entries).to be_empty
      end
    ensure
      allow(FileUtils).to receive(:mkdir_p).and_call_original
    end
  end
end
