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
 * Day dividers and empty-state notes of the chat panels (#881, SPEC DR1).
 *
 * Besides its entries, a chat panel holds a ``-- YYYY-MM-DD --`` divider before
 * the first entry of each day and, when it has no entries, a note saying so.
 * The entry cache ({@link module:main/chat-entry-cache}) keeps entry nodes
 * across refreshes; this module does the same for these structural nodes,
 * keyed per panel, so a refresh that changes nothing in a panel hands back the
 * same nodes and the panel needs no DOM change.
 *
 * @module main/chat-panel-chrome
 */

import { formatDate } from './format-utils.js';

/**
 * One panel build: hands out the panel's dividers and empty note while the
 * caller walks its entries in display order.
 *
 * @typedef {Object} ChatPanelChromeBuild
 * @property {function(number): ?HTMLElement} divider Divider to place before an
 *   entry stamped ``ts`` (Unix seconds), or ``null`` when the entry continues
 *   the previous entry's day or has no timestamp.
 * @property {function(string): HTMLElement} empty The panel's empty-state note,
 *   showing ``label``.
 * @property {function(): void} finish Release dividers this build did not use.
 */

/**
 * Create the divider and empty-note store for every chat panel.
 *
 * @param {{ documentRef?: Document }} [options] Optional document override; the
 *   ambient ``document`` is used when omitted.
 * @returns {{
 *   begin: function(string): ChatPanelChromeBuild,
 *   retainNamespaces: function(Iterable<string>): void,
 *   size: function(string): number
 * }} Store API. A namespace is a tab id, as in the entry cache.
 */
export function createChatPanelChrome({ documentRef } = {}) {
  const doc = documentRef ?? (typeof document !== 'undefined' ? document : null);
  if (!doc || typeof doc.createElement !== 'function') {
    throw new TypeError('createChatPanelChrome requires a document with createElement');
  }

  /** @type {Map<string, { dividers: Map<string, HTMLElement>, empty: ?HTMLElement }>} */
  const panels = new Map();

  /**
   * Resolve (creating if needed) the stored nodes of one panel.
   *
   * @param {string} namespace Tab identifier.
   * @returns {{ dividers: Map<string, HTMLElement>, empty: ?HTMLElement }} Panel state.
   */
  function panelState(namespace) {
    let state = panels.get(namespace);
    if (!state) {
      state = { dividers: new Map(), empty: null };
      panels.set(namespace, state);
    }
    return state;
  }

  /**
   * Start building one panel.
   *
   * @param {string} namespace Tab identifier.
   * @returns {ChatPanelChromeBuild} Build handle for this panel.
   */
  function begin(namespace) {
    const state = panelState(namespace);
    const used = new Set();
    // Runs per day: entries out of time order can start a day twice, and each
    // run keeps its own divider, as before dividers were kept.
    const runs = new Map();
    let lastDay = null;

    return {
      /**
       * Divider to place before an entry stamped ``ts``.
       *
       * @param {number} ts Entry time, Unix seconds.
       * @returns {?HTMLElement} The day's divider, or ``null`` when the entry
       *   continues the previous entry's day or has no timestamp.
       */
      divider(ts) {
        if (!ts) {
          return null;
        }
        const day = formatDate(new Date(ts * 1000));
        if (day === lastDay) {
          return null;
        }
        lastDay = day;
        const run = runs.get(day) || 0;
        runs.set(day, run + 1);
        const key = run === 0 ? day : `${day}#${run}`;
        used.add(key);
        let node = state.dividers.get(key);
        if (!node) {
          node = doc.createElement('div');
          node.className = 'chat-entry-date';
          node.textContent = `-- ${day} --`;
          state.dividers.set(key, node);
        }
        return node;
      },
      /**
       * The panel's empty-state note; its text is written only on a change.
       *
       * @param {string} label Note text.
       * @returns {HTMLElement} The note.
       */
      empty(label) {
        if (!state.empty) {
          state.empty = doc.createElement('p');
          state.empty.className = 'chat-empty';
        }
        if (state.empty.textContent !== label) {
          state.empty.textContent = label;
        }
        return state.empty;
      },
      /**
       * Release the dividers this build did not hand out (days that left the
       * panel).
       *
       * @returns {void}
       */
      finish() {
        for (const key of [...state.dividers.keys()]) {
          if (!used.has(key)) {
            state.dividers.delete(key);
          }
        }
      }
    };
  }

  /**
   * Forget the panels of tabs not in ``activeNamespaces`` (a channel that left
   * the window), mirroring the entry cache.
   *
   * @param {Iterable<string>} activeNamespaces Tab identifiers to keep.
   * @returns {void}
   */
  function retainNamespaces(activeNamespaces) {
    const keep = activeNamespaces instanceof Set ? activeNamespaces : new Set(activeNamespaces);
    for (const namespace of [...panels.keys()]) {
      if (!keep.has(namespace)) {
        panels.delete(namespace);
      }
    }
  }

  /**
   * Number of stored dividers of one panel.
   *
   * @param {string} namespace Tab identifier.
   * @returns {number} Stored divider count.
   */
  function size(namespace) {
    const state = panels.get(namespace);
    return state ? state.dividers.size : 0;
  }

  return { begin, retainNamespaces, size };
}
