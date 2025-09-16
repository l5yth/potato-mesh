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
#
# Main Sinatra application exposing the Meshtastic node and message archive.
# The daemon in +data/mesh.py+ pushes updates into the SQLite database that
# this web process reads from, providing JSON APIs and a rendered HTML index
# page for human visitors.

require "sinatra"
require "json"
require "sqlite3"
require "fileutils"
require "logger"

# run ../data/mesh.sh to populate nodes and messages database
DB_PATH = ENV.fetch("MESH_DB", File.join(__dir__, "../data/mesh.db"))
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

def Sinatra::Application.apply_logger_level!
  logger = settings.logger
  return unless logger

  logger.level = DEBUG ? Logger::DEBUG : Logger::WARN
end

Sinatra::Application.configure do
  app_logger = Logger.new($stdout)
  set :logger, app_logger
  use Rack::CommonLogger, app_logger
  Sinatra::Application.apply_logger_level!
end

# Checks whether the SQLite database already contains the required tables.
#
# @return [Boolean] true when both +nodes+ and +messages+ tables exist.
def db_schema_present?
  return false unless File.exist?(DB_PATH)
  db = SQLite3::Database.new(DB_PATH, readonly: true)
  tables = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('nodes','messages')").flatten
  tables.include?("nodes") && tables.include?("messages")
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
  db = SQLite3::Database.new(DB_PATH)
  %w[nodes messages].each do |schema|
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
  db = SQLite3::Database.new(DB_PATH, readonly: true, results_as_hash: true)
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
  db = SQLite3::Database.new(DB_PATH, readonly: true)
  db.results_as_hash = true
  rows = db.execute <<~SQL, [limit]
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
  msg_fields = %w[id rx_time rx_iso from_id to_id channel portnum text msg_snr rssi hop_limit]
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
    r["node"] = node unless node.empty?
    if DEBUG && (r["from_id"].nil? || r["from_id"].to_s.empty?)
      Kernel.warn "[debug] row after processing: #{r.inspect}"
    end
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
  row = [
    node_id,
    n["num"],
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

# Ensure the request includes the expected bearer token.
#
# @return [void]
# @raise [Sinatra::Halt] when authentication fails.
def require_token!
  token = ENV["API_TOKEN"]
  provided = request.env["HTTP_AUTHORIZATION"].to_s.sub(/^Bearer\s+/i, "")
  halt 403, { error: "Forbidden" }.to_json unless token && !token.empty? && provided == token
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
  from_id = normalize_node_id(db, m["from_id"]) || m["from_id"]
  from_id = from_id.to_s.strip unless from_id.nil?
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
  db.execute <<~SQL, row
               INSERT OR IGNORE INTO messages(id,rx_time,rx_iso,from_id,to_id,channel,portnum,text,snr,rssi,hop_limit)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)
             SQL
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
  db = SQLite3::Database.new(DB_PATH)
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
    data = JSON.parse(request.body.read)
  rescue JSON::ParserError
    halt 400, { error: "invalid JSON" }.to_json
  end
  messages = data.is_a?(Array) ? data : [data]
  halt 400, { error: "too many messages" }.to_json if messages.size > 1000
  db = SQLite3::Database.new(DB_PATH)
  messages.each do |msg|
    insert_message(db, msg)
  end
  { status: "ok" }.to_json
ensure
  db&.close
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
