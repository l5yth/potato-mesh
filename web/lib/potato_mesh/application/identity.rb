# frozen_string_literal: true

module PotatoMesh
  module App
    module Identity
      def determine_app_version
        repo_root = File.expand_path("../../..", __dir__)
        git_dir = File.join(repo_root, ".git")
        return PotatoMesh::Config.version_fallback unless File.directory?(git_dir)

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

      def load_or_generate_instance_private_key
        keyfile_path = PotatoMesh::Config.keyfile_path
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
        warn "[warn] failed to load instance private key, generating a new key: #{e.message}"
        key = OpenSSL::PKey::RSA.new(2048)
        File.open(keyfile_path, File::WRONLY | File::CREAT | File::TRUNC, 0o600) do |file|
          file.write(key.export)
        end
        [key, true]
      end

      def well_known_directory
        PotatoMesh::Config.well_known_storage_root
      end

      def well_known_file_path
        File.join(
          well_known_directory,
          File.basename(PotatoMesh::Config.well_known_relative_path),
        )
      end

      def cleanup_legacy_well_known_artifacts
        legacy_path = PotatoMesh::Config.legacy_public_well_known_path
        FileUtils.rm_f(legacy_path)
        legacy_dir = File.dirname(legacy_path)
        FileUtils.rmdir(legacy_dir) if Dir.exist?(legacy_dir) && Dir.empty?(legacy_dir)
      rescue SystemCallError
        # Ignore errors removing legacy static files; failure only means the directory
        # or file did not exist or is in use.
      end

      def build_well_known_document
        last_update = latest_node_update_timestamp
        payload = {
          publicKey: app_constant(:INSTANCE_PUBLIC_KEY_PEM),
          name: sanitized_site_name,
          version: app_constant(:APP_VERSION),
          domain: app_constant(:INSTANCE_DOMAIN),
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

      def refresh_well_known_document_if_stale
        FileUtils.mkdir_p(well_known_directory)
        path = well_known_file_path
        now = Time.now
        if File.exist?(path)
          mtime = File.mtime(path)
          if (now - mtime) < PotatoMesh::Config.well_known_refresh_interval
            return
          end
        end

        json_output, signature = build_well_known_document
        File.open(path, File::WRONLY | File::CREAT | File::TRUNC, 0o644) do |file|
          file.write(json_output)
          file.write("\n") unless json_output.end_with?("\n")
        end

        debug_log("Updated #{PotatoMesh::Config.well_known_relative_path} content: #{json_output}")
        debug_log(
          "Updated #{PotatoMesh::Config.well_known_relative_path} signature (#{PotatoMesh::Config.instance_signature_algorithm}): #{signature}",
        )
      end

      def latest_node_update_timestamp
        return nil unless File.exist?(PotatoMesh::Config.db_path)

        db = open_database(readonly: true)
        value = db.get_first_value(
          "SELECT MAX(COALESCE(last_heard, first_heard, position_time)) FROM nodes",
        )
        value&.to_i
      rescue SQLite3::Exception
        nil
      ensure
        db&.close
      end

      def log_instance_public_key
        debug_log("Instance public key (PEM):\n#{app_constant(:INSTANCE_PUBLIC_KEY_PEM)}")
        if app_constant(:INSTANCE_KEY_GENERATED)
          debug_log(
            "Generated new instance private key at #{PotatoMesh::Config.keyfile_path}",
          )
        end
      end

      def log_instance_domain_resolution
        message = case app_constant(:INSTANCE_DOMAIN_SOURCE)
          when :environment
            "Instance domain configured from INSTANCE_DOMAIN environment variable: #{app_constant(:INSTANCE_DOMAIN).inspect}"
          when :reverse_dns
            "Instance domain resolved via reverse DNS lookup: #{app_constant(:INSTANCE_DOMAIN).inspect}"
          when :public_ip
            "Instance domain resolved using public IP address: #{app_constant(:INSTANCE_DOMAIN).inspect}"
          when :protected_ip
            "Instance domain resolved using protected network IP address: #{app_constant(:INSTANCE_DOMAIN).inspect}"
          when :local_ip
            "Instance domain defaulted to local IP address: #{app_constant(:INSTANCE_DOMAIN).inspect}"
          else
            "Instance domain could not be determined from the environment or local network."
          end

        debug_log(message)
      end
    end
  end
end
