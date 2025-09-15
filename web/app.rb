# frozen_string_literal: true
require "sinatra"
require "json"
require "sqlite3"

# run ../data/mesh.sh to populate nodes and messages database
DB_PATH = ENV.fetch("MESH_DB", File.join(__dir__, "../data/mesh.db"))
WEEK_SECONDS = 7 * 24 * 60 * 60

set :public_folder, File.join(__dir__, "public")
set :views, File.join(__dir__, "views")

SITE_NAME = ENV.fetch("SITE_NAME", "Meshtastic Berlin")
DEFAULT_CHANNEL = ENV.fetch("DEFAULT_CHANNEL", "#MediumFast")
MAP_CENTER_LAT = ENV.fetch("MAP_CENTER_LAT", "52.502889").to_f
MAP_CENTER_LON = ENV.fetch("MAP_CENTER_LON", "13.404194").to_f
MAX_NODE_DISTANCE_KM = ENV.fetch("MAX_NODE_DISTANCE_KM", "137").to_f
MATRIX_ROOM = ENV.fetch("MATRIX_ROOM", "#meshtastic-berlin:matrix.org")

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

get "/api/nodes" do
  content_type :json
  limit = [params["limit"]&.to_i || 200, 1000].min
  query_nodes(limit).to_json
end

def query_messages(limit)
  db = SQLite3::Database.new(DB_PATH, readonly: true)
  db.results_as_hash = true
  rows = db.execute <<~SQL, [limit]
                      SELECT m.*, n.*, m.snr AS msg_snr
                      FROM messages m
                      LEFT JOIN nodes n ON m.from_id = n.node_id
                      ORDER BY m.rx_time DESC
                      LIMIT ?
                    SQL
  msg_fields = %w[id rx_time rx_iso from_id to_id channel portnum text msg_snr rssi hop_limit]
  rows.each do |r|
    node = {}
    r.keys.each do |k|
      next if msg_fields.include?(k)
      node[k] = r.delete(k)
    end
    r["snr"] = r.delete("msg_snr")
    r["node"] = node unless node.empty?
  end
  rows
ensure
  db&.close
end

get "/api/messages" do
  content_type :json
  limit = [params["limit"]&.to_i || 200, 1000].min
  query_messages(limit).to_json
end

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

def require_token!
  token = ENV["API_TOKEN"]
  provided = request.env["HTTP_AUTHORIZATION"].to_s.sub(/^Bearer\s+/i, "")
  halt 403, { error: "Forbidden" }.to_json unless token && !token.empty? && provided == token
end

def insert_message(db, m)
  msg_id = m["id"] || m["packet_id"]
  return unless msg_id
  rx_time = m["rx_time"]&.to_i || Time.now.to_i
  rx_iso = m["rx_iso"] || Time.at(rx_time).utc.iso8601
  row = [
    msg_id,
    rx_time,
    rx_iso,
    m["from_id"],
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

get "/" do
  erb :index, locals: {
    site_name: SITE_NAME,
    default_channel: DEFAULT_CHANNEL,
    map_center_lat: MAP_CENTER_LAT,
    map_center_lon: MAP_CENTER_LON,
    max_node_distance_km: MAX_NODE_DISTANCE_KM,
    matrix_room: MATRIX_ROOM
  }
end
