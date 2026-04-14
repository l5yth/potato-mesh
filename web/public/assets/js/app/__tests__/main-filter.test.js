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

import { withApp } from './main-app-test-helpers.js';

// ---------------------------------------------------------------------------
// makeRoleFilterKey
// ---------------------------------------------------------------------------

test('makeRoleFilterKey produces compound key for meshtastic protocol', () => {
  withApp((t) => {
    assert.equal(t.makeRoleFilterKey('SENSOR', 'meshtastic'), 'meshtastic:SENSOR');
    assert.equal(t.makeRoleFilterKey('ROUTER', 'meshtastic'), 'meshtastic:ROUTER');
  });
});

test('makeRoleFilterKey produces compound key for meshcore protocol', () => {
  withApp((t) => {
    assert.equal(t.makeRoleFilterKey('SENSOR', 'meshcore'), 'meshcore:SENSOR');
    assert.equal(t.makeRoleFilterKey('REPEATER', 'meshcore'), 'meshcore:REPEATER');
  });
});

test('makeRoleFilterKey defaults null protocol to meshtastic bucket', () => {
  withApp((t) => {
    assert.equal(t.makeRoleFilterKey('SENSOR', null), 'meshtastic:SENSOR');
    assert.equal(t.makeRoleFilterKey('ROUTER', null), 'meshtastic:ROUTER');
  });
});

test('makeRoleFilterKey defaults absent protocol to meshtastic bucket', () => {
  withApp((t) => {
    assert.equal(t.makeRoleFilterKey('CLIENT', undefined), 'meshtastic:CLIENT');
  });
});

test('makeRoleFilterKey SENSOR and REPEATER produce distinct keys across protocols', () => {
  withApp((t) => {
    const meshtasticSensor = t.makeRoleFilterKey('SENSOR', 'meshtastic');
    const meshcoreSensor = t.makeRoleFilterKey('SENSOR', 'meshcore');
    assert.notEqual(meshtasticSensor, meshcoreSensor);

    const meshtasticRepeater = t.makeRoleFilterKey('REPEATER', 'meshtastic');
    const meshcoreRepeater = t.makeRoleFilterKey('REPEATER', 'meshcore');
    assert.notEqual(meshtasticRepeater, meshcoreRepeater);
  });
});

// ---------------------------------------------------------------------------
// matchesRoleFilter — no active filters
// ---------------------------------------------------------------------------

test('matchesRoleFilter returns true when no roles are hidden', () => {
  withApp((t) => {
    t.activeRoleFilters.clear();
    assert.equal(t.matchesRoleFilter({ role: 'ROUTER', protocol: 'meshtastic' }), true);
    assert.equal(t.matchesRoleFilter({ role: 'SENSOR', protocol: 'meshcore' }), true);
  });
});

// ---------------------------------------------------------------------------
// matchesRoleFilter — exclusion-set semantics (roles in set are hidden)
// ---------------------------------------------------------------------------

test('matchesRoleFilter hides meshtastic SENSOR when in exclusion set', () => {
  withApp((t) => {
    t.activeRoleFilters.clear();
    t.activeRoleFilters.add('meshtastic:SENSOR');
    assert.equal(t.matchesRoleFilter({ role: 'SENSOR', protocol: 'meshtastic' }), false);
  });
});

test('matchesRoleFilter does not hide meshcore SENSOR when meshtastic SENSOR is hidden', () => {
  withApp((t) => {
    t.activeRoleFilters.clear();
    t.activeRoleFilters.add('meshtastic:SENSOR');
    assert.equal(t.matchesRoleFilter({ role: 'SENSOR', protocol: 'meshcore' }), true);
  });
});

test('matchesRoleFilter hides meshcore SENSOR when in exclusion set', () => {
  withApp((t) => {
    t.activeRoleFilters.clear();
    t.activeRoleFilters.add('meshcore:SENSOR');
    assert.equal(t.matchesRoleFilter({ role: 'SENSOR', protocol: 'meshcore' }), false);
  });
});

test('matchesRoleFilter does not hide meshtastic SENSOR when meshcore SENSOR is hidden', () => {
  withApp((t) => {
    t.activeRoleFilters.clear();
    t.activeRoleFilters.add('meshcore:SENSOR');
    assert.equal(t.matchesRoleFilter({ role: 'SENSOR', protocol: 'meshtastic' }), true);
  });
});

test('matchesRoleFilter hides meshtastic REPEATER but not meshcore REPEATER', () => {
  withApp((t) => {
    t.activeRoleFilters.clear();
    t.activeRoleFilters.add('meshtastic:REPEATER');
    assert.equal(t.matchesRoleFilter({ role: 'REPEATER', protocol: 'meshtastic' }), false);
    assert.equal(t.matchesRoleFilter({ role: 'REPEATER', protocol: 'meshcore' }), true);
  });
});

