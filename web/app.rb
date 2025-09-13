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
    r["pos_time_iso"]  = pt ? Time.at(pt.to_i).utc.iso8601 : nil
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

get "/" do
  send_file File.join(settings.public_folder, "index.html")
end

get "/nodes" do
  send_file File.join(settings.public_folder, "nodes.html")
end
