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
 * Trailing-edge debounce for the node filter box (SPEC DE1, DE2).
 *
 * A filter edit repaints the nodes table, the map and the chat, which costs
 * hundreds of milliseconds on a large mesh, so the repaint waits until typing
 * pauses: each keystroke restarts a {@link FILTER_DEBOUNCE_MS} window, and the
 * repaint runs once, when a window passes without another keystroke. Enter
 * runs a pending repaint at once ({@link FilterDebounce.flush}); any other
 * path that applies the filter drops it ({@link FilterDebounce.cancel}), since
 * that path repaints with the box's current text itself. Only the repaint
 * waits: the caller updates the box's clear button on every keystroke.
 *
 * @module main/filter-debounce
 */

/**
 * Window in milliseconds that a keystroke in the filter box waits for the
 * next one before the filter repaints (SPEC DE1). Inside the decided 150 to
 * 200 ms; the measured basis is recorded with DE1.
 */
export const FILTER_DEBOUNCE_MS = 200;

/**
 * Default timer: `setTimeout`, looked up per call so fake timers apply, and
 * `unref()`-ed where the handle has it (Node), so a pending window never keeps
 * a process alive. Browsers return a number, which is kept as is.
 *
 * @param {Function} callback Work to run when the window passes.
 * @param {number} delay Window in milliseconds.
 * @returns {*} The timer handle.
 */
function defaultSetTimer(callback, delay) {
  const handle = setTimeout(callback, delay);
  if (handle && typeof handle.unref === 'function') handle.unref();
  return handle;
}

/**
 * Default timer canceller, the pair of {@link defaultSetTimer}.
 *
 * @param {*} handle Handle returned by the timer.
 * @returns {void}
 */
function defaultClearTimer(handle) {
  clearTimeout(handle);
}

/**
 * @typedef {Object} FilterDebounce
 * @property {function(): void} schedule Start the window, or restart the one
 *   running; `apply` runs once it passes.
 * @property {function(): boolean} flush Run a pending `apply` now and drop its
 *   window. Returns whether one was pending; with none it runs nothing.
 * @property {function(): boolean} cancel Drop a pending `apply` without
 *   running it. Returns whether one was pending.
 * @property {function(): boolean} isPending Whether an `apply` waits for its
 *   window.
 */

/**
 * Create a trailing-edge debounce around `apply`.
 *
 * @param {function(): void} apply Work to run once a window passes: the
 *   filter repaint.
 * @param {{
 *   delayMs?: number,
 *   setTimer?: function(Function, number): *,
 *   clearTimer?: function(*): void
 * }} [options] `delayMs` defaults to {@link FILTER_DEBOUNCE_MS}; `setTimer`
 *   and `clearTimer` default to `setTimeout` and `clearTimeout`.
 * @returns {FilterDebounce} The debounce.
 * @throws {TypeError} When `apply` is not a function.
 */
export function createFilterDebounce(apply, { delayMs = FILTER_DEBOUNCE_MS, setTimer = defaultSetTimer, clearTimer = defaultClearTimer } = {}) {
  if (typeof apply !== 'function') {
    throw new TypeError('createFilterDebounce: apply must be a function');
  }
  let handle = null;
  let armed = false;

  /**
   * Drop the running window, if any.
   *
   * @returns {boolean} Whether a window was running.
   */
  function cancel() {
    if (!armed) return false;
    armed = false;
    clearTimer(handle);
    handle = null;
    return true;
  }

  /**
   * Timer callback: the window passed. Disarms before `apply`, so `apply`
   * may schedule the next window and a throwing `apply` leaves none pending.
   *
   * @returns {void}
   */
  function fire() {
    armed = false;
    handle = null;
    apply();
  }

  /**
   * Start the window, or restart the one running.
   *
   * @returns {void}
   */
  function schedule() {
    cancel();
    handle = setTimer(fire, delayMs);
    armed = true;
  }

  /**
   * Run a pending `apply` now and drop its window.
   *
   * @returns {boolean} Whether one was pending; with none, nothing ran.
   */
  function flush() {
    if (!cancel()) return false;
    apply();
    return true;
  }

  /**
   * Whether an `apply` waits for its window.
   *
   * @returns {boolean}
   */
  function isPending() {
    return armed;
  }

  return { schedule, flush, cancel, isPending };
}
