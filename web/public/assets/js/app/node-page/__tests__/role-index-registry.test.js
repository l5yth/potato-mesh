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
 * The node page's role index fills from a node registry (SPEC OV2, OV3): the
 * dashboard's, handed over by the overlay, or the one the standalone page
 * fetches. Only ids the registry lacks are looked up per id, and a registry
 * record contributes what the per-id lookup did.
 *
 * @module node-page/__tests__/role-index-registry
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as roleIndexModule from '../role-index.js';
import { buildTraceRoleIndex } from '../traces.js';
import { renderNeighborGroups } from '../neighbor-rendering.js';
import { fetchNodeDetailHtml } from '../bootstrap.js';
import { applyNodeNameFallback } from '../../main/long-link-router.js';

// Read through the namespace so the suite loads, and fails per test, on a
// tree without the fill.
const { buildNeighborRoleIndex, fillIndexFromRegistry, lookupNeighborDetails } = roleIndexModule;

const HUB = { nodeId: '!a000000f', role: 'ROUTER', shortName: 'HUB0', longName: 'Hub Zero' };

/**
 * A neighbour row of the hub, which names the neighbour by id only.
 *
 * @param {string} id Neighbour id.
 * @returns {Object} Neighbour row.
 */
const row = id => ({ node_id: HUB.nodeId, neighbor_id: id, snr: 4.5 });

/**
 * A ``/api/nodes``-shaped record.
 *
 * @param {string} id Node id.
 * @param {Object} [fields] Extra or overriding fields.
 * @returns {Object} Node record.
 */
const record = (id, fields = {}) => ({
  node_id: id, short_name: `S${id.slice(-2)}`, long_name: `Node ${id}`, role: 'CLIENT', protocol: 'meshtastic', ...fields,
});

/**
 * A registry Map keyed by node id, as ``fetchNodesById`` and the dashboard build it.
 *
 * @param {Array<Object>} records Node records.
 * @returns {Map<string, Object>} Registry.
 */
const registryOf = records => new Map(records.map(entry => [entry.node_id, entry]));

/**
 * A fetch stub serving ``/api/nodes/:id`` from ``records`` (404 otherwise)
 * and logging every request.
 *
 * @param {Array<Object>} [records] Records the per-id route knows.
 * @param {{ list?: Array<Object>, messages?: Array<Object> }} [options]
 *   ``list``: the registry page body; ``messages``: the node's messages.
 * @returns {{ calls: Array<string>, fetchImpl: Function }} Log and stub.
 */
function stubFetch(records = [], { list = [], messages = [] } = {}) {
  const byId = registryOf(records);
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const [path] = url.split('?');
    if (path.startsWith('/api/nodes/')) {
      const found = byId.get(decodeURIComponent(path.slice('/api/nodes/'.length)));
      return found
        ? { ok: true, status: 200, json: async () => ({ ...found }) }
        : { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    }
    if (path === '/api/nodes') return { ok: true, status: 200, json: async () => list.map(entry => ({ ...entry })) };
    if (path.startsWith('/api/messages/')) return { ok: true, status: 200, json: async () => messages };
    return { ok: true, status: 200, json: async () => [] };
  };
  return { calls, fetchImpl };
}

/** Lookups the role index issued, one per neighbour or hop. */
const lookups = calls => calls.filter(url => url.startsWith('/api/nodes/'));

/** A badge stub that shows what the role index resolved. */
const badge = (short, role, longName) => `<b data-role="${role}" title="${longName ?? ''}">${short}</b>`;

test('buildNeighborRoleIndex takes roles and names from a given registry and looks up only the rest (SPEC OV2)', async () => {
  const known = ['!b0000001', '!b0000002', '!b0000003'].map((id, i) => record(id, { role: i === 0 ? 'REPEATER' : 'CLIENT' }));
  const stale = record('!b0000004', { role: 'ROUTER' });
  const { calls, fetchImpl } = stubFetch([...known, stale]);
  const neighbors = [...known, stale].map(entry => row(entry.node_id));

  const index = await buildNeighborRoleIndex(HUB, neighbors, { fetchImpl, nodesById: registryOf(known) });

  assert.deepEqual(lookups(calls), ['/api/nodes/!b0000004'], 'only the id the registry lacks is looked up');
  for (const entry of [...known, stale]) {
    assert.deepEqual(lookupNeighborDetails(index, { identifier: entry.node_id }), {
      role: entry.role, shortName: entry.short_name, longName: entry.long_name,
    });
  }
});

