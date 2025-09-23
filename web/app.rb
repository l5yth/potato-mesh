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

DB_PATH = ENV.fetch("MESH_DB", File.join(__dir__, "../data/mesh.db"))
DB_BUSY_TIMEOUT_MS = ENV.fetch("DB_BUSY_TIMEOUT_MS", "5000").to_i
DB_BUSY_MAX_RETRIES = ENV.fetch("DB_BUSY_MAX_RETRIES", "5").to_i
DB_BUSY_RETRY_DELAY = ENV.fetch("DB_BUSY_RETRY_DELAY", "0.05").to_f
WEEK_SECONDS = 7 * 24 * 60 * 60
DEFAULT_MAX_JSON_BODY_BYTES = 1_048_576
MAX_JSON_BODY_BYTES = begin
    raw = ENV.fetch("MAX_JSON_BODY_BYTES", DEFAULT_MAX_JSON_BODY_BYTES.to_s)
    value = Integer(raw, 10)
    value.positive? ? value : DEFAULT_MAX_JSON_BODY_BYTES
  rescue ArgumentError
    DEFAULT_MAX_JSON_BODY_BYTES
  end
VERSION_FALLBACK = "v0.2.1"

def fetch_config_string(key, default)
  value = ENV[key]
  return default if value.nil?

  trimmed = value.strip
  trimmed.empty? ? default : trimmed
end

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

SITE_NAME = fetch_config_string("SITE_NAME", "Meshtastic Berlin")
DEFAULT_CHANNEL = fetch_config_string("DEFAULT_CHANNEL", "#MediumFast")
DEFAULT_FREQUENCY = fetch_config_string("DEFAULT_FREQUENCY", "868MHz")
MAP_CENTER_LAT = ENV.fetch("MAP_CENTER_LAT", "52.502889").to_f
MAP_CENTER_LON = ENV.fetch("MAP_CENTER_LON", "13.404194").to_f
MAX_NODE_DISTANCE_KM = ENV.fetch("MAX_NODE_DISTANCE_KM", "137").to_f
MATRIX_ROOM = ENV.fetch("MATRIX_ROOM", "#meshtastic-berlin:matrix.org")
DEBUG = ENV["DEBUG"] == "1"

def sanitized_string(value)
  value.to_s.strip
end

def sanitized_site_name
  sanitized_string(SITE_NAME)
end

def sanitized_default_channel
  sanitized_string(DEFAULT_CHANNEL)
end

def sanitized_default_frequency
  sanitized_string(DEFAULT_FREQUENCY)
end

def sanitized_matrix_room
  value = sanitized_string(MATRIX_ROOM)
  value.empty? ? nil : value
end

def string_or_nil(value)
  return nil if value.nil?

  str = value.is_a?(String) ? value : value.to_s
  trimmed = str.strip
  trimmed.empty? ? nil : trimmed
end

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

def sanitized_max_distance_km
  return nil unless defined?(MAX_NODE_DISTANCE_KM)

  distance = MAX_NODE_DISTANCE_KM
  return nil unless distance.is_a?(Numeric)
  return nil unless distance.positive?

  distance
end

def formatted_distance_km(distance)
  format("%.1f", distance).sub(/\.0\z/, "")
end

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

  sentences = [summary, "Track nodes, messages, and coverage in real time."]
  if (distance = sanitized_max_distance_km)
    sentences << "Shows nodes within roughly #{formatted_distance_km(distance)} km of the map center."
  end
  sentences << "Join the community in #{matrix} on Matrix." if matrix

  sentences.join(" ")
end

def meta_configuration
  site = sanitized_site_name
  {
    title: site,
    name: site,
    description: meta_description,
  }
end

class << Sinatra::Application
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
  Sinatra::Application.apply_logger_level!
end

