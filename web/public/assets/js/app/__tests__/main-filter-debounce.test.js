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
 * SPEC DE1-DE3: the node filter box repaints once typing pauses.
 *
 * Each test boots the dashboard with a nodes table, a map and a chat, then
 * drives the real filter box, its clear button and a protocol toggle under
 * `node:test` fake timers (`setTimeout` only), and counts the surfaces the
 * repaint planner handed out. Before DE1 every keystroke repainted the
 * table, the map and the chat at once.
 *
 * @module app/__tests__/main-filter-debounce
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { NOW, runMapApp } from './live-map-harness.js';

/** No surface repainted. */
const NONE = Object.freeze({ table: 0, map: 0, chat: 0, paints: 0 });
/** One repaint of every surface. */
const ONE = Object.freeze({ table: 1, map: 1, chat: 1, paints: 1 });
/** The reviewer's gesture: 16 keystrokes, each typed 120 ms after the last. */
const GESTURE = 'Probe filter nod';
const KEY_GAP_MS = 120;

/**
 * Two meshtastic nodes with positions and one chat message. Only the first
 * matches {@link GESTURE}.
 *
 * @returns {Object<string, *>} Stub-fetch responses a test may edit.
 */
function responses() {
  return {
    'encrypted=true': [],
    '/api/nodes': [
      { node_id: '!a', short_name: 'PFNA', long_name: 'Probe filter node alpha', role: 'CLIENT', protocol: 'meshtastic', last_heard: NOW - 30, latitude: 52.5, longitude: 13.4 },
      { node_id: '!b', short_name: 'B', long_name: 'Node B', role: 'ROUTER', protocol: 'meshtastic', last_heard: NOW - 60, latitude: 52.51, longitude: 13.42 },
    ],
    '/api/messages': [
      { id: 1, channel: 0, from_id: '!a', to_id: '^all', text: 'first message', rx_time: NOW - 20, protocol: 'meshtastic' },
    ],
    '/api/neighbors': [],
  };
}

/**
 * The filter box, its clear button and the MeshCore toggle, registered
 * before boot so the dashboard wires them.
 *
 * @returns {{ box: Object, beforeBoot: function(Object): void }} The elements
 *   (filled at boot) and the hook that registers them.
 */
function filterBox() {
  const box = { focused: 0 };
  const beforeBoot = env => {
    box.input = env.createElement('input', 'filterInput');
    box.input.value = '';
    // The clear button refocuses the input; the DOM stub has no focus().
    box.input.focus = () => {
      box.focused += 1;
    };
    env.registerElement('filterInput', box.input);
    box.clear = env.createElement('button', 'filterClear');
    box.clear.hidden = true;
    env.registerElement('filterClear', box.clear);
    box.meshcoreToggle = env.createElement('button', 'protocolToggleMeshcore');
    env.registerElement('protocolToggleMeshcore', box.meshcoreToggle);
  };
  return { box, beforeBoot };
}

/**
 * Run an element's listeners for one event type.
 *
 * @param {Object} element Mock element.
 * @param {string} type Event type.
 * @param {Object} [fields] Extra event fields (`key`, `isComposing`).
 * @returns {void}
 */
function fire(element, type, fields = {}) {
  for (const handler of element._listeners.get(type) || []) handler({ type, ...fields });
}

/**
 * Set the box's text and fire its `input` event, as a keystroke does.
 *
 * @param {Object} box Elements from {@link filterBox}.
 * @param {string} text New box text.
 * @returns {void}
 */
function typeText(box, text) {
  box.input.value = text;
  fire(box.input, 'input');
}

/**
 * Surface repaints so far, and the repaints that painted at all.
 *
 * @param {Object} ctx Harness context.
 * @returns {{ table: number, map: number, chat: number, paints: number }}
 */
function painted(ctx) {
  return { ...ctx.testUtils.getSurfaceRenderCounts(), paints: ctx.testUtils.getRenderCount() };
}

/**
 * Repaints since `start`.
 *
 * @param {Object} ctx Harness context.
 * @param {Object} start Snapshot from {@link painted}.
 * @returns {{ table: number, map: number, chat: number, paints: number }}
 */
