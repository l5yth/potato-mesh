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

import {
  MAX_VISIBLE_ROLE_CHIPS,
  TRANSPORT_ASPECT,
  aspectLabel,
  aspectRoleRank,
  countDestinations,
  disclosureCellHtml,
  formatProtocolCount,
  isIdentityGroup,
  newestLastHeard,
  planIdentityRows,
  roleChipsHtml,
  sortDestinations,
  subRowCellsHtml,
} from '../identity-groups.js';
import { meshcoreRoleColors, reticulumRoleColors, roleColors } from '../../role-helpers.js';

/** The field's own identity: three aspects of 27716218…, plus its transport. */
const FIELD = {
  node: { node_id: '!27716218', protocol: 'reticulum', long_name: 'Department of Decentralization' },
  nomadnet: {
    id: '9c59da5e1516745d74cc908243e0ba2b', node_id: '!27716218',
    aspect: 'nomadnetwork.node', role: 'NODE', last_heard: 300,
    name: 'Department of Decentralization',
  },
  lxmf: {
    id: '4cf985bf933c21b1aa8dabd407d4ef69', node_id: '!27716218',
    aspect: 'lxmf.delivery', role: 'PEER', last_heard: 200, name: 'Afri Nomad Orion',
  },
  propagation: {
    id: 'fee521eb6fcd937cc519a1ec8c8b0b2a', node_id: '!27716218',
    aspect: 'lxmf.propagation', role: 'PROPAGATION', last_heard: 100, name: null,
  },
  transport: {
    id: 'fbf8e3389bc79a4fe9ed22eae97fc268', node_id: '!27716218',
    aspect: TRANSPORT_ASPECT, role: 'TRANSPORT', last_heard: 300, name: null,
  },
};

const ALL_FOUR = [FIELD.propagation, FIELD.transport, FIELD.lxmf, FIELD.nomadnet];

test('sortDestinations orders by aspect precedence, then newest first', () => {
  // SPEC RE10's order, so the chip that leads a collapsed parent is the aspect
  // that named it — and opening the group never reshuffles what was just read.
  const sorted = sortDestinations(ALL_FOUR);
  assert.deepEqual(sorted.map(d => d.role), ['NODE', 'PEER', 'PROPAGATION', 'TRANSPORT']);

  // Equal rank falls back to recency.
  const tie = sortDestinations([
    { role: 'PEER', last_heard: 10 },
    { role: 'PEER', last_heard: 99 },
  ]);
  assert.deepEqual(tie.map(d => d.last_heard), [99, 10]);
  assert.deepEqual(sortDestinations(null), []);
});

test('aspectRoleRank sorts unknown roles last', () => {
  assert.ok(aspectRoleRank('NODE') < aspectRoleRank('TRANSPORT'));
  assert.ok(aspectRoleRank('TRANSPORT') < aspectRoleRank('WAT'));
});

test('a single-destination identity is not a group', () => {
  // SPEC RA1: a caret that opens onto one row misrepresents depth.
  assert.equal(isIdentityGroup(FIELD.node, [FIELD.lxmf]), false);
  assert.equal(isIdentityGroup(FIELD.node, []), false);
  assert.equal(isIdentityGroup(FIELD.node, null), false);
  assert.equal(isIdentityGroup(FIELD.node, [FIELD.lxmf, FIELD.nomadnet]), true);
});

test('the transport aspect renders as no aspect but keeps its role', () => {
  // SPEC RA7: display rule only — the stored value still drives TRANSPORT.
  assert.equal(aspectLabel(TRANSPORT_ASPECT), '');
  assert.equal(aspectLabel('lxmf.delivery'), 'lxmf.delivery');
  assert.equal(aspectLabel(null), '');
  assert.equal(aspectLabel('   '), '');
  const chips = roleChipsHtml([FIELD.transport], 'reticulum');
  assert.match(chips, /TRANSPORT/);
});

test('newestLastHeard takes the newest announce across destinations', () => {
  assert.equal(newestLastHeard(ALL_FOUR), 300);
  assert.equal(newestLastHeard([{ last_heard: 'nope' }]), null);
  assert.equal(newestLastHeard(null), null);
});

test('role chips use the reticulum ramp and overflow past the budget', () => {
  const chips = roleChipsHtml(ALL_FOUR, 'reticulum');
  // Leading chip is the aspect that named the identity (NODE).
  assert.ok(chips.indexOf('NODE') < chips.indexOf('PEER'));
  assert.match(chips, new RegExp(reticulumRoleColors.NODE));
  assert.match(chips, new RegExp(reticulumRoleColors.PEER));
  // Four distinct roles, three visible: the weakest is hidden behind +1.
  assert.match(chips, /\+1/);
  assert.doesNotMatch(chips, /TRANSPORT/);
  assert.equal(roleChipsHtml([], 'reticulum'), '');
});

