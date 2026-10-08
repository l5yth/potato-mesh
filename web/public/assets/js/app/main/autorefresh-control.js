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
 * Visible live/paused state for the auto-refresh toggle (SPEC UX6, CT4, audit
 * D-010).
 *
 * The single most important status on a live dashboard — whether the data is
 * streaming or frozen — must be readable text, not a glyph-only secret, and
 * the text names what a tap does: `● live · pause` while streaming,
 * `❚❚ paused HH:MM · resume` (the freeze moment) when paused. The action
 * renders in its own span, which base.css hides on phones so pausing does not
 * wrap the meta row. The accessible name starts with the visible state words,
 * so it holds the visible label at every width (WCAG 2.5.3), and goes on with
 * the action and what it acts on: `live, pause auto-refresh`. The helpers are
 * pure so the control's contract is unit-testable; the app applies them to the
 * existing `#autorefreshToggle` button, whose server-rendered markup is the
 * live state.
 *
 * @module main/autorefresh-control
 */

/** Class of the span that carries the action (` · pause`, ` · resume`). */
const ACTION_CLASS = 'autorefresh-toggle__action';

/**
 * Build one control state from its parts, so the visible label and the
 * accessible name cannot drift apart.
 *
 * @param {string} glyph State glyph (`●`, `❚❚`); visual only, left out of the name.
 * @param {string} words State words, visible at every width (`live`, `paused 14:32`).
 * @param {string} action What a tap does (`pause`, `resume`).
 * @param {string} ariaPressed `aria-pressed` value: `true` while paused.
 * @returns {{text: string, status: string, ariaLabel: string, ariaPressed: string}} Control state.
 */
function controlState(glyph, words, action, ariaPressed) {
  const status = `${glyph} ${words}`;
  return { text: `${status} · ${action}`, status, ariaLabel: `${words}, ${action} auto-refresh`, ariaPressed };
}

/**
 * Compute the toggle's visible text and ARIA state.
 *
 * @param {boolean} paused Whether auto-refresh (stream + safety poll) is paused.
 * @param {?string} pausedAtText Clock text of the pause moment (`HH:MM`), when
 *   known; blank/omitted renders the bare paused state.
 * @returns {{text: string, status: string, ariaLabel: string, ariaPressed: string}}
 *   Control state: `text` is the whole visible label and starts with `status`,
 *   the glyph and state words that stay visible on phones; the rest names the
 *   action. `ariaLabel` starts with the state words.
 */
export function autorefreshControlState(paused, pausedAtText) {
  if (!paused) return controlState('●', 'live', 'pause', 'false');
  return controlState('❚❚', pausedAtText ? `paused ${pausedAtText}` : 'paused', 'resume', 'true');
}

/**
 * Format a pause moment as a zero-padded 24-hour `HH:MM` clock.
 *
 * @param {?Date} date Pause moment; invalid or missing dates yield `''`.
 * @returns {string} Clock text, or an empty string when unknown.
 */
export function pauseTimestampText(date) {
  if (!date || typeof date.getHours !== 'function' || Number.isNaN(date.getTime())) {
    return '';
  }
  const pad = value => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Write a control state onto the toggle button: the state words as text, then
 * the action in its own span (`● live<span …> · pause</span>`).
 *
 * @param {?Element} button The `#autorefreshToggle` element.
 * @param {{text: string, status: string, ariaLabel: string, ariaPressed: string}} state
 *   State from {@link autorefreshControlState}.
 * @returns {void}
 */
export function applyAutorefreshControlState(button, state) {
  if (!button || typeof button.setAttribute !== 'function') return;
  const action = button.ownerDocument.createElement('span');
  action.setAttribute('class', ACTION_CLASS);
  action.textContent = state.text.slice(state.status.length);
  button.replaceChildren(state.status, action);
  button.setAttribute('aria-label', state.ariaLabel);
  button.setAttribute('aria-pressed', state.ariaPressed);
}