# Open the SQLite database with a configured busy timeout.
#
# @param readonly [Boolean] whether to open the database in read-only mode.
# @return [SQLite3::Database]
def open_database(readonly: false)
  SQLite3::Database.new(DB_PATH, readonly: readonly).tap do |db|
    db.busy_timeout = DB_BUSY_TIMEOUT_MS
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
  required = %w[nodes messages positions]
  tables = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('nodes','messages','positions')").flatten
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
  %w[nodes messages positions].each do |schema|
    sql_file = File.expand_path("../data/#{schema}.sql", __dir__)
    db.execute_batch(File.read(sql_file))
  end
ensure
  db&.close
end

init_db unless db_schema_present?

# Retrieve recently heard nodes ordered by their last contact time.
#
# @param limit [Integer] maximum number of rows returned.
# @return [Array<Hash>] collection of node records formatted for the API.
def query_nodes(limit)
  db = open_database(readonly: true)
  db.results_as_hash = true
  now = Time.now.to_i
  min_last_heard = now - WEEK_SECONDS
  rows = db.execute <<~SQL, [min_last_heard, limit]
                      SELECT node_id, short_name, long_name, hw_model, role, snr,
                             battery_level, voltage, last_heard, first_heard,
                             uptime_seconds, channel_utilization, air_util_tx,
                             position_time, latitude, longitude, altitude
                      FROM nodes
                      WHERE last_heard >= ?
                      ORDER BY last_heard DESC
                      LIMIT ?
                    SQL
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
                        (m.from_node_id IS NOT NULL AND TRIM(m.from_node_id) <> '' AND m.from_node_id = n.node_id)
                        OR (m.from_node_num IS NOT NULL AND m.from_node_num = n.num)
                        OR (
                          CAST(m.from_id AS TEXT) <> '' AND (
                            CAST(m.from_id AS TEXT) = n.node_id OR (
                              CAST(m.from_id AS TEXT) GLOB '[0-9]*' AND
                              CAST(m.from_id AS INTEGER) = n.num
                            )
                          )
                        )
                      )
                      ORDER BY m.rx_time DESC
                      LIMIT ?
                    SQL
  msg_fields = %w[id rx_time rx_iso from_id from_node_id from_node_num to_id to_node_id to_node_num channel portnum text encrypted msg_snr rssi hop_limit]
  rows.each do |r|
    r["from_node_num"] = coerce_integer(r["from_node_num"])
    r["to_node_num"] = coerce_integer(r["to_node_num"])

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
    references = [r["from_node_id"], r["from_id"], r["from_node_num"]].compact
    if references.any? && (node["node_id"].nil? || node["node_id"].to_s.empty?)
      lookup_keys = []
      canonical = string_or_nil(r["from_node_id"]) || normalize_node_id(db, r["from_id"])
      lookup_keys << canonical if canonical
      raw_ref = r["from_id"].to_s.strip
      lookup_keys << raw_ref unless raw_ref.empty?
      from_num = r["from_node_num"]
      if from_num
        lookup_keys << from_num
      elsif raw_ref.match?(/\A[0-9]+\z/)
        lookup_keys << raw_ref.to_i
      end
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
  end
  rows
ensure
  db&.close
end