function since(ctx, start) {
  const now = painted(ctx);
  return {
    table: now.table - start.table,
    map: now.map - start.map,
    chat: now.chat - start.chat,
    paints: now.paints - start.paints,
  };
}

/**
 * Boot the dashboard with the filter box and run `fn` under fake timers,
 * firing what is still pending before the real timers come back.
 *
 * @param {function(Object, Object): Promise<void>} fn Test body; receives the
 *   harness context and the elements of {@link filterBox}.
 * @param {Object<string, *>} [served] Stub-fetch responses.
 * @returns {Promise<void>}
 */
async function withFilterBox(fn, served = responses()) {
  const { box, beforeBoot } = filterBox();
  await runMapApp({ responses: served, beforeBoot }, async ctx => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await fn(ctx, box);
    } finally {
      try {
        mock.timers.tick(1000);
      } finally {
        mock.timers.reset();
      }
    }
  });
}

test('sixteen keystrokes 120 ms apart repaint every surface once, once typing pauses (DE1)', async () => {
  await withFilterBox(async (ctx, box) => {
    const start = painted(ctx);
    for (let key = 1; key <= GESTURE.length; key += 1) {
      typeText(box, GESTURE.slice(0, key));
      assert.deepEqual(since(ctx, start), NONE, `keystroke ${key}: no surface repaints while typing`);
      if (key < GESTURE.length) mock.timers.tick(KEY_GAP_MS);
    }
    mock.timers.tick(149);
    assert.deepEqual(since(ctx, start), NONE, '149 ms after the last keystroke nothing has repainted');
    mock.timers.tick(51);
    assert.deepEqual(since(ctx, start), ONE, '200 ms after it the table, the map and the chat repaint once');
    assert.equal(ctx.testUtils.getRenderedNodeCount(), 1, 'the table shows the one node the text matches');
    mock.timers.tick(5000);
    assert.deepEqual(since(ctx, start), ONE, 'and nothing repaints after that');
  });
});

test('the clear button shows on the first keystroke and hides on the one that empties the box, before any repaint (DE1)', async () => {
  await withFilterBox(async (ctx, box) => {
    const start = painted(ctx);
    assert.equal(box.clear.hidden, true, 'an empty box hides the clear button');
    typeText(box, 'P');
    assert.equal(box.clear.hidden, false, 'the first keystroke shows the clear button at once');
    assert.deepEqual(since(ctx, start), NONE, 'before any surface repaints');
    mock.timers.tick(KEY_GAP_MS);
    typeText(box, '');
    assert.equal(box.clear.hidden, true, 'the keystroke that empties the box hides it at once');
    assert.deepEqual(since(ctx, start), NONE, 'still before any surface repaints');
    mock.timers.tick(200);
    assert.deepEqual(since(ctx, start), ONE, 'the pause repaints every surface once');
    assert.equal(box.clear.hidden, true);
  });
});

test('Enter applies a pending edit at once, and the window then repaints nothing (DE2)', async () => {
  await withFilterBox(async (ctx, box) => {
    const start = painted(ctx);
    typeText(box, 'Probe');
    assert.deepEqual(since(ctx, start), NONE, 'the keystroke repaints nothing yet');
    fire(box.input, 'keydown', { key: 'Enter' });
    assert.deepEqual(since(ctx, start), ONE, 'Enter repaints every surface without waiting');
    assert.equal(ctx.testUtils.getRenderedNodeCount(), 1, 'with the typed text applied');
    mock.timers.tick(5000);
    assert.deepEqual(since(ctx, start), ONE, 'the window Enter flushed repaints nothing');
  });
});

test('Enter with nothing pending, another key, or an Enter inside an IME composition repaints nothing at once (DE2)', async () => {
  await withFilterBox(async (ctx, box) => {
    const start = painted(ctx);
    fire(box.input, 'keydown', { key: 'Enter' });
    assert.deepEqual(since(ctx, start), NONE, 'Enter with nothing pending repaints nothing');
    typeText(box, 'Probe');
    assert.deepEqual(since(ctx, start), NONE, 'the keystroke repaints nothing yet');
    fire(box.input, 'keydown', { key: 'e' });
    fire(box.input, 'keydown', { key: 'Enter', isComposing: true });
    assert.deepEqual(since(ctx, start), NONE, 'another key and a composing Enter leave the window running');
    mock.timers.tick(200);
    assert.deepEqual(since(ctx, start), ONE, 'the window then repaints every surface once');
  });
});

