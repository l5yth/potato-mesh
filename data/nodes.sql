-- nodes.sql
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS nodes (
  node_id            TEXT PRIMARY KEY,  -- e.g. "!0c63e027"
  num                INTEGER,           -- numeric node number
  short_name         TEXT,
  long_name          TEXT,
  macaddr            TEXT,
  hw_model           TEXT,nodes
  role               TEXT,
  public_key         TEXT,
  is_unmessagable    BOOLEAN,
  is_favorite        BOOLEAN,
  hops_away          INTEGER,
  snr                REAL,
  last_heard         INTEGER,           -- unix seconds
  battery_level      REAL,
  voltage            REAL,
  channel_utilization REAL,
  air_util_tx        REAL,
  uptime_seconds     INTEGER,
  position_time      INTEGER,
  location_source    TEXT,
  latitude           REAL,
  longitude          REAL,
  altitude           REAL,
  node_json          TEXT NOT NULL      -- full original node object for debugging
);

CREATE INDEX IF NOT EXISTS idx_nodes_last_heard ON nodes(last_heard);
CREATE INDEX IF NOT EXISTS idx_nodes_hw_model  ON nodes(hw_model);
CREATE INDEX IF NOT EXISTS idx_nodes_latlon    ON nodes(latitude, longitude);
