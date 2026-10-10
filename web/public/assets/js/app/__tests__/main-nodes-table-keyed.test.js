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
 * Live refreshes keep the reader's place in the nodes table (#881, SPEC DR1,
 * steps 2 and 3). The dashboard is stood up over the SSE harness with the
 * live DOM model, so element identity, removals, focus, selection, overlays
 * and page scroll are observed the way a browser reports them, across real
 * `change` pings and `refresh()` passes.
 *
 * Every step that must reach `renderTable` changes a node the table shows or
 * repaints through the filter box (`applyFilter`): under SPEC DR4 a ping that
 * changes no node repaints no table, and a test that leaned on one would pass
 * without the keyed rows ever running.
 *
 * @module app/__tests__/main-nodes-table-keyed
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createLiveTableDom } from './live-dom-model.js';
import { buildStubFetch, makeFakeEventSource, SSE_BASE_CONFIG } from './sse-app-harness.js';
import { initializeApp } from '../main.js';
import { NODE_TABLE_RENDER_CAP } from '../main/constants.js';

const NOW = Math.floor(Date.now() / 1000);
const A = '!aaaa0001';
const B = '!aaaa0002';
const C = '!aaaa0003';
const IDENTITY = '!27716218';

/**
 * A Meshtastic node payload.
 *
 * @param {string} nodeId Canonical id.
 * @param {number} age Seconds since last heard.
 * @param {Object} [extra] Field overrides.
 * @returns {Object} Node row as `/api/nodes` serves it.
 */
function meshtasticNode(nodeId, age, extra = {}) {
  return {
    node_id: nodeId,
    short_name: nodeId.slice(-4).toUpperCase(),
    long_name: `Node ${nodeId.slice(-1).toUpperCase()}`,
    last_heard: NOW - age,
    protocol: 'meshtastic',
    role: 'CLIENT',
    battery_level: 80,
    voltage: 3.9,
    ...extra,
  };
}

/** Three destinations of one Reticulum identity (SPEC RA1). */
const DESTINATIONS = [
  { id: '9c59da5e1516745d74cc908243e0ba2b', node_id: IDENTITY, aspect: 'nomadnetwork.node', role: 'NODE', name: 'Dept', last_heard: NOW - 130 },
  { id: '4cf985bf933c21b1aa8dabd407d4ef69', node_id: IDENTITY, aspect: 'lxmf.delivery', role: 'PEER', name: 'Orion', last_heard: NOW - 1080 },
  { id: 'fee521eb6fcd937cc519a1ec8c8b0b2a', node_id: IDENTITY, aspect: 'lxmf.propagation', role: 'PROPAGATION', name: null, last_heard: NOW - 2400 },
];

/** The Reticulum identity's node row. */
const IDENTITY_NODE = {
  node_id: IDENTITY, short_name: '2771', long_name: 'Department of Decentralization',
  last_heard: NOW - 130, role: 'NODE', protocol: 'reticulum',
};

/**
 * Yield to timers so background loads and overlay positioning settle.
 *
 * @param {number} [ms] Delay.
 * @returns {Promise<void>} Resolves after the delay.
 */
const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Boot the dashboard over the live table DOM.
 *
 * @param {{nodes: Array<Object>, destinations?: Array<Object>, dom?: Object}} options Payloads and model options.
 * @returns {Promise<Object>} Handles: the DOM, test utils, the mutable responses, `ping`, `setNodes`, `cleanup`.
 */
