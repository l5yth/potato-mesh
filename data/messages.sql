PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  rx_time       INTEGER,                 -- unix seconds
  rx_iso        TEXT,
  from_id       TEXT,
  to_id         TEXT,
  channel       INTEGER,
  portnum       TEXT,
  text          TEXT,
  snr           REAL,
  rssi          INTEGER,
  hop_limit     INTEGER,
  packet_json   TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_rx_time ON messages(rx_time);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
CREATE INDEX IF NOT EXISTS idx_messages_portnum  ON messages(portnum);
