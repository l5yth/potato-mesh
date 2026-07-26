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
  sparklinePathsFromSeries,
  buildMeshActivityModel,
  renderMeshActivityCardHtml,
  createMeshActivityCard,
} from '../map-activity-card.js';

// ---------------------------------------------------------------------------
// sparklinePathsFromSeries
// ---------------------------------------------------------------------------

test('sparklinePathsFromSeries maps totals to a closed area path', () => {
  const paths = sparklinePathsFromSeries([10, 20, 15, 40]);
  assert.match(paths.line, /^M1 /);
  assert.ok(paths.area.startsWith(paths.line));
  assert.ok(paths.area.endsWith('L157 26 L1 26 Z'));
});

test('sparklinePathsFromSeries returns null for fewer than two points or non-arrays', () => {
  assert.equal(sparklinePathsFromSeries([]), null);
  assert.equal(sparklinePathsFromSeries([5]), null);
  assert.equal(sparklinePathsFromSeries(null), null);
  assert.equal(sparklinePathsFromSeries('nope'), null);
});

test('sparklinePathsFromSeries draws a flat baseline for an all-zero series', () => {
  const paths = sparklinePathsFromSeries([0, 0, 0]);
  assert.ok(paths);
  assert.match(paths.line, /24/); // every point sits on the 24px baseline
});

// ---------------------------------------------------------------------------
// buildMeshActivityModel
// ---------------------------------------------------------------------------

test('buildMeshActivityModel sums visible protocols and sizes bars to the busiest', () => {
  const model = buildMeshActivityModel({ total: 120, meshtastic: 76, meshcore: 44 }, new Set(), null);
  assert.equal(model.visible, true);
  assert.equal(model.total, 120);
  assert.deepEqual(model.rows.map(row => row.label), ['Meshtastic', 'MeshCore']);
  assert.equal(model.rows[0].barPct, 100);
  assert.equal(model.rows[1].barPct, Math.round((44 / 76) * 100));
  assert.equal(model.spark, null); // no series supplied
});

test('buildMeshActivityModel attaches a sparkline from the visible per-protocol series', () => {
  const series = [
    { meshcore: 5, meshtastic: 10 },
    { meshcore: 8, meshtastic: 12 },
  ];
  const model = buildMeshActivityModel({ total: 120, meshtastic: 76, meshcore: 44 }, new Set(), series);
  assert.ok(model.spark);
  assert.match(model.spark.line, /^M1 /);
});

test('buildMeshActivityModel rebases the sparkline with the protocol toggles', () => {
  const series = [
    { meshcore: 90, meshtastic: 10 },
    { meshcore: 10, meshtastic: 90 },
  ];
  const all = buildMeshActivityModel({ meshcore: 10, meshtastic: 90 }, new Set(), series);
  const mtOnly = buildMeshActivityModel({ meshtastic: 90 }, new Set(['meshcore']), series);
  assert.ok(all.spark && mtOnly.spark);
  // All-visible sums to a flat [100,100]; meshcore-hidden rises [10,90] — the
  // curve rebases with the toggle just like the headline total.
  assert.notEqual(all.spark.line, mtOnly.spark.line);
});

test('buildMeshActivityModel never renders reticulum', () => {
  const model = buildMeshActivityModel({ total: 50, meshtastic: 50, reticulum: 999 }, new Set(), null);
  assert.deepEqual(model.rows.map(row => row.label), ['Meshtastic']);
});

test('buildMeshActivityModel drops a hidden protocol and rebases the total', () => {
  const model = buildMeshActivityModel({ total: 120, meshtastic: 76, meshcore: 44 }, new Set(['meshcore']), null);
  assert.deepEqual(model.rows.map(row => row.label), ['Meshtastic']);
  assert.equal(model.total, 76);
});

test('buildMeshActivityModel hides when all protocols are off or the total is zero', () => {
  const allHidden = buildMeshActivityModel(
    { total: 120, meshtastic: 76, meshcore: 44 },
    new Set(['meshcore', 'meshtastic']),
    null
  );
  assert.equal(allHidden.visible, false);
  const zero = buildMeshActivityModel({ total: 0, meshtastic: 0, meshcore: 0 }, new Set(), null);
  assert.equal(zero.visible, false);
  assert.deepEqual(zero.rows.map(row => row.barPct), [0, 0]);
});

