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
 * Pure value-presence guards and comparators for the nodes table.
 *
 * @module main/sort-comparators
 */

/**
 * Determine whether a value should count as present when sorting strings.
 *
 * @param {*} value Candidate value extracted from a node record.
 * @returns {boolean} True when the value is a non-empty string.
 */
export function hasStringValue(value) {
  if (value == null) return false;
  return String(value).trim().length > 0;
}

/**
 * Determine whether the provided value can be interpreted as a finite number.
 *
 * @param {*} value Candidate value extracted from a node record.
 * @returns {boolean} True when the value parses to a finite number.
 */
export function hasNumberValue(value) {
  if (value == null || value === '') return false;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num);
}

/**
 * Locale-aware comparator for string table values.
 *
 * @param {*} a First value.
 * @param {*} b Second value.
 * @returns {number} Comparator result compatible with ``Array.prototype.sort``.
 */
export function compareString(a, b) {
  const strA = (a == null ? '' : String(a)).trim();
  const strB = (b == null ? '' : String(b)).trim();
  const hasA = strA.length > 0;
  const hasB = strB.length > 0;
  if (!hasA && !hasB) return 0;
  if (!hasA) return 1;
  if (!hasB) return -1;
  return strA.localeCompare(strB, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Comparator for numeric table values that tolerates string inputs.
 *
 * @param {*} a First value.
 * @param {*} b Second value.
 * @returns {number} Comparator result for ``Array.prototype.sort``.
 */
export function compareNumber(a, b) {
  const numA = typeof a === 'number' ? a : Number(a);
  const numB = typeof b === 'number' ? b : Number(b);
  const validA = Number.isFinite(numA);
  const validB = Number.isFinite(numB);
  if (validA && validB) {
    if (numA === numB) return 0;
    return numA < numB ? -1 : 1;
  }
  if (validA) return -1;
  if (validB) return 1;
  return 0;
}
