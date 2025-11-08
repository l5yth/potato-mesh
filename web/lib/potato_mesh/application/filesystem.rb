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

require "fileutils"

module PotatoMesh
  module App
    # Filesystem helpers responsible for migrating legacy assets to XDG compliant
    # directories and preparing runtime storage locations.
    module Filesystem
      # Execute all filesystem migrations required before the application boots.
      #
      # @return [void]
      def perform_initial_filesystem_setup!
        migrate_legacy_database!
        migrate_legacy_keyfile!
        migrate_legacy_well_known_assets!
      end

      private

      # Copy the legacy database file into the configured XDG data directory.
      #
      # @return [void]
      def migrate_legacy_database!
        return unless default_database_destination?

        migrate_legacy_file(
          PotatoMesh::Config.legacy_db_path,
          PotatoMesh::Config.db_path,
          chmod: 0o600,
          context: "filesystem.db",
        )
      end

      # Copy the legacy keyfile into the configured XDG configuration directory.
      #
      # @return [void]
      def migrate_legacy_keyfile!
        PotatoMesh::Config.legacy_keyfile_candidates.each do |candidate|
          migrate_legacy_file(
            candidate,
            PotatoMesh::Config.keyfile_path,
            chmod: 0o600,
            context: "filesystem.keys",
          )
        end
      end

      # Copy the legacy well-known document into the configured XDG directory.
      #
      # @return [void]
      def migrate_legacy_well_known_assets!
        destination = File.join(
          PotatoMesh::Config.well_known_storage_root,
          File.basename(PotatoMesh::Config.well_known_relative_path),
        )

        PotatoMesh::Config.legacy_well_known_candidates.each do |candidate|
          migrate_legacy_file(
            candidate,
            destination,
            chmod: 0o644,
            context: "filesystem.well_known",
          )
        end
      end

      # Migrate a legacy file if it exists and the destination has not been created yet.
      #
      # @param source_path [String] absolute path to the legacy file.
      # @param destination_path [String] absolute path to the new file location.
      # @param chmod [Integer, nil] optional permission bits applied to the destination file.
      # @param context [String] logging context describing the migration target.
      # @return [void]
      def migrate_legacy_file(source_path, destination_path, chmod:, context:)
        return if source_path == destination_path
        return unless File.exist?(source_path)
        return if File.exist?(destination_path)

        FileUtils.mkdir_p(File.dirname(destination_path))
        FileUtils.cp(source_path, destination_path)
        File.chmod(chmod, destination_path) if chmod

        debug_log(
          "Migrated legacy file to XDG directory",
          context: context,
          source: source_path,
          destination: destination_path,
        )
      rescue SystemCallError => e
        warn_log(
          "Failed to migrate legacy file",
          context: context,
          source: source_path,
          destination: destination_path,
          error_class: e.class.name,
          error_message: e.message,
        )
      end

      # Determine whether the database destination matches the configured default.
      #
      # @return [Boolean] true when the destination should receive migrated data.
      def default_database_destination?
        PotatoMesh::Config.db_path == PotatoMesh::Config.default_db_path
      end
    end
  end
end