# GET /api/messages
#
# Returns a JSON array of stored text messages including node metadata.
get "/api/messages" do
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
  lh = n["lastHeard"]
  pt = pos["time"]
  now = Time.now.to_i
  pt = nil if pt && pt > now
  lh = now if lh && lh > now
  lh = pt if pt && (!lh || lh < pt)
  bool = ->(v) {
    case v
    when true then 1
    when false then 0
    else v
    end
  }
  node_num = resolve_node_num(node_id, n)

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
    pos["latitude"],
    pos["longitude"],
    pos["altitude"],
  ]
  with_busy_retry do
    db.execute <<~SQL, row
                 INSERT INTO nodes(node_id,num,short_name,long_name,macaddr,hw_model,role,public_key,is_unmessagable,is_favorite,
                                   hops_away,snr,last_heard,first_heard,battery_level,voltage,channel_utilization,air_util_tx,uptime_seconds,
                                   position_time,location_source,latitude,longitude,altitude)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(node_id) DO UPDATE SET
                   num=excluded.num, short_name=excluded.short_name, long_name=excluded.long_name, macaddr=excluded.macaddr,
                   hw_model=excluded.hw_model, role=excluded.role, public_key=excluded.public_key, is_unmessagable=excluded.is_unmessagable,
                   is_favorite=excluded.is_favorite, hops_away=excluded.hops_away, snr=excluded.snr, last_heard=excluded.last_heard,
                   battery_level=excluded.battery_level, voltage=excluded.voltage, channel_utilization=excluded.channel_utilization,
                   air_util_tx=excluded.air_util_tx, uptime_seconds=excluded.uptime_seconds, position_time=excluded.position_time,
                   location_source=excluded.location_source, latitude=excluded.latitude, longitude=excluded.longitude,
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

