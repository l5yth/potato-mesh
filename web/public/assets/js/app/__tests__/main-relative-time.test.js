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

// Dashboard wiring for the live relative-time tick (SPEC RT1/RT2, acceptance
// RT-A2): the node-table timestamp cells and the map overlays emit
// data-ts-ago opt-in markup, ticks mutate that markup in place (element
// identity preserved), and a tick never fetches or materializes chat entries.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildNodeRowTimestampCellsHtml } from '../main.js';
import {
  TICK_TIMESTAMP_ATTRIBUTE,
  TICK_SELECTOR,
  updateTickingElements,
} from '../main/relative-time-ticker.js';
import { withApp } from './main-app-test-helpers.js';

/** Reference "now" used by the deterministic markup tests. */
const NOW = 1_000_000;

/**
 * Build a fake element carrying the given attributes with tracked
 * `textContent` writes, mirroring what the ticker sees in a real DOM.
 *
 * @param {Object<string, string>} attrs Attribute map.
 * @param {string} [text] Initial text content.
 * @returns {Object} Fake element.
 */
function fieldWithAttrs(attrs, text = '') {
  let current = text;
  const el = { writes: 0 };
  Object.defineProperty(el, 'textContent', {
    get: () => current,
    set: (value) => {
      current = value;
      el.writes += 1;
    },
  });
  el.getAttribute = (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null);
  return el;
}

test('node-row timestamp cells carry tick opt-in markup (RT-A2)', () => {
  const cells = buildNodeRowTimestampCellsHtml(
    { last_heard: NOW - 4, position_time: NOW - 90 },
    NOW,
  );
  assert.equal(
    cells.lastSeen,
    `<td class="nodes-col nodes-col--last-seen" data-ts-ago="${NOW - 4}">4s</td>`,
  );
  assert.equal(
    cells.lastPosition,
    `<td class="mono nodes-col nodes-col--last-position" data-ts-ago="${NOW - 90}">1m 30s</td>`,
  );
});

test('node-row cells accept the camelCase position alias', () => {
  const cells = buildNodeRowTimestampCellsHtml({ positionTime: NOW - 60 }, NOW);
  assert.match(cells.lastPosition, new RegExp(`data-ts-ago="${NOW - 60}"`));
});

test('nodes without timestamps render today\'s plain static cells (RT4)', () => {
  const cells = buildNodeRowTimestampCellsHtml({}, NOW);
  assert.equal(cells.lastSeen, '<td class="nodes-col nodes-col--last-seen"></td>');
  assert.equal(cells.lastPosition, '<td class="mono nodes-col nodes-col--last-position"></td>');
  const junk = buildNodeRowTimestampCellsHtml({ last_heard: 'nope', position_time: 'junk' }, NOW);
  assert.ok(!junk.lastSeen.includes(TICK_TIMESTAMP_ATTRIBUTE));
  assert.ok(!junk.lastPosition.includes(TICK_TIMESTAMP_ATTRIBUTE));
});

test('the exact emitted cell markup ticks in place — same element, new text (RT-A2)', () => {
  const cells = buildNodeRowTimestampCellsHtml({ last_heard: NOW - 4 }, NOW);
  const ts = cells.lastSeen.match(/data-ts-ago="(\d+)"/)[1];
  const cell = fieldWithAttrs({ [TICK_TIMESTAMP_ATTRIBUTE]: ts }, '4s');
  const doc = { querySelectorAll: (sel) => (sel === TICK_SELECTOR ? [cell] : []) };

  const before = cell;
  assert.equal(updateTickingElements(doc, NOW + 1), 1);
  assert.equal(cell.textContent, '5s');
  assert.equal(cell, before, 'the cell element identity is unchanged');
  assert.equal(updateTickingElements(doc, NOW + 1), 0, 'no rewrite without a change');
});

test('the legacy map popup "Last seen" line carries tick markup', () => {
  withApp(t => {
    try {
      const html = t.buildMapPopupHtml({ long_name: 'Alice', node_id: '!abc12345', last_heard: NOW - 4 }, NOW);
      assert.ok(html.includes(`Last seen: <span data-ts-ago="${NOW - 4}">4s</span>`), html);
    } finally {
      t.stopAutoRefresh();
    }
  });
});

test('the marker short-info overlay gains a ticking "Last seen" line (RT1 amended)', () => {
  withApp(t => {
    try {
      const lastHeard = Math.floor(Date.now() / 1000) - 4;
      const overlayInfo = t.normalizeOverlaySource({ longName: 'Alice', nodeId: '!abc12345', lastHeard });
      const html = t.buildShortInfoOverlayHtml(overlayInfo);
      // The initial text is stamped from the wall clock at open time, so allow
      // any small age; the tick attribute must carry the exact timestamp.
      assert.match(html, new RegExp(`Last seen: <span data-ts-ago="${lastHeard}">\\d+s</span>`));
    } finally {
      t.stopAutoRefresh();
    }
  });
});

test('an overlay without lastHeard shows no "Last seen" line', () => {
  withApp(t => {
    try {
      const overlayInfo = t.normalizeOverlaySource({ longName: 'Bob', nodeId: '!abc45678' });
      const html = t.buildShortInfoOverlayHtml(overlayInfo);
      assert.ok(!html.includes('Last seen:'), html);
    } finally {
      t.stopAutoRefresh();
    }
  });
});

test('the app boots one shared ticker; ticks fetch nothing and materialize nothing (RT1, CR-A1 posture)', () => {
  withApp(t => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = () => {
      fetchCalls += 1;
      return Promise.resolve({ ok: false });
    };
    try {
      assert.equal(t.relativeTimeTicker.running(), true, 'ticker armed at boot');
      t.resetChatRenderStats();
      t.relativeTimeTicker.tick();
      t.relativeTimeTicker.tick();
      assert.equal(fetchCalls, 0, 'a tick must never fetch');
      assert.equal(t.getChatRenderStats().materialized, 0, 'a tick materializes no chat entries');
    } finally {
      globalThis.fetch = originalFetch;
      t.stopAutoRefresh();
    }
    assert.equal(t.relativeTimeTicker.running(), false, 'teardown stops the ticker');
  });
});
