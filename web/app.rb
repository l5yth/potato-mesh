# Copyright (C) 2025 l5yth
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

# Main Sinatra application exposing the Meshtastic node and message archive.
# The daemon in +data/mesh.py+ pushes updates into the SQLite database that
# this web process reads from, providing JSON APIs and a rendered HTML index
# page for human visitors.
require "sinatra"
require "json"
require "sqlite3"
require "fileutils"
require "logger"
require "rack/utils"
require "open3"
require "time"
require "prometheus/client"
require "prometheus/client/formats/text"
require "prometheus/middleware/collector"
require "prometheus/middleware/exporter"

# Path to the SQLite database used by the web application.
DB_PATH = ENV.fetch("MESH_DB", File.join(__dir__, "../data/mesh.db"))
# Default timeout applied to SQLite ``busy`` responses in milliseconds.
DB_BUSY_TIMEOUT_MS = ENV.fetch("DB_BUSY_TIMEOUT_MS", "5000").to_i
# Maximum number of SQLite ``busy`` retries before failing the request.
DB_BUSY_MAX_RETRIES = ENV.fetch("DB_BUSY_MAX_RETRIES", "5").to_i
# Base delay in seconds between SQLite ``busy`` retries.
DB_BUSY_RETRY_DELAY = ENV.fetch("DB_BUSY_RETRY_DELAY", "0.05").to_f
# Convenience constant used when filtering stale records.
WEEK_SECONDS = 7 * 24 * 60 * 60
# Default request body size allowed for JSON uploads.
DEFAULT_MAX_JSON_BODY_BYTES = 1_048_576
# Maximum request body size for JSON uploads, configurable via ``MAX_JSON_BODY_BYTES``.
MAX_JSON_BODY_BYTES = begin
    raw = ENV.fetch("MAX_JSON_BODY_BYTES", DEFAULT_MAX_JSON_BODY_BYTES.to_s)
    value = Integer(raw, 10)
    value.positive? ? value : DEFAULT_MAX_JSON_BODY_BYTES
  rescue ArgumentError
    DEFAULT_MAX_JSON_BODY_BYTES
  end
# Fallback version string used when Git metadata is unavailable.
VERSION_FALLBACK = "v0.3.0"
DEFAULT_REFRESH_INTERVAL_SECONDS = 60
REFRESH_INTERVAL_SECONDS = begin
    raw = ENV.fetch("REFRESH_INTERVAL_SECONDS", DEFAULT_REFRESH_INTERVAL_SECONDS.to_s)
    value = Integer(raw, 10)
    value.positive? ? value : DEFAULT_REFRESH_INTERVAL_SECONDS
  rescue ArgumentError
    DEFAULT_REFRESH_INTERVAL_SECONDS
  end
MAP_TILE_FILTER_LIGHT = ENV.fetch(
  "MAP_TILE_FILTER_LIGHT",
  "grayscale(1) saturate(0) brightness(0.92) contrast(1.05)"
)
MAP_TILE_FILTER_DARK = ENV.fetch(
  "MAP_TILE_FILTER_DARK",
  "grayscale(1) invert(1) brightness(0.9) contrast(1.08)"
)
PROM_REPORT_IDS = ENV.fetch("PROM_REPORT_IDS", "")

# Fetch a configuration string from environment variables.
#
# @param key [String] name of the environment variable to read.
# @param default [String] fallback value returned when the variable is unset or blank.
# @return [String] sanitized configuration value.
def fetch_config_string(key, default)
  value = ENV[key]
  return default if value.nil?

  trimmed = value.strip
  trimmed.empty? ? default : trimmed
end

# Determine the current application version using ``git describe`` when
# available.
#
# @return [String] semantic version string for display in the footer.
def determine_app_version
  repo_root = File.expand_path("..", __dir__)
  git_dir = File.join(repo_root, ".git")
  return VERSION_FALLBACK unless File.directory?(git_dir)

  stdout, status = Open3.capture2("git", "-C", repo_root, "describe", "--tags", "--long", "--abbrev=7")
  return VERSION_FALLBACK unless status.success?

  raw = stdout.strip
  return VERSION_FALLBACK if raw.empty?

  match = /\A(?<tag>.+)-(?<count>\d+)-g(?<hash>[0-9a-f]+)\z/.match(raw)
  return raw unless match

  tag = match[:tag]
  count = match[:count].to_i
  hash = match[:hash]
  return tag if count.zero?

  "#{tag}+#{count}-#{hash}"
rescue StandardError
  VERSION_FALLBACK
end

APP_VERSION = determine_app_version

set :public_folder, File.join(__dir__, "public")
set :views, File.join(__dir__, "views")

get "/favicon.ico" do
  cache_control :public, max_age: WEEK_SECONDS
  ico_path = File.join(settings.public_folder, "favicon.ico")
  if File.file?(ico_path)
    send_file ico_path, type: "image/x-icon"
  else
    send_file File.join(settings.public_folder, "potatomesh-logo.svg"), type: "image/svg+xml"
  end
end

SITE_NAME = fetch_config_string("SITE_NAME", "Meshtastic Berlin")
DEFAULT_CHANNEL = fetch_config_string("DEFAULT_CHANNEL", "#MediumFast")
DEFAULT_FREQUENCY = fetch_config_string("DEFAULT_FREQUENCY", "868MHz")
MAP_CENTER_LAT = ENV.fetch("MAP_CENTER_LAT", "52.502889").to_f
MAP_CENTER_LON = ENV.fetch("MAP_CENTER_LON", "13.404194").to_f
MAX_NODE_DISTANCE_KM = ENV.fetch("MAX_NODE_DISTANCE_KM", "137").to_f
MATRIX_ROOM = ENV.fetch("MATRIX_ROOM", "#meshtastic-berlin:matrix.org")
DEBUG = ENV["DEBUG"] == "1"

#
# Prometheus metrics
#
$prom_messages_total = Prometheus::Client::Counter.new(
  :meshtastic_messages_total,
  docstring: "Total number of messages received",
)
Prometheus::Client.registry.register($prom_messages_total)

$prom_nodes = Prometheus::Client::Gauge.new(
  :meshtastic_nodes,
  docstring: "Number of nodes seen",
)
Prometheus::Client.registry.register($prom_nodes)

$prom_node = Prometheus::Client::Gauge.new(
  :meshtastic_node,
  docstring: "Node details",
  labels: [:node, :short_name, :long_name, :hw_model, :role],
)
Prometheus::Client.registry.register($prom_node)

$prom_node_battery_level = Prometheus::Client::Gauge.new(
  :meshtastic_node_battery_level,
  docstring: "Battery level of a node",
  labels: [:node],
)
Prometheus::Client.registry.register($prom_node_battery_level)

$prom_node_voltage = Prometheus::Client::Gauge.new(
  :meshtastic_node_voltage,
  docstring: "Voltage level of a node",
  labels: [:node],
)
Prometheus::Client.registry.register($prom_node_voltage)

$prom_node_uptime = Prometheus::Client::Gauge.new(
  :meshtastic_node_uptime,
  docstring: "Uptime of a node",
  labels: [:node],
)
Prometheus::Client.registry.register($prom_node_uptime)

$prom_node_channel_utilization = Prometheus::Client::Gauge.new(
  :meshtastic_node_channel_utilization,
  docstring: "Channel utilization level of a node",
  labels: [:node],
)
Prometheus::Client.registry.register($prom_node_channel_utilization)

$prom_node_transmit_air_utilization = Prometheus::Client::Gauge.new(
  :meshtastic_node_transmit_air_utilization,
  docstring: "Air transmit utilization level of a node",
  labels: [:node],
)
Prometheus::Client.registry.register($prom_node_transmit_air_utilization)

$prom_node_latitude = Prometheus::Client::Gauge.new(
  :meshtastic_node_latitude,
  docstring: "Latitude of a node",
  labels: [:node],
)
Prometheus::Client.registry.register($prom_node_latitude)

$prom_node_longitude = Prometheus::Client::Gauge.new(
  :meshtastic_node_longitude,
  docstring: "Longitude of a node",
  labels: [:node],
)
Prometheus::Client.registry.register($prom_node_longitude)

$prom_node_altitude = Prometheus::Client::Gauge.new(
  :meshtastic_node_altitude,
  docstring: "Altitude of a node",
  labels: [:node],
)
Prometheus::Client.registry.register($prom_node_altitude)

# Log a debug message when the ``DEBUG`` environment variable is enabled.
#
# @param message [String] text written to the configured logger.
# @return [void]
def debug_log(message)
  return unless DEBUG

  logger = settings.logger if respond_to?(:settings)
  logger&.debug(message)
end

# Indicates whether the instance should hide sensitive details from visitors.
#
# @return [Boolean] true when the ``PRIVATE`` flag is set.
def private_mode?
  ENV["PRIVATE"] == "1"
end

# Convert arbitrary values into trimmed strings.
#
# @param value [Object] input value converted using ``to_s``.
# @return [String] trimmed representation of ``value``.
def sanitized_string(value)
  value.to_s.strip
end

# Return the configured site name stripped of leading and trailing whitespace.
#
# @return [String] sanitized site name used throughout the UI.
def sanitized_site_name
  sanitized_string(SITE_NAME)
end

# Return the configured default channel label.
#
# @return [String] sanitized channel label for the UI.
def sanitized_default_channel
  sanitized_string(DEFAULT_CHANNEL)
end

# Return the configured default frequency label.
#
# @return [String] sanitized frequency string.
def sanitized_default_frequency
  sanitized_string(DEFAULT_FREQUENCY)
end

