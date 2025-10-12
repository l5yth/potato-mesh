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
  module Config
    module_function

    def web_root
      @web_root ||= File.expand_path("../..", __dir__)
    end

    def repo_root
      @repo_root ||= File.expand_path("..", web_root)
    end

    def default_db_path
      File.expand_path("../data/mesh.db", web_root)
    end

    def db_path
      ENV.fetch("MESH_DB", default_db_path)
    end

    def db_busy_timeout_ms
      ENV.fetch("DB_BUSY_TIMEOUT_MS", "5000").to_i
    end

    def db_busy_max_retries
      ENV.fetch("DB_BUSY_MAX_RETRIES", "5").to_i
    end

    def db_busy_retry_delay
      ENV.fetch("DB_BUSY_RETRY_DELAY", "0.05").to_f
    end

    def week_seconds
      7 * 24 * 60 * 60
    end

    def default_max_json_body_bytes
      1_048_576
    end

    def max_json_body_bytes
      raw = ENV.fetch("MAX_JSON_BODY_BYTES", default_max_json_body_bytes.to_s)
      value = Integer(raw, 10)
      value.positive? ? value : default_max_json_body_bytes
    rescue ArgumentError
      default_max_json_body_bytes
    end

    def version_fallback
      "v0.5.0"
    end

    def default_refresh_interval_seconds
      60
    end

    def refresh_interval_seconds
      raw = ENV.fetch("REFRESH_INTERVAL_SECONDS", default_refresh_interval_seconds.to_s)
      value = Integer(raw, 10)
      value.positive? ? value : default_refresh_interval_seconds
    rescue ArgumentError
      default_refresh_interval_seconds
    end

    def map_tile_filter_light
      ENV.fetch(
        "MAP_TILE_FILTER_LIGHT",
        "grayscale(1) saturate(0) brightness(0.92) contrast(1.05)",
      )
    end

    def map_tile_filter_dark
      ENV.fetch(
        "MAP_TILE_FILTER_DARK",
        "grayscale(1) invert(1) brightness(0.9) contrast(1.08)",
      )
    end

    def tile_filters
      {
        light: map_tile_filter_light,
        dark: map_tile_filter_dark,
      }.freeze
    end

    def prom_report_ids
      ENV.fetch("PROM_REPORT_IDS", "")
    end

    def prom_report_id_list
      prom_report_ids.split(",").map(&:strip).reject(&:empty?)
    end

    def keyfile_path
      File.join(web_root, ".config", "keyfile")
    end

    def well_known_relative_path
      File.join(".well-known", "potato-mesh")
    end

    def well_known_storage_root
      File.join(web_root, ".config", "well-known")
    end

    def legacy_public_well_known_path
      File.join(web_root, "public", well_known_relative_path)
    end

    def well_known_refresh_interval
      24 * 60 * 60
    end

    def instance_signature_algorithm
      "rsa-sha256"
    end

    def remote_instance_http_timeout
      5
    end

    def remote_instance_max_node_age
      86_400
    end

    def remote_instance_min_node_count
      10
    end

    def federation_seed_domains
      ["potatomesh.net"].freeze
    end

    # @return [Integer] the number of seconds between federation announcement broadcasts.
    #   Eight hours provides three updates per day without creating unnecessary chatter.
    def federation_announcement_interval
      8 * 60 * 60
    end

    def site_name
      fetch_string("SITE_NAME", "PotatoMesh Demo")
    end

    def default_channel
      fetch_string("DEFAULT_CHANNEL", "#LongFast")
    end

    def default_frequency
      fetch_string("DEFAULT_FREQUENCY", "915MHz")
    end

    def map_center_lat
      ENV.fetch("MAP_CENTER_LAT", "38.761944").to_f
    end

    def map_center_lon
      ENV.fetch("MAP_CENTER_LON", "-27.090833").to_f
    end

    def max_node_distance_km
      ENV.fetch("MAX_NODE_DISTANCE_KM", "42").to_f
    end

    def matrix_room
      ENV.fetch("MATRIX_ROOM", "#potatomesh:dod.ngo")
    end

    def debug?
      ENV["DEBUG"] == "1"
    end

    def fetch_string(key, default)
      value = ENV[key]
      return default if value.nil?

      trimmed = value.strip
      trimmed.empty? ? default : trimmed
    end
  end
end
