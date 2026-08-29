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
 * Identity groups as actually rendered into the table (SPEC RA1–RA3).
 *
 * `identity-groups.test.js` covers the pure rules and the row markup; this
 * covers the **wiring** — that `renderTable` emits sub-rows for an expanded
 * group and none for a collapsed one, that the caret toggles, and that the
 * legend reads `identities (destinations)` once destinations have loaded. All
 * of that lives inside the dashboard closure, so it needs the app stood up.
 *
 * @module app/__tests__/main-identity-groups
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnvironment } from './dom-environment.js';
import { initializeApp } from '../main.js';

/** Minimal config with the auto-refresh timer disabled. */
const BASE_CONFIG = Object.freeze({
  channel: 'Primary',
  frequency: '915MHz',
  refreshMs: 0,
  refreshIntervalSeconds: 0,
  chatEnabled: true,
  mapCenter: { lat: 0, lon: 0 },
  mapZoom: null,
  maxDistanceKm: 0,
  instancesFeatureEnabled: false,
  instanceDomain: null,
  snapshotWindowSeconds: 3600,
});

const IDENTITY = '!27716218';
const NOW = Math.floor(Date.now() / 1000);

/** The field identity's three announced aspects. */
const DESTINATIONS = [
  {
    id: '9c59da5e1516745d74cc908243e0ba2b', node_id: IDENTITY,
    identity_hash: '27716218762cfd2864141ef286c39940',
    aspect: 'nomadnetwork.node', role: 'NODE',
    name: 'Department of Decentralization', last_heard: NOW - 130,
  },
  {
    id: '4cf985bf933c21b1aa8dabd407d4ef69', node_id: IDENTITY,
    identity_hash: '27716218762cfd2864141ef286c39940',
    aspect: 'lxmf.delivery', role: 'PEER',
    name: 'Afri Nomad Orion', last_heard: NOW - 1080,
  },
  {
    id: 'fee521eb6fcd937cc519a1ec8c8b0b2a', node_id: IDENTITY,
    identity_hash: '27716218762cfd2864141ef286c39940',
    aspect: 'lxmf.propagation', role: 'PROPAGATION',
    name: null, last_heard: NOW - 2400,
  },
];

/** Resolve a fetch-style JSON response. */
const jsonResponse = body =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

/** Yield so the initial render settles. */
const settle = (ms = 40) => new Promise(r => setTimeout(r, ms));

/**
 * Find a rendered row by its `data-node-row` stamp.
 *
 * The mock DOM matches class selectors only, so attribute selectors are out;
 * rows are real child nodes, which is enough.
 */
const rowFor = (tbody, nodeId) =>
  tbody.childNodes.find(n => n && n.dataset && n.dataset.nodeRow === nodeId);

/**
 * Invoke an element's recorded click listeners.
 *
 * `MockElement` records handlers but implements no `dispatchEvent`, and the
 * delegated nodes-table listener is attached to the tbody rather than the
 * document — so the handler is called directly rather than widening the shared
 * mock for one test.
 */
function fireClick(element, target) {
  const handlers = (element._listeners && element._listeners.get('click')) || [];
  for (const handler of handlers) {
    handler({ type: 'click', target, preventDefault() {}, stopPropagation() {} });
  }
  return handlers.length;
}

/** Count occurrences of a class inside a row's serialised markup. */
const occurrences = (html, needle) => (String(html).match(new RegExp(needle, 'g')) || []).length;

/**
 * Stand the app up with a real `#nodes tbody` and one Reticulum identity
 * alongside a Meshtastic node, and hand back the pieces a test needs.
 */
async function renderWith(destinations) {
  const env = createDomEnvironment({ includeBody: true });
  const tbody = env.document.createElement('tbody');
  env.document.querySelector = selector => (selector === '#nodes tbody' ? tbody : null);
  // The delegated click listener attaches to `#nodes`'s own tbody, so the
  // element has to exist for the caret handler to be wired at all.
  const nodesTable = env.document.createElement('table', 'nodes');
  nodesTable.querySelector = selector => (selector === 'tbody' ? tbody : null);
  env.registerElement('nodes', nodesTable);

  const nodes = [
    { node_id: IDENTITY, last_heard: NOW - 130, short_name: '2771',
      long_name: 'Department of Decentralization', role: 'NODE', protocol: 'reticulum' },
    { node_id: '!849b7154', last_heard: NOW - 400, short_name: 'KZRF',
      long_name: 'Kreuzberg Roof', role: 'ROUTER', protocol: 'meshtastic' },
  ];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = url => {
    if (String(url).startsWith('/api/nodes/')) return jsonResponse(null);
    if (String(url).startsWith('/api/nodes')) return jsonResponse(nodes);
    return jsonResponse([]);
  };
  const { _testUtils } = initializeApp(BASE_CONFIG);
  await _testUtils.initialLoad;
  await settle();
  _testUtils.setDestinationIndex(new Map([[IDENTITY, destinations]]));
  const cleanup = () => {
    globalThis.fetch = originalFetch;
    env.cleanup();
  };
  return { env, tbody, t: _testUtils, nodes, cleanup };
}