# Assemble configuration exposed to the frontend JavaScript bundle.
#
# @return [Hash] settings describing refresh cadence and map defaults.
def frontend_app_config
  {
    refreshIntervalSeconds: REFRESH_INTERVAL_SECONDS,
    refreshMs: REFRESH_INTERVAL_SECONDS * 1000,
    chatEnabled: !private_mode?,
    defaultChannel: sanitized_default_channel,
    defaultFrequency: sanitized_default_frequency,
    mapCenter: { lat: MAP_CENTER_LAT, lon: MAP_CENTER_LON },
    maxNodeDistanceKm: MAX_NODE_DISTANCE_KM,
    tileFilters: {
      light: MAP_TILE_FILTER_LIGHT,
      dark: MAP_TILE_FILTER_DARK,
    },
  }
end

# Return the configured Matrix room when present.
#
# @return [String, nil] Matrix room identifier or nil when blank.
def sanitized_matrix_room
  value = sanitized_string(MATRIX_ROOM)
  value.empty? ? nil : value
end

# Coerce arbitrary values into strings or nil when blank.
#
# @param value [Object] raw value to normalize.
# @return [String, nil] string when present or nil for empty inputs.
def string_or_nil(value)
  return nil if value.nil?

  str = value.is_a?(String) ? value : value.to_s
  trimmed = str.strip
  trimmed.empty? ? nil : trimmed
end

# Convert values into integers while tolerating hexadecimal and float inputs.
#
# @param value [Object] input converted to an integer when possible.
# @return [Integer, nil] integer representation or nil when conversion fails.
def coerce_integer(value)
  case value
  when Integer
    value
  when Float
    value.finite? ? value.to_i : nil
  when Numeric
    value.to_i
  when String
    trimmed = value.strip
    return nil if trimmed.empty?
    return trimmed.to_i(16) if trimmed.match?(/\A0[xX][0-9A-Fa-f]+\z/)
    return trimmed.to_i(10) if trimmed.match?(/\A-?\d+\z/)
    begin
      float_val = Float(trimmed)
      float_val.finite? ? float_val.to_i : nil
    rescue ArgumentError
      nil
    end
  else
    nil
  end
end

# Convert values into floats while rejecting non-finite numbers.
#
# @param value [Object] input converted to a float when possible.
# @return [Float, nil] floating-point representation or nil when conversion fails.
def coerce_float(value)
  case value
  when Float
    value.finite? ? value : nil
  when Integer
    value.to_f
  when Numeric
    value.to_f
  when String
    trimmed = value.strip
    return nil if trimmed.empty?
    begin
      float_val = Float(trimmed)
      float_val.finite? ? float_val : nil
    rescue ArgumentError
      nil
    end
  else
    nil
  end
end

# Recursively normalize JSON values to ensure keys are strings.
#
# @param value [Object] array, hash, or scalar value parsed from JSON.
# @return [Object] normalized representation with string keys for hashes.
def normalize_json_value(value)
  case value
  when Hash
    value.each_with_object({}) do |(key, val), memo|
      memo[key.to_s] = normalize_json_value(val)
    end
  when Array
    value.map { |element| normalize_json_value(element) }
  else
    value
  end
end

# Parse user-supplied JSON payloads into normalized hashes.
#
# @param value [Object] JSON string or hash-like object.
# @return [Hash, nil] normalized hash or nil when parsing fails.
def normalize_json_object(value)
  case value
  when Hash
    normalize_json_value(value)
  when String
    trimmed = value.strip
    return nil if trimmed.empty?
    begin
      parsed = JSON.parse(trimmed)
    rescue JSON::ParserError
      return nil
    end
    parsed.is_a?(Hash) ? normalize_json_value(parsed) : nil
  else
    nil
  end
end

# Return the configured maximum node distance when valid.
#
# @return [Float, nil] positive distance in kilometres or nil when invalid.
def sanitized_max_distance_km
  return nil unless defined?(MAX_NODE_DISTANCE_KM)

  distance = MAX_NODE_DISTANCE_KM
  return nil unless distance.is_a?(Numeric)
  return nil unless distance.positive?

  distance
end

# Format a distance in kilometres for display.
#
# @param distance [Numeric] value expressed in kilometres.
# @return [String] distance formatted with a single decimal place.
def formatted_distance_km(distance)
  format("%.1f", distance).sub(/\.0\z/, "")
end

# Compose the meta description used by the landing page.
#
# @return [String] readable sentence summarising the instance.
def meta_description
  site = sanitized_site_name
  channel = sanitized_default_channel
  frequency = sanitized_default_frequency
  matrix = sanitized_matrix_room

  summary = "Live Meshtastic mesh map for #{site}"
  if channel.empty? && frequency.empty?
    summary += "."
  elsif channel.empty?
    summary += " tuned to #{frequency}."
  elsif frequency.empty?
    summary += " on #{channel}."
  else
    summary += " on #{channel} (#{frequency})."
  end

  activity_sentence = if private_mode?
      "Track nodes and coverage in real time."
    else
      "Track nodes, messages, and coverage in real time."
    end

  sentences = [summary, activity_sentence]
  if (distance = sanitized_max_distance_km)
    sentences << "Shows nodes within roughly #{formatted_distance_km(distance)} km of the map center."
  end
  sentences << "Join the community in #{matrix} on Matrix." if matrix

  sentences.join(" ")
end

# Return the metadata used to populate the HTML head section.
#
# @return [Hash] hash containing ``:title``, ``:name``, and ``:description`` keys.
def meta_configuration
  site = sanitized_site_name
  {
    title: site,
    name: site,
    description: meta_description,
  }
end

class << Sinatra::Application
  # Configure the logger level based on the ``DEBUG`` flag.
  #
  # @return [void]
  def apply_logger_level!
    logger = settings.logger
    return unless logger

    logger.level = DEBUG ? Logger::DEBUG : Logger::WARN
  end
end

Sinatra::Application.configure do
  app_logger = Logger.new($stdout)
  set :logger, app_logger
  use Rack::CommonLogger, app_logger
  use Rack::Deflater
  use Prometheus::Middleware::Collector
  use Prometheus::Middleware::Exporter
  Sinatra::Application.apply_logger_level!
end

# Open the SQLite database with a configured busy timeout.
#
# @param readonly [Boolean] whether to open the database in read-only mode.
# @return [SQLite3::Database]
def open_database(readonly: false)
  SQLite3::Database.new(DB_PATH, readonly: readonly).tap do |db|
    db.busy_timeout = DB_BUSY_TIMEOUT_MS
    db.execute("PRAGMA foreign_keys = ON")
  end
end

# Execute the provided block, retrying when SQLite reports the database is
# temporarily locked.
#
# @param max_retries [Integer] maximum number of retries after the initial
#   attempt.
# @param base_delay [Float] base delay in seconds for linear backoff between
#   retries.
# @yieldreturn [Object] result of the block once it succeeds.
def with_busy_retry(max_retries: DB_BUSY_MAX_RETRIES, base_delay: DB_BUSY_RETRY_DELAY)
  attempts = 0
  begin
    yield
  rescue SQLite3::BusyException
    attempts += 1
    raise if attempts > max_retries
    sleep(base_delay * attempts)
    retry
  end
end

# Checks whether the SQLite database already contains the required tables.
#
# @return [Boolean] true when both +nodes+ and +messages+ tables exist.
def db_schema_present?
  return false unless File.exist?(DB_PATH)
  db = open_database(readonly: true)
  required = %w[nodes messages positions telemetry neighbors]
  tables = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('nodes','messages','positions','telemetry','neighbors')").flatten
  (required - tables).empty?
rescue SQLite3::Exception
  false
ensure
  db&.close
end

# Create the SQLite database and seed it with the node and message schemas.
#
# @return [void]
def init_db
  FileUtils.mkdir_p(File.dirname(DB_PATH))
  db = open_database
  %w[nodes messages positions telemetry neighbors].each do |schema|
    sql_file = File.expand_path("../data/#{schema}.sql", __dir__)
    db.execute_batch(File.read(sql_file))
  end
ensure
  db&.close
end

init_db unless db_schema_present?

# Apply opportunistic schema upgrades without forcing a separate migration
# process for existing deployments.
#
# @return [void]
def ensure_schema_upgrades
  db = open_database
  node_columns = db.execute("PRAGMA table_info(nodes)").map { |row| row[1] }
  unless node_columns.include?("precision_bits")
    db.execute("ALTER TABLE nodes ADD COLUMN precision_bits INTEGER")
  end
rescue SQLite3::SQLException => e
  warn "[warn] failed to apply schema upgrade: #{e.message}"
ensure
  db&.close
end

ensure_schema_upgrades

# Retrieve recently heard nodes ordered by their last contact time.
#
# @param limit [Integer] maximum number of rows returned.
# @return [Array<Hash>] collection of node records formatted for the API.
def query_nodes(limit)
  db = open_database(readonly: true)
  db.results_as_hash = true
  now = Time.now.to_i
  min_last_heard = now - WEEK_SECONDS
  params = [min_last_heard]
  sql = <<~SQL
    SELECT node_id, short_name, long_name, hw_model, role, snr,
           battery_level, voltage, last_heard, first_heard,
           uptime_seconds, channel_utilization, air_util_tx,
           position_time, location_source, precision_bits,
           latitude, longitude, altitude
    FROM nodes
    WHERE last_heard >= ?
  SQL
  if private_mode?
    sql += "    AND (role IS NULL OR role <> 'CLIENT_HIDDEN')\n"
  end
  sql += <<~SQL
    ORDER BY last_heard DESC
    LIMIT ?
  SQL
  params << limit

  rows = db.execute(sql, params)
  rows.each do |r|
    r["role"] ||= "CLIENT"
    lh = r["last_heard"]&.to_i
    pt = r["position_time"]&.to_i
    lh = now if lh && lh > now
    pt = nil if pt && pt > now
    r["last_heard"] = lh
    r["position_time"] = pt
    r["last_seen_iso"] = Time.at(lh).utc.iso8601 if lh
    r["pos_time_iso"] = Time.at(pt).utc.iso8601 if pt
    pb = r["precision_bits"]
    r["precision_bits"] = pb.to_i if pb
  end
  rows
