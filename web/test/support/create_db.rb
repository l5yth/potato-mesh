require 'sqlite3'
require 'time'

def create_test_db(path)
  File.delete(path) if File.exist?(path)
  db = SQLite3::Database.new(path)
  root = File.expand_path('../../../..', __dir__)
  db.execute_batch File.read(File.join(root, 'data', 'nodes.sql'))
  db.execute_batch File.read(File.join(root, 'data', 'messages.sql'))
  now = Time.now.to_i
  iso = Time.at(now).utc.iso8601
  db.execute("INSERT INTO nodes (node_id, short_name, long_name, role, last_heard, first_heard) VALUES (?,?,?,?,?,?)", ['node1','N1','Node 1','CLIENT', now, now])
  db.execute("INSERT INTO messages (rx_time, rx_iso, from_id, to_id, channel, portnum, text, snr) VALUES (?,?,?,?,?,?,?,?)", [now, iso, 'node1','node2',1,'TEXT_MESSAGE_APP','hi',5])
  db.close
end

if __FILE__ == $0
  create_test_db(ARGV[0] || File.join(__dir__, '..', 'test.db'))
end
