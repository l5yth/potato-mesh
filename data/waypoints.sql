-- Copyright © 2025-26 l5yth & contributors
--
-- Licensed under the Apache License, Version 2.0 (the "License");
-- you may not use this file except in compliance with the License.
-- You may obtain a copy of the License at
--
--     http://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing, software
-- distributed under the License is distributed on an "AS IS" BASIS,
-- WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
-- See the License for the specific language governing permissions and
-- limitations under the License.

-- Community points of interest broadcast over the mesh (SPEC W1/W5).
-- Rows are keyed by the sender-assigned waypoint id plus the protocol stamp,
-- so a re-broadcast of the same waypoint UPSERTs (the newest broadcast is the
-- full new state) while ids from different protocols can never collide.
CREATE TABLE IF NOT EXISTS waypoints (
    id             INTEGER NOT NULL,
    node_id        TEXT,
    node_num       INTEGER,
    rx_time        INTEGER NOT NULL,
    rx_iso         TEXT NOT NULL,
    name           TEXT,
    description    TEXT,
    icon           INTEGER,
    latitude       REAL,
    longitude      REAL,
    expire         INTEGER,
    locked_to      TEXT,
    snr            REAL,
    rssi           INTEGER,
    hop_limit      INTEGER,
    payload_b64    TEXT,
    ingestor       TEXT,
    protocol       TEXT NOT NULL DEFAULT 'meshtastic',
    PRIMARY KEY (id, protocol)
);

CREATE INDEX IF NOT EXISTS idx_waypoints_rx_time ON waypoints(rx_time);
CREATE INDEX IF NOT EXISTS idx_waypoints_node_id ON waypoints(node_id);
