/*
 * Copyright © 2025-26 l5yth & contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TELEMETRY_FIELDS,
  buildTelemetryDisplayEntries,
  collectTelemetryMetrics,
} from '../short-info-telemetry.js';

test('collectTelemetryMetrics extracts values from nested payloads', () => {
  const payload = {
    battery: '100',
    device_metrics: {
      voltage: 4.224,
      airUtilTx: 0.051,
      uptimeSeconds: 305044,
    },
    environment_metrics: {
      temperature: 21.98,
      relativeHumidity: 39.5,
      barometricPressure: 1017.8,
      gasResistance: 1456,
      iaq: 83,
      distance: 12.5,
      lux: 100.25,
      whiteLux: 64.5,
      irLux: 12.75,
      uvLux: 1.6,
      windDirection: 270,
      windSpeed: 5.9,
      windGust: 7.4,
      windLull: 4.8,
      weight: 32.7,
      radiation: 0.45,
      rainfall1h: 0.18,
      rainfall24h: 1.42,
      soilMoisture: 3100,
      soilTemperature: 18.9,
    },
  };
  const metrics = collectTelemetryMetrics(payload);
  assert.equal(metrics.battery, 100);
  assert.equal(metrics.voltage, 4.224);
  assert.equal(metrics.airUtil, 0.051);
  assert.equal(metrics.uptime, 305044);
  assert.equal(metrics.temperature, 21.98);
  assert.equal(metrics.humidity, 39.5);
  assert.equal(metrics.pressure, 1017.8);
  assert.equal(metrics.gasResistance, 1456);
  assert.equal(metrics.iaq, 83);
  assert.equal(metrics.distance, 12.5);
  assert.equal(metrics.lux, 100.25);
  assert.equal(metrics.whiteLux, 64.5);
  assert.equal(metrics.irLux, 12.75);
  assert.equal(metrics.uvLux, 1.6);
  assert.equal(metrics.windDirection, 270);
  assert.equal(metrics.windSpeed, 5.9);
  assert.equal(metrics.windGust, 7.4);
  assert.equal(metrics.windLull, 4.8);
  assert.equal(metrics.weight, 32.7);
  assert.equal(metrics.radiation, 0.45);
  assert.equal(metrics.rainfall1h, 0.18);
  assert.equal(metrics.rainfall24h, 1.42);
  assert.equal(metrics.soilMoisture, 3100);
  assert.equal(metrics.soilTemperature, 18.9);
});

test('collectTelemetryMetrics prefers latest nested telemetry values over stale top-level metrics', () => {
  const payload = {
    channel_utilization: 0,
    device_metrics: {
      channel_utilization: 0.561,
      air_util_tx: 0.0091,
    },
    telemetry: {
      channel: 0.563,
    },
    raw: {
      device_metrics: {
        channelUtilization: 0.562,
      },
    },
  };

  const metrics = collectTelemetryMetrics(payload);
  assert.equal(metrics.channel, 0.563);
  assert.equal(metrics.airUtil, 0.0091);
});

test('collectTelemetryMetrics prefers utilisation metrics over channel indices', () => {
  const metrics = collectTelemetryMetrics({
    channel: 0,
    channel_utilization: 0.013,
  });

  assert.equal(metrics.channel, 0.013);
});

test('collectTelemetryMetrics prefers air util tx metrics over derived ratios', () => {
  const metrics = collectTelemetryMetrics({
    airUtil: 0,
    device_metrics: {
      air_util_tx: 0.0293
    }
  });

  assert.equal(metrics.airUtil, 0.0293);
});

test('collectTelemetryMetrics ignores non-numeric values', () => {
  const metrics = collectTelemetryMetrics({
    battery: '',
    voltage: 'abc',
    rainfall_1h: null,
    wind_speed: undefined,
  });
  for (const field of TELEMETRY_FIELDS) {
    assert.ok(!(field.key in metrics));
  }
});

test('buildTelemetryDisplayEntries formats values for overlays', () => {
  const telemetry = {
    battery: 99,
    voltage: 4.224,
    current: 0.0715,
    uptime: 305044,
    channel: 0.5967,
    airUtil: 0.03908,
    temperature: 21.98,
    humidity: 39.5,
    pressure: 1017.8,
    gasResistance: 1456,
    iaq: 83,
    distance: 12.5,
    lux: 100.25,
    whiteLux: 64.5,
    irLux: 12.75,
    uvLux: 1.6,
    windDirection: 270,
    windSpeed: 5.9,
    windGust: 7.4,
    windLull: 4.8,
    weight: 32.7,
    radiation: 0.45,
    rainfall1h: 0.18,
    rainfall24h: 1.42,
    soilMoisture: 3100,
    soilTemperature: 18.9,
  };
  const entries = buildTelemetryDisplayEntries(telemetry, {
    formatUptime: value => `formatted-${value}`,
  });
  const entryMap = new Map(entries.map(entry => [entry.label, entry.value]));
  assert.equal(entryMap.get('Battery'), '99%');
  assert.equal(entryMap.get('Voltage'), '4.224V');
  assert.equal(entryMap.get('Current'), '71.5 mA');
  assert.equal(entryMap.get('Uptime'), 'formatted-305044');
  assert.equal(entryMap.get('Channel Util'), '0.597%');
  assert.equal(entryMap.get('Air Util Tx'), '0.039%');
  assert.equal(entryMap.get('Temperature'), '22.0°C');
  assert.equal(entryMap.get('Humidity'), '39.5%');
  assert.equal(entryMap.get('Pressure'), '1017.8 hPa');
  assert.equal(entryMap.get('Gas Resistance'), '1.46 kΩ');
  assert.equal(entryMap.get('IAQ'), '83');
  assert.equal(entryMap.get('Distance'), '12.50 m');
  assert.equal(entryMap.get('Lux'), '100.3 lx');
  assert.equal(entryMap.get('White Lux'), '64.5 lx');
  assert.equal(entryMap.get('IR Lux'), '12.8 lx');
  assert.equal(entryMap.get('UV Lux'), '1.6 lx');
  assert.equal(entryMap.get('Wind Direction'), '270°');
  assert.equal(entryMap.get('Wind Speed'), '5.9 m/s');
  assert.equal(entryMap.get('Wind Gust'), '7.4 m/s');
  assert.equal(entryMap.get('Wind Lull'), '4.8 m/s');
  assert.equal(entryMap.get('Weight'), '32.70 kg');
  assert.equal(entryMap.get('Radiation'), '0.45 µSv/h');
  assert.equal(entryMap.get('Rainfall 1h'), '0.18 mm');
  assert.equal(entryMap.get('Rainfall 24h'), '1.42 mm');
  assert.equal(entryMap.get('Soil Moisture'), '3100');
  assert.equal(entryMap.get('Soil Temperature'), '18.9°C');
});

test('buildTelemetryDisplayEntries omits empty metrics', () => {
  const entries = buildTelemetryDisplayEntries({ uptime: null }, {
    formatUptime: () => '',
  });
  assert.equal(entries.length, 0);
});
