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

module PotatoMesh
  module App
    module Identity
      # Resolve the current application version string using git metadata when available.
      #
      # @return [String] semantic version compatible identifier.
      def determine_app_version
        repo_root = locate_git_repo_root(File.expand_path("../../..", __dir__))
        return PotatoMesh::Config.version_fallback unless repo_root

        stdout, status = Open3.capture2("git", "-C", repo_root, "describe", "--tags", "--long", "--abbrev=7")
        return PotatoMesh::Config.version_fallback unless status.success?

        raw = stdout.strip
        return PotatoMesh::Config.version_fallback if raw.empty?

        match = /\A(?<tag>.+)-(?<count>\d+)-g(?<hash>[0-9a-f]+)\z/.match(raw)
        return raw unless match

        tag = match[:tag]
        count = match[:count].to_i
        hash = match[:hash]
        return tag if count.zero?

        "#{tag}+#{count}-#{hash}"
      rescue StandardError
        PotatoMesh::Config.version_fallback
      end

      # Discover the root directory of the git repository containing the
      # application by traversing parent directories until a ``.git`` entry is
      # located. This supports both traditional repositories where ``.git`` is a
      # directory and worktree checkouts where it is a plain file.
      #
      # @param start_dir [String] absolute path where the search should begin.
      # @return [String, nil] absolute path to the repository root when found,
      #   otherwise ``nil``.
      def locate_git_repo_root(start_dir)
        current = File.expand_path(start_dir)
        loop do
          git_entry = File.join(current, ".git")
          return current if File.exist?(git_entry)

          parent = File.dirname(current)
          break if parent == current

          current = parent
        end

        nil
      end

      # Load the persisted instance private key or generate a new one when absent.
      #
      # @return [Array<OpenSSL::PKey::RSA, Boolean>] tuple of key and generation flag.
      def load_or_generate_instance_private_key
        keyfile_path = PotatoMesh::Config.keyfile_path
        migrate_legacy_keyfile_for_identity!(keyfile_path)
        FileUtils.mkdir_p(File.dirname(keyfile_path))
        if File.exist?(keyfile_path)
          contents = File.binread(keyfile_path)
          return [OpenSSL::PKey.read(contents), false]
        end

        key = OpenSSL::PKey::RSA.new(2048)
        File.open(keyfile_path, File::WRONLY | File::CREAT | File::TRUNC, 0o600) do |file|
          file.write(key.export)
        end
        [key, true]
      rescue OpenSSL::PKey::PKeyError, ArgumentError => e
        warn_log(
          "Failed to load instance private key",
          context: "identity.keys",
          error_class: e.class.name,
          error_message: e.message,
        )
        key = OpenSSL::PKey::RSA.new(2048)
        File.open(keyfile_path, File::WRONLY | File::CREAT | File::TRUNC, 0o600) do |file|
          file.write(key.export)
        end
        [key, true]
      end

      # Migrate an existing legacy keyfile into the configured destination.
      #
      # @param destination_path [String] absolute path where the keyfile should reside.
      # @return [void]
      def migrate_legacy_keyfile_for_identity!(destination_path)
        return if File.exist?(destination_path)

        PotatoMesh::Config.legacy_keyfile_candidates.each do |candidate|
          next unless File.exist?(candidate)
          next if candidate == destination_path

          begin
            FileUtils.mkdir_p(File.dirname(destination_path))
            FileUtils.cp(candidate, destination_path)
            File.chmod(0o600, destination_path)

            debug_log(
              "Migrated legacy keyfile to XDG directory",
              context: "identity.keys",
              source: candidate,
              destination: destination_path,
            )
          rescue SystemCallError => e
            warn_log(
              "Failed to migrate legacy keyfile",
              context: "identity.keys",
              source: candidate,
              destination: destination_path,
              error_class: e.class.name,
              error_message: e.message,
            )
            next
          end

          break
        end
      end

      private :migrate_legacy_keyfile_for_identity!, :locate_git_repo_root

      # Return the directory used to store well-known documents.
      #
      # @return [String] absolute path to the staging directory.
      def well_known_directory
        PotatoMesh::Config.well_known_storage_root
      end

      # Determine the absolute path to the well-known document file.
      #
      # @return [String] filesystem path for the JSON document.
      def well_known_file_path
        File.join(
          well_known_directory,
          File.basename(PotatoMesh::Config.well_known_relative_path),
        )
      end

      # Remove legacy well-known artifacts from previous releases.
      #
      # @return [void]
      def cleanup_legacy_well_known_artifacts
        legacy_path = PotatoMesh::Config.legacy_public_well_known_path
        FileUtils.rm_f(legacy_path)
        legacy_dir = File.dirname(legacy_path)
        FileUtils.rmdir(legacy_dir) if Dir.exist?(legacy_dir) && Dir.empty?(legacy_dir)
      rescue SystemCallError
        # Ignore errors removing legacy static files; failure only means the directory
        # or file did not exist or is in use.
      end

      # Construct the JSON body and detached signature for the well-known document.
      #
      # @return [Array(String, String)] pair of JSON output and base64 signature.
      def build_well_known_document
        last_update = latest_node_update_timestamp
        domain_value = sanitize_instance_domain(app_constant(:INSTANCE_DOMAIN))

        payload = {
          publicKey: app_constant(:INSTANCE_PUBLIC_KEY_PEM),
          name: sanitized_site_name,
          version: app_constant(:APP_VERSION),
          domain: domain_value,
          lastUpdate: last_update,
        }

        signed_payload = JSON.generate(payload, sort_keys: true)
        signature = Base64.strict_encode64(
          app_constant(:INSTANCE_PRIVATE_KEY).sign(OpenSSL::Digest::SHA256.new, signed_payload),
        )

        document = payload.merge(
          signature: signature,
          signatureAlgorithm: PotatoMesh::Config.instance_signature_algorithm,
          signedPayload: Base64.strict_encode64(signed_payload),
        )

        json_output = JSON.pretty_generate(document)
        [json_output, signature]
      end

      # Regenerate the well-known document when it is stale or when the existing
      # content no longer matches the current instance configuration.
      #
      # @return [void]
      def refresh_well_known_document_if_stale
        FileUtils.mkdir_p(well_known_directory)
        path = well_known_file_path
        now = Time.now
        json_output, signature = build_well_known_document
        expected_contents = json_output.end_with?("\n") ? json_output : "#{json_output}\n"

        needs_update = true
        if File.exist?(path)
          current_contents = File.binread(path)
          mtime = File.mtime(path)
          if current_contents == expected_contents &&
             (now - mtime) < PotatoMesh::Config.well_known_refresh_interval
            needs_update = false
          end
        end

        return unless needs_update

        File.open(path, File::WRONLY | File::CREAT | File::TRUNC, 0o644) do |file|
          file.write(expected_contents)
        end

        debug_log(
          "Refreshed well-known document content",
          context: "identity.well_known",
          path: PotatoMesh::Config.well_known_relative_path,
          bytes: json_output.bytesize,
          document: json_output,
        )
        debug_log(
          "Refreshed well-known document signature",
          context: "identity.well_known",
          path: PotatoMesh::Config.well_known_relative_path,
          algorithm: PotatoMesh::Config.instance_signature_algorithm,
          signature: signature,
        )
      end

      # Retrieve the latest node update timestamp from the database.
      #
      # @return [Integer, nil] Unix timestamp or nil when unavailable.
      def latest_node_update_timestamp
        return nil unless File.exist?(PotatoMesh::Config.db_path)

        db = open_database(readonly: true)
        value = db.get_first_value("SELECT MAX(last_heard) FROM nodes")
        value&.to_i
      rescue SQLite3::Exception
        nil
      ensure
        db&.close
      end

      # Emit a debug entry describing the active instance key material.
      #
      # @return [void]
      def log_instance_public_key
        debug_log(
          "Loaded instance public key",
          context: "identity.keys",
          public_key_pem: app_constant(:INSTANCE_PUBLIC_KEY_PEM),
        )
        if app_constant(:INSTANCE_KEY_GENERATED)
          debug_log(
            "Generated new instance private key",
            context: "identity.keys",
            path: PotatoMesh::Config.keyfile_path,
          )
        end
      end

      # Emit a debug entry describing how the instance domain was derived.
      #
      # @return [void]
      def log_instance_domain_resolution
        source = app_constant(:INSTANCE_DOMAIN_SOURCE) || :unknown
        debug_log(
          "Resolved instance domain",
          context: "identity.domain",
          source: source,
          domain: app_constant(:INSTANCE_DOMAIN),
        )
      end
    end
  end
end
