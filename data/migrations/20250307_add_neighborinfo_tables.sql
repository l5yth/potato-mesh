-- Create tables for storing the latest neighbor broadcasts and edges.
CREATE TABLE IF NOT EXISTS neighbor_snapshots (
  node_id                   TEXT PRIMARY KEY,
  last_sent_by_id           TEXT,
  broadcast_interval_secs   INTEGER,
  rx_time                   INTEGER NOT NULL,
  rx_iso                    TEXT NOT NULL,
  rx_snr                    REAL,
  rx_rssi                   INTEGER,
  hop_limit                 INTEGER,
  hop_start                 INTEGER,
  relay_node                INTEGER,
  transport_mechanism       TEXT
);

CREATE TABLE IF NOT EXISTS neighbor_links (
  node_id     TEXT NOT NULL,
  neighbor_id TEXT NOT NULL,
  snr         REAL,
  rx_time     INTEGER NOT NULL,
  PRIMARY KEY (node_id, neighbor_id),
  FOREIGN KEY (node_id) REFERENCES neighbor_snapshots(node_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_neighbor_links_neighbor ON neighbor_links(neighbor_id);
CREATE INDEX IF NOT EXISTS idx_neighbor_links_rx_time ON neighbor_links(rx_time);
