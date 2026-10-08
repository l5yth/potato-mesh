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

// Nodes-table number cells (SPEC DV1, design review rc3 T1): bare numbers with
// a fixed number of decimals per column, the unit in the column header. The
// powered battery sentinel and the voltage noise floor keep their UX10 rules.

import test from 'node:test';
import assert from 'node:assert/strict';

import { tableBattery, tableNumber, tableVoltage } from '../table-number-format.js';

test('tableNumber prints a bare number with the given decimals', () => {
  assert.equal(tableNumber(3.907, 2), '3.91');
  assert.equal(tableNumber('4.1', 2), '4.10');
  assert.equal(tableNumber(312.4, 0), '312');
  assert.equal(tableNumber(40.5, 0), '41');
  assert.equal(tableNumber(869, 0), '869');
  assert.equal(tableNumber(-3.5, 1), '-3.5');
  assert.equal(tableNumber(6.25, 1), '6.3');
  assert.equal(tableNumber(0, 1), '0.0', 'an honest zero is a reading');
});

test('tableNumber leaves an absent or unparseable value blank, for the dash', () => {
  for (const value of [null, undefined, '', 'n/a', Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(tableNumber(value, 1), '', `${String(value)} is no reading`);
  }
});

test('tableBattery prints the level bare and keeps the powered sentinel', () => {
  assert.equal(tableBattery(74), '74');
  assert.equal(tableBattery('61'), '61');
  assert.equal(tableBattery(100), '100');
  assert.equal(tableBattery(0), '0', 'an empty battery is a reading');
  assert.equal(tableBattery(101), '100 ⚡');
  assert.equal(tableBattery(255), '100 ⚡');
  assert.equal(tableBattery(null), '');
});

test('tableVoltage prints two decimals and treats noise below 0.01 V as no reading', () => {
  assert.equal(tableVoltage(3.907), '3.91');
  assert.equal(tableVoltage(4.2), '4.20');
  assert.equal(tableVoltage('3.3'), '3.30');
  assert.equal(tableVoltage(0.004), '');
  assert.equal(tableVoltage(-0.001), '');
  assert.equal(tableVoltage(0), '');
  assert.equal(tableVoltage(undefined), '');
});
