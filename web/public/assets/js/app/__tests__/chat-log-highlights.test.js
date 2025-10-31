/*
 * Copyright (C) 2025 l5yth
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

import { formatPositionHighlights, formatTelemetryHighlights } from '../chat-log-highlights.js';

test('formatTelemetryHighlights includes formatted numeric metrics', () => {
  const highlights = formatTelemetryHighlights({
    temperature: 21.44,
    relative_humidity: 54.27,
  });

  assert.deepEqual(highlights, [
    { label: 'Temperature', value: '21.4°C' },
    { label: 'Humidity', value: '54.3%' },
  ]);
});

test('formatTelemetryHighlights prefers nested telemetry when top-level values are stale', () => {
  const highlights = formatTelemetryHighlights({
    channel_utilization: 0,
    device_metrics: { channelUtilization: 0.561 },
  });

  assert.deepEqual(highlights, [
    { label: 'Channel Util', value: '0.561%' },
  ]);
});

test('formatPositionHighlights renders coordinate and movement data', () => {
  const highlights = formatPositionHighlights({
    latitude: 52.1234567,
    longitude: 13.7654321,
    altitude: 150.5,
    accuracy: 3.2,
    speed: 1.234,
    heading: 181.6,
    satellites: 7,
  });

  assert.deepEqual(highlights, [
    { label: 'Lat', value: '52.12346' },
    { label: 'Lon', value: '13.76543' },
    { label: 'Alt', value: '150.5m' },
    { label: 'Accuracy', value: '3.2m' },
    { label: 'Speed', value: '1.2 m/s' },
    { label: 'Heading', value: '182°' },
    { label: 'Sats', value: '7' },
  ]);
});

test('formatPositionHighlights normalises integer microdegree fields', () => {
  const highlights = formatPositionHighlights({
    position: {
      latitude_i: 52_123_456,
      longitude_i: 13_765_432,
    },
  });

  assert.deepEqual(highlights.slice(0, 2), [
    { label: 'Lat', value: '52.12346' },
    { label: 'Lon', value: '13.76543' },
  ]);
});

test('formatters return empty arrays when payloads are missing', () => {
  assert.deepEqual(formatTelemetryHighlights(null), []);
  assert.deepEqual(formatPositionHighlights(undefined), []);
  assert.deepEqual(formatPositionHighlights({}), []);
});