test('a registry record registers what its per-id lookup registered (SPEC OV2)', async () => {
  const records = [
    record('!b0000001', { role: 'REPEATER' }),
    record('!b0000002', { short_name: undefined }),
    record('!b0000003', { long_name: undefined, role: undefined }),
  ];
  const neighbors = records.map(entry => row(entry.node_id));
  const viaLookups = await buildNeighborRoleIndex(HUB, neighbors, stubFetch(records));
  const { calls, fetchImpl } = stubFetch();
  const viaRegistry = await buildNeighborRoleIndex(HUB, neighbors, { fetchImpl, nodesById: registryOf(records) });

  assert.deepEqual(lookups(calls), []);
  assert.equal(
    renderNeighborGroups(HUB, neighbors, badge, { roleIndex: viaRegistry }),
    renderNeighborGroups(HUB, neighbors, badge, { roleIndex: viaLookups }),
  );
});

test('names the dashboard filled in for a nameless node count as absent, as the API returns none (SPEC OV2)', async () => {
  const nameless = { node_id: '!b00000ef', role: 'ROUTER', protocol: 'meshtastic' };
  const dashboardCopy = { ...nameless };
  applyNodeNameFallback(dashboardCopy);
  assert.ok(dashboardCopy.short_name && dashboardCopy.long_name, 'the dashboard names a nameless node');
  const neighbors = [row(nameless.node_id)];

  const viaLookup = await buildNeighborRoleIndex(HUB, neighbors, stubFetch([nameless]));
  const viaRegistry = await buildNeighborRoleIndex(HUB, neighbors, {
    fetchImpl: stubFetch().fetchImpl,
    nodesById: registryOf([dashboardCopy]),
  });

  const html = renderNeighborGroups(HUB, neighbors, badge, { roleIndex: viaRegistry });
  assert.equal(html, renderNeighborGroups(HUB, neighbors, badge, { roleIndex: viaLookup }));
  assert.ok(html.includes('data-role="ROUTER" title="">00EF</b>'), 'the badge reads the id, uppercase, untitled');
});

test('fillIndexFromRegistry resolves ids case-blind and passes the rest through (SPEC OV2)', () => {
  const index = { byId: new Map(), byNum: new Map(), detailsById: new Map(), detailsByNum: new Map() };
  const wanted = new Map([['!b0000001', '!B0000001'], ['!b0000002', '!b0000002']]);
  const remaining = fillIndexFromRegistry(index, wanted, registryOf([record('!b0000001', { role: 'REPEATER' })]));

  assert.deepEqual([...remaining], [['!b0000002', '!b0000002']]);
  assert.equal(lookupNeighborDetails(index, { identifier: '!B0000001' }).role, 'REPEATER');
  assert.equal(wanted.size, 2, 'the caller map is left as it was');
  // No registry, an empty one, or nothing wanted: the wanted ids pass through.
  assert.equal(fillIndexFromRegistry(index, wanted, null), wanted);
  assert.equal(fillIndexFromRegistry(index, wanted, new Map()), wanted);
  assert.equal(fillIndexFromRegistry(index, new Map(), registryOf([record('!b0000001')])).size, 0);
  assert.equal(fillIndexFromRegistry(index, null, registryOf([record('!b0000001')])), null);
});

test('a registry record names its node by node_id, nodeId or id, else by the id it was found under (SPEC OV2)', () => {
  const index = { byId: new Map(), byNum: new Map(), detailsById: new Map(), detailsByNum: new Map() };
  const registry = new Map([
    ['!b0000001', { nodeId: '!b0000001', role: 'ROUTER' }],
    ['!b0000002', { id: '!b0000002', role: 'REPEATER' }],
    ['!b0000003', { role: 'CLIENT_MUTE' }],
  ]);
  const wanted = new Map([...registry.keys()].map(id => [id, id]));
  assert.equal(fillIndexFromRegistry(index, wanted, registry).size, 0);
  assert.deepEqual([...index.byId], [['!b0000001', 'ROUTER'], ['!b0000002', 'REPEATER'], ['!b0000003', 'CLIENT_MUTE']]);
});

test('buildTraceRoleIndex names hops from the registry and looks up only the rest (SPEC OV2)', async () => {
  const relay = record('!c0000001', { short_name: 'RLY1', role: 'REPEATER' });
  const target = record('!c0000002', { short_name: 'TGT1' });
  const { calls, fetchImpl } = stubFetch([target]);
  const traces = [{ src: HUB.nodeId, hops: [relay.node_id], dest: target.node_id }];
  const base = await buildNeighborRoleIndex(HUB, [], { fetchImpl });

  const index = await buildTraceRoleIndex(traces, base, { fetchImpl, nodesById: registryOf([relay]) });

  assert.deepEqual(lookups(calls), ['/api/nodes/!c0000002']);
  assert.equal(lookupNeighborDetails(index, { identifier: relay.node_id }).shortName, 'RLY1');
  assert.equal(lookupNeighborDetails(index, { identifier: target.node_id }).shortName, 'TGT1');
});

