CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    rx_time   INTEGER NOT NULL,        -- unix seconds when received
    rx_iso    TEXT NOT NULL,           -- ISO8601 UTC timestamp
    from_id   TEXT,                    -- sender node id (string form)
    to_id     TEXT,                    -- recipient node id
    channel   INTEGER,                 -- channel index
    portnum   TEXT,                    -- application portnum (e.g. TEXT_MESSAGE_APP)
    text      TEXT,                    -- decoded text payload if present
    snr       REAL,                    -- signal-to-noise ratio
    rssi      INTEGER,                 -- received signal strength
    hop_limit INTEGER,                 -- hops left when received
    raw_json  TEXT                     -- entire packet JSON dump
);

CREATE INDEX IF NOT EXISTS idx_messages_rx_time   ON messages(rx_time);
CREATE INDEX IF NOT EXISTS idx_messages_from_id   ON messages(from_id);
CREATE INDEX IF NOT EXISTS idx_messages_to_id     ON messages(to_id);
CREATE INDEX IF NOT EXISTS idx_messages_channel   ON messages(channel);
CREATE INDEX IF NOT EXISTS idx_messages_portnum   ON messages(portnum);
