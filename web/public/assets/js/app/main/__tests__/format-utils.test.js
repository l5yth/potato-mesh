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
  cssEscape,
  fmtCoords,
  fmtHw,
  formatDate,
  formatShortInfoUptime,
  formatSnrDisplay,
  formatTime,
  pad,
  parseNodeNumericRef,
  pickFirstProperty,
  pickNumericProperty,
  resolveTimestampSeconds,
  shortInfoValueOrDash,
  timeAgo,
  timeHum,
  toFiniteNumber,
} from '../format-utils.js';

// ---------------------------------------------------------------------------
// pad / formatTime / formatDate
// ---------------------------------------------------------------------------

test('pad pads small numbers to two digits', () => {
  assert.equal(pad(0), '00');
  assert.equal(pad(7), '07');
  assert.equal(pad(42), '42');
});

test('formatTime renders HH:MM:SS', () => {
  const d = new Date(2026, 0, 1, 9, 5, 7); // Local time.
  assert.equal(formatTime(d), '09:05:07');
});

test('formatDate renders YYYY-MM-DD', () => {
  const d = new Date(2026, 0, 9); // Jan 9, 2026 local.
  assert.equal(formatDate(d), '2026-01-09');
});

// ---------------------------------------------------------------------------
// fmtHw
// ---------------------------------------------------------------------------

test('fmtHw passes through normal values', () => {
  assert.equal(fmtHw('TBEAM'), 'TBEAM');
});

test('fmtHw hides the UNSET sentinel', () => {
  assert.equal(fmtHw('UNSET'), '');
});

test('fmtHw returns empty string for falsy input', () => {
  assert.equal(fmtHw(null), '');
  assert.equal(fmtHw(''), '');
  assert.equal(fmtHw(undefined), '');
});

// ---------------------------------------------------------------------------
// fmtCoords
// ---------------------------------------------------------------------------

test('fmtCoords formats numbers with default precision 5', () => {
  assert.equal(fmtCoords(52.520008), '52.52001');
});

test('fmtCoords accepts a custom precision', () => {
  assert.equal(fmtCoords(52.520008, 2), '52.52');
});

test('fmtCoords returns empty string for null, undefined, and empty', () => {
  assert.equal(fmtCoords(null), '');
  assert.equal(fmtCoords(undefined), '');
  assert.equal(fmtCoords(''), '');
});

test('fmtCoords returns empty string for non-numeric input', () => {
  assert.equal(fmtCoords('not a number'), '');
});

// ---------------------------------------------------------------------------
// formatSnrDisplay
// ---------------------------------------------------------------------------

test('formatSnrDisplay appends dB suffix with one decimal', () => {
  assert.equal(formatSnrDisplay(7.49), '7.5 dB');
  assert.equal(formatSnrDisplay(-3), '-3.0 dB');
});

test('formatSnrDisplay returns empty string for null and empty input', () => {
  assert.equal(formatSnrDisplay(null), '');
  assert.equal(formatSnrDisplay(''), '');
});

test('formatSnrDisplay returns empty string for non-finite input', () => {
  assert.equal(formatSnrDisplay('abc'), '');
});

// ---------------------------------------------------------------------------
// timeHum
// ---------------------------------------------------------------------------

test('timeHum returns empty string for falsy input', () => {
  assert.equal(timeHum(0), '');
  assert.equal(timeHum(null), '');
});

test('timeHum returns 0s for negative durations', () => {
  assert.equal(timeHum(-5), '0s');
});

test('timeHum formats sub-minute durations as seconds', () => {
  assert.equal(timeHum(45), '45s');
});

test('timeHum formats sub-hour durations as minutes and seconds', () => {
  assert.equal(timeHum(125), '2m 5s');
});

test('timeHum formats sub-day durations as hours and minutes', () => {
  assert.equal(timeHum(3700), '1h 1m');
});

test('timeHum formats day-scale durations as days and hours', () => {
  assert.equal(timeHum(90061), '1d 1h');
});

// ---------------------------------------------------------------------------
// timeAgo
// ---------------------------------------------------------------------------

test('timeAgo returns empty string when the input is missing', () => {
  assert.equal(timeAgo(0), '');
  assert.equal(timeAgo(null), '');
});

test('timeAgo clamps future timestamps to 0s', () => {
  assert.equal(timeAgo(5000, 1000), '0s');
});

test('timeAgo formats sub-minute deltas as seconds', () => {
  assert.equal(timeAgo(950, 1000), '50s');
});