test('matchesRoleFilter hides meshcore REPEATER but not meshtastic REPEATER', () => {
  withApp((t) => {
    t.activeRoleFilters.clear();
    t.activeRoleFilters.add('meshcore:REPEATER');
    assert.equal(t.matchesRoleFilter({ role: 'REPEATER', protocol: 'meshcore' }), false);
    assert.equal(t.matchesRoleFilter({ role: 'REPEATER', protocol: 'meshtastic' }), true);
  });
});

// ---------------------------------------------------------------------------
// matchesRoleFilter — null/absent protocol treated as meshtastic
// ---------------------------------------------------------------------------

test('matchesRoleFilter treats null protocol as meshtastic for exclusion', () => {
  withApp((t) => {
    t.activeRoleFilters.clear();
    t.activeRoleFilters.add('meshtastic:SENSOR');
    // null-protocol node should be hidden by the meshtastic SENSOR exclusion
    assert.equal(t.matchesRoleFilter({ role: 'SENSOR', protocol: null }), false);
    // but meshcore SENSOR exclusion should not affect null-protocol nodes
    t.activeRoleFilters.clear();
    t.activeRoleFilters.add('meshcore:SENSOR');
    assert.equal(t.matchesRoleFilter({ role: 'SENSOR', protocol: null }), true);
  });
});

test('matchesRoleFilter with multiple hidden roles hides only those roles', () => {
  withApp((t) => {
    t.activeRoleFilters.clear();
    t.activeRoleFilters.add('meshtastic:SENSOR');
    t.activeRoleFilters.add('meshcore:REPEATER');
    assert.equal(t.matchesRoleFilter({ role: 'SENSOR', protocol: 'meshtastic' }), false);
    assert.equal(t.matchesRoleFilter({ role: 'REPEATER', protocol: 'meshcore' }), false);
    assert.equal(t.matchesRoleFilter({ role: 'ROUTER', protocol: 'meshtastic' }), true);
  });
});

// ---------------------------------------------------------------------------
// matchesProtocolFilter
// ---------------------------------------------------------------------------

test('matchesProtocolFilter returns true when no protocols are hidden', () => {
  withApp((t) => {
    t.hiddenProtocols.clear();
    assert.equal(t.matchesProtocolFilter({ protocol: 'meshtastic' }), true);
    assert.equal(t.matchesProtocolFilter({ protocol: 'meshcore' }), true);
    assert.equal(t.matchesProtocolFilter({ protocol: null }), true);
  });
});

test('matchesProtocolFilter hides meshtastic nodes when meshtastic is hidden', () => {
  withApp((t) => {
    t.hiddenProtocols.clear();
    t.hiddenProtocols.add('meshtastic');
    assert.equal(t.matchesProtocolFilter({ protocol: 'meshtastic' }), false);
    assert.equal(t.matchesProtocolFilter({ protocol: 'meshcore' }), true);
  });
});

test('matchesProtocolFilter hides meshcore nodes when meshcore is hidden', () => {
  withApp((t) => {
    t.hiddenProtocols.clear();
    t.hiddenProtocols.add('meshcore');
    assert.equal(t.matchesProtocolFilter({ protocol: 'meshcore' }), false);
    assert.equal(t.matchesProtocolFilter({ protocol: 'meshtastic' }), true);
  });
});

test('matchesProtocolFilter always shows null-protocol nodes even when meshtastic is hidden', () => {
  withApp((t) => {
    t.hiddenProtocols.clear();
    t.hiddenProtocols.add('meshtastic');
    // null/absent protocol nodes are NOT hidden — they predate the protocol field
    assert.equal(t.matchesProtocolFilter({ protocol: null }), true);
    assert.equal(t.matchesProtocolFilter({}), true);
  });
});

// ---------------------------------------------------------------------------
// Role filter key independence across protocols
// ---------------------------------------------------------------------------

test('SENSOR filter keys for meshtastic and meshcore are distinct strings', () => {
  withApp((t) => {
    const m = t.makeRoleFilterKey('SENSOR', 'meshtastic');
    const mc = t.makeRoleFilterKey('SENSOR', 'meshcore');
    // They must be different keys so they can live independently in the Set
    assert.notEqual(m, mc);
    // Adding one to the filter set must not affect the other
    t.activeRoleFilters.clear();
    t.activeRoleFilters.add(m);
    assert.equal(t.activeRoleFilters.has(m), true);
    assert.equal(t.activeRoleFilters.has(mc), false);
  });
});

