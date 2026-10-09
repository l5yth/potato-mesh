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
 * SPEC DR1 through the real refresh paths (#881): a live refresh keeps every
 * chat element whose content did not change. A refresh that brings one new
 * message, on every live path, removes no element from `#chat` and only adds
 * the new entry, and an idle repaint changes nothing; every refresh here
 * carries a changed row, so each one repaints the chat even where a refresh
 * repaints only the surfaces whose rows changed (DR4). A new message adds its
 * entry and moves nothing else;
 * a focused tab keeps focus, also when a reorder moves it; a text selection in
 * an unchanged entry survives; day dividers stay in place; the LV4 tab flash
 * lands on the kept tab button and outlives the next refresh.
 *
 * The shared DOM mock has no parents, no focus and no selection, so this suite
 * teaches it the browser behaviour these checks depend on, locally: a node has
 * one parent (inserting it elsewhere moves it), removing a node, also for the
 * instant of a move, drops focus inside it and collapses a selection in it,
 * every element removed from under `#chat` is counted, a `.chat-tabpanel`
 * derives its scroll height from its entries, and `document.querySelectorAll`
 * answers the `[data-*="…"]` lookups of the flash code.
 *
 * @module __tests__/main-chat-keyed-refresh
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnvironment } from './dom-environment.js';
import { makeFakeEventSource, SSE_BASE_CONFIG } from './sse-app-harness.js';
import { initializeApp } from '../main.js';
import { formatDate } from '../main/format-utils.js';

const NOW = Math.floor(Date.now() / 1000);
/** Local midnight that starts the current day, Unix seconds. */
const MIDNIGHT = (() => {
  const day = new Date(NOW * 1000);
  day.setHours(0, 0, 0, 0);
  return Math.floor(day.getTime() / 1000);
})();
/** Modelled height of one chat entry or divider, in px. */
const ENTRY_PX = 20;
/** Modelled visible height of a chat panel, in px. */
const PANEL_PX = 300;

/**
 * Teach the shared mock the DOM behaviour DR1 is about. Patches the mock's
 * prototype and document until the returned ``restore`` runs.
 *
 * @param {Object} env Environment from {@link createDomEnvironment}.
 * @param {Object} root The `#chat` element; removals under it are counted.
 * @returns {{
 *   stats: { removed: number },
 *   select: function(Object): void,
 *   selection: function(): ?Object,
 *   restore: function(): void
 * }} Model handle: removal counter, selection helpers and undo.
 */