# Resolve message sender/recipient references to database node identifiers.
#
# @param db [SQLite3::Database] open database handle.
# @param raw_ref [Object] raw identifier provided in the payload.
# @param provided_ids [Array<Object>] optional candidate identifiers to normalise.
# @param provided_nums [Array<Object>] optional candidate numeric identifiers.
# @return [Array(String, Integer)] pair containing canonical node ID and numeric reference.
def resolve_message_node_reference(db, raw_ref, provided_ids: [], provided_nums: [])
  canonical = nil
  Array(provided_ids).compact.each do |candidate|
    normalised = normalize_node_id(db, candidate)
    next unless normalised

    canonical = string_or_nil(normalised)
    break if canonical
  end

  unless canonical
    normalised = normalize_node_id(db, raw_ref)
    canonical = string_or_nil(normalised)
  end

  node_num = nil
  Array(provided_nums).compact.each do |candidate|
    node_num = coerce_integer(candidate)
    break if node_num
  end

  if node_num.nil?
    node_num = coerce_integer(raw_ref)
    if node_num.nil?
      Array(provided_ids).compact.each do |candidate|
        node_num = coerce_integer(candidate)
        break if node_num
      end
    end
  end

  if canonical && node_num.nil?
    lookup = db.get_first_value("SELECT num FROM nodes WHERE node_id = ?", [canonical])
    node_num = coerce_integer(lookup)
  end

  if node_num && canonical.nil?
    canonical = string_or_nil(normalize_node_id(db, node_num))
  end

  [canonical, node_num]
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
# @param snr [Float, nil] link SNR for the packet.
def update_node_from_position(db, node_id, node_num, rx_time, position_time, location_source, latitude, longitude, altitude, snr)
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
  snr_val = coerce_float(snr)

  row = [
    id,
    num,
    last_heard,
    last_heard,
    pos_time,
    loc,
    lat,
    lon,
    alt,
    snr_val,
  ]
  with_busy_retry do
    db.execute <<~SQL, row
                 INSERT INTO nodes(node_id,num,last_heard,first_heard,position_time,location_source,latitude,longitude,altitude,snr)
                 VALUES (?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(node_id) DO UPDATE SET
                   num=COALESCE(excluded.num,nodes.num),
                   snr=COALESCE(excluded.snr,nodes.snr),
                   last_heard=MAX(COALESCE(nodes.last_heard,0),COALESCE(excluded.last_heard,0)),
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
    lat,
    lon,
    alt,
    snr,
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
  use_canonical = canonical_from_id && (trimmed_from_id.nil? || prefer_canonical_sender?(m))
  from_id = use_canonical ? canonical_from_id : trimmed_from_id

  from_node_id, from_node_num = resolve_message_node_reference(
    db,
    raw_from_id,
    provided_ids: [canonical_from_id, m["from_node_id"]],
    provided_nums: [m["from_node_num"]],
  )
  from_node_id ||= canonical_from_id
  from_node_id = string_or_nil(from_node_id)
  from_node_num = coerce_integer(from_node_num)

  raw_to_id = m["to_id"]
  raw_to_id = m["to"] if raw_to_id.nil? || raw_to_id.to_s.strip.empty?
  to_id = string_or_nil(raw_to_id)

  to_node_id, to_node_num = resolve_message_node_reference(
    db,
    raw_to_id,
    provided_ids: [m["to_node_id"]],
    provided_nums: [m["to_node_num"]],
  )
  to_node_id = string_or_nil(to_node_id)
  to_node_num = coerce_integer(to_node_num)

  encrypted = string_or_nil(m["encrypted"])

  row = [
    msg_id,
    rx_time,
    rx_iso,
    from_id,
    from_node_id,
    from_node_num,
    to_id,
    to_node_id,
    to_node_num,
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
      "SELECT from_id, from_node_id, from_node_num, to_id, to_node_id, to_node_num, encrypted FROM messages WHERE id = ?",
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

      if from_node_id
        existing_from_node_id = existing.is_a?(Hash) ? existing["from_node_id"] : existing[1]
        existing_from_node_id_str = existing_from_node_id&.to_s
        should_update = existing_from_node_id_str.nil? || existing_from_node_id_str.strip.empty?
        should_update ||= existing_from_node_id != from_node_id
        updates["from_node_id"] = from_node_id if should_update
      end

      if from_node_num
        existing_from_node_num = existing.is_a?(Hash) ? existing["from_node_num"] : existing[2]
        should_update = existing_from_node_num.nil?
        should_update ||= coerce_integer(existing_from_node_num) != from_node_num
        updates["from_node_num"] = from_node_num if should_update
      end

      if to_id
        existing_to = existing.is_a?(Hash) ? existing["to_id"] : existing[3]
        existing_to_str = existing_to&.to_s
        should_update = existing_to_str.nil? || existing_to_str.strip.empty?
        should_update ||= existing_to != to_id
        updates["to_id"] = to_id if should_update
      end

      if to_node_id
        existing_to_node_id = existing.is_a?(Hash) ? existing["to_node_id"] : existing[4]
        existing_to_node_id_str = existing_to_node_id&.to_s
        should_update = existing_to_node_id_str.nil? || existing_to_node_id_str.strip.empty?
        should_update ||= existing_to_node_id != to_node_id
        updates["to_node_id"] = to_node_id if should_update
      end

      if to_node_num
        existing_to_node_num = existing.is_a?(Hash) ? existing["to_node_num"] : existing[5]
        should_update = existing_to_node_num.nil?
        should_update ||= coerce_integer(existing_to_node_num) != to_node_num
        updates["to_node_num"] = to_node_num if should_update
      end

      if encrypted
        existing_encrypted = existing.is_a?(Hash) ? existing["encrypted"] : existing[6]
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
      begin
        db.execute <<~SQL, row
                     INSERT INTO messages(id,rx_time,rx_iso,from_id,from_node_id,from_node_num,to_id,to_node_id,to_node_num,channel,portnum,text,encrypted,snr,rssi,hop_limit)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   SQL
      rescue SQLite3::ConstraintException
        fallback_updates = {}
        fallback_updates["from_id"] = from_id if from_id
        fallback_updates["from_node_id"] = from_node_id if from_node_id
        fallback_updates["from_node_num"] = from_node_num if from_node_num
        fallback_updates["to_id"] = to_id if to_id
        fallback_updates["to_node_id"] = to_node_id if to_node_id
        fallback_updates["to_node_num"] = to_node_num if to_node_num
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
  { status: "ok" }.to_json
ensure
  db&.close
end

# POST /api/messages
#
# Accepts an array or object describing text messages and stores each entry.
post "/api/messages" do
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

# GET /
#
# Renders the main site with configuration-driven defaults for the template.
get "/" do
  meta = meta_configuration

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
              }
end