test('REPEATER filter keys for meshtastic and meshcore are distinct strings', () => {
  withApp((t) => {
    const m = t.makeRoleFilterKey('REPEATER', 'meshtastic');
    const mc = t.makeRoleFilterKey('REPEATER', 'meshcore');
    assert.notEqual(m, mc);
    t.activeRoleFilters.clear();
    t.activeRoleFilters.add(mc);
    assert.equal(t.activeRoleFilters.has(mc), true);
    assert.equal(t.activeRoleFilters.has(m), false);
  });
});

// ---------------------------------------------------------------------------
// normalizeFilterProtocol
// ---------------------------------------------------------------------------

test('normalizeFilterProtocol returns meshcore for explicit meshcore', () => {
  withApp((t) => {
    assert.equal(t.normalizeFilterProtocol('meshcore'), 'meshcore');
  });
});

test('normalizeFilterProtocol returns meshtastic for explicit meshtastic', () => {
  withApp((t) => {
    assert.equal(t.normalizeFilterProtocol('meshtastic'), 'meshtastic');
  });
});

test('normalizeFilterProtocol returns meshtastic for null', () => {
  withApp((t) => {
    assert.equal(t.normalizeFilterProtocol(null), 'meshtastic');
  });
});

test('normalizeFilterProtocol returns meshtastic for undefined', () => {
  withApp((t) => {
    assert.equal(t.normalizeFilterProtocol(undefined), 'meshtastic');
  });
});

test('normalizeFilterProtocol returns meshtastic for unknown protocol', () => {
  withApp((t) => {
    assert.equal(t.normalizeFilterProtocol('reticulum'), 'meshtastic');
  });
});

// ---------------------------------------------------------------------------
// buildProtocolIconImg / buildMeshtasticIconImg / buildMeshcoreIconImg
// ---------------------------------------------------------------------------

test('buildProtocolIconImg returns an img element with the correct src and class', () => {
  withApp((t) => {
    const img = t.buildProtocolIconImg('/assets/img/test.svg', 'protocol-icon--test');
    assert.equal(img.tagName.toLowerCase(), 'img');
    assert.equal(img.getAttribute('src'), '/assets/img/test.svg');
    assert.ok(img.className.includes('protocol-icon'));
    assert.ok(img.className.includes('protocol-icon--test'));
    assert.equal(img.getAttribute('aria-hidden'), 'true');
    assert.equal(img.getAttribute('alt'), '');
    assert.equal(img.getAttribute('width'), '12');
    assert.equal(img.getAttribute('height'), '12');
  });
});

test('buildMeshtasticIconImg references meshtastic.svg and carries the meshtastic class', () => {
  withApp((t) => {
    const img = t.buildMeshtasticIconImg();
    assert.ok(img.getAttribute('src').includes('meshtastic.svg'));
    assert.ok(img.className.includes('protocol-icon--meshtastic'));
    assert.equal(img.getAttribute('aria-hidden'), 'true');
  });
});

test('buildMeshcoreIconImg references meshcore.svg and carries the meshcore class', () => {
  withApp((t) => {
    const img = t.buildMeshcoreIconImg();
    assert.ok(img.getAttribute('src').includes('meshcore.svg'));
    assert.ok(img.className.includes('protocol-icon--meshcore'));
    assert.equal(img.getAttribute('aria-hidden'), 'true');
  });
});

test('buildMeshtasticIconImg and buildMeshcoreIconImg return different src values', () => {
  withApp((t) => {
    const mt = t.buildMeshtasticIconImg();
    const mc = t.buildMeshcoreIconImg();
    assert.notEqual(mt.getAttribute('src'), mc.getAttribute('src'));
  });
});

// ---------------------------------------------------------------------------
// legendClickHandler
// ---------------------------------------------------------------------------

test('legendClickHandler calls preventDefault and stopPropagation before fn', () => {
  withApp((t) => {
    let fnCalled = false;
    let preventDefaultCalled = false;
    let stopPropagationCalled = false;
    const handler = t.legendClickHandler(() => { fnCalled = true; });
    const fakeEvent = {
      preventDefault: () => { preventDefaultCalled = true; },
      stopPropagation: () => { stopPropagationCalled = true; },
    };
    handler(fakeEvent);
    assert.equal(preventDefaultCalled, true);
    assert.equal(stopPropagationCalled, true);
    assert.equal(fnCalled, true);
  });
});