async function bootTable({ nodes, destinations = [], dom: domOptions = {} }) {
  const dom = createLiveTableDom(domOptions);
  const responses = {
    'encrypted=true': [],
    '/api/nodes/': [],
    '/api/nodes': nodes,
    '/api/messages': [{ id: 1, channel: 0, from_id: A, to_id: '^all', text: 'hi', rx_time: NOW, protocol: 'meshtastic' }],
    '/api/destinations': destinations,
  };
  const saved = { fetch: globalThis.fetch, EventSource: globalThis.EventSource, indexedDB: globalThis.indexedDB };
  globalThis.fetch = buildStubFetch(responses).fetch;
  globalThis.indexedDB = undefined;
  const FakeEventSource = makeFakeEventSource();
  globalThis.EventSource = FakeEventSource;
  const { _testUtils: t } = initializeApp({ ...SSE_BASE_CONFIG });
  await t.initialLoad;
  await t.flushBackfill();
  await settle();
  return {
    dom,
    t,
    responses,
    /**
     * Land one SSE `change` ping and await its refresh.
     *
     * @param {string} collection Collection named by the ping.
     * @returns {Promise<void>}
     */
    async ping(collection) {
      FakeEventSource.instances[0].dispatch('change', { data: JSON.stringify({ collection }) });
      await t.flushLiveRefresh();
    },
    /**
     * Repaint every surface the way a filter keystroke does (`applyFilter`),
     * applied at once with Enter (SPEC DE2) rather than once typing pauses.
     * Under SPEC DR4 a ping that changes no node repaints no table, so a step
     * that needs the table rendered with nothing changed repaints explicitly.
     *
     * @returns {void}
     */
    repaint() {
      const paints = t.getRenderCount();
      dom.filterInput.dispatchEvent({ type: 'input' });
      dom.filterInput.dispatchEvent({ type: 'keydown', key: 'Enter' });
      assert.equal(t.getRenderCount(), paints + 1, 'the filter box repainted at once');
    },
    /**
     * Patch one node in the served payload.
     *
     * @param {string} nodeId Node to patch.
     * @param {Object} patch Field overrides.
     * @returns {void}
     */
    setNode(nodeId, patch) {
      responses['/api/nodes'] = responses['/api/nodes'].map(n => (n.node_id === nodeId ? { ...n, ...patch } : n));
    },
    /**
     * Settle pending tails, stop the timers and restore the globals.
     *
     * @returns {Promise<void>}
     */
    async cleanup() {
      await t.flushCacheWrites();
      for (let i = 0; i < 3; i += 1) await settle(0);
      t.stopAutoRefresh();
      globalThis.fetch = saved.fetch;
      if (saved.EventSource === undefined) delete globalThis.EventSource;
      else globalThis.EventSource = saved.EventSource;
      globalThis.indexedDB = saved.indexedDB;
      dom.cleanup();
    },
  };
}

/**
 * Assert element identity without handing elements to the assertion: a
 * failing diff of two live nodes would serialise the whole model graph.
 *
 * @param {*} actual Observed node.
 * @param {*} expected Expected node.
 * @param {string} message What identity means here.
 * @returns {void}
 */
const same = (actual, expected, message) => assert.ok(actual === expected, message);

/**
 * Assert two nodes are different elements (see {@link same}).
 *
 * @param {*} actual Observed node.
 * @param {*} unexpected Node it must not be.
 * @param {string} message What the difference means here.
 * @returns {void}
 */
const notSame = (actual, unexpected, message) => assert.ok(actual !== unexpected, message);

/**
 * The node row of one node.
 *
 * @param {Object} dom Live table handles.
 * @param {string} nodeId Node id.
 * @returns {?Object} Row element.
 */
const rowOf = (dom, nodeId) => dom.tbody.children.find(row => row.dataset.nodeRow === nodeId) || null;

/**
 * The `+` disclosure row that follows a node's row and sub-rows.
 *
 * @param {Object} dom Live table handles.
 * @param {string} nodeId Node id.
 * @returns {?Object} Disclosure row element.
 */
function extraOf(dom, nodeId) {
  let row = rowOf(dom, nodeId).nextElementSibling;
  while (row && row.classList.contains('nodes-subrow')) row = row.nextElementSibling;
  return row && row.classList.contains('node-extra') ? row : null;
}