test('role chips deduplicate repeated roles rather than counting rows', () => {
  // Two lxmf.delivery destinations are still one PEER chip, and no +N.
  const chips = roleChipsHtml(
    [FIELD.lxmf, { ...FIELD.lxmf, id: 'other', last_heard: 50 }],
    'reticulum',
  );
  assert.equal(chips.match(/PEER/g).length, 1);
  assert.doesNotMatch(chips, /\+/);
});

test('the chip budget leaves room for the common case', () => {
  // A stock stack announces three aspects; all three must fit without overflow.
  const chips = roleChipsHtml([FIELD.nomadnet, FIELD.lxmf, FIELD.propagation], 'reticulum');
  assert.doesNotMatch(chips, /\+/);
  assert.ok(MAX_VISIBLE_ROLE_CHIPS >= 3);
});

test('the disclosure control states its expanded state', () => {
  const collapsed = disclosureCellHtml(false, '!27716218');
  assert.match(collapsed, /aria-expanded="false"/);
  assert.match(collapsed, /▸/);
  assert.match(collapsed, /data-identity="!27716218"/);
  const open = disclosureCellHtml(true, '!27716218');
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /▾/);
});

test('counts read identities (destinations) only where a node holds several', () => {
  // SPEC RA3: the bracket marks a real distinction, so Meshtastic and Meshcore
  // pass null and keep a bare count.
  assert.equal(formatProtocolCount(3, 8), '3 (8)');
  assert.equal(formatProtocolCount(26, null), '26');
  assert.equal(formatProtocolCount(4, undefined), '4');
  assert.equal(formatProtocolCount(undefined, null), '0');
});

test('countDestinations totals the index', () => {
  const index = new Map([['!a', [1, 2]], ['!b', [3]], ['!c', null]]);
  assert.equal(countDestinations(index), 3);
  assert.equal(countDestinations(null), 0);
});

test('planIdentityRows keeps sub-rows with their parent in sort order', () => {
  // SPEC RA2: sorting orders parents; a group's destinations follow the identity
  // they belong to, so no sort interleaves two identities' addresses.
  const other = { node_id: '!849b7154', protocol: 'meshtastic' };
  const index = new Map([['!27716218', ALL_FOUR]]);
  const plan = planIdentityRows(
    [FIELD.node, other],
    index,
    new Set(['!27716218']),
  );
  assert.deepEqual(plan.map(p => p.node.node_id), ['!27716218', '!849b7154']);
  assert.equal(plan[0].isGroup, true);
  assert.equal(plan[0].isExpanded, true);
  assert.deepEqual(plan[0].subRows.map(d => d.role), ['NODE', 'PEER', 'PROPAGATION', 'TRANSPORT']);
  // A node with no destinations is an ordinary row (Invariant IV).
  assert.equal(plan[1].isGroup, false);
  assert.deepEqual(plan[1].subRows, []);
});

test('planIdentityRows emits no sub-rows while a group is collapsed', () => {
  const index = new Map([['!27716218', ALL_FOUR]]);
  const plan = planIdentityRows([FIELD.node], index, new Set());
  assert.equal(plan[0].isGroup, true);
  assert.equal(plan[0].isExpanded, false);
  assert.deepEqual(plan[0].subRows, []);
  // The destinations are still attached, because the collapsed parent needs
  // them for its chips and its newest-last-heard.
  assert.equal(plan[0].destinations.length, 4);
});

test('planIdentityRows tolerates a missing index and malformed nodes', () => {
  assert.deepEqual(planIdentityRows(null, new Map(), new Set()), []);
  const plan = planIdentityRows([{}, FIELD.node], null, null);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].isGroup, false);
});

test('an unrecognised role still renders a chip, in its own palette', () => {
  // Roles come from the wire; a protocol that grows one must not blank the cell,
  // and it must not fall out of its protocol's palette either.
  const chips = roleChipsHtml([{ role: 'SOMETHING_NEW', last_heard: 1 }], 'reticulum');
  assert.match(chips, /SOMETHING_NEW/);
  assert.match(chips, new RegExp(reticulumRoleColors.PEER));
});

