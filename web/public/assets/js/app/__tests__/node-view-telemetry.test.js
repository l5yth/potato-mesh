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

import { renderTelemetrySvg, renderTelemetryPlot, clampPercent, SERIES_DEFINITIONS } from '../node-view-telemetry.js';

test('clampPercent bounds values between 0 and 100', () => {
  assert.equal(clampPercent(-10), 0);
  assert.equal(clampPercent(50), 50);
  assert.equal(clampPercent(120), 100);
  assert.equal(clampPercent('foo'), null);
});

test('renderTelemetrySvg returns fallback when no data is present', () => {
  const markup = renderTelemetrySvg([], { theme: 'light' });
  assert.match(markup, /No telemetry reported/);
});

test('renderTelemetrySvg renders circles for each metric', () => {
  const ts = Date.UTC(2025, 0, 5);
  const data = [
    {
      timestampMs: ts,
      batteryLevel: 90,
      channelUtilization: 40,
      airUtilTx: 25
    }
  ];
  const markup = renderTelemetrySvg(data, { theme: 'dark', width: 600, height: 260 });
  for (const series of SERIES_DEFINITIONS) {
    assert.match(markup, new RegExp(series.label));
  }
  assert.match(markup, /circle/);
  assert.match(markup, /viewBox="0 0 600 260"/);
});

test('renderTelemetryPlot updates container content', () => {
  const container = { innerHTML: '' };
  const ts = Date.UTC(2025, 0, 6);
  renderTelemetryPlot(
    container,
    [
      {
        timestampMs: ts,
        batteryLevel: 65,
        channelUtilization: 20,
        airUtilTx: 15
      }
    ],
    { theme: 'light' }
  );
  assert.match(container.innerHTML, /Node telemetry over the last seven days/);
});

test('renderTelemetryPlot enforces container argument', () => {
  assert.throws(() => renderTelemetryPlot(null, []), /container element is required/);
});