ensure
  db&.close
end

# GET /api/nodes
#
# Returns a JSON array of the most recently heard nodes.
get "/api/nodes" do
  content_type :json
  limit = [params["limit"]&.to_i || 200, 1000].min
  query_nodes(limit).to_json
end

# Retrieve recent text messages joined with related node information.
#
# @param limit [Integer] maximum number of rows returned.
# @return [Array<Hash>] collection of message rows suitable for serialisation.
def query_messages(limit)
  db = open_database(readonly: true)
  db.results_as_hash = true
  rows = db.execute <<~SQL, [limit]
                      SELECT m.*, n.*, m.snr AS msg_snr
                      FROM messages m
                      LEFT JOIN nodes n ON (
                        m.from_id IS NOT NULL AND TRIM(m.from_id) <> '' AND (
                          m.from_id = n.node_id OR (
                            m.from_id GLOB '[0-9]*' AND CAST(m.from_id AS INTEGER) = n.num
                          )
                        )
                      )
                      WHERE COALESCE(TRIM(m.encrypted), '') = ''
                      ORDER BY m.rx_time DESC
                      LIMIT ?
                    SQL
  msg_fields = %w[id rx_time rx_iso from_id to_id channel portnum text encrypted msg_snr rssi hop_limit]
  rows.each do |r|
    if DEBUG && (r["from_id"].nil? || r["from_id"].to_s.empty?)
      raw = db.execute("SELECT * FROM messages WHERE id = ?", [r["id"]]).first
      Kernel.warn "[debug] messages row before join: #{raw.inspect}"
      Kernel.warn "[debug] row after join: #{r.inspect}"
    end
    node = {}
    r.keys.each do |k|
      next if msg_fields.include?(k)
      node[k] = r.delete(k)
    end
    r["snr"] = r.delete("msg_snr")
    references = [r["from_id"]].compact
    if references.any? && (node["node_id"].nil? || node["node_id"].to_s.empty?)
      lookup_keys = []
      canonical = normalize_node_id(db, r["from_id"])
      lookup_keys << canonical if canonical
      raw_ref = r["from_id"].to_s.strip
      lookup_keys << raw_ref unless raw_ref.empty?
      lookup_keys << raw_ref.to_i if raw_ref.match?(/\A[0-9]+\z/)
      fallback = nil
      lookup_keys.uniq.each do |ref|
        sql = ref.is_a?(Integer) ? "SELECT * FROM nodes WHERE num = ?" : "SELECT * FROM nodes WHERE node_id = ?"
        fallback = db.get_first_row(sql, [ref])
        break if fallback
      end
      if fallback
        fallback.each do |key, value|
          next unless key.is_a?(String)
          next if msg_fields.include?(key)
          node[key] = value if node[key].nil?
        end
      end
    end
    node["role"] = "CLIENT" if node.key?("role") && (node["role"].nil? || node["role"].to_s.empty?)
    r["node"] = node

    canonical_from_id = string_or_nil(node["node_id"]) || string_or_nil(normalize_node_id(db, r["from_id"]))
    if canonical_from_id
      raw_from_id = string_or_nil(r["from_id"])
      if raw_from_id.nil? || raw_from_id.match?(/\A[0-9]+\z/)
        r["from_id"] = canonical_from_id
      elsif raw_from_id.start_with?("!") && raw_from_id.casecmp(canonical_from_id) != 0
        r["from_id"] = canonical_from_id
      end
    end
    if DEBUG && (r["from_id"].nil? || r["from_id"].to_s.empty?)
      Kernel.warn "[debug] row after processing: #{r.inspect}"
    end
  end
  rows
ensure
  db&.close
end

# Retrieve recorded position packets ordered by receive time.
#
# @param limit [Integer] maximum number of rows returned.
# @return [Array<Hash>] collection of position rows formatted for the API.
def query_positions(limit)
  db = open_database(readonly: true)
  db.results_as_hash = true
  rows = db.execute <<~SQL, [limit]
                      SELECT id, node_id, node_num, rx_time, rx_iso, position_time,
                             to_id, latitude, longitude, altitude, location_source,
                             precision_bits, sats_in_view, pdop, ground_speed,
                             ground_track, snr, rssi, hop_limit, bitfield,
                             payload_b64
                      FROM positions
                      ORDER BY rx_time DESC
                      LIMIT ?
                    SQL
  rows.each do |r|
    pt = r["position_time"]
    if pt
      begin
        r["position_time"] = Integer(pt, 10)
      rescue ArgumentError, TypeError
        r["position_time"] = coerce_integer(pt)
      end
    end
    pt_val = r["position_time"]
    r["position_time_iso"] = Time.at(pt_val).utc.iso8601 if pt_val
    pb = r["precision_bits"]
    r["precision_bits"] = pb.to_i if pb
  end
  rows
ensure
  db&.close
end

# Retrieve recent neighbour signal reports ordered by the recorded time.
#
# @param limit [Integer] maximum number of rows returned.
# @return [Array<Hash>] neighbour tuples formatted for the API response.
def query_neighbors(limit)
  db = open_database(readonly: true)
  db.results_as_hash = true
  rows = db.execute <<~SQL, [limit]
                      SELECT node_id, neighbor_id, snr, rx_time
                      FROM neighbors
                      ORDER BY rx_time DESC
                      LIMIT ?
                    SQL
  rows.each do |r|
    rx_time = coerce_integer(r["rx_time"])
    r["rx_time"] = rx_time if rx_time
    r["rx_iso"] = Time.at(rx_time).utc.iso8601 if rx_time
    r["snr"] = coerce_float(r["snr"])
  end
  rows
ensure
  db&.close
end

# Retrieve telemetry packets enriched with parsed numeric values.
#
# @param limit [Integer] maximum number of rows returned.
# @return [Array<Hash>] telemetry rows suitable for serialisation.
def query_telemetry(limit)
  db = open_database(readonly: true)
  db.results_as_hash = true
  rows = db.execute <<~SQL, [limit]
                      SELECT id, node_id, node_num, from_id, to_id, rx_time, rx_iso,
                             telemetry_time, channel, portnum, hop_limit, snr, rssi,
                             bitfield, payload_b64, battery_level, voltage,
                             channel_utilization, air_util_tx, uptime_seconds,
                             temperature, relative_humidity, barometric_pressure
                      FROM telemetry
                      ORDER BY rx_time DESC
                      LIMIT ?
                    SQL
  now = Time.now.to_i
  rows.each do |r|
    rx_time = coerce_integer(r["rx_time"])
    r["rx_time"] = rx_time if rx_time
    r["rx_iso"] = Time.at(rx_time).utc.iso8601 if rx_time && string_or_nil(r["rx_iso"]).nil?

    node_num = coerce_integer(r["node_num"])
    r["node_num"] = node_num if node_num

    telemetry_time = coerce_integer(r["telemetry_time"])
    telemetry_time = nil if telemetry_time && telemetry_time > now
    r["telemetry_time"] = telemetry_time
    r["telemetry_time_iso"] = Time.at(telemetry_time).utc.iso8601 if telemetry_time

    r["channel"] = coerce_integer(r["channel"])
    r["hop_limit"] = coerce_integer(r["hop_limit"])
    r["rssi"] = coerce_integer(r["rssi"])
    r["bitfield"] = coerce_integer(r["bitfield"])
    r["snr"] = coerce_float(r["snr"])
    r["battery_level"] = coerce_float(r["battery_level"])
    r["voltage"] = coerce_float(r["voltage"])
    r["channel_utilization"] = coerce_float(r["channel_utilization"])
    r["air_util_tx"] = coerce_float(r["air_util_tx"])
    r["uptime_seconds"] = coerce_integer(r["uptime_seconds"])
    r["temperature"] = coerce_float(r["temperature"])
    r["relative_humidity"] = coerce_float(r["relative_humidity"])
    r["barometric_pressure"] = coerce_float(r["barometric_pressure"])
  end
  rows
ensure
  db&.close
end

# GET /api/messages
#
# Returns a JSON array of stored text messages including node metadata.
get "/api/messages" do
  halt 404 if private_mode?
  content_type :json
  limit = [params["limit"]&.to_i || 200, 1000].min
  query_messages(limit).to_json
end

# GET /api/positions
#
# Returns a JSON array of recorded position packets.
get "/api/positions" do
  content_type :json
  limit = [params["limit"]&.to_i || 200, 1000].min
  query_positions(limit).to_json
end

# GET /api/neighbors
#
# Returns the most recent neighbor tuples describing mesh health.
get "/api/neighbors" do
  content_type :json
  limit = [params["limit"]&.to_i || 200, 1000].min
  query_neighbors(limit).to_json
end

# GET /api/telemetry
#
# Returns a JSON array of recorded telemetry packets.
get "/api/telemetry" do
  content_type :json
  limit = [params["limit"]&.to_i || 200, 1000].min
  query_telemetry(limit).to_json
end

