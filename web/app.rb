# frozen_string_literal: true
require "sinatra"
require "json"
require "sqlite3"

# run ../data/mesh.sh to populate nodes and messages database
DB_PATH = ENV.fetch("MESH_DB", File.join(__dir__, "../data/mesh.db"))

set :public_folder, File.join(__dir__, "public")

def query_nodes(limit)
  db = SQLite3::Database.new(DB_PATH)
  db.results_as_hash = true
  min_last_heard = Time.now.to_i - 7 * 24 * 60 * 60
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
    lh = r["last_heard"]; pt = r["position_time"]
    r["last_seen_iso"] = lh ? Time.at(lh.to_i).utc.iso8601 : nil
    r["pos_time_iso"] = pt ? Time.at(pt.to_i).utc.iso8601 : nil
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
  db = SQLite3::Database.new(DB_PATH)
  db.results_as_hash = true
  rows = db.execute <<~SQL, [limit]
                      SELECT m.*, n.*, m.snr AS msg_snr
                      FROM messages m
                      LEFT JOIN nodes n ON m.from_id = n.node_id
                      ORDER BY m.rx_time DESC
                      LIMIT ?
                    SQL
  msg_fields = %w[id rx_time rx_iso from_id to_id channel portnum text msg_snr rssi hop_limit raw_json]
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
  lh = now if lh && lh > now
  pt = now if pt && pt > now
  lh = pt if pt && (!lh || lh < pt)
  row = [
    node_id,
    n["num"],
    user["shortName"],
    user["longName"],
    user["macaddr"],
    user["hwModel"] || n["hwModel"],
    role,
    user["publicKey"],
    user["isUnmessagable"],
    n["isFavorite"],
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
    pos["altitude"]
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
  halt 403, { error: "Forbidden" }.to_json unless token && provided == token
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

get "/" do
  send_file File.join(settings.public_folder, "index.html")
end