test('legendClickHandler passes the event to fn', () => {
  withApp((t) => {
    let received = null;
    const handler = t.legendClickHandler(ev => { received = ev; });
    const fakeEvent = {
      preventDefault: () => {},
      stopPropagation: () => {},
      detail: 'test',
    };
    handler(fakeEvent);
    assert.equal(received, fakeEvent);
  });
});

// ---------------------------------------------------------------------------
// buildRoleButtons
// ---------------------------------------------------------------------------

test('buildRoleButtons appends one child per palette entry', () => {
  withApp((t) => {
    t.legendRoleButtons.clear();
    const col = document.createElement('div');
    t.buildRoleButtons(col, { SENSOR: '#40749E', REPEATER: '#B8C4D4' }, 'meshcore');
    assert.equal(col.childNodes.length, 2);
  });
});

test('buildRoleButtons sets dataset.role and dataset.protocol on each button', () => {
  withApp((t) => {
    t.legendRoleButtons.clear();
    const col = document.createElement('div');
    t.buildRoleButtons(col, { SENSOR: '#40749E' }, 'meshcore');
    const btn = t.legendRoleButtons.get('meshcore:SENSOR');
    assert.ok(btn, 'button should be in legendRoleButtons');
    assert.equal(btn.dataset.role, 'SENSOR');
    assert.equal(btn.dataset.protocol, 'meshcore');
  });
});

test('buildRoleButtons registers compound keys in legendRoleButtons', () => {
  withApp((t) => {
    t.legendRoleButtons.clear();
    const col = document.createElement('div');
    t.buildRoleButtons(col, { SENSOR: '#40749E', REPEATER: '#B8C4D4' }, 'meshcore');
    assert.ok(t.legendRoleButtons.has('meshcore:SENSOR'));
    assert.ok(t.legendRoleButtons.has('meshcore:REPEATER'));
  });
});

test('buildRoleButtons keeps meshtastic and meshcore SENSOR keys distinct', () => {
  withApp((t) => {
    t.legendRoleButtons.clear();
    const colMc = document.createElement('div');
    const colMt = document.createElement('div');
    t.buildRoleButtons(colMc, { SENSOR: '#40749E' }, 'meshcore');
    t.buildRoleButtons(colMt, { SENSOR: '#A8D5BA' }, 'meshtastic');
    assert.ok(t.legendRoleButtons.has('meshcore:SENSOR'));
    assert.ok(t.legendRoleButtons.has('meshtastic:SENSOR'));
    assert.notEqual(
      t.legendRoleButtons.get('meshcore:SENSOR'),
      t.legendRoleButtons.get('meshtastic:SENSOR'),
    );
  });
});

test('buildRoleButtons sets aria-pressed to true initially (all visible)', () => {
  withApp((t) => {
    t.legendRoleButtons.clear();
    const col = document.createElement('div');
    t.buildRoleButtons(col, { ROUTER: '#ff0019' }, 'meshtastic');
    const btn = t.legendRoleButtons.get('meshtastic:ROUTER');
    assert.ok(btn, 'button should be in legendRoleButtons');
    assert.equal(btn.getAttribute('aria-pressed'), 'true');
  });
});

test('buildRoleButtons creates swatch child with background color', () => {
  withApp((t) => {
    t.legendRoleButtons.clear();
    const col = document.createElement('div');
    t.buildRoleButtons(col, { ROUTER: '#ff0019' }, 'meshtastic');
    const btn = t.legendRoleButtons.get('meshtastic:ROUTER');
    // swatch is the first child of the button
    const swatch = btn.childNodes[0];
    assert.ok(swatch, 'swatch element should exist');
    assert.ok(swatch.style.background, 'swatch should have background color');
  });
});

test('buildRoleButtons creates label child with role text', () => {
  withApp((t) => {
    t.legendRoleButtons.clear();
    const col = document.createElement('div');
    t.buildRoleButtons(col, { ROUTER: '#ff0019' }, 'meshtastic');
    const btn = t.legendRoleButtons.get('meshtastic:ROUTER');
    // label is the second child of the button
    const label = btn.childNodes[1];
    assert.ok(label, 'label element should exist');
    assert.equal(label.textContent, 'ROUTER');
  });
});

// ---------------------------------------------------------------------------
// updateLegendRoleFiltersUI
// ---------------------------------------------------------------------------

test('updateLegendRoleFiltersUI sets aria-pressed false on hidden role buttons', () => {
  withApp((t) => {
    t.legendRoleButtons.clear();
    const col = document.createElement('div');
    t.buildRoleButtons(col, { SENSOR: '#40749E' }, 'meshcore');
    const btn = t.legendRoleButtons.get('meshcore:SENSOR');
    t.activeRoleFilters.clear();
    t.activeRoleFilters.add('meshcore:SENSOR');
    t.updateLegendRoleFiltersUI();
    assert.equal(btn.getAttribute('aria-pressed'), 'false');
  });
});

