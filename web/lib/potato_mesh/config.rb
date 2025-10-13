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
    DEFAULT_DB_BUSY_TIMEOUT_MS = 5_000
    DEFAULT_DB_BUSY_MAX_RETRIES = 5
    DEFAULT_DB_BUSY_RETRY_DELAY = 0.05
    DEFAULT_MAX_JSON_BODY_BYTES = 1_048_576
    DEFAULT_REFRESH_INTERVAL_SECONDS = 60
    DEFAULT_TILE_FILTERS = {
      light: "grayscale(1) saturate(0) brightness(0.92) contrast(1.05)",
      dark: "grayscale(1) invert(1) brightness(0.9) contrast(1.08)",
    }.freeze
    DEFAULT_MAP_CENTER = [38.761944, -27.090833].freeze
    DEFAULT_HTTP_PORT = 41_447

    module_function

    # Container for runtime configuration overrides used by the test suite and
    # internal components. Public configuration is read exclusively from
    # environment variables that remain supported.
    #
    # @return [Hash{Symbol=>Object}] override mapping.
    def config_overrides
      @config_overrides ||= {}
    end

    # Apply temporary runtime configuration overrides.
    #
    # @param values [Hash{Symbol=>Object}] collection of overrides to apply.
    # @return [void]
    def configure(values = {})
      values.each do |key, value|
        config_overrides[key] = value
      end
    end

    # Reset all runtime overrides to their defaults.
    #
    # @return [void]
    def reset_overrides!
      config_overrides.clear
    end

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

    # Build the default SQLite database path inside the data directory.
    #
    # @return [String] absolute path to +data/mesh.db+.
    def default_db_path
      File.expand_path("../data/mesh.db", web_root)
    end

    # Determine the configured database location, defaulting to the bundled
    # SQLite file.
    #
    # @return [String] absolute path to the database file.
    def db_path
      override = config_overrides[:db_path]
      return override if override && !override.to_s.empty?

      default_db_path
    end

    # Retrieve the SQLite busy timeout duration in milliseconds.
    #
    # @return [Integer] timeout value in milliseconds.
    def db_busy_timeout_ms
      value = config_overrides.fetch(:db_busy_timeout_ms, DEFAULT_DB_BUSY_TIMEOUT_MS)
      value.to_i
    end

    # Retrieve the maximum number of retries when encountering SQLITE_BUSY.
    #
    # @return [Integer] maximum retry attempts.
    def db_busy_max_retries
      value = config_overrides.fetch(:db_busy_max_retries, DEFAULT_DB_BUSY_MAX_RETRIES)
      value.to_i
    end

    # Retrieve the backoff delay between busy retries in seconds.
    #
    # @return [Float] seconds to wait between retries.
    def db_busy_retry_delay
      value = config_overrides.fetch(:db_busy_retry_delay, DEFAULT_DB_BUSY_RETRY_DELAY)
      value.to_f
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
      DEFAULT_MAX_JSON_BODY_BYTES
    end

    # Determine the maximum allowed JSON body size with validation. When an
    # override is present it must be a positive integer, otherwise the default
    # value is returned.
    #
    # @return [Integer] configured byte limit.
    def max_json_body_bytes
      raw = config_overrides[:max_json_body_bytes]
      return default_max_json_body_bytes if raw.nil?

      value = Integer(raw, 10)
      value.positive? ? value : default_max_json_body_bytes
    rescue ArgumentError, TypeError
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
      DEFAULT_REFRESH_INTERVAL_SECONDS
    end

    # Fetch the refresh interval, ensuring a positive integer value. Overrides
    # are primarily intended for tests and internal callers.
    #
    # @return [Integer] polling cadence in seconds.
    def refresh_interval_seconds
      raw = config_overrides[:refresh_interval_seconds]
      return default_refresh_interval_seconds if raw.nil?

      value = Integer(raw, 10)
      value.positive? ? value : default_refresh_interval_seconds
    rescue ArgumentError, TypeError
      default_refresh_interval_seconds
    end

    # Determine the HTTP port used when binding the Sinatra server.
    #
    # @return [Integer] resolved TCP port number.
    def http_port
      raw = config_overrides[:http_port]
      return DEFAULT_HTTP_PORT if raw.nil?

      Integer(raw, 10)
    rescue ArgumentError, TypeError
      DEFAULT_HTTP_PORT
    end

    # Retrieve the CSS filter used for light themed maps.
    #
    # @return [String] CSS filter string.
    def map_tile_filter_light
      override = config_overrides.dig(:tile_filters, :light)
      override ? override.to_s : DEFAULT_TILE_FILTERS[:light]
    end

    # Retrieve the CSS filter used for dark themed maps.
    #
    # @return [String] CSS filter string for dark tiles.
    def map_tile_filter_dark
      override = config_overrides.dig(:tile_filters, :dark)
      override ? override.to_s : DEFAULT_TILE_FILTERS[:dark]
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
      config_overrides.fetch(:prom_report_ids, "")
    end

    # Transform Prometheus report identifiers into a cleaned array.
    #
    # @return [Array<String>] list of unique report identifiers.
    def prom_report_id_list
      value = prom_report_ids
      return value if value.is_a?(Array)

      value.to_s.split(",").map(&:strip).reject(&:empty?)
    end

    # Path storing the instance private key used for signing.
    #
    # @return [String] absolute location of the PEM file.
    def keyfile_path
      File.join(web_root, ".config", "keyfile")
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
      File.join(web_root, ".config", "well-known")
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
    def channel
      fetch_string("CHANNEL", "#LongFast")
    end

    # Retrieve the default radio frequency description.
    #
    # @return [String] frequency identifier.
    def frequency
      fetch_string("FREQUENCY", "915MHz")
    end

    # Retrieve the configured map centre coordinates as a tuple.
    #
    # @return [Array(Float, Float)] latitude and longitude pair.
    def map_center
      return config_overrides[:map_center] if config_overrides[:map_center]

      raw = ENV["MAP_CENTER"]
      return DEFAULT_MAP_CENTER unless raw

      lat_str, lon_str = raw.split(",", 2)
      return DEFAULT_MAP_CENTER unless lat_str && lon_str

      [Float(lat_str), Float(lon_str)]
    rescue ArgumentError
      DEFAULT_MAP_CENTER
    end

    # Map display latitude centre for the frontend map widget.
    #
    # @return [Float] latitude in decimal degrees.
    def map_center_lat
      map_center[0]
    end

    # Map display longitude centre for the frontend map widget.
    #
    # @return [Float] longitude in decimal degrees.
    def map_center_lon
      map_center[1]
    end

    # Maximum straight-line distance between nodes before relationships are
    # hidden.
    #
    # @return [Float] distance in kilometres.
    def max_distance_km
      value = ENV.fetch("MAX_DISTANCE", "42").to_f
      value.positive? ? value : 42.0
    end

    # Contact link for community discussion.
    #
    # @return [String] contact URL or identifier.
    def contact_link
      fetch_string("CONTACT_LINK", "")
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
  end
end