test('a table repaint with nothing changed keeps every row and removes none (DR1)', async () => {
  const app = await bootTable({ nodes: [meshtasticNode(A, 10), meshtasticNode(B, 20)] });
  try {
    const before = [...app.dom.tbody.children];
    assert.equal(before.length, 4, 'two node rows, each with its disclosure row');
    app.dom.model.resetStats();
    app.repaint();
    assert.equal(app.dom.model.statsFor(app.dom.tbody).removed, 0, 'a repaint with nothing changed removes no element from #nodes tbody');
    assert.deepEqual(app.dom.tbody.children.map((row, i) => row === before[i]), [true, true, true, true]);
  } finally {
    await app.cleanup();
  }
});

test('a changed node rebuilds only its own changed row; every other row keeps its element', async () => {
  const app = await bootTable({ nodes: [meshtasticNode(A, 10), meshtasticNode(B, 20)] });
  try {
    const [rowA, extraA, rowB, extraB] = app.dom.tbody.children;
    app.dom.model.resetStats();
    app.setNode(A, { battery_level: 41 });
    await app.ping('nodes');
    const [nextA, nextExtraA, nextB, nextExtraB] = app.dom.tbody.children;
    notSame(nextA, rowA, 'the changed row is rebuilt');
    assert.match(nextA.querySelector('.nodes-col--battery').textContent, /41/);
    same(nextExtraA, extraA, 'its disclosure row did not change, so it is kept');
    same(nextB, rowB, 'the other node keeps its row');
    same(nextExtraB, extraB, 'the other node keeps its disclosure row');
    assert.equal(app.dom.model.statsFor(app.dom.tbody).removed, 1, 'one removal: the replaced row');
  } finally {
    await app.cleanup();
  }
});

test('a node that sorts to the top is the only row that moves (DR1)', async () => {
  const app = await bootTable({ nodes: [meshtasticNode(A, 10), meshtasticNode(B, 20), meshtasticNode(C, 30)] });
  try {
    const rowA = rowOf(app.dom, A);
    const rowB = rowOf(app.dom, B);
    const extraC = extraOf(app.dom, C);
    app.dom.model.resetStats();
    app.setNode(C, { last_heard: NOW });
    await app.ping('nodes');
    assert.deepEqual(app.dom.tbody.children.filter(r => r.dataset.nodeRow).map(r => r.dataset.nodeRow), [C, A, B]);
    same(rowOf(app.dom, A), rowA, 'A keeps its row');
    same(rowOf(app.dom, B), rowB, 'B keeps its row');
    same(extraOf(app.dom, C), extraC, 'the unchanged disclosure row moves with its node');
    const stats = app.dom.model.statsFor(app.dom.tbody);
    assert.equal(stats.removed, 1, 'only the changed row is removed');
    assert.equal(stats.moved, 1, 'only the moved node\'s unchanged disclosure row moves; nothing else does');
  } finally {
    await app.cleanup();
  }
});

test('zebra striping and flashes follow the live order on kept rows', async () => {
  const app = await bootTable({ nodes: [meshtasticNode(A, 10), meshtasticNode(B, 20), meshtasticNode(C, 30)] });
  try {
    const rowA = rowOf(app.dom, A);
    const rowB = rowOf(app.dom, B);
    assert.equal(rowA.classList.contains('row-alt'), false);
    assert.equal(rowB.classList.contains('row-alt'), true);
    app.setNode(C, { last_heard: NOW });
    await app.ping('nodes');
    same(rowOf(app.dom, A), rowA, 'A keeps its element');
    assert.equal(rowA.classList.contains('row-alt'), true, 'A is now the second row');
    assert.equal(rowB.classList.contains('row-alt'), false, 'B is now the third row');
    assert.equal(rowOf(app.dom, C).classList.contains('row-alt'), false);
    assert.equal(rowOf(app.dom, C).classList.contains('live-flash'), true, 'the changed node flashes (VF3, LV1)');
  } finally {
    await app.cleanup();
  }
});