test('timeAgo formats sub-hour deltas as minutes and seconds', () => {
  assert.equal(timeAgo(875, 1000), '2m 5s');
});

test('timeAgo formats sub-day deltas as hours and minutes', () => {
  // Use a non-zero past timestamp; timeAgo treats 0 as "missing" and returns "".
  assert.equal(timeAgo(1000, 4700), '1h 1m');
});

test('timeAgo formats day-scale deltas as days and hours', () => {
  assert.equal(timeAgo(1000, 91061), '1d 1h');
});

// ---------------------------------------------------------------------------
// toFiniteNumber
// ---------------------------------------------------------------------------

test('toFiniteNumber converts numeric strings', () => {
  assert.equal(toFiniteNumber('42'), 42);
});

test('toFiniteNumber returns null for null, undefined, and empty', () => {
  assert.equal(toFiniteNumber(null), null);
  assert.equal(toFiniteNumber(undefined), null);
  assert.equal(toFiniteNumber(''), null);
});

test('toFiniteNumber rejects non-finite values', () => {
  assert.equal(toFiniteNumber('abc'), null);
  assert.equal(toFiniteNumber(Number.NaN), null);
  assert.equal(toFiniteNumber(Number.POSITIVE_INFINITY), null);
});

// ---------------------------------------------------------------------------
// resolveTimestampSeconds
// ---------------------------------------------------------------------------

test('resolveTimestampSeconds prefers a numeric timestamp', () => {
  assert.equal(resolveTimestampSeconds(1700000000, '2024-01-01T00:00:00Z'), 1700000000);
});

test('resolveTimestampSeconds falls back to ISO when numeric is missing', () => {
  // 2024-01-01T00:00:00Z = 1704067200 seconds.
  assert.equal(resolveTimestampSeconds(null, '2024-01-01T00:00:00Z'), 1704067200);
});

test('resolveTimestampSeconds returns null when both inputs are unusable', () => {
  assert.equal(resolveTimestampSeconds(null, null), null);
  assert.equal(resolveTimestampSeconds(null, ''), null);
  assert.equal(resolveTimestampSeconds(null, 'not a date'), null);
});

// ---------------------------------------------------------------------------
// cssEscape
// ---------------------------------------------------------------------------

test('cssEscape returns empty string for non-strings and empty input', () => {
  assert.equal(cssEscape(''), '');
  assert.equal(cssEscape(null), '');
  assert.equal(cssEscape(undefined), '');
  assert.equal(cssEscape(42), '');
});

test('cssEscape uses window.CSS.escape when available', () => {
  const previous = globalThis.window;
  globalThis.window = {
    CSS: {
      escape: value => `escaped(${value})`,
    },
  };
  try {
    assert.equal(cssEscape('foo'), 'escaped(foo)');
  } finally {
    if (previous === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previous;
    }
  }
});

test('cssEscape falls back to manual escaping when window.CSS is unavailable', () => {
  const previous = globalThis.window;
  delete globalThis.window;
  try {
    // Underscores and hyphens pass through; everything else is backslash-escaped.
    assert.equal(cssEscape('a-b_c'), 'a-b_c');
    assert.equal(cssEscape('a:b'), 'a\\:b');
  } finally {
    if (previous !== undefined) {
      globalThis.window = previous;
    }
  }
});

// ---------------------------------------------------------------------------
// formatShortInfoUptime
// ---------------------------------------------------------------------------

test('formatShortInfoUptime returns empty string for null and empty', () => {
  assert.equal(formatShortInfoUptime(null), '');
  assert.equal(formatShortInfoUptime(''), '');
});

test('formatShortInfoUptime returns empty string for non-finite input', () => {
  assert.equal(formatShortInfoUptime('abc'), '');
});

test('formatShortInfoUptime renders 0s for zero', () => {
  assert.equal(formatShortInfoUptime(0), '0s');
});

test('formatShortInfoUptime delegates to timeHum for positive values', () => {
  assert.equal(formatShortInfoUptime(125), '2m 5s');
});

// ---------------------------------------------------------------------------
// shortInfoValueOrDash
// ---------------------------------------------------------------------------

test('shortInfoValueOrDash returns the string form of present values', () => {
  assert.equal(shortInfoValueOrDash('text'), 'text');
  assert.equal(shortInfoValueOrDash(0), '0');
});