/**
 * ``refreshImpl`` for the hub with the given neighbour rows.
 *
 * @param {Array<Object>} neighbors Neighbour rows.
 * @returns {Function} Refresh stub.
 */
const refreshHub = neighbors => async () => ({
  ...HUB, neighbors, rawSources: { node: { node_id: HUB.nodeId, role: HUB.role, short_name: HUB.shortName } },
});

test('fetchNodeDetailHtml uses a given registry: no registry page, no lookups, and its messages read it (SPEC OV1)', async () => {
  const neighbours = [record('!b0000001', { role: 'REPEATER' }), record('!b0000002')];
  // Not a neighbour: only the registry knows the node a message mentions.
  const mentioned = record('!b00000aa', { protocol: 'meshcore', short_name: 'MEN1', long_name: 'Mentioned Node' });
  const messages = [{ text: 'hi @[Mentioned Node]', protocol: 'meshcore', rx_time: 1_700_000_000, node_id: HUB.nodeId }];
  const { calls, fetchImpl } = stubFetch(neighbours, { messages });

  const html = await fetchNodeDetailHtml({ nodeId: HUB.nodeId }, {
    refreshImpl: refreshHub(neighbours.map(entry => row(entry.node_id))),
    fetchImpl,
    renderShortHtml: badge,
    nodesById: registryOf([...neighbours, mentioned]),
  });

  assert.deepEqual(calls.filter(url => url.startsWith('/api/nodes')), [], 'no registry page and no lookup');
  assert.ok(html.includes('data-role="REPEATER" title="Node !b0000001">S01</b>'), 'the neighbour reads the registry');
  assert.ok(html.includes('title="Mentioned Node">MEN1</b>'), 'the mention resolves to the given registry record');
});

test('the standalone page fetches the registry once and looks up only neighbours it lacks (SPEC OV3)', async () => {
  const recent = [record('!b0000001', { role: 'REPEATER' }), record('!b0000002')];
  // Heard ten days ago: past the 7-day registry page, inside the 28-day per-id lookup.
  const older = record('!b0000003', { role: 'ROUTER' });
  const { calls, fetchImpl } = stubFetch([...recent, older], { list: recent });

  const html = await fetchNodeDetailHtml({ nodeId: HUB.nodeId }, {
    refreshImpl: refreshHub([...recent, older].map(entry => row(entry.node_id))),
    fetchImpl,
    renderShortHtml: badge,
  });

  assert.deepEqual(calls.filter(url => url.startsWith('/api/nodes')), ['/api/nodes?limit=1000', '/api/nodes/!b0000003']);
  for (const entry of [...recent, older]) {
    assert.ok(html.includes(`data-role="${entry.role}" title="${entry.long_name}">${entry.short_name}</b>`), entry.node_id);
  }
});

test('a failed node read leaves the list request unread, with no warning (SPEC OV3)', async () => {
  const calls = [];
  let reads = 0;
  const fetchImpl = async url => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => { reads += 1; return []; } };
  };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    await assert.rejects(
      fetchNodeDetailHtml({ nodeId: HUB.nodeId }, {
        refreshImpl: async () => { throw new Error('node read failed'); },
        fetchImpl,
        renderShortHtml: badge,
      }),
      /node read failed/,
    );
    await new Promise(resolve => setTimeout(resolve, 0));
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(calls, ['/api/nodes?limit=1000'], 'the list request still starts beside the node read');
  assert.equal(reads, 0, 'its response is never read');
  assert.deepEqual(warnings, []);
});

test('an empty registry is fetched like the standalone page (an overlay without dashboard data, FP-A5)', async () => {
  const { calls, fetchImpl } = stubFetch([], { list: [record('!b0000001')] });
  await fetchNodeDetailHtml({ nodeId: HUB.nodeId }, {
    refreshImpl: refreshHub([row('!b0000001')]),
    fetchImpl,
    renderShortHtml: badge,
    nodesById: new Map(),
  });
  assert.deepEqual(calls.filter(url => url.startsWith('/api/nodes')), ['/api/nodes?limit=1000']);
});