test('buildMeshActivityModel hides when packets are absent or malformed', () => {
  assert.equal(buildMeshActivityModel(null, new Set(), null).visible, false);
  assert.equal(buildMeshActivityModel(undefined, undefined, undefined).visible, false);
  const skipped = buildMeshActivityModel({ meshtastic: 'n/a', meshcore: -5 }, new Set(), null);
  assert.equal(skipped.visible, false);
});

// ---------------------------------------------------------------------------
// renderMeshActivityCardHtml
// ---------------------------------------------------------------------------

test('renderMeshActivityCardHtml emits total/rows/icons; sparkline only with a series', () => {
  const withSpark = renderMeshActivityCardHtml(
    buildMeshActivityModel({ total: 120, meshtastic: 76, meshcore: 44 }, new Set(), [
      { meshcore: 5, meshtastic: 10 },
      { meshcore: 8, meshtastic: 12 },
    ])
  );
  assert.match(withSpark, /map-activity-card__total-value">120</);
  assert.match(withSpark, /packets\/h/);
  assert.match(withSpark, /meshtastic\.svg/);
  assert.match(withSpark, /meshcore\.svg/);
  assert.match(withSpark, /width:100%/);
  assert.match(withSpark, /map-activity-card__spark-line/);
  assert.doesNotMatch(withSpark, /data-placeholder/);

  const noSpark = renderMeshActivityCardHtml(
    buildMeshActivityModel({ total: 120, meshtastic: 76, meshcore: 44 }, new Set(), null)
  );
  assert.doesNotMatch(noSpark, /map-activity-card__spark/);
});

// ---------------------------------------------------------------------------
// createMeshActivityCard
// ---------------------------------------------------------------------------

test('createMeshActivityCard requires a usable document', () => {
  assert.throws(() => createMeshActivityCard(null), /requires a document/);
  assert.throws(() => createMeshActivityCard({}), /requires a document/);
});

test('createMeshActivityCard renders, adds the sparkline via setSeries, hides on zero', () => {
  const env = createDomEnvironment();
  try {
    const card = createMeshActivityCard(env.document);
    assert.equal(card.element.getAttribute('role'), 'group');
    assert.equal(card.element.classList.contains('map-activity-card--hidden'), true);

    // Live rates → visible, no sparkline yet.
    const visible = card.render({
      packets: { total: 120, meshtastic: 76, meshcore: 44 },
      hiddenProtocols: new Set(),
    });
    assert.equal(visible, true);
    assert.equal(card.element.getAttribute('aria-label'), 'Mesh activity: 120 packets per hour');
    assert.doesNotMatch(card.element.innerHTML, /map-activity-card__spark/);

    // Series arrives → repaint with the sparkline, rates preserved.
    assert.equal(card.setSeries([{ meshcore: 5, meshtastic: 10 }, { meshcore: 8, meshtastic: 12 }]), true);
    assert.match(card.element.innerHTML, /map-activity-card__spark-line/);
    assert.match(card.element.innerHTML, /map-activity-card__total-value">120</);

    // Zero total → hidden and emptied.
    assert.equal(card.render({ packets: { total: 0 }, hiddenProtocols: new Set() }), false);
    assert.equal(card.element.classList.contains('map-activity-card--hidden'), true);
    assert.equal(card.element.innerHTML, '');
  } finally {
    env.cleanup();
  }
});

test('createMeshActivityCard setSeries before rates stays hidden until rates arrive', () => {
  const env = createDomEnvironment();
  try {
    const card = createMeshActivityCard(env.document);
    assert.equal(card.setSeries([{ meshcore: 5, meshtastic: 10 }, { meshcore: 8, meshtastic: 12 }]), false); // nothing to show without rates
    assert.equal(card.element.classList.contains('map-activity-card--hidden'), true);
    assert.equal(
      card.render({ packets: { total: 50, meshtastic: 50 }, hiddenProtocols: new Set() }),
      true
    );
    assert.match(card.element.innerHTML, /map-activity-card__spark-line/); // earlier series used
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
    assert.doesNotMatch(card.element.innerHTML, /MeshCore/);
  } finally {
    env.cleanup();
  }
});

test('createMeshActivityCard defaults to the global document and no-arg render hides', () => {
  const env = createDomEnvironment();
  try {
    const card = createMeshActivityCard();
    assert.equal(card.render(), false);
  } finally {
    env.cleanup();
  }
});