# Determine the numeric node reference for a canonical node identifier.
#
# The Meshtastic protobuf encodes the node ID as a hexadecimal string prefixed
# with an exclamation mark (for example ``!4ed36bd0``).  Many payloads also
# include a decimal ``num`` alias, but some integrations omit it.  When the
# alias is missing we can reconstruct it from the canonical identifier so that
# later joins using ``nodes.num`` continue to work.
#
# @param node_id [String, nil] canonical node identifier (e.g. ``!4ed36bd0``).
# @param payload [Hash] raw node payload provided by the data daemon.
# @return [Integer, nil] numeric node reference if it can be determined.
def resolve_node_num(node_id, payload)
  raw = payload["num"]

  case raw
  when Integer
    return raw
  when Numeric
    return raw.to_i
  when String
    trimmed = raw.strip
    return nil if trimmed.empty?
    return Integer(trimmed, 10) if trimmed.match?(/\A[0-9]+\z/)
    return Integer(trimmed.delete_prefix("0x").delete_prefix("0X"), 16) if trimmed.match?(/\A0[xX][0-9A-Fa-f]+\z/)
    if trimmed.match?(/\A[0-9A-Fa-f]+\z/)
      canonical = node_id.is_a?(String) ? node_id.strip : ""
      return Integer(trimmed, 16) if canonical.match?(/\A!?[0-9A-Fa-f]+\z/)
    end
  end

  return nil unless node_id.is_a?(String)

  hex = node_id.strip
  return nil if hex.empty?
  hex = hex.delete_prefix("!")
  return nil unless hex.match?(/\A[0-9A-Fa-f]+\z/)

  Integer(hex, 16)
rescue ArgumentError
  nil
end

# Determine canonical node identifiers and derived metadata for a reference.
#
# @param node_ref [Object] raw node identifier or numeric reference.
# @param fallback_num [Object] optional numeric reference used when the
#   identifier does not encode the value directly.
# @return [Array(String, Integer, String), nil] tuple containing the canonical
#   node ID, numeric node reference, and uppercase short identifier suffix when
#   the reference can be parsed. Returns nil when the reference cannot be
#   converted into a canonical ID.
def canonical_node_parts(node_ref, fallback_num = nil)
  fallback = coerce_integer(fallback_num)

  hex = nil
  num = nil

  case node_ref
  when Integer
    num = node_ref
  when Numeric
    num = node_ref.to_i
  when String
    trimmed = node_ref.strip
    return nil if trimmed.empty?

    if trimmed.start_with?("!")
      hex = trimmed.delete_prefix("!")
    elsif trimmed.match?(/\A0[xX][0-9A-Fa-f]+\z/)
      hex = trimmed[2..].to_s
    elsif trimmed.match?(/\A-?\d+\z/)
      num = trimmed.to_i
    elsif trimmed.match?(/\A[0-9A-Fa-f]+\z/)
      hex = trimmed
    else
      return nil
    end
  when nil
    num = fallback if fallback
  else
    return nil
  end

  num ||= fallback if fallback

  if hex
    begin
      num ||= Integer(hex, 16)
    rescue ArgumentError
      return nil
    end
  elsif num
    return nil if num.negative?
    hex = format("%08x", num & 0xFFFFFFFF)
  else
    return nil
  end

  return nil if hex.nil? || hex.empty?

  begin
    parsed = Integer(hex, 16)
  rescue ArgumentError
    return nil
  end

  parsed &= 0xFFFFFFFF
  canonical_hex = format("%08x", parsed)
  short_id = canonical_hex[-4, 4].upcase

  ["!#{canonical_hex}", parsed, short_id]
end

# Ensure a placeholder node entry exists for the provided identifier.
#
# Messages and telemetry can reference nodes before the daemon has received a
# full node snapshot. When this happens we create a minimal hidden entry so the
# sender can be resolved in the UI until richer metadata becomes available.
#
# @param db [SQLite3::Database] open database handle.
# @param node_ref [Object] raw identifier extracted from the payload.
# @param fallback_num [Object] optional numeric reference used when the
#   identifier is missing.
def ensure_unknown_node(db, node_ref, fallback_num = nil, heard_time: nil)
  parts = canonical_node_parts(node_ref, fallback_num)
  return unless parts

  node_id, node_num, short_id = parts

  existing = db.get_first_value(
    "SELECT 1 FROM nodes WHERE node_id = ? LIMIT 1",
    [node_id],
  )
  return if existing

  long_name = "Meshtastic #{short_id}"
  heard_time = coerce_integer(heard_time)
  inserted = false

  with_busy_retry do
    db.execute(
      <<~SQL,
      INSERT OR IGNORE INTO nodes(node_id,num,short_name,long_name,role,last_heard,first_heard)
      VALUES (?,?,?,?,?,?,?)
    SQL
      [node_id, node_num, short_id, long_name, "CLIENT_HIDDEN", heard_time, heard_time],
    )
    inserted = db.changes.positive?
  end

  if inserted
    debug_log(
      "ensure_unknown_node created hidden node_id=#{node_id} from=#{node_ref.inspect} " \
      "fallback=#{fallback_num.inspect} heard_time=#{heard_time.inspect}"
    )
  end

  inserted
end

# Ensure the node's last_seen timestamp reflects the provided receive time.
#
# @param db [SQLite3::Database] open database handle.
# @param node_ref [Object] raw identifier used to resolve the node.
# @param fallback_num [Object] optional numeric identifier.
# @param rx_time [Object] receive timestamp that should update the node.
def touch_node_last_seen(db, node_ref, fallback_num = nil, rx_time: nil, source: nil)
  timestamp = coerce_integer(rx_time)
  return unless timestamp

  node_id = nil

  parts = canonical_node_parts(node_ref, fallback_num)
  node_id, = parts if parts

  unless node_id
    trimmed = string_or_nil(node_ref)
    if trimmed
      node_id = normalize_node_id(db, trimmed) || trimmed
    elsif fallback_num
      fallback_parts = canonical_node_parts(fallback_num, nil)
      node_id, = fallback_parts if fallback_parts
    end
  end

  return unless node_id

  updated = false
  with_busy_retry do
    db.execute <<~SQL, [timestamp, timestamp, timestamp, node_id]
                 UPDATE nodes
                    SET last_heard = CASE
                      WHEN COALESCE(last_heard, 0) >= ? THEN last_heard
                      ELSE ?
                    END,
                        first_heard = COALESCE(first_heard, ?)
                  WHERE node_id = ?
               SQL
    updated ||= db.changes.positive?
  end

  if updated
    debug_log(
      "touch_node_last_seen updated last_heard node_id=#{node_id} timestamp=#{timestamp} " \
      "source=#{(source || :unknown).inspect}"
    )
  end

  updated
end

# Insert or update a node row with the most recent metrics.
#
# @param db [SQLite3::Database] open database handle.
# @param node_id [String] primary identifier for the node.
# @param n [Hash] node payload provided by the data daemon.
def upsert_node(db, node_id, n)
  user = n["user"] || {}
  met = n["deviceMetrics"] || {}
  pos = n["position"] || {}
  role = user["role"] || "CLIENT"
  lh = coerce_integer(n["lastHeard"])
  pt = coerce_integer(pos["time"])
  now = Time.now.to_i
  pt = nil if pt && pt > now
  lh = now if lh && lh > now
  lh = pt if pt && (!lh || lh < pt)
  lh ||= now
  bool = ->(v) {
    case v
    when true then 1
    when false then 0
    else v
    end
  }
  node_num = resolve_node_num(node_id, n)

  if !PROM_REPORT_IDS.empty? && node_id
    report_ids = PROM_REPORT_IDS.split(",").map(&:strip).reject(&:empty?)

    if PROM_REPORT_IDS == "*" || report_ids.include?(node_id)
      $prom_node.set(
        1,
        labels: {
          node: node_id,
          short_name: user["shortName"],
          long_name: user["longName"],
          hw_model: user["hwModel"] || n["hwModel"],
          role: role,
        },
      )

      if met["batteryLevel"]
        $prom_node_battery_level.set(met["batteryLevel"], labels: { node: node_id })
      end

      if met["voltage"]
        $prom_node_voltage.set(met["voltage"], labels: { node: node_id })
      end

      if met["uptimeSeconds"]
        $prom_node_uptime.set(met["uptimeSeconds"], labels: { node: node_id })
      end

      if met["channelUtilization"]
        $prom_node_channel_utilization.set(met["channelUtilization"], labels: { node: node_id })
      end

      if met["airUtilTx"]
        $prom_node_transmit_air_utilization.set(met["airUtilTx"], labels: { node: node_id })
      end

      if pos["latitude"]
        $prom_node_latitude.set(pos["latitude"], labels: { node: node_id })
      end

      if pos["longitude"]
        $prom_node_longitude.set(pos["longitude"], labels: { node: node_id })
      end

      if pos["altitude"]
        $prom_node_altitude.set(pos["altitude"], labels: { node: node_id })
      end
    end
  end

  row = [
    node_id,
    node_num,
    user["shortName"],
    user["longName"],
    user["macaddr"],
    user["hwModel"] || n["hwModel"],
    role,
    user["publicKey"],
    bool.call(user["isUnmessagable"]),
    bool.call(n["isFavorite"]),
    n["hopsAway"],
    n["snr"],
    lh,
    lh,
    met["batteryLevel"],
    met["voltage"],
    met["channelUtilization"],
    met["airUtilTx"],
    met["uptimeSeconds"],
    pt,
    pos["locationSource"],
    coerce_integer(
      pos["precisionBits"] ||
      pos["precision_bits"] ||
      pos.dig("raw", "precision_bits"),
    ),
    pos["latitude"],
    pos["longitude"],
    pos["altitude"],
  ]
  with_busy_retry do
    db.execute <<~SQL, row
                 INSERT INTO nodes(node_id,num,short_name,long_name,macaddr,hw_model,role,public_key,is_unmessagable,is_favorite,
                                   hops_away,snr,last_heard,first_heard,battery_level,voltage,channel_utilization,air_util_tx,uptime_seconds,
                                   position_time,location_source,precision_bits,latitude,longitude,altitude)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(node_id) DO UPDATE SET
                   num=excluded.num, short_name=excluded.short_name, long_name=excluded.long_name, macaddr=excluded.macaddr,
                   hw_model=excluded.hw_model, role=excluded.role, public_key=excluded.public_key, is_unmessagable=excluded.is_unmessagable,
                   is_favorite=excluded.is_favorite, hops_away=excluded.hops_away, snr=excluded.snr, last_heard=excluded.last_heard,
                   first_heard=COALESCE(nodes.first_heard, excluded.first_heard, excluded.last_heard),
                   battery_level=excluded.battery_level, voltage=excluded.voltage, channel_utilization=excluded.channel_utilization,
                   air_util_tx=excluded.air_util_tx, uptime_seconds=excluded.uptime_seconds, position_time=excluded.position_time,
                   location_source=excluded.location_source, precision_bits=excluded.precision_bits, latitude=excluded.latitude, longitude=excluded.longitude,
                   altitude=excluded.altitude
                 WHERE COALESCE(excluded.last_heard,0) >= COALESCE(nodes.last_heard,0)
               SQL
  end
