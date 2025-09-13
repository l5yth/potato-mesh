# frozen_string_literal: true
require "sinatra"
require "json"
require "sqlite3"

# run ../data/nodes.sh to nodespopulate nodes database
DB_PATH = ENV.fetch("MESH_DB", File.join(__dir__, "../data/nodes.db"))

set :public_folder, File.join(__dir__, "public")

def query_nodes(limit)
  db = SQLite3::Database.new(DB_PATH)
  db.results_as_hash = true
  rows = db.execute <<~SQL, [limit]
                      SELECT node_id, short_name, long_name, hw_model, role, snr, battery_level,
                             last_heard, position_time, latitude, longitude, altitude
                      FROM nodes
                      ORDER BY last_heard DESC
                      LIMIT ?
                    SQL
  rows.each do |r|
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

def upsert_node(db, node_id, n)
  user = n["user"] || {}
  met = n["deviceMetrics"] || {}
  pos = n["position"] || {}
  row = [
    node_id,
    n["num"],
    user["shortName"],
    user["longName"],
    user["macaddr"],
    user["hwModel"] || n["hwModel"],
    user["role"],
    user["publicKey"],
    user["isUnmessagable"],
    n["isFavorite"],
    n["hopsAway"],
    n["snr"],
    n["lastHeard"],
    met["batteryLevel"],
    met["voltage"],
    met["channelUtilization"],
    met["airUtilTx"],
    met["uptimeSeconds"],
    pos["time"],
    pos["locationSource"],
    pos["latitude"],
    pos["longitude"],
    pos["altitude"]
  ]
  db.execute <<~SQL, row
    INSERT INTO nodes(node_id,num,short_name,long_name,macaddr,hw_model,role,public_key,is_unmessagable,is_favorite,
                      hops_away,snr,last_heard,battery_level,voltage,channel_utilization,air_util_tx,uptime_seconds,
                      position_time,location_source,latitude,longitude,altitude)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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

get "/nodes" do
  send_file File.join(settings.public_folder, "nodes.html")
end