test('a role-less destination takes its protocol base role, never CLIENT (SPEC RA9)', () => {
  // Regression guard: a local `?? colors.CLIENT` fallback in the chip renderer
  // reintroduced exactly the defect RA9 fixed -- CLIENT is a Meshtastic role
  // absent from these ramps, so it resolved to grey and mislabelled the chip.
  const reticulum = roleChipsHtml([{ role: null, last_heard: 1 }], 'reticulum');
  assert.match(reticulum, />PEER</);
  assert.match(reticulum, new RegExp(reticulumRoleColors.PEER));
  assert.doesNotMatch(reticulum, /CLIENT/);
  assert.doesNotMatch(reticulum, /#ccc/);

  const meshcore = roleChipsHtml([{ role: null, last_heard: 1 }], 'meshcore');
  assert.match(meshcore, />COMPANION</);
  assert.match(meshcore, new RegExp(meshcoreRoleColors.COMPANION));
  assert.doesNotMatch(meshcore, /CLIENT/);
});

test('the disclosure control tolerates a missing identity', () => {
  const html = disclosureCellHtml(false, null);
  assert.match(html, /data-identity=""/);
});

test('a role outside the protocol ramp falls back within that ramp', () => {
  // PROPAGATION is a Reticulum role; asked for on meshtastic it must resolve to
  // the meshtastic base colour, not to grey.
  const chips = roleChipsHtml([{ role: 'PROPAGATION', last_heard: 1 }], 'meshtastic');
  assert.match(chips, new RegExp(roleColors.CLIENT));
  assert.doesNotMatch(chips, /#ccc/);
});

// ---------------------------------------------------------------------------
// Sub-row markup (SPEC RA2). Extracted from renderTable so it is testable at
// all: the row template previously lived inside a 5,000-line closure and had
// no coverage, so every RA-A1 row-level claim was unverified.
// ---------------------------------------------------------------------------

/**
 * Minimal badge renderer standing in for renderShortHtml.
 *
 * Echoes the `nodeData` it is handed, so a test can assert what the sub-row
 * passes it -- the real renderer builds its overlay hook from that argument.
 */
const badge = (short, role, name, nodeData) =>
  `<span class="short-name" data-role="${role ?? ''}" data-node-id="${nodeData?.node_id ?? ''}">${short}</span>`;

test('a sub-row leads with its aspect and carries the destination name and id', () => {
  const html = subRowCellsHtml(FIELD.lxmf, '!27716218', '<td class="ts"></td>', badge);
  assert.match(html, /nodes-subrow__aspect[^>]*>lxmf\.delivery</);
  assert.match(html, /Afri Nomad Orion/);
  assert.match(html, /\[!4cf985bf\]/);
  // The badge links to the parent identity, since a destination's own page
  // canonicalises to it (SPEC RA5).
  assert.match(html, /!27716218/);
});

test('a sub-row reports the muted dash in every column a destination cannot fill', () => {
  // SPEC RA2 + RA6: the table keeps its dashes, so "not reported" stays
  // distinct from "still loading". The Role cell is included -- it was the one
  // column that rendered an empty string instead.
  const html = subRowCellsHtml(
    { id: 'a'.repeat(32), aspect: 'lxmf.delivery', role: null, name: null },
    '!27716218',
    '<td class="ts"></td>',
    badge,
  );
  const dashes = (html.match(/class="cell-empty"/g) || []).length;
  assert.ok(dashes >= 15, `expected the unfillable columns to dash, saw ${dashes}`);
  assert.doesNotMatch(html, /nodes-col--role"><\/td>/);
});

test('a sub-row spans exactly as many columns as a parent row', () => {
  // A mismatch silently misaligns the whole table.
  const html = subRowCellsHtml(FIELD.nomadnet, '!27716218', '<td class="ts"></td>', badge);
  assert.equal((html.match(/<td/g) || []).length, 22);
});

test('the transport sub-row shows no aspect but keeps its role (RA7)', () => {
  const html = subRowCellsHtml(FIELD.transport, '!27716218', '<td class="ts"></td>', badge);
  assert.doesNotMatch(html, new RegExp(TRANSPORT_ASPECT));
  assert.match(html, />TRANSPORT</);
});

test('a sub-row escapes a hostile destination name', () => {
  const html = subRowCellsHtml(
    { id: 'b'.repeat(32), aspect: 'lxmf.delivery', role: 'PEER', name: '<img src=x onerror=alert(1)>' },
    '!27716218',
    '<td class="ts"></td>',
    badge,
  );
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('a sub-row renders its role as a coloured chip, like its parent', () => {
  // A sub-row that spells its role in plain text while the row above it uses
  // colour reads as two different kinds of value (field report).
  const html = subRowCellsHtml(FIELD.nomadnet, '!27716218', '<td class="ts"></td>', badge);
  assert.match(html, /class="role-chip"/);
  assert.match(html, new RegExp(reticulumRoleColors.NODE));
  assert.match(html, />NODE</);
});

test('a sub-row with no role dashes rather than rendering an empty chip', () => {
  const html = subRowCellsHtml(
    { id: 'c'.repeat(32), aspect: 'lxmf.delivery', role: null, name: 'x' },
    '!27716218', '<td class="ts"></td>', badge,
  );
  assert.doesNotMatch(html, /role-chip/);
  assert.match(html, /nodes-col--role"><span class="cell-empty">/);
});

test('a sub-row identifier links to the destination page and its anchor (SPEC RL5)', () => {
  const html = subRowCellsHtml(FIELD.lxmf, '!27716218', '<td class="ts"></td>', badge);
  // Links to the destination's own canonical id, which resolves server-side to
  // the identity that owns it, and carries the fragment for that row.
  assert.match(html, /href="\/nodes\/!4cf985bf#dest-4cf985bf"/);
  assert.match(html, />\[!4cf985bf\]</);
});

test('a sub-row with no id emits plain text, not an empty link', () => {
  const html = subRowCellsHtml(
    { aspect: 'lxmf.delivery', role: 'PEER', name: 'x' },
    '!27716218', '<td class="ts"></td>', badge,
  );
  assert.doesNotMatch(html, /<a /);
});