end

# Ensure the request includes the expected bearer token.
#
# @return [void]
# @raise [Sinatra::Halt] when authentication fails.
def require_token!
  token = ENV["API_TOKEN"]
  provided = request.env["HTTP_AUTHORIZATION"].to_s.sub(/^Bearer\s+/i, "")
  halt 403, { error: "Forbidden" }.to_json unless token && !token.empty? && secure_token_match?(token, provided)
end

# Perform a constant-time comparison between two strings, returning false on
# length mismatches or invalid input.
#
# @param expected [String]
# @param provided [String]
# @return [Boolean]
def secure_token_match?(expected, provided)
  return false unless expected.is_a?(String) && provided.is_a?(String)

  expected_bytes = expected.b
  provided_bytes = provided.b
  return false unless expected_bytes.bytesize == provided_bytes.bytesize
  Rack::Utils.secure_compare(expected_bytes, provided_bytes)
rescue Rack::Utils::SecurityError
  false
end

# Read the request body enforcing a maximum allowed size.
#
# @param limit [Integer, nil] optional override for the number of bytes.
# @return [String]
def read_json_body(limit: nil)
  max_bytes = limit || MAX_JSON_BODY_BYTES
  max_bytes = max_bytes.to_i
  max_bytes = MAX_JSON_BODY_BYTES if max_bytes <= 0

  body = request.body.read(max_bytes + 1)
  body = "" if body.nil?
  halt 413, { error: "payload too large" }.to_json if body.bytesize > max_bytes

  body
ensure
  request.body.rewind if request.body.respond_to?(:rewind)
end

# Determine whether the canonical node identifier should replace the provided
# sender reference for a message payload.
#
# @param message [Object] raw request payload element.
# @return [Boolean]
def prefer_canonical_sender?(message)
  message.is_a?(Hash) && message.key?("packet_id") && !message.key?("id")
end

# Update or create a node entry using information from a position payload.
#
# @param db [SQLite3::Database] open database handle.
# @param node_id [String, nil] canonical node identifier when available.
# @param node_num [Integer, nil] numeric node reference if known.
# @param rx_time [Integer] time the packet was received by the gateway.
# @param position_time [Integer, nil] timestamp reported by the device.
# @param location_source [String, nil] location source flag from the packet.
# @param latitude [Float, nil] reported latitude.
# @param longitude [Float, nil] reported longitude.
# @param altitude [Float, nil] reported altitude.
# @param precision_bits [Integer, nil] precision estimate provided by the device.
# @param snr [Float, nil] link SNR for the packet.
def update_node_from_position(db, node_id, node_num, rx_time, position_time, location_source, precision_bits, latitude, longitude, altitude, snr)
  num = coerce_integer(node_num)
  id = string_or_nil(node_id)
  if id&.start_with?("!")
    id = "!#{id.delete_prefix("!").downcase}"
  end
  id ||= format("!%08x", num & 0xFFFFFFFF) if num
  return unless id

  now = Time.now.to_i
  rx = coerce_integer(rx_time) || now
  rx = now if rx && rx > now
  pos_time = coerce_integer(position_time)
  pos_time = nil if pos_time && pos_time > now
  last_heard = [rx, pos_time].compact.max || rx
  last_heard = now if last_heard && last_heard > now

  loc = string_or_nil(location_source)
  lat = coerce_float(latitude)
  lon = coerce_float(longitude)
  alt = coerce_float(altitude)
  precision = coerce_integer(precision_bits)
  snr_val = coerce_float(snr)

  row = [
    id,
    num,
    last_heard,
    last_heard,
    pos_time,
    loc,
    precision,
    lat,
    lon,
    alt,
    snr_val,
  ]
  with_busy_retry do
    db.execute <<~SQL, row
                 INSERT INTO nodes(node_id,num,last_heard,first_heard,position_time,location_source,precision_bits,latitude,longitude,altitude,snr)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(node_id) DO UPDATE SET
                   num=COALESCE(excluded.num,nodes.num),
                   snr=COALESCE(excluded.snr,nodes.snr),
                   last_heard=MAX(COALESCE(nodes.last_heard,0),COALESCE(excluded.last_heard,0)),
                   first_heard=COALESCE(nodes.first_heard, excluded.first_heard, excluded.last_heard),
                   position_time=CASE
                     WHEN COALESCE(excluded.position_time,0) >= COALESCE(nodes.position_time,0)
                       THEN excluded.position_time
                     ELSE nodes.position_time
                   END,
                   location_source=CASE
                     WHEN COALESCE(excluded.position_time,0) >= COALESCE(nodes.position_time,0)
                          AND excluded.location_source IS NOT NULL
                       THEN excluded.location_source
                     ELSE nodes.location_source
                   END,
                   precision_bits=CASE
                     WHEN COALESCE(excluded.position_time,0) >= COALESCE(nodes.position_time,0)
                          AND excluded.precision_bits IS NOT NULL
                       THEN excluded.precision_bits
                     ELSE nodes.precision_bits
                   END,
                   latitude=CASE
                     WHEN COALESCE(excluded.position_time,0) >= COALESCE(nodes.position_time,0)
                          AND excluded.latitude IS NOT NULL
                       THEN excluded.latitude
                     ELSE nodes.latitude
                   END,
                   longitude=CASE
                     WHEN COALESCE(excluded.position_time,0) >= COALESCE(nodes.position_time,0)
                          AND excluded.longitude IS NOT NULL
                       THEN excluded.longitude
                     ELSE nodes.longitude
                   END,
                   altitude=CASE
                     WHEN COALESCE(excluded.position_time,0) >= COALESCE(nodes.position_time,0)
                          AND excluded.altitude IS NOT NULL
                       THEN excluded.altitude
                     ELSE nodes.altitude
                   END
               SQL
  end
end

