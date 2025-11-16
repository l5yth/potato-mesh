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

CREATE TABLE IF NOT EXISTS traces (
    id          INTEGER PRIMARY KEY,
    request_id  INTEGER,
    src         INTEGER,
    dest        INTEGER,
    rx_time     INTEGER NOT NULL,
    rx_iso      TEXT NOT NULL,
    rssi        INTEGER,
    snr         REAL,
    elapsed_ms  INTEGER
);

CREATE TABLE IF NOT EXISTS trace_hops (
    id         INTEGER PRIMARY KEY,
    trace_id   INTEGER NOT NULL,
    hop_index  INTEGER NOT NULL,
    node_id    INTEGER NOT NULL,
    FOREIGN KEY(trace_id) REFERENCES traces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_traces_rx_time ON traces(rx_time);
CREATE INDEX IF NOT EXISTS idx_traces_request ON traces(request_id);
CREATE INDEX IF NOT EXISTS idx_trace_hops_trace ON trace_hops(trace_id);
CREATE INDEX IF NOT EXISTS idx_trace_hops_node ON trace_hops(node_id);