test('shortInfoValueOrDash returns em dash for null, undefined, and empty', () => {
  assert.equal(shortInfoValueOrDash(null), '—');
  assert.equal(shortInfoValueOrDash(undefined), '—');
  assert.equal(shortInfoValueOrDash(''), '—');
});

// ---------------------------------------------------------------------------
// pickFirstProperty
// ---------------------------------------------------------------------------

test('pickFirstProperty returns null when sources or keys are not arrays', () => {
  assert.equal(pickFirstProperty(null, ['a']), null);
  assert.equal(pickFirstProperty([{}], null), null);
});

test('pickFirstProperty returns the first present trimmed string', () => {
  const sources = [
    {},
    { id: '   ' },
    { id: '  hello  ' },
  ];
  assert.equal(pickFirstProperty(sources, ['id']), 'hello');
});

test('pickFirstProperty returns the first non-string value verbatim', () => {
  assert.equal(pickFirstProperty([{ count: 5 }], ['count']), 5);
  assert.equal(pickFirstProperty([{ flag: false }], ['flag']), false);
});

test('pickFirstProperty skips non-object entries and absent properties', () => {
  const sources = [null, 42, { other: 'value' }, { name: 'final' }];
  assert.equal(pickFirstProperty(sources, ['name']), 'final');
});

test('pickFirstProperty returns null when no source provides a value', () => {
  assert.equal(pickFirstProperty([{ a: null }, { a: '' }], ['a']), null);
});

// ---------------------------------------------------------------------------
// pickNumericProperty
// ---------------------------------------------------------------------------

test('pickNumericProperty returns null when sources or keys are not arrays', () => {
  assert.equal(pickNumericProperty(null, ['a']), null);
  assert.equal(pickNumericProperty([{}], null), null);
});

test('pickNumericProperty returns the first finite numeric value', () => {
  const sources = [
    { value: '' },
    { value: 'abc' },
    { value: '42' },
  ];
  assert.equal(pickNumericProperty(sources, ['value']), 42);
});

test('pickNumericProperty skips non-object entries and missing keys', () => {
  const sources = [null, undefined, { other: 1 }, { count: 7 }];
  assert.equal(pickNumericProperty(sources, ['count']), 7);
});

test('pickNumericProperty returns null when no candidate is finite', () => {
  assert.equal(pickNumericProperty([{ a: 'abc' }, { a: null }], ['a']), null);
});

// ---------------------------------------------------------------------------
// parseNodeNumericRef
// ---------------------------------------------------------------------------

test('parseNodeNumericRef returns null for null and undefined', () => {
  assert.equal(parseNodeNumericRef(null), null);
  assert.equal(parseNodeNumericRef(undefined), null);
});

test('parseNodeNumericRef passes through finite numbers', () => {
  assert.equal(parseNodeNumericRef(42), 42);
});

test('parseNodeNumericRef returns null for non-finite numbers', () => {
  assert.equal(parseNodeNumericRef(Number.NaN), null);
  assert.equal(parseNodeNumericRef(Number.POSITIVE_INFINITY), null);
});

test('parseNodeNumericRef parses !-prefixed hex strings', () => {
  assert.equal(parseNodeNumericRef('!aabbccdd'), 0xaabbccdd);
});

test('parseNodeNumericRef rejects !-prefixed strings with invalid characters', () => {
  assert.equal(parseNodeNumericRef('!ZZZ'), null);
});

test('parseNodeNumericRef parses 0x-prefixed hex strings', () => {
  assert.equal(parseNodeNumericRef('0x1A'), 0x1a);
});

test('parseNodeNumericRef parses decimal strings', () => {
  assert.equal(parseNodeNumericRef('123'), 123);
});

test('parseNodeNumericRef returns null for blank strings', () => {
  assert.equal(parseNodeNumericRef(''), null);
  assert.equal(parseNodeNumericRef('   '), null);
});

test('parseNodeNumericRef returns null for unparseable strings', () => {
  assert.equal(parseNodeNumericRef('not a number'), null);
});

test('parseNodeNumericRef coerces other inputs via Number()', () => {
  // Booleans, Date, etc. — anything the global Number() constructor can
  // map to a finite number passes through.
  assert.equal(parseNodeNumericRef(true), 1);
  assert.equal(parseNodeNumericRef(false), 0);
});

test('parseNodeNumericRef returns null for unparseable non-string inputs', () => {
  assert.equal(parseNodeNumericRef({}), null);
});