test('Safari\'s Enter that commits an IME composition, isComposing false and keyCode 229, leaves the window running (DE2)', async () => {
  await withFilterBox(async (ctx, box) => {
    const start = painted(ctx);
    typeText(box, 'Probe');
    assert.deepEqual(since(ctx, start), NONE, 'the keystroke repaints nothing yet');
    fire(box.input, 'keydown', { key: 'Enter', isComposing: false, keyCode: 229 });
    assert.deepEqual(since(ctx, start), NONE, 'the composing Enter repaints nothing at once');
    mock.timers.tick(200);
    assert.deepEqual(since(ctx, start), ONE, 'the window then repaints every surface once');
  });
});

test('the clear button applies at once and drops the pending repaint (DE2)', async () => {
  await withFilterBox(async (ctx, box) => {
    const start = painted(ctx);
    typeText(box, 'Probe');
    assert.deepEqual(since(ctx, start), NONE, 'the keystroke repaints nothing yet');
    fire(box.clear, 'click');
    assert.equal(box.input.value, '', 'the box is empty');
    assert.equal(box.clear.hidden, true, 'the clear button hides');
    assert.equal(box.focused, 1, 'the input has the focus back');
    assert.deepEqual(since(ctx, start), ONE, 'every surface repaints without waiting');
    assert.equal(ctx.testUtils.getRenderedNodeCount(), 2, 'both nodes are back');
    mock.timers.tick(5000);
    assert.deepEqual(since(ctx, start), ONE, 'the dropped window repaints nothing');
  });
});

test('a protocol toggle applies the typed text at once and drops the pending repaint (DE2)', async () => {
  await withFilterBox(async (ctx, box) => {
    const start = painted(ctx);
    typeText(box, 'Probe');
    assert.deepEqual(since(ctx, start), NONE, 'the keystroke repaints nothing yet');
    fire(box.meshcoreToggle, 'click');
    assert.deepEqual(since(ctx, start), ONE, 'the toggle repaints every surface without waiting');
    assert.equal(ctx.testUtils.getRenderedNodeCount(), 1, 'with the typed text applied');
    mock.timers.tick(5000);
    assert.deepEqual(since(ctx, start), ONE, 'the dropped window repaints nothing');
  });
});

test('a refresh inside the window repaints what it changed, and the pause still repaints every surface (DE3)', async () => {
  const served = responses();
  await withFilterBox(async (ctx, box) => {
    const start = painted(ctx);
    typeText(box, 'Probe');
    assert.deepEqual(since(ctx, start), NONE, 'the keystroke repaints nothing yet');
    served['/api/messages'].push(
      { id: 2, channel: 0, from_id: '!a', to_id: '^all', text: 'second message', rx_time: NOW, protocol: 'meshtastic' },
    );
    ctx.stream.dispatch('change', { data: JSON.stringify({ collection: 'messages' }) });
    await ctx.testUtils.flushLiveRefresh();
    assert.deepEqual(since(ctx, start), { table: 0, map: 0, chat: 1, paints: 1 }, 'the messages refresh repaints the chat alone (DR4)');
    mock.timers.tick(200);
    assert.deepEqual(since(ctx, start), { table: 1, map: 1, chat: 2, paints: 2 }, 'the pause then repaints every surface');
    assert.equal(ctx.testUtils.getRenderedNodeCount(), 1, 'with the typed text applied');
  }, served);
});

test('the stopAutoRefresh teardown hook drops a pending repaint, so no window outlives a test (DE4)', async () => {
  await withFilterBox(async (ctx, box) => {
    const start = painted(ctx);
    typeText(box, 'Probe');
    assert.deepEqual(since(ctx, start), NONE, 'the keystroke repaints nothing yet');
    ctx.testUtils.stopAutoRefresh();
    mock.timers.tick(5000);
    assert.deepEqual(since(ctx, start), NONE, 'after stopAutoRefresh the window repaints nothing');
  });
});
