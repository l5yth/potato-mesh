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
 * Visible live/paused state for the auto-refresh toggle (SPEC UX6, audit
 * D-010).
 *
 * The single most important status on a live dashboard — whether the data is
 * streaming or frozen — must be readable text, not a glyph-only secret:
 * `● live` while streaming, `❚❚ paused HH:MM` (the freeze moment) when
 * paused. The helpers are pure so the control's contract is unit-testable;
 * the app applies them to the existing `#autorefreshToggle` button.
 *
 * @module main/autorefresh-control
 */

/**
 * Compute the toggle's visible text and ARIA state.
 *
 * @param {boolean} paused Whether auto-refresh (stream + safety poll) is paused.
 * @param {?string} pausedAtText Clock text of the pause moment (`HH:MM`), when
 *   known; blank/omitted renders the bare paused state.
 * @returns {{text: string, ariaLabel: string, ariaPressed: string}} Control state.
 */
export function autorefreshControlState(paused, pausedAtText) {
  if (!paused) {
    return { text: '● live', ariaLabel: 'Pause auto-refresh', ariaPressed: 'false' };
  }
  const stamp = pausedAtText ? ` ${pausedAtText}` : '';
  return {
    text: `❚❚ paused${stamp}`,
    ariaLabel: 'Resume auto-refresh',
    ariaPressed: 'true',
  };
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
 * Write a control state onto the toggle button.
 *
 * @param {?Element} button The `#autorefreshToggle` element.
 * @param {{text: string, ariaLabel: string, ariaPressed: string}} state State
 *   from {@link autorefreshControlState}.
 * @returns {void}
 */
export function applyAutorefreshControlState(button, state) {
  if (!button || typeof button.setAttribute !== 'function') return;
  button.textContent = state.text;
  button.setAttribute('aria-label', state.ariaLabel);
  button.setAttribute('aria-pressed', state.ariaPressed);
}
