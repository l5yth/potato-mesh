-- Add first_heard column to nodes table and backfill with last_heard
BEGIN TRANSACTION;

CREATE TABLE nodes_new (
  node_id            TEXT PRIMARY KEY,
  num                INTEGER,
  short_name         TEXT,
  long_name          TEXT,
  macaddr            TEXT,
  hw_model           TEXT,
  role               TEXT,
  public_key         TEXT,
  is_unmessagable    BOOLEAN,
  is_favorite        BOOLEAN,
  hops_away          INTEGER,
  snr                REAL,
  last_heard         INTEGER,
  first_heard        INTEGER NOT NULL,
  battery_level      REAL,
  voltage            REAL,
  channel_utilization REAL,
  air_util_tx        REAL,
  uptime_seconds     INTEGER,
  position_time      INTEGER,
  location_source    TEXT,
  latitude           REAL,
  longitude          REAL,
  altitude           REAL
);

INSERT INTO nodes_new(node_id,num,short_name,long_name,macaddr,hw_model,role,public_key,is_unmessagable,is_favorite,
                      hops_away,snr,last_heard,first_heard,battery_level,voltage,channel_utilization,air_util_tx,uptime_seconds,
                      position_time,location_source,latitude,longitude,altitude)
SELECT node_id,num,short_name,long_name,macaddr,hw_model,role,public_key,is_unmessagable,is_favorite,
       hops_away,snr,last_heard,last_heard,battery_level,voltage,channel_utilization,air_util_tx,uptime_seconds,
       position_time,location_source,latitude,longitude,altitude
FROM nodes;

DROP TABLE nodes;
ALTER TABLE nodes_new RENAME TO nodes;

CREATE INDEX IF NOT EXISTS idx_nodes_last_heard ON nodes(last_heard);
CREATE INDEX IF NOT EXISTS idx_nodes_hw_model  ON nodes(hw_model);
CREATE INDEX IF NOT EXISTS idx_nodes_latlon    ON nodes(latitude, longitude);

COMMIT;

