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

-- Add telemetry subtype discriminator to enable per-chart type filtering.
-- Backfills existing rows using field-presence heuristics that mirror
-- classifySnapshot() in node-page.js, so historical data is classified
-- consistently regardless of whether the new ingestors are deployed yet.

BEGIN;
ALTER TABLE telemetry ADD COLUMN telemetry_type TEXT;

-- Device metrics: battery/channel fields are exclusive to device_metrics
UPDATE telemetry SET telemetry_type = 'device'
  WHERE telemetry_type IS NULL
    AND (battery_level IS NOT NULL OR channel_utilization IS NOT NULL
         OR air_util_tx IS NOT NULL OR uptime_seconds IS NOT NULL);

-- Power sensor: voltage/current without any device field
UPDATE telemetry SET telemetry_type = 'power'
  WHERE telemetry_type IS NULL
    AND (current IS NOT NULL OR voltage IS NOT NULL);

-- Environment: temperature/humidity/pressure
UPDATE telemetry SET telemetry_type = 'environment'
  WHERE telemetry_type IS NULL
    AND (temperature IS NOT NULL OR relative_humidity IS NOT NULL
         OR barometric_pressure IS NOT NULL OR iaq IS NOT NULL
         OR gas_resistance IS NOT NULL);

COMMIT;
