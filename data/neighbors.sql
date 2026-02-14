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

CREATE TABLE IF NOT EXISTS neighbors (
    node_id     TEXT NOT NULL,
    neighbor_id TEXT NOT NULL,
    snr         REAL,
    rx_time     INTEGER NOT NULL,
    ingestor    TEXT,
    PRIMARY KEY (node_id, neighbor_id),
    FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE,
    FOREIGN KEY (neighbor_id) REFERENCES nodes(node_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_neighbors_rx_time ON neighbors(rx_time);
CREATE INDEX IF NOT EXISTS idx_neighbors_neighbor_id ON neighbors(neighbor_id);
