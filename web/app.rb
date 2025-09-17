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

DB_PATH = ENV.fetch("MESH_DB", File.join(__dir__, "../data/mesh.db"))
DB_BUSY_TIMEOUT_MS = ENV.fetch("DB_BUSY_TIMEOUT_MS", "5000").to_i
DB_BUSY_MAX_RETRIES = ENV.fetch("DB_BUSY_MAX_RETRIES", "5").to_i
DB_BUSY_RETRY_DELAY = ENV.fetch("DB_BUSY_RETRY_DELAY", "0.05").to_f
WEEK_SECONDS = 7 * 24 * 60 * 60

set :public_folder, File.join(__dir__, "public")
set :views, File.join(__dir__, "views")

SITE_NAME = ENV.fetch("SITE_NAME", "Meshtastic Berlin")
DEFAULT_CHANNEL = ENV.fetch("DEFAULT_CHANNEL", "#MediumFast")
DEFAULT_FREQUENCY = ENV.fetch("DEFAULT_FREQUENCY", "868MHz")
MAP_CENTER_LAT = ENV.fetch("MAP_CENTER_LAT", "52.502889").to_f
MAP_CENTER_LON = ENV.fetch("MAP_CENTER_LON", "13.404194").to_f
MAX_NODE_DISTANCE_KM = ENV.fetch("MAX_NODE_DISTANCE_KM", "137").to_f
MATRIX_ROOM = ENV.fetch("MATRIX_ROOM", "#meshtastic-berlin:matrix.org")
DEBUG = ENV["DEBUG"] == "1"

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

# Execute the provided block with a database connection.
#
# @param readonly [Boolean] whether to open the database in read-only mode.
# @param results_as_hash [Boolean] whether to return query rows as hashes.
# @yieldparam db [SQLite3::Database]
# @yieldreturn [Object] value returned by the block.
def with_database(readonly: false, results_as_hash: false)
  db = open_database(readonly: readonly)
  db.results_as_hash = true if results_as_hash
  yield db
ensure
  db&.close
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
  with_database(readonly: true) do |db|
    tables = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('nodes','messages')").flatten
    tables.include?("nodes") && tables.include?("messages")
  end
rescue SQLite3::Exception
  false
end

# Create the SQLite database and seed it with the node and message schemas.
#
# @return [void]
def init_db
  FileUtils.mkdir_p(File.dirname(DB_PATH))
  with_database do |db|
    %w[nodes messages].each do |schema|
      sql_file = File.expand_path("../data/#{schema}.sql", __dir__)
      db.execute_batch(File.read(sql_file))
    end
  end
end

init_db unless db_schema_present?

# Retrieve recently heard nodes ordered by their last contact time.
#
# @param limit [Integer] maximum number of rows returned.
# @return [Array<Hash>] collection of node records formatted for the API.
def query_nodes(limit)
  now = Time.now.to_i
  min_last_heard = now - WEEK_SECONDS

  with_database(readonly: true, results_as_hash: true) do |db|
    db.execute(<<~SQL, [min_last_heard, limit]).map do |row|
      normalize_node_row(row, now)
    end
  end
end

def normalize_node_row(row, current_time)
  row["role"] ||= "CLIENT"

  last_heard = row["last_heard"]&.to_i
  position_time = row["position_time"]&.to_i

  last_heard = current_time if last_heard && last_heard > current_time
  position_time = nil if position_time && position_time > current_time

  row["last_heard"] = last_heard
  row["position_time"] = position_time
  row["last_seen_iso"] = Time.at(last_heard).utc.iso8601 if last_heard
  row["pos_time_iso"] = Time.at(position_time).utc.iso8601 if position_time

  row
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
MESSAGE_FIELDS = %w[id rx_time rx_iso from_id to_id channel portnum text msg_snr rssi hop_limit].freeze
MESSAGE_QUERY_SQL = <<~SQL
  SELECT m.*, n.*, m.snr AS msg_snr
  FROM messages m
  LEFT JOIN nodes n ON (
    m.from_id = n.node_id OR (
      CAST(m.from_id AS TEXT) <> '' AND
      CAST(m.from_id AS TEXT) GLOB '[0-9]*' AND
      CAST(m.from_id AS INTEGER) = n.num
    )
  )
  ORDER BY m.rx_time DESC
  LIMIT ?
SQL

def query_messages(limit)
  with_database(readonly: true, results_as_hash: true) do |db|
    db.execute(MESSAGE_QUERY_SQL, [limit]).map do |row|
      build_message_row(db, row)
    end
  end
end

def build_message_row(db, row)
  log_missing_sender_state(db, row, :before_processing)

  node = extract_node_attributes(row)
  row["snr"] = row.delete("msg_snr")

  populate_fallback_node_data(db, row, node)
  node["role"] = "CLIENT" if node.key?("role") && (node["role"].nil? || node["role"].to_s.empty?)

  row["node"] = node

  log_missing_sender_state(db, row, :after_processing)
  row
end

def extract_node_attributes(row)
  node = {}
  row.keys.each do |key|
    next if MESSAGE_FIELDS.include?(key)

    node[key] = row.delete(key)
  end
  node
end

