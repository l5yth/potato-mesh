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
  # Configuration wrapper responsible for exposing ENV backed settings used by
  # the web and data ingestion services.
  module Config
    module_function

    # Resolve the absolute path to the web application root directory.
    #
    # @return [String] absolute filesystem path of the web folder.
    def web_root
      @web_root ||= File.expand_path("../..", __dir__)
    end

    # Resolve the repository root directory relative to the web folder.
    #
    # @return [String] path to the Git repository root.
    def repo_root
      @repo_root ||= File.expand_path("..", web_root)
    end

    # Resolve the current XDG data directory for PotatoMesh content.
    #
    # @return [String] absolute path to the PotatoMesh data directory.
    def data_directory
      File.join(resolve_xdg_home("XDG_DATA_HOME", %w[.local share]), "potato-mesh")
    end

    # Resolve the current XDG configuration directory for PotatoMesh files.
    #
    # @return [String] absolute path to the PotatoMesh configuration directory.
    def config_directory
      File.join(resolve_xdg_home("XDG_CONFIG_HOME", %w[.config]), "potato-mesh")
    end

    # Build the default SQLite database path inside the data directory.
    #
    # @return [String] absolute path to the managed +mesh.db+ file.
    def default_db_path
      File.join(data_directory, "mesh.db")
    end

    # Legacy database path bundled alongside the repository.
    #
    # @return [String] absolute path to the repository managed database file.
    def legacy_db_path
      File.expand_path("../data/mesh.db", web_root)
    end

    # Determine the configured database location, defaulting to the bundled
    # SQLite file.
    #
    # @return [String] absolute path to the database file.
    def db_path
      ENV.fetch("MESH_DB", default_db_path)
    end

    # Retrieve the SQLite busy timeout duration in milliseconds.
    #
    # @return [Integer] timeout value in milliseconds.
    def db_busy_timeout_ms
      ENV.fetch("DB_BUSY_TIMEOUT_MS", "5000").to_i
    end

    # Retrieve the maximum number of retries when encountering SQLITE_BUSY.
    #
    # @return [Integer] maximum retry attempts.
    def db_busy_max_retries
      ENV.fetch("DB_BUSY_MAX_RETRIES", "5").to_i
    end

    # Retrieve the backoff delay between busy retries in seconds.
    #
    # @return [Float] seconds to wait between retries.
    def db_busy_retry_delay
      ENV.fetch("DB_BUSY_RETRY_DELAY", "0.05").to_f
    end

    # Convenience constant describing the number of seconds in a week.
    #
    # @return [Integer] seconds in seven days.
    def week_seconds
      7 * 24 * 60 * 60
    end

    # Default upper bound for accepted JSON payload sizes.
    #
    # @return [Integer] byte ceiling for HTTP request bodies.
    def default_max_json_body_bytes
      1_048_576
    end

    # Determine the maximum allowed JSON body size with validation.
    #
    # @return [Integer] configured byte limit.
    def max_json_body_bytes
      raw = ENV.fetch("MAX_JSON_BODY_BYTES", default_max_json_body_bytes.to_s)
      value = Integer(raw, 10)
      value.positive? ? value : default_max_json_body_bytes
    rescue ArgumentError
      default_max_json_body_bytes
    end

    # Provide the fallback version string when git metadata is unavailable.
    #
    # @return [String] semantic version identifier.
    def version_fallback
      "v0.5.0"
    end

    # Default refresh interval for frontend polling routines.
    #
    # @return [Integer] refresh period in seconds.
    def default_refresh_interval_seconds
      60
    end

    # Fetch the refresh interval, ensuring a positive integer value.
    #
    # @return [Integer] polling cadence in seconds.
    def refresh_interval_seconds
      raw = ENV.fetch("REFRESH_INTERVAL_SECONDS", default_refresh_interval_seconds.to_s)
      value = Integer(raw, 10)
      value.positive? ? value : default_refresh_interval_seconds
    rescue ArgumentError
      default_refresh_interval_seconds
    end

    # Retrieve the CSS filter used for light themed maps.
    #
    # @return [String] CSS filter string.
    def map_tile_filter_light
      ENV.fetch(
        "MAP_TILE_FILTER_LIGHT",
        "grayscale(1) saturate(0) brightness(0.92) contrast(1.05)",
      )
    end

    # Retrieve the CSS filter used for dark themed maps.
    #
    # @return [String] CSS filter string for dark tiles.
    def map_tile_filter_dark
      ENV.fetch(
        "MAP_TILE_FILTER_DARK",
        "grayscale(1) invert(1) brightness(0.9) contrast(1.08)",
      )
    end

    # Provide a simple hash of tile filters for template use.
    #
    # @return [Hash] frozen mapping of themes to CSS filters.
    def tile_filters
      {
        light: map_tile_filter_light,
        dark: map_tile_filter_dark,
      }.freeze
    end

    # Retrieve the raw comma separated Prometheus report identifiers.
    #
    # @return [String] comma separated list of report IDs.
    def prom_report_ids
      ENV.fetch("PROM_REPORT_IDS", "")
    end

    # Transform Prometheus report identifiers into a cleaned array.
    #
    # @return [Array<String>] list of unique report identifiers.
    def prom_report_id_list
      prom_report_ids.split(",").map(&:strip).reject(&:empty?)
    end

    # Path storing the instance private key used for signing.
    #
    # @return [String] absolute location of the PEM file.
    def keyfile_path
      File.join(config_directory, "keyfile")
    end

    # Sub-path used when exposing well known configuration files.
    #
    # @return [String] relative path within the public directory.
    def well_known_relative_path
      File.join(".well-known", "potato-mesh")
    end

    # Filesystem directory used to stage /.well-known artifacts.
    #
    # @return [String] absolute storage path.
    def well_known_storage_root
      File.join(config_directory, "well-known")
    end

    # Legacy configuration directory bundled with the repository.
    #
    # @return [String] absolute path to the repository managed configuration directory.
    def legacy_config_directory
      File.join(web_root, ".config")
    end

    # Legacy keyfile location used before introducing XDG directories.
    #
    # @return [String] absolute filesystem path to the legacy keyfile.
    def legacy_keyfile_path
      File.join(legacy_config_directory, "keyfile")
    end

    # Legacy location for well known assets within the public folder.
    #
    # @return [String] absolute path to the legacy output directory.
    def legacy_public_well_known_path
      File.join(web_root, "public", well_known_relative_path)
    end

    # Interval used to refresh well known documents from disk.
    #
    # @return [Integer] refresh duration in seconds.
    def well_known_refresh_interval
      24 * 60 * 60
    end

    # Cryptographic algorithm identifier for HTTP signatures.
    #
    # @return [String] RFC-compliant algorithm label.
    def instance_signature_algorithm
      "rsa-sha256"
    end

    # Timeout used when querying remote instances during federation.
    #
    # @return [Integer] HTTP timeout in seconds.
    def remote_instance_http_timeout
      5
    end

    # Maximum acceptable age for remote node data.
    #
    # @return [Integer] seconds before remote nodes are considered stale.
    def remote_instance_max_node_age
      86_400
    end

    # Minimum node count expected from a remote instance before storing.
    #
    # @return [Integer] node threshold for remote ingestion.
    def remote_instance_min_node_count
      10
    end

    # Domains used to seed the federation discovery process.
    #
    # @return [Array<String>] list of default seed domains.
    def federation_seed_domains
      ["potatomesh.net"].freeze
    end

    # Determine how often we broadcast federation announcements.
    #
    # @return [Integer] number of seconds between announcement cycles.
    def federation_announcement_interval
      8 * 60 * 60
    end

    # Retrieve the configured site name for presentation.
    #
    # @return [String] human friendly site label.
    def site_name
      fetch_string("SITE_NAME", "PotatoMesh Demo")
    end

    # Retrieve the default radio channel label.
    #
    # @return [String] channel name from configuration.
    def default_channel
      fetch_string("DEFAULT_CHANNEL", "#LongFast")
    end

    # Retrieve the default radio frequency description.
    #
    # @return [String] frequency identifier.
    def default_frequency
      fetch_string("DEFAULT_FREQUENCY", "915MHz")
    end

    # Map display latitude centre for the frontend map widget.
    #
    # @return [Float] latitude in decimal degrees.
    def map_center_lat
      ENV.fetch("MAP_CENTER_LAT", "38.761944").to_f
    end

    # Map display longitude centre for the frontend map widget.
    #
    # @return [Float] longitude in decimal degrees.
    def map_center_lon
      ENV.fetch("MAP_CENTER_LON", "-27.090833").to_f
    end

    # Maximum straight-line distance between nodes before relationships are
    # hidden.
    #
    # @return [Float] distance in kilometres.
    def max_node_distance_km
      ENV.fetch("MAX_NODE_DISTANCE_KM", "42").to_f
    end

    # Matrix room identifier for community discussion.
    #
    # @return [String] Matrix room alias.
    def matrix_room
      ENV.fetch("MATRIX_ROOM", "#potatomesh:dod.ngo")
    end

    # Check whether verbose debugging is enabled for the runtime.
    #
    # @return [Boolean] true when DEBUG=1.
    def debug?
      ENV["DEBUG"] == "1"
    end

    # Fetch and sanitise string based configuration values.
    #
    # @param key [String] environment variable to read.
    # @param default [String] fallback value when unset or blank.
    # @return [String] cleaned configuration string.
    def fetch_string(key, default)
      value = ENV[key]
      return default if value.nil?

      trimmed = value.strip
      trimmed.empty? ? default : trimmed
    end

    # Resolve the effective XDG directory honoring environment overrides.
    #
    # @param env_key [String] name of the environment variable to inspect.
    # @param fallback_segments [Array<String>] path segments appended to the user home directory.
    # @return [String] absolute base directory referenced by the XDG variable.
    def resolve_xdg_home(env_key, fallback_segments)
      raw = fetch_string(env_key, nil)
      candidate = raw && !raw.empty? ? raw : nil
      return File.expand_path(candidate) if candidate

      base_home = safe_home_directory
      File.expand_path(File.join(base_home, *fallback_segments))
    end

    # Retrieve the current user's home directory handling runtime failures.
    #
    # @return [String] absolute path to the user home or web root fallback.
    def safe_home_directory
      home = Dir.home
      return web_root if home.nil? || home.empty?

      home
    rescue ArgumentError, RuntimeError
      web_root
    end
  end
end