function installDomModel(env, root) {
  const { document } = env;
  const proto = Object.getPrototypeOf(env.createElement('div'));
  const patched = ['appendChild', 'insertBefore', 'removeChild', 'replaceChildren', 'replaceChild', 'focus', 'blur'];
  const accessors = ['parentNode', 'isConnected', 'clientHeight', 'scrollHeight', 'scrollTop'];
  const saved = new Map([...patched, ...accessors].map(name => [name, Object.getOwnPropertyDescriptor(proto, name)]));
  const savedQuerySelectorAll = document.querySelectorAll;
  const savedCreateDocumentFragment = document.createDocumentFragment;
  const parentOf = new WeakMap();
  const scrollTops = new WeakMap();
  const stats = { removed: 0 };
  let selected = null;

  const isElement = node => Boolean(node) && typeof node === 'object' && Array.isArray(node.childNodes);
  const isFragment = node => isElement(node) && node.tagName === 'FRAGMENT';
  const contains = (ancestor, node) => {
    for (let current = node; current; current = parentOf.get(current)) {
      if (current === ancestor) return true;
    }
    return false;
  };
  const connected = node => contains(root, node) || contains(document.body, node);
  const elementsIn = node => (isElement(node) ? [node, ...node.childNodes.flatMap(elementsIn)] : []);
  // A node leaving its parent: what a browser does to focus and selection, and the count.
  const detach = node => {
    const parent = isElement(node) ? parentOf.get(node) : null;
    if (!parent) return;
    if (contains(root, parent)) stats.removed += elementsIn(node).length;
    if (contains(node, document.activeElement)) document.activeElement = document.body;
    if (selected && contains(node, selected)) selected = null;
    parent.childNodes.splice(parent.childNodes.indexOf(node), 1);
    parentOf.delete(node);
  };
  const expand = nodes => nodes.flatMap(node => (isFragment(node) ? [...node.childNodes] : [node]));
  const adopt = (parent, node, index) => {
    parent.childNodes.splice(index, 0, node);
    if (isElement(node)) parentOf.set(node, parent);
  };

  proto.insertBefore = function insertBefore(node, ref) {
    for (const child of expand([node])) {
      detach(child);
      const index = ref == null ? this.childNodes.length : this.childNodes.indexOf(ref);
      if (index < 0) throw new Error('insertBefore: the reference node is not a child');
      adopt(this, child, index);
    }
    return node;
  };
  proto.appendChild = function appendChild(node) {
    return this.insertBefore(node, null);
  };
  proto.removeChild = function removeChild(node) {
    if (parentOf.get(node) !== this) throw new Error('removeChild: not a child');
    detach(node);
    return node;
  };
  proto.replaceChildren = function replaceChildren(...nodes) {
    const incoming = expand(nodes.filter(node => node != null));
    incoming.forEach(detach);
    [...this.childNodes].forEach(detach);
    this.childNodes = [];
    incoming.forEach(child => adopt(this, child, this.childNodes.length));
  };
  proto.replaceChild = function replaceChild(newNode, oldNode) {
    if (parentOf.get(oldNode) !== this) throw new Error('replaceChild: oldNode is not a child');
    detach(newNode);
    const index = this.childNodes.indexOf(oldNode);
    detach(oldNode);
    adopt(this, newNode, index);
    return oldNode;
  };
  proto.focus = function focus() {
    if (connected(this)) document.activeElement = this;
  };
  proto.blur = function blur() {
    if (document.activeElement === this) document.activeElement = document.body;
  };
  const define = (name, get, set) => Object.defineProperty(proto, name, { configurable: true, get, set });
  define('parentNode', function parentNode() {
    return parentOf.get(this) || null;
  });
  define('isConnected', function isConnected() {
    return connected(this);
  });
  const isPanel = node => node.classList.contains('chat-tabpanel');
  const panelRange = panel => {
    const entries = panel.childNodes.filter(node => isElement(node) && String(node.className).includes('chat-entry'));
    return Math.max(PANEL_PX, entries.length * ENTRY_PX) - PANEL_PX;
  };
  define('clientHeight', function clientHeight() {
    return isPanel(this) ? PANEL_PX : 0;
  });
  define('scrollHeight', function scrollHeight() {
    return isPanel(this) ? panelRange(this) + PANEL_PX : 0;
  });
  // Layout clamps a panel's offset to the range its entries give it.
  define(
    'scrollTop',
    function getScrollTop() {
      const stored = scrollTops.get(this) || 0;
      return isPanel(this) ? Math.min(Math.max(stored, 0), panelRange(this)) : stored;
    },
    function setScrollTop(value) {
      scrollTops.set(this, Number(value) || 0);
    }
  );
  document.activeElement = document.body;
  // A fragment is an ordinary node here, so appending to it moves the node.
  document.createDocumentFragment = () => env.createElement('fragment');
  // The flash code looks rows and tab headers up by data attribute.
  document.querySelectorAll = selector => {
    const match = /^\[data-([a-z-]+)="([^"]*)"\]$/.exec(selector);
    if (!match) return savedQuerySelectorAll.call(document, selector);
    const key = match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    return elementsIn(root).filter(element => element.dataset && element.dataset[key] === match[2]);
  };

  return {
    stats,
    select(node) {
      selected = node;
    },
    selection() {
      return selected;
    },
    restore() {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(proto, name, descriptor);
        else delete proto[name];
      }
      document.querySelectorAll = savedQuerySelectorAll;
      document.createDocumentFragment = savedCreateDocumentFragment;
      delete document.activeElement;
    },
  };
}

/**
 * A stub `fetch` answering from a URL-substring map, which honours the
 * `since` parameter of a delta fetch for rows that carry `rx_time`, as the API
 * does. A row without `rx_time` (a node) is always returned.
 *
 * @param {Object<string, *>} responses URL-substring -> JSON body.
 * @returns {function(string): Promise<Object>} Fetch double.
 */