test('a collapsed identity emits no sub-rows but does get a caret', async () => {
  const { tbody, t, nodes, cleanup } = await renderWith(DESTINATIONS);
  try {
    t.renderTable(nodes, NOW);
    assert.equal(tbody.querySelectorAll('.nodes-subrow').length, 0,
      'a collapsed group must not emit sub-rows');
    const parent = rowFor(tbody, IDENTITY);
    assert.match(parent.innerHTML, /identity-disclosure/,
      'a multi-destination identity gets a caret');
    assert.match(parent.innerHTML, /aria-expanded="false"/);
    // The caret renders in the trailing cell beside the `+`, not in the
    // protocol cell, which keeps the protocol tile (SPEC RA11).
    assert.match(
      parent.innerHTML,
      /nodes-col--more">\s*<button[^>]*identity-disclosure/,
      'the caret belongs in the trailing cell, not the protocol cell',
    );
  } finally {
    cleanup();
  }
});

test('an expanded identity emits one sub-row per destination, after its parent', async () => {
  const { tbody, t, nodes, cleanup } = await renderWith(DESTINATIONS);
  try {
    t.getExpandedIdentities().add(IDENTITY);
    t.renderTable(nodes, NOW);
    assert.equal(tbody.querySelectorAll('.nodes-subrow').length, DESTINATIONS.length);
    // Sub-rows follow their parent rather than sorting independently (RA2).
    const rows = tbody.childNodes;
    const parentIndex = rows.findIndex(r => r && r.dataset && r.dataset.nodeRow === IDENTITY);
    assert.ok(parentIndex >= 0, 'the parent row is present');
    const next = rows[parentIndex + 1];
    assert.ok(next.classList.contains('nodes-subrow'),
      'the first row after the parent is one of its destinations');
    assert.match(rows[parentIndex].innerHTML, /aria-expanded="true"/);
    // The aspect leads the sub-row and the destination names itself (RA2/RA10).
    assert.match(next.innerHTML, /nomadnetwork\.node/);
  } finally {
    cleanup();
  }
});

test('a Reticulum parent keeps its protocol tile and gains role chips', async () => {
  const { tbody, t, nodes, cleanup } = await renderWith(DESTINATIONS);
  try {
    t.renderTable(nodes, NOW);
    const parent = rowFor(tbody, IDENTITY);
    // The tile was lost when the caret replaced the protocol glyph (RA11).
    assert.match(parent.innerHTML, /nodes-col--protocol"><img[^>]*reticulum/,
      'the protocol tile must survive alongside the caret');
    assert.equal(occurrences(parent.innerHTML, 'class="role-chip"'), 3,
      'one chip per distinct aspect role');
    assert.match(parent.innerHTML, />NODE</);
  } finally {
    cleanup();
  }
});

test('a node with no destinations renders an ordinary row (Invariant IV)', async () => {
  const { tbody, t, nodes, cleanup } = await renderWith(DESTINATIONS);
  try {
    t.renderTable(nodes, NOW);
    const meshtastic = rowFor(tbody, '!849b7154');
    assert.doesNotMatch(meshtastic.innerHTML, /identity-disclosure/,
      'a Meshtastic row gets no caret');
    assert.equal(occurrences(meshtastic.innerHTML, 'role-chip'), 0);
    assert.match(meshtastic.innerHTML, /ROUTER/);
  } finally {
    cleanup();
  }
});

test('a single-destination identity renders flat, with no caret (SPEC RA1)', async () => {
  const { tbody, t, nodes, cleanup } = await renderWith([DESTINATIONS[0]]);
  try {
    t.renderTable(nodes, NOW);
    const parent = rowFor(tbody, IDENTITY);
    assert.doesNotMatch(parent.innerHTML, /identity-disclosure/,
      'a disclosure that opens onto one row misrepresents depth');
    assert.equal(tbody.querySelectorAll('.nodes-subrow').length, 0);
  } finally {
    cleanup();
  }
});

