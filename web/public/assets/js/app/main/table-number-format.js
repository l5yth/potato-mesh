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

/**
 * Number cells of the nodes table (SPEC DV1, design review rc3 T1).
 *
 * Each numeric column names its unit once, in its header, so a cell is a bare
 * number with the same number of decimals on every row: the digits and the
 * decimal points line up under `tabular-nums`. The values keep the UX10 rules
 * (the powered battery sentinel, the voltage noise floor). The `+` disclosure
 * row and the overlays keep the unit-bearing formatters of
 * `short-info-telemetry.js`, because their values stand alone.
 *
 * An absent value returns `''`, which `formatTableCell` renders as the muted
 * dash (SPEC UX4).
 *
 * @module main/table-number-format
 */

/** Powered sentinel: the firmware reports a level above 100 on external power. */
const POWERED_BATTERY = '100 ⚡';

/** Voltages below this magnitude are sense-line noise, not a reading (UX10). */
const VOLTAGE_NOISE_FLOOR = 0.01;

/**
 * Parse a raw value as a finite number.
 *
 * @param {*} value Raw value.
 * @returns {?number} The number, or `null` for an absent or unparseable value.
 */
function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Format a bare table number with a fixed number of decimals.
 *
 * @param {*} value Raw value.
 * @param {number} decimals Digits after the decimal point.
 * @returns {string} The number, or `''` without a reading.
 */
export function tableNumber(value, decimals) {
  const number = finiteOrNull(value);
  return number === null ? '' : number.toFixed(decimals);
}

/**
 * Format a battery level as a bare whole percentage.
 *
 * @param {*} value Raw battery level.
 * @returns {string} The level, `100 ⚡` above 100, or `''` without a reading.
 */
export function tableBattery(value) {
  const number = finiteOrNull(value);
  if (number === null) return '';
  return number > 100 ? POWERED_BATTERY : number.toFixed(0);
}

/**
 * Format a battery voltage as a bare number with two decimals.
 *
 * @param {*} value Raw voltage.
 * @returns {string} The voltage, or `''` without a reading or below the noise floor.
 */
export function tableVoltage(value) {
  const number = finiteOrNull(value);
  if (number === null || Math.abs(number) < VOLTAGE_NOISE_FLOOR) return '';
  return number.toFixed(2);
}