# Insert a position packet into the history table and refresh node metadata.
#
# @param db [SQLite3::Database] open database handle.
# @param payload [Hash] position payload provided by the data daemon.
def insert_position(db, payload)
  pos_id = coerce_integer(payload["id"] || payload["packet_id"])
  return unless pos_id

  now = Time.now.to_i
  rx_time = coerce_integer(payload["rx_time"])
  rx_time = now if rx_time.nil? || rx_time > now
  rx_iso = string_or_nil(payload["rx_iso"])
  rx_iso ||= Time.at(rx_time).utc.iso8601

  raw_node_id = payload["node_id"] || payload["from_id"] || payload["from"]
  node_id = string_or_nil(raw_node_id)
  node_id = "!#{node_id.delete_prefix("!").downcase}" if node_id&.start_with?("!")
  raw_node_num = coerce_integer(payload["node_num"]) || coerce_integer(payload["num"])
  node_id ||= format("!%08x", raw_node_num & 0xFFFFFFFF) if node_id.nil? && raw_node_num

  payload_for_num = payload.is_a?(Hash) ? payload.dup : {}
  payload_for_num["num"] ||= raw_node_num if raw_node_num
  node_num = resolve_node_num(node_id, payload_for_num)
  node_num ||= raw_node_num
  canonical = normalize_node_id(db, node_id || node_num)
  node_id = canonical if canonical

  ensure_unknown_node(db, node_id || node_num, node_num, heard_time: rx_time)
  touch_node_last_seen(db, node_id || node_num, node_num, rx_time: rx_time, source: :position)

  to_id = string_or_nil(payload["to_id"] || payload["to"])

  position_section = payload["position"].is_a?(Hash) ? payload["position"] : {}

  lat = coerce_float(payload["latitude"]) || coerce_float(position_section["latitude"])
  lon = coerce_float(payload["longitude"]) || coerce_float(position_section["longitude"])
  alt = coerce_float(payload["altitude"]) || coerce_float(position_section["altitude"])

  lat ||= begin
      lat_i = coerce_integer(position_section["latitudeI"] || position_section["latitude_i"] || position_section.dig("raw", "latitude_i"))
      lat_i ? lat_i / 1e7 : nil
    end
  lon ||= begin
      lon_i = coerce_integer(position_section["longitudeI"] || position_section["longitude_i"] || position_section.dig("raw", "longitude_i"))
      lon_i ? lon_i / 1e7 : nil
    end
  alt ||= coerce_float(position_section.dig("raw", "altitude"))

  position_time = coerce_integer(
    payload["position_time"] ||
    position_section["time"] ||
    position_section.dig("raw", "time"),
  )

  location_source = string_or_nil(
    payload["location_source"] ||
    payload["locationSource"] ||
    position_section["location_source"] ||
    position_section["locationSource"] ||
    position_section.dig("raw", "location_source"),
  )

  precision_bits = coerce_integer(
    payload["precision_bits"] ||
    payload["precisionBits"] ||
    position_section["precision_bits"] ||
    position_section["precisionBits"] ||
    position_section.dig("raw", "precision_bits"),
  )

  sats_in_view = coerce_integer(
    payload["sats_in_view"] ||
    payload["satsInView"] ||
    position_section["sats_in_view"] ||
    position_section["satsInView"] ||
    position_section.dig("raw", "sats_in_view"),
  )

  pdop = coerce_float(
    payload["pdop"] ||
    payload["PDOP"] ||
    position_section["pdop"] ||
    position_section["PDOP"] ||
    position_section.dig("raw", "PDOP") ||
    position_section.dig("raw", "pdop"),
  )

  ground_speed = coerce_float(
    payload["ground_speed"] ||
    payload["groundSpeed"] ||
    position_section["ground_speed"] ||
    position_section["groundSpeed"] ||
    position_section.dig("raw", "ground_speed"),
  )

  ground_track = coerce_float(
    payload["ground_track"] ||
    payload["groundTrack"] ||
    position_section["ground_track"] ||
    position_section["groundTrack"] ||
    position_section.dig("raw", "ground_track"),
  )

  snr = coerce_float(payload["snr"] || payload["rx_snr"] || payload["rxSnr"])
  rssi = coerce_integer(payload["rssi"] || payload["rx_rssi"] || payload["rxRssi"])
  hop_limit = coerce_integer(payload["hop_limit"] || payload["hopLimit"])
  bitfield = coerce_integer(payload["bitfield"])

  payload_b64 = string_or_nil(payload["payload_b64"] || payload["payload"])
  payload_b64 ||= string_or_nil(position_section.dig("payload", "__bytes_b64__"))

  row = [
    pos_id,
    node_id,
    node_num,
    rx_time,
    rx_iso,
    position_time,
    to_id,
    lat,
    lon,
    alt,
    location_source,
    precision_bits,
    sats_in_view,
    pdop,
    ground_speed,
    ground_track,
    snr,
    rssi,
    hop_limit,
    bitfield,
    payload_b64,
  ]

  with_busy_retry do
    db.execute <<~SQL, row
                 INSERT INTO positions(id,node_id,node_num,rx_time,rx_iso,position_time,to_id,latitude,longitude,altitude,location_source,
                                       precision_bits,sats_in_view,pdop,ground_speed,ground_track,snr,rssi,hop_limit,bitfield,payload_b64)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(id) DO UPDATE SET
                   node_id=COALESCE(excluded.node_id,positions.node_id),
                   node_num=COALESCE(excluded.node_num,positions.node_num),
                   rx_time=excluded.rx_time,
                   rx_iso=excluded.rx_iso,
                   position_time=COALESCE(excluded.position_time,positions.position_time),
                   to_id=COALESCE(excluded.to_id,positions.to_id),
                   latitude=COALESCE(excluded.latitude,positions.latitude),
                   longitude=COALESCE(excluded.longitude,positions.longitude),
                   altitude=COALESCE(excluded.altitude,positions.altitude),
                   location_source=COALESCE(excluded.location_source,positions.location_source),
                   precision_bits=COALESCE(excluded.precision_bits,positions.precision_bits),
                   sats_in_view=COALESCE(excluded.sats_in_view,positions.sats_in_view),
                   pdop=COALESCE(excluded.pdop,positions.pdop),
                   ground_speed=COALESCE(excluded.ground_speed,positions.ground_speed),
                   ground_track=COALESCE(excluded.ground_track,positions.ground_track),
                   snr=COALESCE(excluded.snr,positions.snr),
                   rssi=COALESCE(excluded.rssi,positions.rssi),
                   hop_limit=COALESCE(excluded.hop_limit,positions.hop_limit),
                   bitfield=COALESCE(excluded.bitfield,positions.bitfield),
                   payload_b64=COALESCE(excluded.payload_b64,positions.payload_b64)
               SQL
  end

  update_node_from_position(
    db,
    node_id,
    node_num,
    rx_time,
    position_time,
    location_source,
    precision_bits,
    lat,
    lon,
    alt,
    snr,
  )
end

# Ingest neighbour relationship data for a node and refresh cached records.
#
# @param db [SQLite3::Database] open database handle.
# @param payload [Hash] neighbour payload provided by the data daemon.
# @return [void]
def insert_neighbors(db, payload)
  return unless payload.is_a?(Hash)

  now = Time.now.to_i
  rx_time = coerce_integer(payload["rx_time"])
  rx_time = now if rx_time.nil? || rx_time > now

  raw_node_id = payload["node_id"] || payload["node"] || payload["from_id"]
  raw_node_num = coerce_integer(payload["node_num"]) || coerce_integer(payload["num"])

  canonical_parts = canonical_node_parts(raw_node_id, raw_node_num)
  if canonical_parts
    node_id, node_num, = canonical_parts
  else
    node_id = string_or_nil(raw_node_id)
    canonical = normalize_node_id(db, node_id || raw_node_num)
    node_id = canonical if canonical
    if node_id&.start_with?("!") && raw_node_num.nil?
      begin
        node_num = Integer(node_id.delete_prefix("!"), 16)
      rescue ArgumentError
        node_num = nil
      end
    else
      node_num = raw_node_num
    end
  end

  return unless node_id

  node_id = "!#{node_id.delete_prefix("!").downcase}" if node_id.start_with?("!")

  ensure_unknown_node(db, node_id || node_num, node_num, heard_time: rx_time)
  touch_node_last_seen(db, node_id || node_num, node_num, rx_time: rx_time, source: :neighborinfo)

  neighbor_entries = []
  neighbors_payload = payload["neighbors"]
  neighbors_list = neighbors_payload.is_a?(Array) ? neighbors_payload : []

  neighbors_list.each do |neighbor|
    next unless neighbor.is_a?(Hash)

    neighbor_ref = neighbor["neighbor_id"] || neighbor["node_id"] || neighbor["nodeId"] || neighbor["id"]
    neighbor_num = coerce_integer(
      neighbor["neighbor_num"] || neighbor["node_num"] || neighbor["nodeId"] || neighbor["id"],
    )

    canonical_neighbor = canonical_node_parts(neighbor_ref, neighbor_num)
    if canonical_neighbor
      neighbor_id, neighbor_num, = canonical_neighbor
    else
      neighbor_id = string_or_nil(neighbor_ref)
      canonical_neighbor_id = normalize_node_id(db, neighbor_id || neighbor_num)
      neighbor_id = canonical_neighbor_id if canonical_neighbor_id
      if neighbor_id&.start_with?("!") && neighbor_num.nil?
        begin
          neighbor_num = Integer(neighbor_id.delete_prefix("!"), 16)
        rescue ArgumentError
          neighbor_num = nil
        end
      end
    end

    next unless neighbor_id

    neighbor_id = "!#{neighbor_id.delete_prefix("!").downcase}" if neighbor_id.start_with?("!")

    entry_rx_time = coerce_integer(neighbor["rx_time"]) || rx_time
    entry_rx_time = now if entry_rx_time && entry_rx_time > now
    snr = coerce_float(neighbor["snr"])

    ensure_unknown_node(db, neighbor_id || neighbor_num, neighbor_num, heard_time: entry_rx_time)
    touch_node_last_seen(db, neighbor_id || neighbor_num, neighbor_num, rx_time: entry_rx_time, source: :neighborinfo)

    neighbor_entries << [neighbor_id, snr, entry_rx_time]
  end

  with_busy_retry do
    db.transaction do
      db.execute("DELETE FROM neighbors WHERE node_id = ?", [node_id])
      neighbor_entries.each do |neighbor_id, snr, heard_time|
        db.execute(
          <<~SQL,
          INSERT OR REPLACE INTO neighbors(node_id, neighbor_id, snr, rx_time)
          VALUES (?, ?, ?, ?)
        SQL
          [node_id, neighbor_id, snr, heard_time],
        )
      end
    end
  end
end

# Update cached node metrics using the provided telemetry readings.
#
# @param db [SQLite3::Database] open database handle.
# @param node_id [String, nil] canonical node identifier when available.
# @param node_num [Integer, nil] numeric node reference.
# @param rx_time [Integer, nil] last receive timestamp associated with the telemetry.
# @param metrics [Hash] telemetry metrics extracted from the payload.
# @return [void]
def update_node_from_telemetry(db, node_id, node_num, rx_time, metrics = {})
  num = coerce_integer(node_num)
  id = string_or_nil(node_id)
  if id&.start_with?("!")
    id = "!#{id.delete_prefix("!").downcase}"
  end
  id ||= format("!%08x", num & 0xFFFFFFFF) if num
  return unless id

  ensure_unknown_node(db, id, num, heard_time: rx_time)
  touch_node_last_seen(db, id, num, rx_time: rx_time, source: :telemetry)

  battery = coerce_float(metrics[:battery_level] || metrics["battery_level"])
  voltage = coerce_float(metrics[:voltage] || metrics["voltage"])
  channel_util = coerce_float(metrics[:channel_utilization] || metrics["channel_utilization"])
  air_util_tx = coerce_float(metrics[:air_util_tx] || metrics["air_util_tx"])
  uptime = coerce_integer(metrics[:uptime_seconds] || metrics["uptime_seconds"])

  assignments = []
  params = []

  if num
    assignments << "num = ?"
    params << num
  end

  metric_updates = {
    "battery_level" => battery,
    "voltage" => voltage,
    "channel_utilization" => channel_util,
    "air_util_tx" => air_util_tx,
    "uptime_seconds" => uptime,
  }

  metric_updates.each do |column, value|
    next if value.nil?

    assignments << "#{column} = ?"
    params << value
  end

  return if assignments.empty?

  assignments_sql = assignments.join(", ")
  params << id

  with_busy_retry do
    db.execute("UPDATE nodes SET #{assignments_sql} WHERE node_id = ?", params)
  end