def populate_fallback_node_data(db, row, node)
  from_id = row["from_id"]
  return unless from_id
  return unless node["node_id"].nil? || node["node_id"].to_s.empty?

  fallback = find_node_fallback(db, fallback_lookup_keys(db, from_id))
  return unless fallback

  fallback.each do |key, value|
    next unless key.is_a?(String)
    next if MESSAGE_FIELDS.include?(key)

    node[key] = value if node[key].nil?
  end
end

def fallback_lookup_keys(db, raw_from_id)
  lookup_keys = []
  canonical = normalize_node_id(db, raw_from_id)
  lookup_keys << canonical if canonical

  raw_ref = raw_from_id.to_s.strip
  unless raw_ref.empty?
    lookup_keys << raw_ref
    lookup_keys << raw_ref.to_i if raw_ref.match?(/\A[0-9]+\z/)
  end

  lookup_keys.uniq
end

def find_node_fallback(db, lookup_keys)
  lookup_keys.each do |ref|
    sql = ref.is_a?(Integer) ? "SELECT * FROM nodes WHERE num = ?" : "SELECT * FROM nodes WHERE node_id = ?"
    fallback = db.get_first_row(sql, [ref])
    return fallback if fallback
  end
  nil
end

def log_missing_sender_state(db, row, stage)
  return unless DEBUG
  from_id = row["from_id"]
  return unless from_id.nil? || from_id.to_s.empty?

  case stage
  when :before_processing
    raw = db.execute("SELECT * FROM messages WHERE id = ?", [row["id"]]).first
    Kernel.warn "[debug] messages row before join: #{raw.inspect}"
    Kernel.warn "[debug] row after join: #{row.inspect}"
  when :after_processing
    Kernel.warn "[debug] row after processing: #{row.inspect}"
  end
end

# GET /api/messages
#
# Returns a JSON array of stored text messages including node metadata.
get "/api/messages" do
  content_type :json
  limit = [params["limit"]&.to_i || 200, 1000].min
  query_messages(limit).to_json
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
  halt 403, { error: "Forbidden" }.to_json unless token && !token.empty? && provided == token
end

# Determine whether the canonical node identifier should replace the provided
# sender reference for a message payload.
#
# @param message [Object] raw request payload element.
# @return [Boolean]
def prefer_canonical_sender?(message)
  message.is_a?(Hash) && message.key?("packet_id") && !message.key?("id")
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
  trimmed_from_id = raw_from_id.nil? ? nil : raw_from_id.to_s.strip
  trimmed_from_id = nil if trimmed_from_id&.empty?
  canonical_from_id = normalize_node_id(db, raw_from_id)
  use_canonical = canonical_from_id && (trimmed_from_id.nil? || prefer_canonical_sender?(m))
  from_id = if use_canonical
      canonical_from_id.to_s.strip
    else
      trimmed_from_id
    end
  from_id = nil if from_id&.empty?
  row = [
    msg_id,
    rx_time,
    rx_iso,
    from_id,
    m["to_id"],
    m["channel"],
    m["portnum"],
    m["text"],
    m["snr"],
    m["rssi"],
    m["hop_limit"],
  ]
  with_busy_retry do
    existing = db.get_first_row("SELECT from_id FROM messages WHERE id = ?", [msg_id])
    if existing
      if from_id
        existing_from = existing.is_a?(Hash) ? existing["from_id"] : existing[0]
        existing_from_str = existing_from&.to_s
        should_update = existing_from_str.nil? || existing_from_str.strip.empty?
        should_update ||= existing_from != from_id
        db.execute("UPDATE messages SET from_id = ? WHERE id = ?", [from_id, msg_id]) if should_update
      end
    else
      begin
        db.execute <<~SQL, row
                     INSERT INTO messages(id,rx_time,rx_iso,from_id,to_id,channel,portnum,text,snr,rssi,hop_limit)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?)
                   SQL
      rescue SQLite3::ConstraintException
        db.execute("UPDATE messages SET from_id = ? WHERE id = ?", [from_id, msg_id]) if from_id
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
    data = JSON.parse(request.body.read)
  rescue JSON::ParserError
    halt 400, { error: "invalid JSON" }.to_json
  end
  halt 400, { error: "too many nodes" }.to_json if data.is_a?(Hash) && data.size > 1000
  with_database do |db|
    data.each do |node_id, node|
      upsert_node(db, node_id, node)
    end
  end
  { status: "ok" }.to_json
end

# POST /api/messages
#
# Accepts an array or object describing text messages and stores each entry.
post "/api/messages" do
  require_token!
  content_type :json
  begin
    data = JSON.parse(request.body.read)
  rescue JSON::ParserError
    halt 400, { error: "invalid JSON" }.to_json
  end
  messages = data.is_a?(Array) ? data : [data]
  halt 400, { error: "too many messages" }.to_json if messages.size > 1000
  with_database do |db|
    messages.each do |msg|
      insert_message(db, msg)
    end
  end
  { status: "ok" }.to_json
end

# GET /
#
# Renders the main site with configuration-driven defaults for the template.
get "/" do
  erb :index, locals: {
                site_name: SITE_NAME,
                default_channel: DEFAULT_CHANNEL,
                default_frequency: DEFAULT_FREQUENCY,
                map_center_lat: MAP_CENTER_LAT,
                map_center_lon: MAP_CENTER_LON,
                max_node_distance_km: MAX_NODE_DISTANCE_KM,
                matrix_room: MATRIX_ROOM,
              }
end
