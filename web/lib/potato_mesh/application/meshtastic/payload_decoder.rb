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

require "json"
require "open3"

module PotatoMesh
  module App
    module Meshtastic
      # Decode Meshtastic protobuf payloads via the Python helper script.
      module PayloadDecoder
        module_function

        PYTHON_ENV_KEY = "MESHTASTIC_PYTHON"
        DEFAULT_PYTHON_RELATIVE = File.join("data", ".venv", "bin", "python")
        DEFAULT_DECODER_RELATIVE = File.join("data", "mesh_ingestor", "decode_payload.py")
        FALLBACK_PYTHON_NAMES = ["python3", "python"].freeze

        # Decode a protobuf payload using the Meshtastic helper.
        #
        # @param portnum [Integer] Meshtastic port number.
        # @param payload_b64 [String] base64-encoded payload bytes.
        # @return [Hash, nil] decoded payload hash or nil when decoding fails.
        def decode(portnum:, payload_b64:)
          return nil unless portnum && payload_b64

          decoder_path = decoder_script_path
          python_path = python_executable_path
          return nil unless decoder_path && python_path

          input = JSON.generate({ portnum: portnum, payload_b64: payload_b64 })
          stdout, stderr, status = Open3.capture3(python_path, decoder_path, stdin_data: input)
          return nil unless status.success?

          parsed = JSON.parse(stdout)
          return nil unless parsed.is_a?(Hash)
          return nil if parsed["error"]

          parsed
        rescue JSON::ParserError
          nil
        rescue Errno::ENOENT
          nil
        rescue ArgumentError
          nil
        end

        # Resolve the configured Python executable for Meshtastic decoding.
        #
        # @return [String, nil] python path or nil when missing.
        def python_executable_path
          configured = ENV[PYTHON_ENV_KEY]
          return configured if configured && !configured.strip.empty?

          candidate = File.expand_path(DEFAULT_PYTHON_RELATIVE, repo_root)
          return candidate if File.exist?(candidate)

          FALLBACK_PYTHON_NAMES.each do |name|
            found = find_executable(name)
            return found if found
          end

          nil
        end

        # Resolve the Meshtastic payload decoder script path.
        #
        # @return [String, nil] script path or nil when missing.
        def decoder_script_path
          repo_candidate = File.expand_path(DEFAULT_DECODER_RELATIVE, repo_root)
          return repo_candidate if File.exist?(repo_candidate)

          web_candidate = File.expand_path(DEFAULT_DECODER_RELATIVE, web_root)
          return web_candidate if File.exist?(web_candidate)

          nil
        end

        # Resolve the repository root directory from the application config.
        #
        # @return [String] absolute path to the repository root.
        def repo_root
          PotatoMesh::Config.repo_root
        end

        def web_root
          PotatoMesh::Config.web_root
        end

        def find_executable(name)
          # Locate an executable in PATH without invoking a subshell.
          #
          # @param name [String] executable name to resolve.
          # @return [String, nil] full path when found.
          ENV.fetch("PATH", "").split(File::PATH_SEPARATOR).each do |path|
            candidate = File.join(path, name)
            return candidate if File.file?(candidate) && File.executable?(candidate)
          end

          nil
        end

        private_class_method :find_executable
      end
    end
  end
end
