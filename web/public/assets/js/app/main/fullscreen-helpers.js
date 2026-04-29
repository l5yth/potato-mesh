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
 * Pure helpers for the Fullscreen API used by the map fullscreen toggle.
 *
 * @module main/fullscreen-helpers
 */

/**
 * Resolve the element currently being displayed in fullscreen mode.
 *
 * @returns {Element|null} Active fullscreen element if any.
 */
export function getActiveFullscreenElement() {
  if (typeof document === 'undefined') return null;
  return (
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.msFullscreenElement ||
    null
  );
}

/**
 * Wrap a legend button click handler so it always calls
 * ``preventDefault`` and ``stopPropagation`` before running the body.
 *
 * Centralising this prevents the two-line boilerplate from repeating in every
 * legend button handler, reducing token-level duplication.
 *
 * @param {function(Event): void} fn Handler body.
 * @returns {function(Event): void} Full click listener.
 */
export function legendClickHandler(fn) {
  return (event) => {
    event.preventDefault();
    event.stopPropagation();
    fn(event);
  };
}
