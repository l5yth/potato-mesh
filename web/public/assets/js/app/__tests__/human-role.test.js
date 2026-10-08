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
 * Roles read as words, not firmware enums (SPEC ML4): `humanRole` turns
 * `ROUTER_LATE` into `Router late`, and every surface that names a role shows
 * that label with the enum kept in `title`. The legend chip and the Reticulum
 * role chips are covered by their own suites; this file covers the helpers,
 * the nodes-table Role cell and disclosure row, the marker overlay, the map
 * popup, and the node page's spec sheet and destinations table.
 *
 * @module app/__tests__/human-role
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { humanRole, humanRoleHtml } from '../role-helpers.js';
import { renderDestinationsSection } from '../node-page/destinations.js';
import { renderSingleNodeTable } from '../node-page/single-node-table.js';
import { setupAppWithOptions, withApp } from './main-app-test-helpers.js';

const NOW = Math.floor(Date.now() / 1000);

test('humanRole spells an enum as a sentence-case label (ML4)', () => {
  assert.equal(humanRole('LOST_AND_FOUND'), 'Lost and found');
  assert.equal(humanRole('CLIENT_HIDDEN'), 'Client hidden');
  assert.equal(humanRole('ROUTER_LATE'), 'Router late');
  assert.equal(humanRole('ROOM_SERVER', 'meshcore'), 'Room server');
  assert.equal(humanRole('ROUTER'), 'Router');
});

test('humanRole names a missing role after its protocol base role (ML4, RA9)', () => {
  assert.equal(humanRole(null, 'meshcore'), 'Companion');
  assert.equal(humanRole('', 'reticulum'), 'Peer');
  assert.equal(humanRole(undefined), 'Client');
});

test('humanRole reads a numeric role id as its enum (ML4)', () => {
  assert.equal(humanRole(5), 'Tracker');
  assert.equal(humanRole('11'), 'Router late');
});

test('humanRoleHtml shows the label and keeps the enum in title, both escaped (ML4)', () => {
  assert.equal(humanRoleHtml('ROUTER_LATE'), '<span title="ROUTER_LATE">Router late</span>');
  assert.equal(humanRoleHtml(null, 'meshcore'), '<span title="COMPANION">Companion</span>');
  assert.equal(humanRoleHtml('<b>"x"'), '<span title="&lt;b&gt;&quot;x&quot;">&lt;b&gt;&quot;x&quot;</span>');
});

test('the nodes table Role cell and disclosure row show the label, the enum in title (ML4)', () => {
  const { testUtils: t, env, cleanup } = setupAppWithOptions();
  try {
    const tbody = env.document.createElement('tbody');
    env.document.querySelector = selector => (selector === '#nodes tbody' ? tbody : null);
    t.renderTable([
      { node_id: '!aa000001', short_name: 'LATE', long_name: 'Late Router', role: 'ROUTER_LATE', protocol: 'meshtastic', last_heard: NOW - 60 },
      { node_id: '!bb000002', short_name: 'CORE', long_name: 'Core Node', role: null, protocol: 'meshcore', last_heard: NOW - 90 },
    ], NOW);
    const [lateRow, lateExtra, coreRow] = tbody.childNodes;
    assert.match(lateRow.innerHTML, /nodes-col--role"><span title="ROUTER_LATE">Router late<\/span><\/td>/);
    assert.match(lateExtra.innerHTML, /title="ROUTER_LATE">Router late</);
    assert.match(coreRow.innerHTML, /nodes-col--role"><span title="COMPANION">Companion<\/span><\/td>/);
  } finally {
    t.stopAutoRefresh();
    cleanup();
  }
});

test('the marker overlay and the map popup show the label, the enum in title (ML4)', () => {
  withApp(t => {
    try {
      const overlay = t.buildShortInfoOverlayHtml(t.normalizeOverlaySource({ nodeId: '!aa000001', role: 'CLIENT_BASE' }));
      assert.ok(overlay.includes('Role: <span title="CLIENT_BASE">Client base</span>'), overlay);
      const popup = t.buildMapPopupHtml({ node_id: '!aa000001', long_name: 'Alice', role: 'LOST_AND_FOUND' }, NOW);
      assert.ok(popup.includes('Role: <span title="LOST_AND_FOUND">Lost and found</span>'), popup);
    } finally {
      t.stopAutoRefresh();
    }
  });
});

test('the node page spec sheet shows the label, the enum in title, and no role it was not told (ML4, RA6)', () => {
  const sheet = renderSingleNodeTable({ node_id: '!cc000003', role: 'ROOM_SERVER', protocol: 'meshcore', last_heard: NOW - 46 }, () => '', NOW);
  assert.match(sheet, /<dt>Role<\/dt><dd title="ROOM_SERVER">Room server<\/dd>/);
  const unreported = renderSingleNodeTable({ node_id: '!cc000004', protocol: 'meshcore', last_heard: NOW - 46 }, () => '', NOW);
  assert.doesNotMatch(unreported, /<dt>Role<\/dt>/);
});

test('the node page destinations table shows the label, the enum in title, or the dash (ML4)', () => {
  const html = renderDestinationsSection([
    { id: 'a'.repeat(32), node_id: '!27716218', aspect: 'lxmf.delivery', role: 'PEER', last_heard: NOW - 60 },
    { id: 'b'.repeat(32), node_id: '!27716218', aspect: 'lxmf.propagation', role: '  ', last_heard: NOW - 90 },
  ], { nowSeconds: NOW });
  assert.match(html, /destinations__role"><span title="PEER">Peer<\/span><\/td>/);
  assert.match(html, /destinations__role"><span class="cell-empty">—<\/span><\/td>/, 'a blank role dashes');
});