function sinceAwareFetch(responses) {
  return url => {
    const since = Number(new URL(url, 'http://127.0.0.1').searchParams.get('since')) || 0;
    const match = Object.entries(responses).find(([prefix]) => url.includes(prefix));
    const body = match ? match[1] : [];
    const rows = Array.isArray(body) ? body.filter(row => !(row.rx_time < since)) : body;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(rows) });
  };
}

/**
 * Boot the dashboard over a fake `EventSource` and a stub `fetch` with the DOM
 * model installed, run `fn`, then tear everything down.
 *
 * @param {Object<string, *>} responses URL-substring -> JSON body; the test may
 *   mutate it between refreshes.
 * @param {function(Object): Promise<void>} fn Body, given the app context.
 * @returns {Promise<void>}
 */
async function runChatApp(responses, fn) {
  const env = createDomEnvironment({ includeBody: true });
  const chat = env.createElement('div', 'chat');
  env.registerElement('chat', chat);
  const model = installDomModel(env, chat);
  const originalFetch = globalThis.fetch;
  const originalES = globalThis.EventSource;
  const originalIdb = globalThis.indexedDB;
  globalThis.fetch = sinceAwareFetch(responses);
  globalThis.indexedDB = undefined;
  const FakeEventSource = makeFakeEventSource();
  globalThis.EventSource = FakeEventSource;
  let testUtils = null;
  try {
    ({ _testUtils: testUtils } = initializeApp({ ...SSE_BASE_CONFIG }));
    await testUtils.initialLoad;
    await testUtils.flushBackfill();
    const stream = FakeEventSource.instances[0];
    const ping = async collection => {
      stream.dispatch('change', { data: JSON.stringify({ collection }) });
      await testUtils.flushLiveRefresh();
    };
    await fn({ testUtils, stream, ping, chat, model, document: env.document });
  } finally {
    if (testUtils) await testUtils.flushCacheWrites();
    for (let i = 0; i < 3; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
    if (testUtils) testUtils.stopAutoRefresh();
    globalThis.fetch = originalFetch;
    if (originalES === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = originalES;
    globalThis.indexedDB = originalIdb;
    model.restore();
    env.cleanup();
  }
}

/**
 * A plaintext channel message.
 *
 * @param {number} id Message id.
 * @param {number} rxTime Receive time, Unix seconds.
 * @param {{ channel?: number, channelName?: string, from?: string }} [options] Channel and sender.
 * @returns {Object} Message row as `/api/messages` serves it.
 */
function message(id, rxTime, { channel = 0, channelName, from = '!a' } = {}) {
  const row = { id, channel, from_id: from, to_id: '^all', text: `line ${id}`, rx_time: rxTime };
  if (channelName) row.channel_name = channelName;
  return row;
}

/**
 * ``count`` receive times spread over the last ten minutes, oldest first, all
 * on the current day so no day divider appears between them.
 *
 * @param {number} count Number of timestamps.
 * @returns {Array<number>} Unix seconds, ascending, at most ``NOW - 1``.
 */
function todayTimes(count) {
  const start = Math.max(MIDNIGHT, NOW - 600);
  return Array.from({ length: count }, (_, index) => start + Math.floor((index * (NOW - 1 - start)) / count));
}

/**
 * Stub responses: two nodes and the given messages. The encrypted feed is
 * listed first so it does not also match the plaintext `/api/messages` key.
 *
 * @param {Array<Object>} messages Plaintext messages (mutated by tests).
 * @returns {Object<string, *>} Stub-fetch response map.
 */
function responsesWith(messages) {
  return {
    'encrypted=true': [],
    '/api/nodes': [
      { node_id: '!a', short_name: 'A', long_name: 'Node A', last_heard: NOW - 3600 },
      { node_id: '!b', short_name: 'B', long_name: 'Node B', last_heard: NOW - 3600 },
    ],
    '/api/messages': messages,
  };
}

/**
 * Every element under `node`, depth first, the node itself excluded.
 *
 * @param {Object} node Root element.
 * @returns {Array<Object>} Descendant elements.
 */
function descendants(node) {
  return node.children.flatMap(child => [child, ...descendants(child)]);
}

/**
 * Tab button whose label starts with ``label``.
 *
 * @param {Object} chat The `#chat` container.
 * @param {string} label Label prefix, e.g. ``Alpha``.
 * @returns {?Object} The button.
 */
function tabButton(chat, label) {
  return chat.children[0].children[1].children.find(button => String(button.textContent).startsWith(label)) || null;
}

/**
 * Panel controlled by ``button``.
 *
 * @param {Object} chat The `#chat` container.
 * @param {Object} button A tab button.
 * @returns {?Object} The panel.
 */
function panelOf(chat, button) {
  return chat.children[1].children.find(panel => panel.getAttribute('aria-labelledby') === button.getAttribute('id')) || null;
}

test('a refresh with one new message removes no element from #chat, on every refresh path (DR1, #881)', async () => {
  const messages = [
    message(1, NOW - 300),
    message(2, NOW - 200),
    message(3, NOW - 100, { channel: 1, channelName: 'Alpha', from: '!b' }),
  ];
  await runChatApp(responsesWith(messages), async ({ testUtils, stream, chat, model }) => {
    // Each live path carries one new message, so the chat repaints on every
    // path, also where a refresh repaints only the surfaces whose rows changed
    // (DR4). A nodes ping cannot bring a message on its own: a message ingest
    // publishes `messages` and `nodes` together (#822), and the two pings land
    // in one debounced refresh.
    let next = 4;
    const arrive = () => {
      messages.push(message(next, NOW - 100 + next * 5));
      next += 1;
      return String(next - 1);
    };
    const changePing = async (...collections) => {
      for (const collection of collections) {
        stream.dispatch('change', { data: JSON.stringify({ collection }) });
      }
      await testUtils.flushLiveRefresh();
    };
    const paths = [
      ['a messages ping', () => changePing('messages')],
      ['a messages and nodes ping pair', () => changePing('messages', 'nodes')],
      [
        'a (re)connect resync',
        async () => {
          stream.dispatch('open', {});
          await testUtils.flushLiveRefresh();
        },
      ],
      ['the safety poll', () => testUtils.refresh()],
    ];
    for (const [label, run] of paths) {
      const before = descendants(chat);
      const id = arrive();
      model.stats.removed = 0;
      await run();
      assert.equal(model.stats.removed, 0, `${label} removes no element from #chat`);
      const after = descendants(chat);
      let kept = 0;
      for (const element of after) if (element === before[kept]) kept += 1;
      assert.equal(kept, before.length, `${label} keeps every earlier element, in order`);
      assert.ok(after.some(element => element.dataset.messageId === id), `${label} adds the new message's entry`);
    }

    // A backfill page with nothing new is the pure idle repaint.
    const before = descendants(chat);
    model.stats.removed = 0;
    testUtils.rerenderChatLog();
    assert.equal(model.stats.removed, 0, 'an idle repaint removes no element from #chat');
    const after = descendants(chat);
    assert.equal(after.length, before.length, 'an idle repaint adds no element');
    assert.ok(after.every((element, index) => element === before[index]), 'an idle repaint keeps every element in place');
  });
});

test('a new message adds its entry and moves no other chat element (DR1, #881)', async () => {
  const messages = todayTimes(30).map((rxTime, index) => message(index + 1, rxTime));
  await runChatApp(responsesWith(messages), async ({ ping, chat, model }) => {
    const button = tabButton(chat, 'Primary');
    const panel = panelOf(chat, button);
    const entries = [...panel.children];
    const strip = chat.children[0].children[1];
    panel.scrollTop = 100; // the reader scrolls up into the history

    messages.push(message(31, NOW));
    model.stats.removed = 0;
    await ping('messages');

    assert.ok(tabButton(chat, 'Primary') === button, 'the tab button is kept');
    assert.ok(panelOf(chat, button) === panel, 'the panel is kept');
    assert.ok(chat.children[0].children[1] === strip, 'the tab strip is kept');
    assert.equal(panel.children.length, entries.length + 1, 'one entry was added');
    assert.ok(entries.every((entry, index) => panel.children[index] === entry), 'every earlier entry stays in place');
    assert.equal(model.stats.removed, 0, 'nothing left #chat, not even for a moment');
    assert.equal(panel.scrollTop, 100, 'the scrolled-up reader keeps their place');
  });
});

test('a focused tab keeps focus across refreshes, also when a reorder moves it (DR1, #881)', async () => {
  const messages = [
    message(1, NOW - 300),
    message(2, NOW - 200, { channel: 1, channelName: 'Alpha', from: '!b' }),
    message(3, NOW - 100, { channel: 2, channelName: 'Bravo', from: '!b' }),
  ];
  await runChatApp(responsesWith(messages), async ({ testUtils, ping, chat, document }) => {
    const alpha = tabButton(chat, 'Alpha');
    alpha.focus();
    assert.ok(document.activeElement === alpha);

    // The safety poll brings a message for another tab: the chat repaints.
    messages.push(message(6, NOW - 60));
    await testUtils.refresh();
    assert.ok(document.activeElement === alpha, 'a refresh with a new message keeps focus on the tab');

    // Bravo overtakes Alpha on activity: the tab order changes and Alpha moves.
    messages.push(message(4, NOW - 50, { channel: 2, channelName: 'Bravo', from: '!b' }));
    messages.push(message(5, NOW - 40, { channel: 2, channelName: 'Bravo', from: '!b' }));
    await ping('messages');
    const labels = chat.children[0].children[1].children.map(button => String(button.textContent).split(' ')[0]);
    assert.deepEqual(labels, ['Log', 'Primary', 'Bravo', 'Alpha'], 'Bravo now leads Alpha');
    assert.ok(tabButton(chat, 'Alpha') === alpha, 'the Alpha button is kept');
    assert.ok(document.activeElement === alpha, 'focus follows the moved tab');
  });
});

test('a text selection inside an unchanged entry survives a refresh (DR1, #881)', async () => {
  const messages = todayTimes(5).map((rxTime, index) => message(index + 1, rxTime));
  await runChatApp(responsesWith(messages), async ({ ping, chat, model }) => {
    const panel = panelOf(chat, tabButton(chat, 'Primary'));
    const entry = panel.children.find(node => String(node.className).includes('chat-entry-msg'));
    model.select(entry);

    messages.push(message(6, NOW));
    await ping('messages');
    assert.ok(model.selection() === entry, 'the selection is still inside the entry');
  });
});

test('day dividers are kept and stay before the first entry of their day (DR1, #881)', async () => {
  const yesterday = MIDNIGHT - 3600;
  const messages = [message(1, yesterday - 60), message(2, yesterday), message(3, NOW - 120), message(4, NOW - 60)];
  await runChatApp(responsesWith(messages), async ({ testUtils, ping, chat }) => {
    const panel = panelOf(chat, tabButton(chat, 'Primary'));
    const layout = () =>
      panel.children.map(node => (node.className === 'chat-entry-date' ? node.textContent : `entry:${node.dataset.messageId}`));
    const days = [...new Set(messages.map(row => formatDate(new Date(row.rx_time * 1000))))];
    const dividers = () => panel.children.filter(node => node.className === 'chat-entry-date');
    const expected = rows => {
      let lastDay = null;
      return rows.flatMap(row => {
        const day = formatDate(new Date(row.rx_time * 1000));
        // A divider shows the day in en-GB without the year (SPEC CD5) and is keyed by the ISO day.
        const label = new Date(row.rx_time * 1000).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
        const out = day === lastDay ? [] : [label];
        lastDay = day;
        return [...out, `entry:${row.id}`];
      });
    };
    assert.deepEqual(layout(), expected(messages));
    assert.equal(dividers().length, days.length);
    const kept = dividers();

    testUtils.rerenderChatLog();
    messages.push(message(5, NOW));
    await ping('messages');
    assert.ok(panelOf(chat, tabButton(chat, 'Primary')) === panel, 'the panel is kept');
    assert.deepEqual(layout(), expected(messages), 'a new entry of the same day adds no divider');
    assert.ok(kept.every((divider, index) => dividers()[index] === divider), 'the dividers are kept');
  });
});

test('the LV4 tab flash lands on the kept tab button and outlives the next refresh (LV4, DR1, #881)', async () => {
  const messages = [message(1, NOW - 300), message(2, NOW - 200, { channel: 1, channelName: 'Alpha', from: '!b' })];
  await runChatApp(responsesWith(messages), async ({ testUtils, ping, chat }) => {
    const alpha = tabButton(chat, 'Alpha');
    messages.push(message(3, NOW, { channel: 1, channelName: 'Alpha', from: '!b' }));
    await ping('messages');
    assert.ok(testUtils.getLastFlashedMessageIds().includes('3'), 'the new message flashed');
    assert.ok(tabButton(chat, 'Alpha') === alpha, 'the flashed header is the kept button');
    assert.ok(alpha.classList.contains('live-flash'), 'the message flashed its own tab header');
    assert.ok(!tabButton(chat, 'Primary').classList.contains('live-flash'), 'and no other tab header');

    testUtils.rerenderChatLog();
    assert.ok(alpha.isConnected && alpha.classList.contains('live-flash'), 'a refresh mid-fade keeps the fading header');
  });
});

test('focus on an entry that a refresh rebuilds moves to the rebuilt entry (DR1, #881)', async () => {
  const messages = todayTimes(3).map((rxTime, index) => message(index + 1, rxTime, { from: index === 1 ? '!b' : '!a' }));
  const responses = responsesWith(messages);
  await runChatApp(responses, async ({ ping, chat, document }) => {
    const livePanel = () => panelOf(chat, tabButton(chat, 'Primary'));
    const panel = livePanel();
    const byId = id => livePanel().children.find(node => node.dataset.messageId === id);
    const [first, second, third] = ['1', '2', '3'].map(byId);
    second.focus();

    // Node B is renamed: its message renders a new badge, so the entry is rebuilt.
    responses['/api/nodes'] = [
      { node_id: '!a', short_name: 'A', long_name: 'Node A', last_heard: NOW - 3600 },
      { node_id: '!b', short_name: 'BB', long_name: 'Node B renamed', last_heard: NOW },
    ];
    await ping('nodes');
    const rebuilt = byId('2');
    assert.ok(rebuilt && rebuilt !== second, 'the renamed sender rebuilt its entry');
    assert.ok(livePanel() === panel, 'the panel is kept');
    assert.ok(byId('1') === first && byId('3') === third, 'the other entries are kept');
    assert.ok(document.activeElement === rebuilt, 'focus moved to the rebuilt entry');
  });
});

test('a part that joins a burst updates its Log line in place: the same node, no removal, no scroll jump (LA4, DR1)', async () => {
  const start = NOW - 400;
  const positions = [];
  const telemetry = [];
  const encrypted = todayTimes(30).map((rxTime, index) => ({
    id: index + 1, channel: 0, from_id: '!b', to_id: '^all', encrypted: true, text: 'q83vEjRWeJA=', rx_time: rxTime,
  }));
  const responses = {
    'encrypted=true': [],
    '/api/nodes': [
      { node_id: '!a', short_name: 'SNS1', long_name: 'Creek sensor', role: 'SENSOR', last_heard: start },
      { node_id: '!b', short_name: 'B', long_name: 'Node B', last_heard: NOW - 3600 },
    ],
    '/api/positions': positions,
    '/api/telemetry': telemetry,
    '/api/messages': encrypted,
  };
  await runChatApp(responses, async ({ ping, chat, model }) => {
    const logPanel = () => chat.children[1].children[0];
    const burstRow = () => logPanel().children.find(node => String(node.innerHTML).includes('>SNS1<'));
    const row = burstRow();
    assert.ok(row, 'the advert shows');
    const panel = logPanel();
    panel.scrollTop = 100; // the reader scrolls up into the history

    for (const [collection, rows, record, shown] of [
      ['positions', positions, { id: 1, node_id: '!a', rx_time: start + 2, latitude: 38.0249, longitude: -123.0132 }, 'position</span> 38.0249, -123.0132'],
      ['telemetry', telemetry, { id: 1, node_id: '!a', rx_time: start + 5, battery_level: 61, voltage: 3.84, channel_utilization: 0.21 }, 'telemetry</span> 61% · 3.84 V · util 0.2%'],
    ]) {
      rows.push(record);
      model.stats.removed = 0;
      await ping(collection);
      assert.strictEqual(burstRow(), row, `the ${collection} part joins the same row`);
      assert.ok(row.innerHTML.includes(shown), row.innerHTML);
      assert.equal(model.stats.removed, 0, `a ${collection} part removes no element from #chat`);
      assert.strictEqual(logPanel(), panel, 'the panel is kept');
      assert.equal(panel.scrollTop, 100, 'the reader stays where they were');
    }
    assert.equal(logPanel().children.filter(node => String(node.innerHTML).includes('>SNS1<')).length, 1, 'one line for the burst');
  });
});