test('the clock passing rebuilds no row; age buckets move in place (RT2, UX5)', async () => {
  const app = await bootTable({ nodes: [meshtasticNode(A, 10), meshtasticNode(B, 20)] });
  const realNow = Date.now;
  try {
    const before = [...app.dom.tbody.children];
    assert.equal(before[0].getAttribute('data-age'), 'live');
    app.dom.model.resetStats();
    Date.now = () => realNow() + 4 * 3600 * 1000;
    await app.ping('messages');
    // DR4: an idle ping repaints no table; the shared ticker moves the bucket.
    app.t.relativeTimeTicker.tick();
    // A table repaint at the later clock must not rebuild a row either.
    app.repaint();
    assert.equal(app.dom.model.statsFor(app.dom.tbody).removed, 0, 'a later clock alone rebuilds nothing');
    same(app.dom.tbody.children[0], before[0], 'the first row keeps its element');
    assert.equal(before[0].getAttribute('data-age'), 'today', 'the bucket attribute moved in place');
  } finally {
    Date.now = realNow;
    await app.cleanup();
  }
});

test('an open + disclosure stays open across refreshes, on kept and rebuilt rows (DR1, UX9)', async () => {
  const app = await bootTable({ nodes: [meshtasticNode(A, 10), meshtasticNode(B, 20)] });
  try {
    rowOf(app.dom, A).querySelector('.node-extra-toggle').click();
    assert.equal(extraOf(app.dom, A).hidden, false, 'setup: the + opened the disclosure row');

    app.setNode(B, { battery_level: 12 });
    await app.ping('nodes');
    let toggle = rowOf(app.dom, A).querySelector('.node-extra-toggle');
    assert.equal(extraOf(app.dom, A).hidden, false, 'a refresh that rebuilds another row keeps it open');
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(toggle.textContent, '−');

    app.setNode(A, { voltage: 3.1 });
    await app.ping('nodes');
    toggle = rowOf(app.dom, A).querySelector('.node-extra-toggle');
    assert.match(extraOf(app.dom, A).textContent, /3\.1/, 'the disclosure row was rebuilt with the new value');
    assert.equal(extraOf(app.dom, A).hidden, false, 'a rebuilt disclosure row opens from the remembered state');
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(toggle.textContent, '−');

    toggle.click();
    app.repaint();
    assert.equal(extraOf(app.dom, A).hidden, true, 'a closed disclosure stays closed');
    assert.equal(rowOf(app.dom, A).querySelector('.node-extra-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(extraOf(app.dom, B).hidden, true, 'other rows were never opened');
  } finally {
    await app.cleanup();
  }
});

test('focus on a control of a rebuilt row moves to the same control of its replacement (DR1)', async () => {
  const app = await bootTable({ nodes: [meshtasticNode(A, 10), meshtasticNode(B, 20)] });
  try {
    const link = rowOf(app.dom, A).querySelector('.nodes-col--long-name a');
    link.focus();
    app.dom.model.resetStats();
    app.setNode(A, { battery_level: 12 });
    await app.ping('nodes');
    const replacement = rowOf(app.dom, A).querySelector('.nodes-col--long-name a');
    notSame(replacement, link, 'setup: the row was rebuilt');
    same(app.dom.document.activeElement, replacement, 'focus lands on the same control of the new row');
    assert.deepEqual(app.dom.model.focusCalls.map(c => c.options.preventScroll), [true], 'refocusing never scrolls');
  } finally {
    await app.cleanup();
  }
});

test('focus inside an unchanged row is never touched', async () => {
  const app = await bootTable({ nodes: [meshtasticNode(A, 10), meshtasticNode(B, 20)] });
  try {
    const toggle = rowOf(app.dom, B).querySelector('.node-extra-toggle');
    toggle.focus();
    app.dom.model.resetStats();
    app.setNode(A, { battery_level: 12 });
    await app.ping('nodes');
    same(app.dom.document.activeElement, toggle, 'focus stays on the kept control');
    assert.equal(app.dom.model.focusCalls.length, 0, 'no refocus was needed');
  } finally {
    await app.cleanup();
  }
});

test('the identity caret keeps focus across its own click and a refresh (RA1, RA2)', async () => {
  const app = await bootTable({ nodes: [IDENTITY_NODE, meshtasticNode(A, 400)], destinations: DESTINATIONS });
  try {
    const caret = rowOf(app.dom, IDENTITY).querySelector('.identity-disclosure');
    assert.ok(caret, 'setup: the identity renders as a group');
    caret.focus();
    caret.click();
    const opened = rowOf(app.dom, IDENTITY).querySelector('.identity-disclosure');
    assert.equal(opened.getAttribute('aria-expanded'), 'true');
    same(app.dom.document.activeElement, opened, 'the caret keeps focus across its own re-render');
    const order = app.dom.tbody.children.slice(0, 5).map(r => (r.dataset.nodeRow ? 'parent' : r.className));
    assert.deepEqual(order, ['parent', 'nodes-subrow', 'nodes-subrow', 'nodes-subrow', 'node-extra'], 'sub-rows follow their parent (RA2)');

    const subRows = app.dom.tbody.children.slice(1, 4);
    app.setNode(A, { battery_level: 12 });
    await app.ping('nodes');
    same(app.dom.document.activeElement, opened, 'a refresh that rebuilds another row leaves the caret focused');
    assert.deepEqual(app.dom.tbody.children.slice(1, 4).map((r, i) => r === subRows[i]), [true, true, true], 'sub-rows keep their elements');
  } finally {
    await app.cleanup();
  }
});

test('a text selection inside an unchanged row survives a refresh that rebuilds another row', async () => {
  const app = await bootTable({ nodes: [meshtasticNode(A, 10), meshtasticNode(B, 20)] });
  try {
    app.dom.select(rowOf(app.dom, A).querySelector('.nodes-col--long-name a'));
    assert.equal(app.dom.window.getSelection().toString(), 'Node 1');
    app.setNode(B, { battery_level: 12 });
    await app.ping('nodes');
    assert.equal(app.dom.window.getSelection().toString(), 'Node 1');
  } finally {
    await app.cleanup();
  }
});

test('an overlay opened from a table badge stays open, re-anchored when its row is rebuilt', async () => {
  const app = await bootTable({ nodes: [meshtasticNode(B, 5), meshtasticNode(A, 10)] });
  /** @returns {Array<Object>} Open short-info overlays in the body. */
  const overlays = () => app.dom.body.querySelectorAll('.short-info-overlay');
  try {
    rowOf(app.dom, A).querySelector('.short-name').click();
    await settle();
    assert.equal(overlays().length, 1, 'setup: the badge opened its overlay');

    app.setNode(B, { battery_level: 12 });
    await app.ping('nodes');
    assert.equal(overlays().length, 1, 'a refresh that rebuilds another row keeps the overlay');

    app.setNode(A, { battery_level: 12 });
    await app.ping('nodes');
    await settle();
    assert.equal(overlays().length, 1, 'a rebuilt row keeps the overlay open');
    const badgeTop = rowOf(app.dom, A).querySelector('.short-name').getBoundingClientRect().top;
    assert.equal(overlays()[0].style.top, `${badgeTop}px`, 'the overlay follows the new badge');
    overlays()[0].querySelector('.short-info-close').click();
    assert.equal(overlays().length, 0, 'its close button still closes it');
  } finally {
    await app.cleanup();
  }
});

test('an overlay on a kept badge follows its row when a row lands above it', async () => {
  const app = await bootTable({ nodes: [meshtasticNode(B, 5), meshtasticNode(A, 10), meshtasticNode(C, 30)] });
  /** @returns {Array<Object>} Open short-info overlays in the body. */
  const overlays = () => app.dom.body.querySelectorAll('.short-info-overlay');
  try {
    const badge = rowOf(app.dom, A).querySelector('.short-name');
    badge.click();
    await settle();
    assert.equal(overlays()[0].style.top, `${badge.getBoundingClientRect().top}px`, 'setup: the overlay sits on the badge');
    app.setNode(C, { last_heard: NOW });
    await app.ping('nodes');
    same(rowOf(app.dom, A).querySelector('.short-name'), badge, 'setup: the badge is kept');
    assert.equal(app.dom.model.scrollY, 0, 'setup: at the page top nothing scrolls');
    assert.equal(overlays()[0].style.top, `${badge.getBoundingClientRect().top}px`, 'the overlay moved down with its row');
  } finally {
    await app.cleanup();
  }
});

test('an overlay still loading when its row is rebuilt shows its details on the new badge', async () => {
  const app = await bootTable({ nodes: [meshtasticNode(B, 5), meshtasticNode(A, 10)] });
  const stubFetch = globalThis.fetch;
  const held = [];
  // Hold the badge's details fetch so the live refresh lands while it is in flight.
  globalThis.fetch = (url, init) => (String(url).startsWith('/api/nodes/')
    ? new Promise(resolve => held.push(() => resolve(stubFetch(url, init))))
    : stubFetch(url, init));
  /** @returns {Array<Object>} Open short-info overlays in the body. */
  const overlays = () => app.dom.body.querySelectorAll('.short-info-overlay');
  try {
    rowOf(app.dom, A).querySelector('.short-name').click();
    assert.match(overlays()[0].textContent, /Loading/, 'setup: the details are still loading');
    app.setNode(A, { battery_level: 12 });
    await app.ping('nodes');
    assert.equal(overlays().length, 1, 'the loading overlay follows the rebuilt badge');
    held.splice(0).forEach(release => release());
    await settle();
    assert.equal(overlays().length, 1);
    assert.doesNotMatch(overlays()[0].textContent, /Loading/, 'the details land on the moved overlay');
    const badgeTop = rowOf(app.dom, A).querySelector('.short-name').getBoundingClientRect().top;
    assert.equal(overlays()[0].style.top, `${badgeTop}px`, 'anchored to the new badge');
  } finally {
    globalThis.fetch = stubFetch;
    await app.cleanup();
  }
});

test('the row under a page-scrolled reader stays put when a row lands above it', async () => {
  const nodes = Array.from({ length: 8 }, (_, i) => meshtasticNode(`!bbbb000${i}`, 10 * (i + 1)));
  const app = await bootTable({ nodes, dom: { tableTop: 400, rowHeight: 20, nativeScrollAnchoring: false } });
  try {
    app.dom.model.scrollY = 460;
    const reader = app.dom.model.rowAt(5);
    assert.equal(reader.dataset.nodeRow, '!bbbb0003', 'setup: the fourth node sits under the reader');
    app.setNode('!bbbb0007', { last_heard: NOW });
    await app.ping('nodes');
    same(rowOf(app.dom, '!bbbb0007'), app.dom.tbody.children[0], 'setup: the bumped node moved to the top');
    same(app.dom.model.rowAt(5), reader, 'the same row is still under the reader');
    assert.equal(app.dom.model.scrollY, 480);
  } finally {
    await app.cleanup();
  }
});

test('a browser with native scroll anchoring gets no manual scroll', async () => {
  const nodes = Array.from({ length: 8 }, (_, i) => meshtasticNode(`!bbbb000${i}`, 10 * (i + 1)));
  const app = await bootTable({ nodes, dom: { nativeScrollAnchoring: true } });
  try {
    app.dom.model.scrollY = 460;
    app.dom.model.resetStats();
    app.setNode('!bbbb0007', { last_heard: NOW });
    await app.ping('nodes');
    assert.deepEqual(app.dom.model.scrollCalls, [], 'CSS scroll anchoring keeps the reader in place on its own');
  } finally {
    await app.cleanup();
  }
});

test('coordinate links stay on kept rows and follow a moved position', async () => {
  const app = await bootTable({ nodes: [meshtasticNode(A, 10, { latitude: 52.5, longitude: 13.4 })] });
  try {
    const link = rowOf(app.dom, A).querySelector('.nodes-col--latitude .nodes-coordinate-link');
    assert.ok(link, 'setup: the latitude cell carries a map link');
    app.repaint();
    same(rowOf(app.dom, A).querySelector('.nodes-col--latitude .nodes-coordinate-link'), link, 'a kept row keeps its map link');
    app.setNode(A, { latitude: 52.6 });
    await app.ping('nodes');
    const moved = rowOf(app.dom, A).querySelector('.nodes-col--latitude .nodes-coordinate-link');
    notSame(moved, link, 'a moved position rebuilds the link');
    assert.equal(moved.dataset.lat, '52.6');
  } finally {
    await app.cleanup();
  }
});

test('a row without a node id or last-heard time is keyed by position and keeps its own + state', async () => {
  const app = await bootTable({ nodes: [] });
  const anonymous = { short_name: 'ANON', long_name: 'Anonymous', protocol: 'meshtastic', last_heard: 0 };
  try {
    app.t.renderTable([anonymous], NOW);
    const [row, extra] = app.dom.tbody.children;
    assert.equal(row.getAttribute('data-node-row'), null, 'no node id to stamp');
    assert.equal(row.getAttribute('data-age'), null, 'no age bucket without a last-heard time');
    row.querySelector('.node-extra-toggle').click();
    assert.equal(extra.hidden, false, 'setup: the + opened the disclosure row');
    app.t.renderTable([anonymous], NOW);
    same(app.dom.tbody.children[0], row, 'the row is kept under its positional key');
    assert.equal(extra.hidden, false, 'its open disclosure is left as the reader set it');
  } finally {
    await app.cleanup();
  }
});

test('the waiting row survives a repaint of an empty table (UX4)', async () => {
  const app = await bootTable({ nodes: [] });
  try {
    const waiting = app.dom.tbody.querySelector('.nodes-empty-row');
    assert.ok(waiting, 'setup: the empty table shows the waiting row');
    app.dom.model.resetStats();
    app.repaint();
    same(app.dom.tbody.querySelector('.nodes-empty-row'), waiting, 'the waiting row keeps its element');
    assert.equal(app.dom.model.statsFor(app.dom.tbody).removed, 0);

    app.responses['/api/nodes'] = [meshtasticNode(A, 10)];
    await app.ping('nodes');
    same(app.dom.tbody.querySelector('.nodes-empty-row'), null, 'real rows replace the waiting row');
    assert.ok(rowOf(app.dom, A));
  } finally {
    await app.cleanup();
  }
});

test('the show-all row survives a repaint; show all keeps the rendered rows', async () => {
  const nodes = Array.from({ length: NODE_TABLE_RENDER_CAP + 3 }, (_, i) =>
    meshtasticNode(`!cc${String(i).padStart(6, '0')}`, i + 1));
  const app = await bootTable({ nodes });
  try {
    const showAll = app.dom.tbody.querySelector('.nodes-show-all-row');
    assert.ok(showAll, 'setup: the capped table offers show all');
    const firstRow = app.dom.tbody.children[0];
    app.dom.model.resetStats();
    app.repaint();
    same(app.dom.tbody.querySelector('.nodes-show-all-row'), showAll, 'the show-all row keeps its element');
    assert.equal(app.dom.model.statsFor(app.dom.tbody).removed, 0);

    app.dom.tbody.querySelector('.nodes-show-all').click();
    same(app.dom.tbody.querySelector('.nodes-show-all-row'), null, 'show all drops its own row');
    same(app.dom.tbody.children[0], firstRow, 'the rows already on screen keep their elements');
    assert.equal(app.dom.tbody.children.filter(r => r.dataset.nodeRow).length, NODE_TABLE_RENDER_CAP + 3);
  } finally {
    await app.cleanup();
  }
});
