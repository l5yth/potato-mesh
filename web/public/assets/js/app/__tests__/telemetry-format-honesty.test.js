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

// Regression guard for audit finding D-022 (SPEC UX10 / ACCEPTANCE UX-A8):
// utilisation at 1 decimal, battery clamped at the powered sentinel, and
// below-noise voltage treated as no reading.

import test from 'node:test';
import assert from 'node:assert/strict';

import { fmtTx, fmtBattery, fmtVoltage } from '../short-info-telemetry.js';

test('utilisation defaults to one decimal', () => {
  assert.equal(fmtTx(1.6789), '1.7%');
  assert.equal(fmtTx(0), '0.0%');
  assert.equal(fmtTx('12.35'), '12.3%');
  assert.equal(fmtTx(null), '');
});

test('battery above 100 renders as the powered sentinel', () => {
  assert.equal(fmtBattery(101), '100% ⚡');
  assert.equal(fmtBattery(255), '100% ⚡');
});

test('battery within range renders plainly', () => {
  assert.equal(fmtBattery(83), '83%');
  assert.equal(fmtBattery(100), '100%');
  assert.equal(fmtBattery(0), '0%');
});

test('battery without a reading renders empty', () => {
  assert.equal(fmtBattery(null), '');
  assert.equal(fmtBattery('nope'), '');
});

test('voltage below 0.01 V counts as no reading', () => {
  assert.equal(fmtVoltage(-0.001), '');
  assert.equal(fmtVoltage(0.009), '');
  assert.equal(fmtVoltage(0), '');
});

test('real voltages render with the unit', () => {
  assert.equal(fmtVoltage(3.907), '3.907V');
  assert.equal(fmtVoltage('4.1'), '4.1V');
  assert.equal(fmtVoltage(null), '');
});
