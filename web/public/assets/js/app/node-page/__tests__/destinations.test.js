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

import test from 'node:test';
import assert from 'node:assert/strict';

import { identitySummary, renderDestinationsSection } from '../destinations.js';
import { renderSingleNodeTable } from '../single-node-table.js';
import { TRANSPORT_ASPECT } from '../../main/identity-groups.js';

const NOW = 1_700_000_000;

/** The field identity: three announced aspects plus its transport instance. */
const DESTINATIONS = [
  {
    id: 'fee521eb6fcd937cc519a1ec8c8b0b2a', node_id: '!27716218',
    identity_hash: '27716218762cfd2864141ef286c39940', aspect: 'lxmf.propagation',
    role: 'PROPAGATION', name: null, interface: 'RNodeInterface[BerlinMesh]',
    first_heard: NOW - 800000, last_heard: NOW - 2400,
  },
  {
    id: '9c59da5e1516745d74cc908243e0ba2b', node_id: '!27716218',
    identity_hash: '27716218762cfd2864141ef286c39940', aspect: 'nomadnetwork.node',
    role: 'NODE', name: 'Department of Decentralization',
    interface: 'RNodeInterface[BerlinMesh]',
    first_heard: NOW - 1200000, last_heard: NOW - 130,
  },
  {
    id: '4cf985bf933c21b1aa8dabd407d4ef69', node_id: '!27716218',
    identity_hash: '27716218762cfd2864141ef286c39940', aspect: 'lxmf.delivery',
    role: 'PEER', name: 'Afri Nomad Orion', interface: 'RNodeInterface[BerlinMesh]',
    first_heard: NOW - 1200000, last_heard: NOW - 1080,
  },
  {
    id: 'fbf8e3389bc79a4fe9ed22eae97fc268', node_id: '!27716218',
    identity_hash: '27716218762cfd2864141ef286c39940', aspect: TRANSPORT_ASPECT,
    role: 'TRANSPORT', name: null, interface: 'RNodeInterface[BerlinMesh]',
    first_heard: NOW - 1200000, last_heard: NOW - 130,
  },
];

test('the section shows the full 32-hex destination hashes', () => {
  // SPEC RA5: this is the one view that shows them, because they are what a
  // reader needs to message the peer — everywhere else shows a truncated id.
  const html = renderDestinationsSection(DESTINATIONS, { nowSeconds: NOW });
  for (const destination of DESTINATIONS) {
    assert.ok(html.includes(destination.id), `missing ${destination.id}`);
    assert.equal(destination.id.length, 32);
  }
});

test('rows follow aspect precedence, matching the table chips', () => {
  const html = renderDestinationsSection(DESTINATIONS, { nowSeconds: NOW });
  const order = ['NODE', 'PEER', 'PROPAGATION', 'TRANSPORT'].map(r => html.indexOf(`>${r}<`));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'roles are out of precedence order');
});

test('the section carries every documented column', () => {
  const html = renderDestinationsSection(DESTINATIONS, { nowSeconds: NOW });
  for (const heading of ['Aspect', 'Destination', 'Name', 'Role', 'Interface', 'First Heard', 'Last Heard']) {
    assert.match(html, new RegExp(`<th>${heading}</th>`));
  }
  assert.match(html, /Department of Decentralization/);
  assert.match(html, /Afri Nomad Orion/);
});

test('the transport row shows no aspect but keeps its role (RA7)', () => {
  const html = renderDestinationsSection([DESTINATIONS[3]], { nowSeconds: NOW });
  // The stored aspect is never printed…
  assert.doesNotMatch(html, new RegExp(TRANSPORT_ASPECT));
  // …but the role it maps to still is.
  assert.match(html, />TRANSPORT</);
});

test('a nameless destination renders the muted dash, not an empty cell', () => {
  // `.cell-empty` is the repo's muted-dash class. An earlier draft emitted
  // `class="muted"`, which matches no selector in base.css, so the dash
  // rendered at full foreground weight while this test still passed.
  const html = renderDestinationsSection([DESTINATIONS[0]], { nowSeconds: NOW });
  assert.match(html, /<span class="cell-empty">—<\/span>/);
  assert.doesNotMatch(html, /class="muted"/);
});

test('the section is absent for a node with no destinations', () => {
  // How it stays invisible for Meshtastic and Meshcore (Invariant IV).
  assert.equal(renderDestinationsSection([], { nowSeconds: NOW }), '');
  assert.equal(renderDestinationsSection(null, { nowSeconds: NOW }), '');
  assert.equal(renderDestinationsSection(undefined), '');
});

test('identitySummary reads the identity, count and interface from the rows', () => {
  // /api/nodes deliberately does not serve identity_hash, so the destination
  // rows are the only source (CONTRACTS).
  const summary = identitySummary(DESTINATIONS);
  assert.equal(summary.identityHash, '27716218762cfd2864141ef286c39940');
  assert.equal(summary.count, 4);
  assert.equal(summary.interface, 'RNodeInterface[BerlinMesh]');
});