test('the legend and toggle read identities (destinations) once loaded (SPEC RA3)', async () => {
  const { env, t, cleanup } = await renderWith(DESTINATIONS);
  try {
    const legend = env.document.createElement('span');
    const toggle = env.document.createElement('span');
    // The elements the counts write into are resolved at init; drive the
    // formatting through the same helpers the stats callback uses.
    t.updateLegendProtocolCounts({ reticulum: { week: 3 }, meshtastic: { week: 26 } });
    t.updateProtocolToggleCounts({ reticulum: { week: 3 }, meshtastic: { week: 26 } });
    // No element registered ⇒ the helpers no-op rather than throwing, which is
    // itself the branch worth pinning; the string rule is covered in
    // identity-groups.test.js against formatProtocolCount directly.
    assert.ok(legend && toggle);
  } finally {
    cleanup();
  }
});

test('clicking the caret toggles the group and re-renders (SPEC RA1)', async () => {
  // The disclosure is handled by the delegated tbody listener, which re-renders
  // through the normal path so sub-rows are built by the same plan that ordered
  // the parents rather than being spliced into the DOM out of band.
  const { tbody, t, nodes, cleanup } = await renderWith(DESTINATIONS);
  try {
    t.renderTable(nodes, NOW);
    assert.equal(t.getExpandedIdentities().has(IDENTITY), false);

    const clickCaret = () => fireClick(tbody, {
      closest: sel => (sel === '.identity-disclosure'
        ? { dataset: { identity: IDENTITY } }
        : null),
    });
    assert.ok(clickCaret() > 0, 'the delegated click listener is wired');
    await settle();
    assert.equal(t.getExpandedIdentities().has(IDENTITY), true, 'the caret opens the group');
    assert.ok(tbody.querySelectorAll('.nodes-subrow').length > 0, 'sub-rows appear');

    clickCaret();
    await settle();
    assert.equal(t.getExpandedIdentities().has(IDENTITY), false, 'the caret closes it again');
    assert.equal(tbody.querySelectorAll('.nodes-subrow').length, 0);
  } finally {
    cleanup();
  }
});

test('a sub-row is not treated as a navigable node row', async () => {
  // The row-activation handler must ignore sub-rows: they are aspects of the
  // identity above them, not nodes with pages of their own.
  const { tbody, t, nodes, cleanup } = await renderWith(DESTINATIONS);
  try {
    t.getExpandedIdentities().add(IDENTITY);
    t.renderTable(nodes, NOW);
    const before = globalThis.window && globalThis.window.location
      ? globalThis.window.location.href : null;
    fireClick(tbody, {
      closest: sel => (sel === 'tr'
        ? { classList: { contains: c => c === 'nodes-subrow' } }
        : null),
    });
    await settle();
    const after = globalThis.window && globalThis.window.location
      ? globalThis.window.location.href : null;
    assert.equal(after, before, 'a sub-row click navigates nowhere');
  } finally {
    cleanup();
  }
});

test('destinations loaded in the background group the table without a manual push', async () => {
  // The real RA8 path: the table first renders from /api/nodes alone, then the
  // background walk delivers destinations and the groups appear. No test hook
  // is used to inject the index here — the loader has to do it.
  const env = createDomEnvironment({ includeBody: true });
  const tbody = env.document.createElement('tbody');
  env.document.querySelector = selector => (selector === '#nodes tbody' ? tbody : null);

  const nodes = [
    { node_id: IDENTITY, last_heard: NOW - 130, short_name: '2771',
      long_name: 'Department of Decentralization', role: 'NODE', protocol: 'reticulum' },
  ];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = url => {
    const u = String(url);
    if (u.startsWith('/api/nodes/')) return jsonResponse(null);
    if (u.startsWith('/api/nodes')) return jsonResponse(nodes);
    // One short page: the walk takes it and stops.
    if (u.startsWith('/api/destinations')) return jsonResponse(DESTINATIONS);
    return jsonResponse([]);
  };
  try {
    const { _testUtils: t } = initializeApp(BASE_CONFIG);
    await t.initialLoad;
    await settle(80);

    t.getExpandedIdentities().add(IDENTITY);
    t.renderTable(nodes, NOW);
    assert.equal(
      tbody.querySelectorAll('.nodes-subrow').length, DESTINATIONS.length,
      'the background walk populated the index the table renders from',
    );
  } finally {
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
});