test('updateLegendRoleFiltersUI sets aria-pressed true on visible role buttons', () => {
  withApp((t) => {
    t.legendRoleButtons.clear();
    const col = document.createElement('div');
    t.buildRoleButtons(col, { SENSOR: '#40749E' }, 'meshcore');
    const btn = t.legendRoleButtons.get('meshcore:SENSOR');
    t.activeRoleFilters.clear();
    t.updateLegendRoleFiltersUI();
    assert.equal(btn.getAttribute('aria-pressed'), 'true');
  });
});

test('updateLegendRoleFiltersUI is safe when legendContainer is null', () => {
  withApp((t) => {
    // legendContainer starts null in tests (no map); should not throw
    assert.doesNotThrow(() => t.updateLegendRoleFiltersUI());
  });
});

// ---------------------------------------------------------------------------
// adjustStatsForHiddenProtocols
// ---------------------------------------------------------------------------

test('adjustStatsForHiddenProtocols returns original stats when nothing is hidden', () => {
  withApp((t) => {
    t.hiddenProtocols.clear();
    const stats = { hour: 10, day: 50, week: 100, month: 200, meshcore: { hour: 2, day: 10, week: 20, month: 40 }, meshtastic: { hour: 8, day: 40, week: 80, month: 160 } };
    const result = t.adjustStatsForHiddenProtocols(stats);
    assert.equal(result, stats);
  });
});

test('adjustStatsForHiddenProtocols subtracts meshcore counts when meshcore hidden', () => {
  withApp((t) => {
    t.hiddenProtocols.clear();
    t.hiddenProtocols.add('meshcore');
    const stats = { hour: 10, day: 50, week: 100, month: 200, meshcore: { hour: 2, day: 10, week: 20, month: 40 }, meshtastic: { hour: 8, day: 40, week: 80, month: 160 } };
    const result = t.adjustStatsForHiddenProtocols(stats);
    assert.equal(result.week, 80);
    assert.equal(result.day, 40);
    assert.equal(result.month, 160);
    assert.equal(result.hour, 8);
  });
});

test('adjustStatsForHiddenProtocols subtracts meshtastic counts when meshtastic hidden', () => {
  withApp((t) => {
    t.hiddenProtocols.clear();
    t.hiddenProtocols.add('meshtastic');
    const stats = { hour: 10, day: 50, week: 100, month: 200, meshcore: { hour: 2, day: 10, week: 20, month: 40 }, meshtastic: { hour: 8, day: 40, week: 80, month: 160 } };
    const result = t.adjustStatsForHiddenProtocols(stats);
    assert.equal(result.week, 20);
    assert.equal(result.day, 10);
  });
});

test('adjustStatsForHiddenProtocols subtracts both when both hidden', () => {
  withApp((t) => {
    t.hiddenProtocols.clear();
    t.hiddenProtocols.add('meshcore');
    t.hiddenProtocols.add('meshtastic');
    const stats = { hour: 10, day: 50, week: 100, month: 200, meshcore: { hour: 2, day: 10, week: 20, month: 40 }, meshtastic: { hour: 8, day: 40, week: 80, month: 160 } };
    const result = t.adjustStatsForHiddenProtocols(stats);
    assert.equal(result.week, 0);
    assert.equal(result.day, 0);
  });
});

test('adjustStatsForHiddenProtocols floors at zero', () => {
  withApp((t) => {
    t.hiddenProtocols.clear();
    t.hiddenProtocols.add('meshcore');
    const stats = { hour: 1, day: 5, week: 10, month: 20, meshcore: { hour: 50, day: 50, week: 50, month: 50 } };
    const result = t.adjustStatsForHiddenProtocols(stats);
    assert.equal(result.week, 0);
    assert.equal(result.day, 0);
  });
});

test('adjustStatsForHiddenProtocols handles null stats gracefully', () => {
  withApp((t) => {
    t.hiddenProtocols.add('meshcore');
    assert.equal(t.adjustStatsForHiddenProtocols(null), null);
    assert.equal(t.adjustStatsForHiddenProtocols(undefined), undefined);
  });
});

test('adjustStatsForHiddenProtocols handles missing protocol bucket', () => {
  withApp((t) => {
    t.hiddenProtocols.clear();
    t.hiddenProtocols.add('meshcore');
    const stats = { hour: 10, day: 50, week: 100, month: 200 };
    const result = t.adjustStatsForHiddenProtocols(stats);
    assert.equal(result.week, 100);
  });
});