end

# Insert or update a telemetry packet and propagate relevant metrics to the node.
#
# @param db [SQLite3::Database] open database handle.
# @param payload [Hash] telemetry payload provided by the data daemon.
# @return [void]
def insert_telemetry(db, payload)
  return unless payload.is_a?(Hash)

  telemetry_id = coerce_integer(payload["id"] || payload["packet_id"])
  return unless telemetry_id

  now = Time.now.to_i
  rx_time = coerce_integer(payload["rx_time"])
  rx_time = now if rx_time.nil? || rx_time > now
  rx_iso = string_or_nil(payload["rx_iso"])
  rx_iso ||= Time.at(rx_time).utc.iso8601

  raw_node_id = payload["node_id"] || payload["from_id"] || payload["from"]
  node_id = string_or_nil(raw_node_id)
  node_id = "!#{node_id.delete_prefix("!").downcase}" if node_id&.start_with?("!")
  raw_node_num = coerce_integer(payload["node_num"]) || coerce_integer(payload["num"])

  payload_for_num = payload.dup
  payload_for_num["num"] ||= raw_node_num if raw_node_num
  node_num = resolve_node_num(node_id, payload_for_num)
  node_num ||= raw_node_num

  canonical = normalize_node_id(db, node_id || node_num)
  node_id = canonical if canonical

  from_id = string_or_nil(payload["from_id"]) || node_id
  to_id = string_or_nil(payload["to_id"] || payload["to"])

  telemetry_time = coerce_integer(payload["telemetry_time"] || payload["time"] || payload.dig("telemetry", "time"))
  telemetry_time = nil if telemetry_time && telemetry_time > now

  channel = coerce_integer(payload["channel"])
  portnum = string_or_nil(payload["portnum"])
  hop_limit = coerce_integer(payload["hop_limit"] || payload["hopLimit"])
  snr = coerce_float(payload["snr"])
  rssi = coerce_integer(payload["rssi"])
  bitfield = coerce_integer(payload["bitfield"])
  payload_b64 = string_or_nil(payload["payload_b64"] || payload["payload"])

  telemetry_section = normalize_json_object(payload["telemetry"])
  device_metrics = normalize_json_object(payload["device_metrics"] || payload["deviceMetrics"])
  device_metrics ||= normalize_json_object(telemetry_section["deviceMetrics"]) if telemetry_section&.key?("deviceMetrics")
  environment_metrics = normalize_json_object(payload["environment_metrics"] || payload["environmentMetrics"])
  environment_metrics ||= normalize_json_object(telemetry_section["environmentMetrics"]) if telemetry_section&.key?("environmentMetrics")

  fetch_metric = lambda do |map, *names|
    next nil unless map.is_a?(Hash)
    names.each do |name|
      next unless name
      key = name.to_s
      return map[key] if map.key?(key)
    end
    nil
  end

  battery_level = payload.key?("battery_level") ? payload["battery_level"] : nil
  battery_level = coerce_float(battery_level)
  battery_level ||= coerce_float(fetch_metric.call(device_metrics, :battery_level, :batteryLevel))

  voltage = payload.key?("voltage") ? payload["voltage"] : nil
  voltage = coerce_float(voltage)
  voltage ||= coerce_float(fetch_metric.call(device_metrics, :voltage))

  channel_utilization = payload.key?("channel_utilization") ? payload["channel_utilization"] : nil
  channel_utilization ||= payload["channelUtilization"] if payload.key?("channelUtilization")
  channel_utilization = coerce_float(channel_utilization)
  channel_utilization ||= coerce_float(fetch_metric.call(device_metrics, :channel_utilization, :channelUtilization))

  air_util_tx = payload.key?("air_util_tx") ? payload["air_util_tx"] : nil
  air_util_tx ||= payload["airUtilTx"] if payload.key?("airUtilTx")
  air_util_tx = coerce_float(air_util_tx)
  air_util_tx ||= coerce_float(fetch_metric.call(device_metrics, :air_util_tx, :airUtilTx))

  uptime_seconds = payload.key?("uptime_seconds") ? payload["uptime_seconds"] : nil
  uptime_seconds ||= payload["uptimeSeconds"] if payload.key?("uptimeSeconds")
  uptime_seconds = coerce_integer(uptime_seconds)
  uptime_seconds ||= coerce_integer(fetch_metric.call(device_metrics, :uptime_seconds, :uptimeSeconds))

  temperature = payload.key?("temperature") ? payload["temperature"] : nil
  temperature = coerce_float(temperature)
  temperature ||= coerce_float(fetch_metric.call(environment_metrics, :temperature, :temperatureC, :temperature_c, :tempC))

  relative_humidity = payload.key?("relative_humidity") ? payload["relative_humidity"] : nil
  relative_humidity ||= payload["relativeHumidity"] if payload.key?("relativeHumidity")
  relative_humidity ||= payload["humidity"] if payload.key?("humidity")
  relative_humidity = coerce_float(relative_humidity)
  relative_humidity ||= coerce_float(fetch_metric.call(environment_metrics, :relative_humidity, :relativeHumidity, :humidity))

  barometric_pressure = payload.key?("barometric_pressure") ? payload["barometric_pressure"] : nil
  barometric_pressure ||= payload["barometricPressure"] if payload.key?("barometricPressure")
  barometric_pressure ||= payload["pressure"] if payload.key?("pressure")
  barometric_pressure = coerce_float(barometric_pressure)
  barometric_pressure ||= coerce_float(fetch_metric.call(environment_metrics, :barometric_pressure, :barometricPressure, :pressure))

  row = [
    telemetry_id,
    node_id,
    node_num,
    from_id,
    to_id,
    rx_time,
    rx_iso,
    telemetry_time,
    channel,
    portnum,
    hop_limit,
    snr,
    rssi,
    bitfield,
    payload_b64,
    battery_level,
    voltage,
    channel_utilization,
    air_util_tx,
    uptime_seconds,
    temperature,
    relative_humidity,
    barometric_pressure,
  ]

  with_busy_retry do
    db.execute <<~SQL, row
                 INSERT INTO telemetry(id,node_id,node_num,from_id,to_id,rx_time,rx_iso,telemetry_time,channel,portnum,hop_limit,snr,rssi,bitfield,payload_b64,
                                       battery_level,voltage,channel_utilization,air_util_tx,uptime_seconds,temperature,relative_humidity,barometric_pressure)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(id) DO UPDATE SET
                   node_id=COALESCE(excluded.node_id,telemetry.node_id),
                   node_num=COALESCE(excluded.node_num,telemetry.node_num),
                   from_id=COALESCE(excluded.from_id,telemetry.from_id),
                   to_id=COALESCE(excluded.to_id,telemetry.to_id),
                   rx_time=excluded.rx_time,
                   rx_iso=excluded.rx_iso,
                   telemetry_time=COALESCE(excluded.telemetry_time,telemetry.telemetry_time),
                   channel=COALESCE(excluded.channel,telemetry.channel),
                   portnum=COALESCE(excluded.portnum,telemetry.portnum),
                   hop_limit=COALESCE(excluded.hop_limit,telemetry.hop_limit),
                   snr=COALESCE(excluded.snr,telemetry.snr),
                   rssi=COALESCE(excluded.rssi,telemetry.rssi),
                   bitfield=COALESCE(excluded.bitfield,telemetry.bitfield),
                   payload_b64=COALESCE(excluded.payload_b64,telemetry.payload_b64),
                   battery_level=COALESCE(excluded.battery_level,telemetry.battery_level),
                   voltage=COALESCE(excluded.voltage,telemetry.voltage),
                   channel_utilization=COALESCE(excluded.channel_utilization,telemetry.channel_utilization),
                   air_util_tx=COALESCE(excluded.air_util_tx,telemetry.air_util_tx),
                   uptime_seconds=COALESCE(excluded.uptime_seconds,telemetry.uptime_seconds),
                   temperature=COALESCE(excluded.temperature,telemetry.temperature),
                   relative_humidity=COALESCE(excluded.relative_humidity,telemetry.relative_humidity),
                   barometric_pressure=COALESCE(excluded.barometric_pressure,telemetry.barometric_pressure)
               SQL
  end

  update_node_from_telemetry(
    db,
    node_id || from_id,
    node_num,
    rx_time,
    battery_level: battery_level,
    voltage: voltage,
    channel_utilization: channel_utilization,
    air_util_tx: air_util_tx,
    uptime_seconds: uptime_seconds,
  )
end

