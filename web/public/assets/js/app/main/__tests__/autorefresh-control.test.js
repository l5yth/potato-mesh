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

// Regression guard for audit finding D-010 (SPEC UX6 / ACCEPTANCE UX-A4):
// live vs. paused must be visible text, not a glyph-only secret — `● live`
// while streaming, `❚❚ paused HH:MM` when frozen.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  autorefreshControlState,
  pauseTimestampText,
  applyAutorefreshControlState,
} from '../autorefresh-control.js';

test('live state renders the accent dot with visible text', () => {
  const state = autorefreshControlState(false, null);
  assert.equal(state.text, '● live');
  assert.equal(state.ariaLabel, 'Pause auto-refresh');
  assert.equal(state.ariaPressed, 'false');
});

test('paused state renders the pause bars with the freeze timestamp', () => {
  const state = autorefreshControlState(true, '14:32');
  assert.equal(state.text, '❚❚ paused 14:32');
  assert.equal(state.ariaLabel, 'Resume auto-refresh');
  assert.equal(state.ariaPressed, 'true');
});

test('paused state without a timestamp still names the state', () => {
  const state = autorefreshControlState(true, '');
  assert.equal(state.text, '❚❚ paused');
});

test('pauseTimestampText renders a zero-padded 24h clock', () => {
  assert.equal(pauseTimestampText(new Date(2026, 6, 23, 14, 32, 5)), '14:32');
  assert.equal(pauseTimestampText(new Date(2026, 6, 23, 9, 4, 0)), '09:04');
});

test('pauseTimestampText tolerates an invalid date', () => {
  assert.equal(pauseTimestampText(new Date('nope')), '');
  assert.equal(pauseTimestampText(null), '');
});

test('applyAutorefreshControlState writes text and aria state to the button', () => {
  const attrs = {};
  const button = {
    textContent: '',
    setAttribute: (name, value) => {
      attrs[name] = value;
    },
  };
  applyAutorefreshControlState(button, autorefreshControlState(true, '08:01'));
  assert.equal(button.textContent, '❚❚ paused 08:01');
  assert.equal(attrs['aria-label'], 'Resume auto-refresh');
  assert.equal(attrs['aria-pressed'], 'true');
});

test('applyAutorefreshControlState tolerates a missing button', () => {
  assert.doesNotThrow(() => applyAutorefreshControlState(null, autorefreshControlState(false, null)));
});
