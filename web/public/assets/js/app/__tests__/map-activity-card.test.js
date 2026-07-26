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

import { createDomEnvironment } from './dom-environment.js';
import {
  placeholderSparklinePaths,
  buildMeshActivityModel,
  renderMeshActivityCardHtml,
  createMeshActivityCard,
} from '../map-activity-card.js';

// ---------------------------------------------------------------------------
// placeholderSparklinePaths
// ---------------------------------------------------------------------------

test('placeholderSparklinePaths is deterministic and returns a closed area', () => {
  const first = placeholderSparklinePaths();
  const second = placeholderSparklinePaths();
  assert.deepEqual(first, second);
  assert.match(first.line, /^M1 /);
  assert.ok(first.area.startsWith(first.line));
  assert.ok(first.area.endsWith('L157 26 L1 26 Z'));
});

// ---------------------------------------------------------------------------
// buildMeshActivityModel
// ---------------------------------------------------------------------------

test('buildMeshActivityModel sums visible protocols and sizes bars to the busiest', () => {
  const model = buildMeshActivityModel({ total: 120, meshtastic: 76, meshcore: 44 }, new Set());
  assert.equal(model.visible, true);
  assert.equal(model.total, 120);
  assert.deepEqual(model.rows.map(row => row.label), ['Meshtastic', 'MeshCore']);
  assert.equal(model.rows[0].rate, 76);
  assert.equal(model.rows[0].barPct, 100); // busiest vantage fills the bar
  assert.equal(model.rows[1].rate, 44);
  assert.equal(model.rows[1].barPct, Math.round((44 / 76) * 100));
});

test('buildMeshActivityModel never renders reticulum', () => {
  const model = buildMeshActivityModel({ total: 50, meshtastic: 50, reticulum: 999 }, new Set());
  assert.deepEqual(model.rows.map(row => row.label), ['Meshtastic']);
  assert.equal(model.total, 50);
});

test('buildMeshActivityModel drops a hidden protocol and rebases the total', () => {
  const model = buildMeshActivityModel(
    { total: 120, meshtastic: 76, meshcore: 44 },
    new Set(['meshcore'])
  );
  assert.deepEqual(model.rows.map(row => row.label), ['Meshtastic']);
  assert.equal(model.total, 76); // rebased to the visible protocols only
  assert.equal(model.visible, true);
});

test('buildMeshActivityModel hides when every protocol is toggled off', () => {
  const model = buildMeshActivityModel(
    { total: 120, meshtastic: 76, meshcore: 44 },
    new Set(['meshcore', 'meshtastic'])
  );
  assert.equal(model.visible, false);
  assert.equal(model.rows.length, 0);
});

test('buildMeshActivityModel hides on a zero total (bars degrade to 0%)', () => {
  const model = buildMeshActivityModel({ total: 0, meshtastic: 0, meshcore: 0 }, new Set());
  assert.equal(model.visible, false);
  assert.deepEqual(model.rows.map(row => row.barPct), [0, 0]);
});

test('buildMeshActivityModel hides when packets are absent or malformed', () => {
  assert.equal(buildMeshActivityModel(null, new Set()).visible, false);
  // A non-Set hiddenProtocols argument is tolerated.
  assert.equal(buildMeshActivityModel(undefined, undefined).visible, false);
  const skipped = buildMeshActivityModel({ meshtastic: 'n/a', meshcore: -5 }, new Set());
  assert.equal(skipped.visible, false);
  assert.equal(skipped.rows.length, 0);
});

// ---------------------------------------------------------------------------
// renderMeshActivityCardHtml
// ---------------------------------------------------------------------------

test('renderMeshActivityCardHtml emits total, rows, icons and a placeholder sparkline', () => {
  const model = buildMeshActivityModel({ total: 120, meshtastic: 76, meshcore: 44 }, new Set());
  const html = renderMeshActivityCardHtml(model);
  assert.match(html, /map-activity-card__total-value">120</);
  assert.match(html, /packets\/h/);
  assert.match(html, /meshtastic\.svg/);
  assert.match(html, /meshcore\.svg/);
  assert.match(html, />Meshtastic</);
  assert.match(html, />MeshCore</);
  assert.match(html, /data-placeholder="true"/);
  assert.match(html, /width:100%/); // busiest protocol's bar
});

// ---------------------------------------------------------------------------
// createMeshActivityCard
// ---------------------------------------------------------------------------

test('createMeshActivityCard requires a usable document', () => {
  assert.throws(() => createMeshActivityCard(null), /requires a document/);
  assert.throws(() => createMeshActivityCard({}), /requires a document/);
});

test('createMeshActivityCard renders, hides on zero, and updates aria-label', () => {
  const env = createDomEnvironment();
  try {
    const card = createMeshActivityCard(env.document);
    assert.ok(card.element.classList.contains('map-activity-card'));
    // Starts hidden until data arrives.
    assert.equal(card.element.classList.contains('map-activity-card--hidden'), true);
    assert.equal(card.element.getAttribute('hidden'), 'hidden');
    assert.equal(card.element.getAttribute('aria-hidden'), 'true');

    const visible = card.render({
      packets: { total: 120, meshtastic: 76, meshcore: 44 },
      hiddenProtocols: new Set(),
    });
    assert.equal(visible, true);
    assert.equal(card.element.classList.contains('map-activity-card--hidden'), false);
    assert.equal(card.element.getAttribute('hidden'), null);
    assert.equal(card.element.getAttribute('aria-hidden'), null);
    assert.equal(card.element.getAttribute('aria-label'), 'Mesh activity: 120 packets per hour');
    assert.match(card.element.innerHTML, /map-activity-card__total-value">120</);

    // A zero total hides and empties the card again.
    const stillVisible = card.render({ packets: { total: 0 }, hiddenProtocols: new Set() });
    assert.equal(stillVisible, false);
    assert.equal(card.element.classList.contains('map-activity-card--hidden'), true);
    assert.equal(card.element.innerHTML, '');
  } finally {
    env.cleanup();
  }
});

test('createMeshActivityCard rebases when a protocol is toggled off', () => {
  const env = createDomEnvironment();
  try {
    const card = createMeshActivityCard(env.document);
    card.render({
      packets: { total: 120, meshtastic: 76, meshcore: 44 },
      hiddenProtocols: new Set(['meshcore']),
    });
    assert.equal(card.element.getAttribute('aria-label'), 'Mesh activity: 76 packets per hour');
    assert.match(card.element.innerHTML, /Meshtastic/);
    assert.doesNotMatch(card.element.innerHTML, /MeshCore/);
  } finally {
    env.cleanup();
  }
});

test('createMeshActivityCard defaults to the global document and no-arg render hides', () => {
  const env = createDomEnvironment();
  try {
    const card = createMeshActivityCard();
    assert.ok(card.element);
    assert.equal(typeof card.render, 'function');
    // No data → nothing to show.
    assert.equal(card.render(), false);
  } finally {
    env.cleanup();
  }
});
