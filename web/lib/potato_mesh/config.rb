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

    DEFAULT_DB_BUSY_TIMEOUT_MS = 5_000
    DEFAULT_DB_BUSY_MAX_RETRIES = 5
    DEFAULT_DB_BUSY_RETRY_DELAY = 0.05
    DEFAULT_MAX_JSON_BODY_BYTES = 1_048_576
    DEFAULT_REFRESH_INTERVAL_SECONDS = 60
    DEFAULT_TILE_FILTER_LIGHT = "grayscale(1) saturate(0) brightness(0.92) contrast(1.05)"
    DEFAULT_TILE_FILTER_DARK = "grayscale(1) invert(1) brightness(0.9) contrast(1.08)"
    DEFAULT_MAP_CENTER_LAT = 38.761944
    DEFAULT_MAP_CENTER_LON = -27.090833
    DEFAULT_MAP_CENTER = "#{DEFAULT_MAP_CENTER_LAT},#{DEFAULT_MAP_CENTER_LON}"
    DEFAULT_CHANNEL = "#LongFast"
    DEFAULT_FREQUENCY = "915MHz"
    DEFAULT_CONTACT_LINK = "#potatomesh:dod.ngo"
    DEFAULT_MAX_DISTANCE_KM = 42.0
    DEFAULT_REMOTE_INSTANCE_CONNECT_TIMEOUT = 5
    DEFAULT_REMOTE_INSTANCE_READ_TIMEOUT = 12

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
      default_db_path
    end

    # Retrieve the SQLite busy timeout duration in milliseconds.
    #
    # @return [Integer] timeout value in milliseconds.
    def db_busy_timeout_ms
      DEFAULT_DB_BUSY_TIMEOUT_MS
    end

    # Retrieve the maximum number of retries when encountering SQLITE_BUSY.
    #
    # @return [Integer] maximum retry attempts.
    def db_busy_max_retries
      DEFAULT_DB_BUSY_MAX_RETRIES
    end

    # Retrieve the backoff delay between busy retries in seconds.
    #
    # @return [Float] seconds to wait between retries.
    def db_busy_retry_delay
      DEFAULT_DB_BUSY_RETRY_DELAY
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

    # Determine the maximum allowed JSON body size with validation.
    #
    # @return [Integer] configured byte limit.
    def max_json_body_bytes
      default_max_json_body_bytes
    end

    # Provide the fallback version string when git metadata is unavailable.
    #
    # @return [String] semantic version identifier.
    def version_fallback
      "v0.5.2"
    end

    # Default refresh interval for frontend polling routines.
    #
    # @return [Integer] refresh period in seconds.
    def default_refresh_interval_seconds
      DEFAULT_REFRESH_INTERVAL_SECONDS
    end

    # Fetch the refresh interval, ensuring a positive integer value.
    #
    # @return [Integer] polling cadence in seconds.
    def refresh_interval_seconds
      default_refresh_interval_seconds
    end

    # Retrieve the CSS filter used for light themed maps.
    #
    # @return [String] CSS filter string.
    def map_tile_filter_light
      DEFAULT_TILE_FILTER_LIGHT
    end

    # Retrieve the CSS filter used for dark themed maps.
    #
    # @return [String] CSS filter string for dark tiles.
    def map_tile_filter_dark
      DEFAULT_TILE_FILTER_DARK
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
      ""
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
      legacy_keyfile_candidates.find { |path| File.exist?(path) } || legacy_keyfile_candidates.first
    end

    # Enumerate known legacy keyfile locations for migration.
    #
    # @return [Array<String>] ordered list of absolute legacy keyfile paths.
    def legacy_keyfile_candidates
      [
        File.join(web_root, ".config", "keyfile"),
        File.join(web_root, ".config", "potato-mesh", "keyfile"),
        File.join(web_root, "config", "keyfile"),
        File.join(web_root, "config", "potato-mesh", "keyfile"),
      ].map { |path| File.expand_path(path) }.uniq
    end

    # Legacy location for well known assets within the public folder.
    #
    # @return [String] absolute path to the legacy output directory.
    def legacy_public_well_known_path
      File.join(web_root, "public", well_known_relative_path)
    end

    # Enumerate known legacy well-known document locations for migration.
    #
    # @return [Array<String>] ordered list of absolute legacy well-known document paths.
    def legacy_well_known_candidates
      filename = File.basename(well_known_relative_path)
      [
        File.join(web_root, ".config", "well-known", filename),
        File.join(web_root, ".config", ".well-known", filename),
        File.join(web_root, ".config", "potato-mesh", "well-known", filename),
        File.join(web_root, ".config", "potato-mesh", ".well-known", filename),
        File.join(web_root, "config", "well-known", filename),
        File.join(web_root, "config", ".well-known", filename),
        File.join(web_root, "config", "potato-mesh", "well-known", filename),
        File.join(web_root, "config", "potato-mesh", ".well-known", filename),
      ].map { |path| File.expand_path(path) }.uniq
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

    # Connection timeout used when establishing federation HTTP sockets.
    #
    # @return [Integer] connect timeout in seconds.
    def remote_instance_http_timeout
      DEFAULT_REMOTE_INSTANCE_CONNECT_TIMEOUT
    end

    # Read timeout used when streaming federation HTTP responses.
    #
    # @return [Integer] read timeout in seconds.
    def remote_instance_read_timeout
      DEFAULT_REMOTE_INSTANCE_READ_TIMEOUT
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
      fetch_string("CHANNEL", DEFAULT_CHANNEL)
    end

    # Retrieve the default radio frequency description.
    #
    # @return [String] frequency identifier.
    def frequency
      fetch_string("FREQUENCY", DEFAULT_FREQUENCY)
    end

    # Parse the configured map centre coordinates.
    #
    # @return [Hash{Symbol=>Float}] latitude and longitude in decimal degrees.
    def map_center
      raw = fetch_string("MAP_CENTER", DEFAULT_MAP_CENTER)
      lat_str, lon_str = raw.split(",", 2).map { |part| part&.strip }.compact
      lat = Float(lat_str, exception: false)
      lon = Float(lon_str, exception: false)
      lat = DEFAULT_MAP_CENTER_LAT unless lat
      lon = DEFAULT_MAP_CENTER_LON unless lon
      { lat: lat, lon: lon }
    end

    # Map display latitude centre for the frontend map widget.
    #
    # @return [Float] latitude in decimal degrees.
    def map_center_lat
      map_center[:lat]
    end

    # Map display longitude centre for the frontend map widget.
    #
    # @return [Float] longitude in decimal degrees.
    def map_center_lon
      map_center[:lon]
    end

    # Maximum straight-line distance between nodes before relationships are
    # hidden.
    #
    # @return [Float] distance in kilometres.
    def max_distance_km
      raw = fetch_string("MAX_DISTANCE", nil)
      parsed = raw && Float(raw, exception: false)
      return parsed if parsed && parsed.positive?

      DEFAULT_MAX_DISTANCE_KM
    end

    # Contact link for community discussion.
    #
    # @return [String] contact URI or identifier.
    def contact_link
      fetch_string("CONTACT_LINK", DEFAULT_CONTACT_LINK)
    end

    # Determine the best URL to represent the configured contact link.
    #
    # @return [String, nil] absolute URL when derivable, otherwise nil.
    def contact_link_url
      link = contact_link.to_s.strip
      return nil if link.empty?

      if matrix_alias?(link)
        "https://matrix.to/#/#{link}"
      elsif link.match?(%r{\Ahttps?://}i)
        link
      else
        nil
      end
    end

    # Check whether a contact link is a Matrix room alias.
    #
    # @param link [String] candidate link string.
    # @return [Boolean] true when the link resembles a Matrix alias.
    def matrix_alias?(link)
      link.match?(/\A[#!][^\s:]+:[^\s]+\z/)
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
