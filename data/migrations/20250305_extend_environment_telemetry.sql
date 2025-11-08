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

-- Extend the telemetry table with additional environment metrics.

BEGIN;
ALTER TABLE telemetry ADD COLUMN gas_resistance REAL;
ALTER TABLE telemetry ADD COLUMN current REAL;
ALTER TABLE telemetry ADD COLUMN iaq INTEGER;
ALTER TABLE telemetry ADD COLUMN distance REAL;
ALTER TABLE telemetry ADD COLUMN lux REAL;
ALTER TABLE telemetry ADD COLUMN white_lux REAL;
ALTER TABLE telemetry ADD COLUMN ir_lux REAL;
ALTER TABLE telemetry ADD COLUMN uv_lux REAL;
ALTER TABLE telemetry ADD COLUMN wind_direction INTEGER;
ALTER TABLE telemetry ADD COLUMN wind_speed REAL;
ALTER TABLE telemetry ADD COLUMN weight REAL;
ALTER TABLE telemetry ADD COLUMN wind_gust REAL;
ALTER TABLE telemetry ADD COLUMN wind_lull REAL;
ALTER TABLE telemetry ADD COLUMN radiation REAL;
ALTER TABLE telemetry ADD COLUMN rainfall_1h REAL;
ALTER TABLE telemetry ADD COLUMN rainfall_24h REAL;
ALTER TABLE telemetry ADD COLUMN soil_moisture INTEGER;
ALTER TABLE telemetry ADD COLUMN soil_temperature REAL;
COMMIT;