test('identitySummary degrades cleanly with nothing to summarise', () => {
  assert.deepEqual(identitySummary([]), { identityHash: null, count: 0, interface: null });
  assert.deepEqual(identitySummary(null), { identityHash: null, count: 0, interface: null });
  // Rows missing the fields contribute nothing rather than empty strings.
  const partial = identitySummary([{ id: 'x' }, { identity_hash: '  ', interface: '' }]);
  assert.equal(partial.identityHash, null);
  assert.equal(partial.interface, null);
  assert.equal(partial.count, 2);
});

test('the spec sheet gains an Identity group for a Reticulum identity', () => {
  const node = { node_id: '!27716218', role: 'NODE', last_heard: NOW - 130, first_heard: NOW - 1200000 };
  const html = renderSingleNodeTable(node, () => '', NOW, { destinations: DESTINATIONS });
  assert.match(html, /Identity hash/);
  assert.match(html, /27716218762cfd2864141ef286c39940/);
  assert.match(html, /<dt>Destinations<\/dt>/);
  assert.match(html, /RNodeInterface\[BerlinMesh\]/);
  assert.match(html, /<dt>First Heard<\/dt>/);
});

test('the spec sheet still renders for a node with no destinations', () => {
  // Every other protocol passes no destinations; the sheet must be unchanged
  // apart from an Identity group with nothing in it (RA6 trims it in bucket 5).
  const node = { node_id: '!849b7154', role: 'ROUTER', last_heard: NOW - 400 };
  const html = renderSingleNodeTable(node, () => '', NOW);
  assert.match(html, /<dt>Last Seen<\/dt>/);
  assert.match(html, /<dt>Role<\/dt>/);
  assert.doesNotMatch(html, /27716218/);
});

test('the Destinations section is pushed into the node detail (SPEC RA5)', async () => {
  // detail-html composes optional sections; this pins that destinations reach
  // it and that a node without them leaves the section out entirely.
  const { renderNodeDetailHtml } = await import('../detail-html.js');
  const node = { nodeId: '!27716218', node_id: '!27716218', role: 'NODE', last_heard: NOW - 130 };
  const withDestinations = renderNodeDetailHtml(node, {
    destinations: DESTINATIONS,
    renderShortHtml: () => '',
    chartNowMs: NOW * 1000,
  });
  assert.match(withDestinations, /node-detail__destinations/);
  assert.match(withDestinations, /9c59da5e1516745d74cc908243e0ba2b/);

  const without = renderNodeDetailHtml(node, {
    renderShortHtml: () => '',
    chartNowMs: NOW * 1000,
  });
  assert.doesNotMatch(without, /node-detail__destinations/);
});

test('a destination hash links to its identity page and its row is anchored (SPEC RL5)', () => {
  // RA5 specified that /nodes/!<destination> canonicalises to the owning
  // identity, and the route does — but nothing in the interface ever emitted
  // the link, so the behaviour was reachable only by typing a URL. A spec claim
  // no interface exercises is indistinguishable from one that is false.
  const html = renderDestinationsSection(DESTINATIONS, { nowSeconds: NOW });
  for (const d of DESTINATIONS) {
    const short = d.id.slice(0, 8);
    assert.ok(
      html.includes(`<a href="/nodes/!${short}">${d.id}</a>`),
      `${d.id} is not a link to its identity page`,
    );
    assert.ok(html.includes(`<tr id="dest-${short}">`), `${d.id} has no anchor`);
  }
});

test('a destination with no id renders neither a link nor an anchor', () => {
  const html = renderDestinationsSection(
    [{ node_id: '!27716218', aspect: 'lxmf.delivery', role: 'PEER', name: null }],
    { nowSeconds: NOW },
  );
  assert.doesNotMatch(html, /<a href="\/nodes\//);
  assert.doesNotMatch(html, /<tr id="dest-/);
});

test('the fragment is re-targeted after the table renders (SPEC RL5)', async () => {
  // The destinations table is built after several awaited fetches, so the
  // browser resolved `#dest-…` against a page that did not yet contain the row.
  // Without this the link resolved but landed at the top of the page — the
  // "lands on the row it names" half of RL5 silently did nothing.
  const { scrollToHashTarget } = await import('../bootstrap.js');
  const scrolled = [];
  const doc = {
    location: { hash: '#dest-4cf985bf' },
    getElementById: id => (id === 'dest-4cf985bf'
      ? { scrollIntoView: () => scrolled.push(id) }
      : null),
  };
  assert.equal(scrollToHashTarget(doc), true);
  assert.deepEqual(scrolled, ['dest-4cf985bf']);
});

test('re-targeting is a no-op without a fragment or a matching row', async () => {
  const { scrollToHashTarget } = await import('../bootstrap.js');
  const missing = { location: { hash: '#dest-nope' }, getElementById: () => null };
  assert.equal(scrollToHashTarget(missing), false);
  assert.equal(
    scrollToHashTarget({ location: { hash: '' }, getElementById: () => ({}) }),
    false,
  );
  // An element without scrollIntoView (or no document at all) must not throw.
  assert.equal(
    scrollToHashTarget({ location: { hash: '#x' }, getElementById: () => ({}) }),
    false,
  );
  assert.equal(scrollToHashTarget(null), false);
});