# Insert a text message if it does not already exist.
#
# @param db [SQLite3::Database] open database handle.
# @param m [Hash] message payload provided by the data daemon.
def insert_message(db, m)
  msg_id = m["id"] || m["packet_id"]
  return unless msg_id

  rx_time = m["rx_time"]&.to_i || Time.now.to_i
  rx_iso = m["rx_iso"] || Time.at(rx_time).utc.iso8601

  raw_from_id = m["from_id"]
  if raw_from_id.nil? || raw_from_id.to_s.strip.empty?
    alt_from = m["from"]
    raw_from_id = alt_from unless alt_from.nil? || alt_from.to_s.strip.empty?
  end

  trimmed_from_id = string_or_nil(raw_from_id)
  canonical_from_id = string_or_nil(normalize_node_id(db, raw_from_id))
  from_id = trimmed_from_id
  if canonical_from_id
    if from_id.nil?
      from_id = canonical_from_id
    elsif prefer_canonical_sender?(m)
      from_id = canonical_from_id
    elsif from_id.start_with?("!") && from_id.casecmp(canonical_from_id) != 0
      from_id = canonical_from_id
    end
  end

  raw_to_id = m["to_id"]
  raw_to_id = m["to"] if raw_to_id.nil? || raw_to_id.to_s.strip.empty?
  trimmed_to_id = string_or_nil(raw_to_id)
  canonical_to_id = string_or_nil(normalize_node_id(db, raw_to_id))
  to_id = trimmed_to_id
  if canonical_to_id
    if to_id.nil?
      to_id = canonical_to_id
    elsif to_id.start_with?("!") && to_id.casecmp(canonical_to_id) != 0
      to_id = canonical_to_id
    end
  end

  encrypted = string_or_nil(m["encrypted"])

  ensure_unknown_node(db, from_id || raw_from_id, m["from_num"], heard_time: rx_time)
  touch_node_last_seen(
    db,
    from_id || raw_from_id || m["from_num"],
    m["from_num"],
    rx_time: rx_time,
    source: :message,
  )

  row = [
    msg_id,
    rx_time,
    rx_iso,
    from_id,
    to_id,
    m["channel"],
    m["portnum"],
    m["text"],
    encrypted,
    m["snr"],
    m["rssi"],
    m["hop_limit"],
  ]

  with_busy_retry do
    existing = db.get_first_row(
      "SELECT from_id, to_id, encrypted FROM messages WHERE id = ?",
      [msg_id],
    )
    if existing
      updates = {}

      if from_id
        existing_from = existing.is_a?(Hash) ? existing["from_id"] : existing[0]
        existing_from_str = existing_from&.to_s
        should_update = existing_from_str.nil? || existing_from_str.strip.empty?
        should_update ||= existing_from != from_id
        updates["from_id"] = from_id if should_update
      end

      if to_id
        existing_to = existing.is_a?(Hash) ? existing["to_id"] : existing[1]
        existing_to_str = existing_to&.to_s
        should_update = existing_to_str.nil? || existing_to_str.strip.empty?
        should_update ||= existing_to != to_id
        updates["to_id"] = to_id if should_update
      end

      if encrypted
        existing_encrypted = existing.is_a?(Hash) ? existing["encrypted"] : existing[2]
        existing_encrypted_str = existing_encrypted&.to_s
        should_update = existing_encrypted_str.nil? || existing_encrypted_str.strip.empty?
        should_update ||= existing_encrypted != encrypted
        updates["encrypted"] = encrypted if should_update
      end

      unless updates.empty?
        assignments = updates.keys.map { |column| "#{column} = ?" }.join(", ")
        db.execute("UPDATE messages SET #{assignments} WHERE id = ?", updates.values + [msg_id])
      end
    else
      $prom_messages_total.increment

      begin
        db.execute <<~SQL, row
                     INSERT INTO messages(id,rx_time,rx_iso,from_id,to_id,channel,portnum,text,encrypted,snr,rssi,hop_limit)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                   SQL
      rescue SQLite3::ConstraintException
        fallback_updates = {}
        fallback_updates["from_id"] = from_id if from_id
        fallback_updates["to_id"] = to_id if to_id
        fallback_updates["encrypted"] = encrypted if encrypted
        unless fallback_updates.empty?
          assignments = fallback_updates.keys.map { |column| "#{column} = ?" }.join(", ")
          db.execute("UPDATE messages SET #{assignments} WHERE id = ?", fallback_updates.values + [msg_id])
        end
      end
    end
  end
end

# Resolve a node reference to the canonical node ID when possible.
#
# @param db [SQLite3::Database] open database handle.
# @param node_ref [Object] raw node identifier or numeric reference.
# @return [String, nil] canonical node ID or nil if it cannot be resolved.
def normalize_node_id(db, node_ref)
  return nil if node_ref.nil?
  ref_str = node_ref.to_s.strip
  return nil if ref_str.empty?

  node_id = db.get_first_value("SELECT node_id FROM nodes WHERE node_id = ?", [ref_str])
  return node_id if node_id

  begin
    ref_num = Integer(ref_str, 10)
  rescue ArgumentError
    return nil
  end

  db.get_first_value("SELECT node_id FROM nodes WHERE num = ?", [ref_num])
end

# POST /api/nodes
#
# Upserts one or more nodes provided as a JSON object keyed by node ID.
post "/api/nodes" do
  require_token!
  content_type :json
  begin
    data = JSON.parse(read_json_body)
  rescue JSON::ParserError
    halt 400, { error: "invalid JSON" }.to_json
  end
  halt 400, { error: "too many nodes" }.to_json if data.is_a?(Hash) && data.size > 1000
  db = open_database
  data.each do |node_id, node|
    upsert_node(db, node_id, node)
  end

  $prom_nodes.set(query_nodes(1000).length)

  { status: "ok" }.to_json
ensure
  db&.close
end

# POST /api/messages
#
# Accepts an array or object describing text messages and stores each entry.
post "/api/messages" do
  halt 404 if private_mode?
  require_token!
  content_type :json
  begin
    data = JSON.parse(read_json_body)
  rescue JSON::ParserError
    halt 400, { error: "invalid JSON" }.to_json
  end
  messages = data.is_a?(Array) ? data : [data]
  halt 400, { error: "too many messages" }.to_json if messages.size > 1000
  db = open_database
  messages.each do |msg|
    insert_message(db, msg)
  end
  { status: "ok" }.to_json
ensure
  db&.close
end

# POST /api/positions
#
# Accepts an array or object describing position packets and stores each entry.
post "/api/positions" do
  require_token!
  content_type :json
  begin
    data = JSON.parse(read_json_body)
  rescue JSON::ParserError
    halt 400, { error: "invalid JSON" }.to_json
  end
  positions = data.is_a?(Array) ? data : [data]
  halt 400, { error: "too many positions" }.to_json if positions.size > 1000
  db = open_database
  positions.each do |pos|
    insert_position(db, pos)
  end
  { status: "ok" }.to_json
ensure
  db&.close
end

# POST /api/neighbors
#
# Accepts an array or object describing neighbor tuples and stores each entry.
post "/api/neighbors" do
  require_token!
  content_type :json
  begin
    data = JSON.parse(read_json_body)
  rescue JSON::ParserError
    halt 400, { error: "invalid JSON" }.to_json
  end
  neighbor_payloads = data.is_a?(Array) ? data : [data]
  halt 400, { error: "too many neighbor packets" }.to_json if neighbor_payloads.size > 1000
  db = open_database
  neighbor_payloads.each do |packet|
    insert_neighbors(db, packet)
  end
  { status: "ok" }.to_json
ensure
  db&.close
end

# POST /api/telemetry
#
# Accepts an array or object describing telemetry packets and stores each entry.
post "/api/telemetry" do
  require_token!
  content_type :json
  begin
    data = JSON.parse(read_json_body)
  rescue JSON::ParserError
    halt 400, { error: "invalid JSON" }.to_json
  end
  telemetry_packets = data.is_a?(Array) ? data : [data]
  halt 400, { error: "too many telemetry packets" }.to_json if telemetry_packets.size > 1000
  db = open_database
  telemetry_packets.each do |packet|
    insert_telemetry(db, packet)
  end
  { status: "ok" }.to_json
ensure
  db&.close
end

get "/potatomesh-logo.svg" do
  # Sinatra знает корень через settings.root (обычно это каталог app.rb)
  path = File.expand_path("potatomesh-logo.svg", settings.public_folder)

  # отладка в лог (видно в docker logs)
  settings.logger&.info("logo_path=#{path} exist=#{File.exist?(path)}
file=#{File.file?(path)}")

  halt 404, "Not Found" unless File.exist?(path) && File.readable?(path)

  content_type "image/svg+xml"
  last_modified File.mtime(path)
  cache_control :public, max_age: 3600
  send_file path
end

# GET /
#
# Renders the main site with configuration-driven defaults for the template.
get "/" do
  meta = meta_configuration
  config = frontend_app_config

  raw_theme = request.cookies["theme"]
  theme = %w[dark light].include?(raw_theme) ? raw_theme : "dark"
  if raw_theme != theme
    response.set_cookie("theme", value: theme, path: "/", max_age: 60 * 60 * 24 * 7, same_site: :lax)
  end

  erb :index, locals: {
                site_name: meta[:name],
                meta_title: meta[:title],
                meta_name: meta[:name],
                meta_description: meta[:description],
                default_channel: sanitized_default_channel,
                default_frequency: sanitized_default_frequency,
                map_center_lat: MAP_CENTER_LAT,
                map_center_lon: MAP_CENTER_LON,
                max_node_distance_km: MAX_NODE_DISTANCE_KM,
                matrix_room: sanitized_matrix_room,
                version: APP_VERSION,
                private_mode: private_mode?,
                refresh_interval_seconds: REFRESH_INTERVAL_SECONDS,
                app_config_json: JSON.generate(config),
                initial_theme: theme,
              }
end

# GET /metrics
#
# Prometheus metrics endpoint.
get "/metrics" do
  content_type Prometheus::Client::Formats::Text::CONTENT_TYPE
  Prometheus::Client::Formats::Text.marshal(Prometheus::Client.registry)
end
