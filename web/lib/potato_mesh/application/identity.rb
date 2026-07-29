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
      # Resolve the current application version string. Always +"v"+-prefixed
      # (e.g. +"v0.7.4"+) so every build shape — git, baked-Docker, or constant
      # fallback — advertises the same form across +/version+, the footer, the
      # federation self-record, and the User-Agent.
      #
      # @return [String] semantic version compatible identifier, +"v"+-prefixed.
      def determine_app_version
        resolve_app_version.fetch(:version)
      end

      # Whether {APP_VERSION} is a unique-per-build identifier — baked into the
      # image via +ENV["APP_VERSION"]+ or produced by a successful +git describe+
      # — as opposed to the constant {PotatoMesh::Config.version_fallback}. Only a
      # pinned build is safe to serve +immutable+, because only then does the
      # +?v=+ asset cache-buster change whenever the assets do (SPEC AV1/AV6,
      # ACCEPTANCE CA-A1). A fallback build is served revalidatable instead.
      #
      # @return [Boolean] +true+ for a baked/git version, +false+ for the fallback.
      def app_version_pinned?
        resolve_app_version.fetch(:pinned)
      end

      # Resolve the running version **and** its immutable-safety in one pass, in
      # precedence order:
      # 1. A non-blank +ENV["APP_VERSION"]+ — the git version baked into a Docker
      #    image at build time (+web/Dockerfile+ +ARG+/+ENV+, computed by
      #    +.github/workflows/docker.yml+ via +git describe+). The image ships
      #    without +.git+, so this is the only way the in-image cache-buster stays
      #    unique per build (SPEC AV6) — hence +pinned: true+.
      # 2. +git describe+ against the enclosing repository (+pinned: true+).
      # 3. {PotatoMesh::Config.version_fallback} as a last resort (+pinned: false+).
      #
      # @return [Hash{Symbol=>Object}] +{ version: String, pinned: Boolean }+; the
      #   version is always +"v"+-prefixed (see {normalize_version}).
      def resolve_app_version
        baked = ENV["APP_VERSION"].to_s.strip
        return { version: normalize_version(baked), pinned: true } unless baked.empty?

        repo_root = locate_git_repo_root(File.expand_path("../../..", __dir__))
        return fallback_app_version unless repo_root

        stdout, status = Open3.capture2("git", "-C", repo_root, "describe", "--tags", "--long", "--abbrev=7")
        return fallback_app_version unless status.success?

        raw = stdout.strip
        return fallback_app_version if raw.empty?

        { version: normalize_version(raw), pinned: true }
      rescue StandardError
        fallback_app_version
      end

      # The constant-fallback resolution: {PotatoMesh::Config.version_fallback}
      # (bare semver kept in lockstep with the polyglot manifests, e.g. +"0.7.4"+)
      # normalized to +"v0.7.4"+ and marked **not pinned**, so the asset
      # middleware serves it revalidatable rather than +immutable+.
      #
      # @return [Hash{Symbol=>Object}] +{ version: String, pinned: false }+.
      def fallback_app_version
        { version: normalize_version(PotatoMesh::Config.version_fallback), pinned: false }
      end

      # Normalize a raw version source into the canonical PotatoMesh string:
      # collapse any +git describe+ tail (see {normalize_git_description}), then
      # ensure exactly one leading +"v"+ (mirroring the display rule in
      # +display_version+). So +"0.7.4"+ and +"v0.7.4-0-g<hash>"+ both render
      # +"v0.7.4"+, and an already-+"v"+-prefixed value is left unchanged.
      #
      # @param raw [String] a git-describe string, baked value, or bare version.
      # @return [String] the canonical, +"v"+-prefixed version string.
      def normalize_version(raw)
        described = normalize_git_description(raw)
        described.start_with?("v") ? described : "v#{described}"
      end

      # Normalize a ``git describe --tags --long`` string into the canonical
      # PotatoMesh version. ``<tag>-0-g<hash>`` (a build sitting exactly on a tag)
      # collapses to ``<tag>``; ``<tag>-<n>-g<hash>`` (``n`` commits past the tag)
      # becomes ``<tag>+<n>-<hash>``. Any string that does not match that grammar
      # — an already-normalized version, or an operator-supplied label — is
      # returned unchanged. Sharing this with the git branch guarantees a baked
      # +ENV["APP_VERSION"]+ renders identically whether CI passes the raw
      # ``git describe`` output or a pre-normalized version.
      #
      # @param raw [String] a git-describe string or pre-formatted version.
      # @return [String] the canonical version string (before +"v"+ prefixing).
      def normalize_git_description(raw)
        match = /\A(?<tag>.+)-(?<count>\d+)-g(?<hash>[0-9a-f]+)\z/.match(raw)
        return raw unless match

        tag = match[:tag]
        count = match[:count].to_i
        return tag if count.zero?

        "#{tag}+#{count}-#{match[:hash]}"
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

      private :migrate_legacy_keyfile_for_identity!, :locate_git_repo_root,
              :fallback_app_version, :normalize_version, :normalize_git_description

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
          "public_key" => app_constant(:INSTANCE_PUBLIC_KEY_PEM),
          "name" => sanitized_site_name,
          "version" => app_constant(:APP_VERSION),
          "domain" => domain_value,
          "last_update" => last_update,
        }

        # Shared snake_case canonicalizer (SPEC FS1/FS4, U0) stamps
        # signature_version inside the signed bytes so the format cannot be
        # silently downgraded.
        signed_payload = canonical_signed_payload(payload)
        signature = Base64.strict_encode64(
          app_constant(:INSTANCE_PRIVATE_KEY).sign(OpenSSL::Digest::SHA256.new, signed_payload),
        )

        document = payload.merge(
          "signature_version" => PotatoMesh::Config.federation_signature_version,
          "signature" => signature,
          "signature_algorithm" => PotatoMesh::Config.instance_signature_algorithm,
          "signed_payload" => Base64.strict_encode64(signed_payload),
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
      # Opted-out nodes are excluded so the +/version+ cache hint and the
      # federation self-record do not leak the freshness of nodes that have
      # asked to stay hidden.
      #
      # @return [Integer, nil] Unix timestamp or nil when unavailable.
      def latest_node_update_timestamp
        return nil unless File.exist?(PotatoMesh::Config.db_path)

        db = open_database(readonly: true)
        sql = "SELECT MAX(last_heard) FROM nodes WHERE #{opt_out_self_filter}"
        value = db.get_first_value(sql, opt_out_marker_params)
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
      # When +INSTANCE_DOMAIN+ is unset in production, also surface a
      # warning because canonical URLs, sitemap entries, and JSON-LD
      # metadata fall back to whatever +Host+ header the request arrived
      # with — which can be cache-poisoned by a misconfigured proxy.
      #
      # @return [void]
      def log_instance_domain_resolution
        source = app_constant(:INSTANCE_DOMAIN_SOURCE) || :unknown
        domain = app_constant(:INSTANCE_DOMAIN)
        debug_log(
          "Resolved instance domain",
          context: "identity.domain",
          source: source,
          domain: domain,
        )
        if production_environment? && (domain.nil? || domain.to_s.strip.empty?)
          warn_log(
            "INSTANCE_DOMAIN is unset; canonical URLs and sitemap entries " \
            "will be derived from the inbound Host header",
            context: "identity.domain",
            source: source,
          )
        end
      end
    end
  end
end
