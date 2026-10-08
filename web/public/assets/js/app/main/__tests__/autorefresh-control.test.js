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

// Regression guard for audit finding D-010 (SPEC UX6, CT4 / ACCEPTANCE UX-A4,
// CT-A4): live vs. paused must be visible text, not a glyph-only secret, and
// the text names what a tap does: `● live · pause` while streaming,
// `❚❚ paused HH:MM · resume` when frozen. The accessible name starts with the
// visible state words, so it holds the visible label at every width (WCAG
// 2.5.3), the action hidden from view on phones included.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  autorefreshControlState,
  pauseTimestampText,
  applyAutorefreshControlState,
} from '../autorefresh-control.js';
import { createLiveDocument } from '../../__tests__/live-dom-model.js';
import { declarationsFor } from '../../__tests__/base-css-rules.js';

/** Class of the span carrying the action; base.css hides it on phones. */
const ACTION_CLASS = 'autorefresh-toggle__action';

/** The dashboard layout, which server-renders the toggle. */
const LAYOUT_PATH = fileURLToPath(new URL('../../../../../../views/layouts/app.erb', import.meta.url));

/**
 * A `<button>` of the live DOM model, with the `ownerDocument` the browser
 * gives every element.
 *
 * @returns {Object} Live button element.
 */
function liveButton() {
  const { document } = createLiveDocument();
  const button = document.createElement('button');
  button.ownerDocument = document;
  return button;
}

test('live state names the pause action after the accent dot', () => {
  const state = autorefreshControlState(false, null);
  assert.equal(state.text, '● live · pause');
  assert.equal(state.status, '● live');
  assert.equal(state.ariaLabel, 'live, pause auto-refresh');
  assert.equal(state.ariaPressed, 'false');
});

test('paused state keeps the freeze timestamp and names the resume action', () => {
  const state = autorefreshControlState(true, '14:32');
  assert.equal(state.text, '❚❚ paused 14:32 · resume');
  assert.equal(state.status, '❚❚ paused 14:32');
  assert.equal(state.ariaLabel, 'paused 14:32, resume auto-refresh');
  assert.equal(state.ariaPressed, 'true');
});

test('paused state without a timestamp still names the state and the action', () => {
  const state = autorefreshControlState(true, '');
  assert.equal(state.text, '❚❚ paused · resume');
  assert.equal(state.status, '❚❚ paused');
  assert.equal(state.ariaLabel, 'paused, resume auto-refresh');
});

test('the accessible name starts with the visible state words and names the action (WCAG 2.5.3)', () => {
  for (const state of [autorefreshControlState(false, null), autorefreshControlState(true, '14:32'), autorefreshControlState(true, '')]) {
    // The state words follow the glyph and stay visible on phones; the action
    // follows the separator and shows from 660 px up.
    const words = state.status.slice(state.status.indexOf(' ') + 1);
    const action = state.text.slice(state.text.lastIndexOf(' · ') + 3);
    assert.ok(state.ariaLabel.startsWith(`${words}, `), `${state.ariaLabel} starts with ${words}`);
    assert.ok(state.ariaLabel.includes(`${action} auto-refresh`), `${state.ariaLabel} names ${action}`);
    assert.doesNotMatch(state.ariaLabel, /[●❚]/, 'the glyph stays visual');
  }
});

test('pauseTimestampText renders a zero-padded 24h clock', () => {
  assert.equal(pauseTimestampText(new Date(2026, 6, 23, 14, 32, 5)), '14:32');
  assert.equal(pauseTimestampText(new Date(2026, 6, 23, 9, 4, 0)), '09:04');
});

test('pauseTimestampText tolerates an invalid date', () => {
  assert.equal(pauseTimestampText(new Date('nope')), '');
  assert.equal(pauseTimestampText(null), '');
});

test('applyAutorefreshControlState renders the action in its own span and writes the aria state', () => {
  const button = liveButton();
  applyAutorefreshControlState(button, autorefreshControlState(true, '08:01'));
  assert.equal(button.textContent, '❚❚ paused 08:01 · resume');
  assert.equal(button.innerHTML, `❚❚ paused 08:01<span class="${ACTION_CLASS}"> · resume</span>`);
  assert.equal(button.getAttribute('aria-label'), 'paused 08:01, resume auto-refresh');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
});

test('applyAutorefreshControlState replaces the previous label', () => {
  const button = liveButton();
  applyAutorefreshControlState(button, autorefreshControlState(true, '08:01'));
  applyAutorefreshControlState(button, autorefreshControlState(false, null));
  assert.equal(button.innerHTML, `● live<span class="${ACTION_CLASS}"> · pause</span>`);
  assert.equal(button.getAttribute('aria-label'), 'live, pause auto-refresh');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
});

test('applyAutorefreshControlState tolerates a missing button', () => {
  assert.doesNotThrow(() => applyAutorefreshControlState(null, autorefreshControlState(false, null)));
});

test('the server renders the live state, so the first apply changes nothing (CT3, CT4)', () => {
  const served = readFileSync(LAYOUT_PATH, 'utf8').match(/<button id="autorefreshToggle"([^>]*)>([^]*?)<\/button>/);
  assert.ok(served, 'app.erb renders #autorefreshToggle');
  const live = autorefreshControlState(false, null);
  assert.ok(served[1].includes(`aria-label="${live.ariaLabel}"`), served[1]);
  assert.ok(served[1].includes(`aria-pressed="${live.ariaPressed}"`), served[1]);
  const parsed = liveButton();
  parsed.innerHTML = served[2];
  const applied = liveButton();
  applyAutorefreshControlState(applied, live);
  assert.equal(parsed.innerHTML, applied.innerHTML);
});

test('base.css draws the toggle as a pill, framed in the accent while paused (CT4)', () => {
  const live = declarationsFor('#autorefreshToggle[aria-pressed="false"]');
  const paused = declarationsFor('#autorefreshToggle[aria-pressed="true"]');
  assert.equal(declarationsFor('#autorefreshToggle')['border-radius'], '999px');
  assert.equal(live.color, 'var(--accent)');
  assert.equal(paused.color, 'var(--muted)');
  assert.equal(paused['border-color'], 'var(--accent)');
});

test('base.css hides the action on phones only, leaving it in the DOM (CT4)', () => {
  const phone = declarationsFor(`.${ACTION_CLASS}`, { media: '(max-width: 659px)' });
  const hidden = { position: phone.position, width: phone.width, overflow: phone.overflow, clip: phone.clip, display: phone.display };
  assert.deepEqual(hidden, { position: 'absolute', width: '1px', overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', display: undefined });
  assert.equal(declarationsFor(`.${ACTION_CLASS}`).position, undefined, 'the action shows from 660 px up');
});
