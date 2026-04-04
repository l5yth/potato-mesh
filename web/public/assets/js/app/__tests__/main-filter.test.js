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
import { initializeApp } from '../main.js';

const MINIMAL_CONFIG = Object.freeze({
  channel: 'Primary',
  frequency: '915MHz',
  refreshMs: 0,
  refreshIntervalSeconds: 30,
  chatEnabled: true,
  mapCenter: { lat: 0, lon: 0 },
  mapZoom: null,
  maxDistanceKm: 0,
  tileFilters: { light: '', dark: '' },
  instancesFeatureEnabled: false,
  instanceDomain: null,
  snapshotWindowSeconds: 3600,
});

/**
 * Spin up a minimal app and return test utilities with a cleanup handle.
 *
 * @returns {{ testUtils: Object, cleanup: Function }}
 */
function setupApp() {
  const env = createDomEnvironment({ includeBody: true });
  env.createElement('button', 'themeToggle');
  const { _testUtils } = initializeApp(MINIMAL_CONFIG);
  return { testUtils: _testUtils, cleanup: env.cleanup.bind(env) };
}

/**
 * Run a test body with a fresh app instance, ensuring cleanup regardless of outcome.
 *
 * @param {function(Object): void} fn Receives the _testUtils object.
 */
function withApp(fn) {
  const { testUtils, cleanup } = setupApp();
  try {
    fn(testUtils);
  } finally {
    cleanup();
  }
}

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

test('matchesRoleFilter returns true when no filters are active', () => {
  withApp((t) => {
    t.activeRoleFilters.clear();
    assert.equal(t.matchesRoleFilter({ role: 'ROUTER', protocol: 'meshtastic' }), true);
    assert.equal(t.matchesRoleFilter({ role: 'SENSOR', protocol: 'meshcore' }), true);
  });
});

// ---------------------------------------------------------------------------
// matchesRoleFilter — protocol-aware compound key matching
// ---------------------------------------------------------------------------

test('matchesRoleFilter matches meshtastic SENSOR filter for meshtastic node', () => {
  withApp((t) => {
    t.activeRoleFilters.clear();
    t.activeRoleFilters.add('meshtastic:SENSOR');
    assert.equal(t.matchesRoleFilter({ role: 'SENSOR', protocol: 'meshtastic' }), true);
  });
});

test('matchesRoleFilter does not match meshtastic SENSOR filter for meshcore node', () => {
  withApp((t) => {
    t.activeRoleFilters.clear();
    t.activeRoleFilters.add('meshtastic:SENSOR');
    assert.equal(t.matchesRoleFilter({ role: 'SENSOR', protocol: 'meshcore' }), false);
  });
});

test('matchesRoleFilter matches meshcore SENSOR filter for meshcore node', () => {
  withApp((t) => {
    t.activeRoleFilters.clear();
    t.activeRoleFilters.add('meshcore:SENSOR');
    assert.equal(t.matchesRoleFilter({ role: 'SENSOR', protocol: 'meshcore' }), true);
  });
});

test('matchesRoleFilter does not match meshcore SENSOR filter for meshtastic node', () => {
  withApp((t) => {
    t.activeRoleFilters.clear();
    t.activeRoleFilters.add('meshcore:SENSOR');
    assert.equal(t.matchesRoleFilter({ role: 'SENSOR', protocol: 'meshtastic' }), false);
  });
});

test('matchesRoleFilter matches meshtastic REPEATER filter for meshtastic node', () => {
  withApp((t) => {
    t.activeRoleFilters.clear();
    t.activeRoleFilters.add('meshtastic:REPEATER');
    assert.equal(t.matchesRoleFilter({ role: 'REPEATER', protocol: 'meshtastic' }), true);
    assert.equal(t.matchesRoleFilter({ role: 'REPEATER', protocol: 'meshcore' }), false);
  });
});

test('matchesRoleFilter matches meshcore REPEATER filter for meshcore node', () => {
  withApp((t) => {
    t.activeRoleFilters.clear();
    t.activeRoleFilters.add('meshcore:REPEATER');
    assert.equal(t.matchesRoleFilter({ role: 'REPEATER', protocol: 'meshcore' }), true);
    assert.equal(t.matchesRoleFilter({ role: 'REPEATER', protocol: 'meshtastic' }), false);
  });
});

// ---------------------------------------------------------------------------
// matchesRoleFilter — null/absent protocol treated as meshtastic
// ---------------------------------------------------------------------------

test('matchesRoleFilter treats null protocol as meshtastic for filter matching', () => {
  withApp((t) => {
    t.activeRoleFilters.clear();
    t.activeRoleFilters.add('meshtastic:SENSOR');
    // null-protocol node should match the meshtastic SENSOR filter
    assert.equal(t.matchesRoleFilter({ role: 'SENSOR', protocol: null }), true);
    // but not the meshcore one
    t.activeRoleFilters.clear();
    t.activeRoleFilters.add('meshcore:SENSOR');
    assert.equal(t.matchesRoleFilter({ role: 'SENSOR', protocol: null }), false);
  });
});

test('matchesRoleFilter with multiple active filters returns true when any matches', () => {
  withApp((t) => {
    t.activeRoleFilters.clear();
    t.activeRoleFilters.add('meshtastic:SENSOR');
    t.activeRoleFilters.add('meshcore:REPEATER');
    assert.equal(t.matchesRoleFilter({ role: 'SENSOR', protocol: 'meshtastic' }), true);
    assert.equal(t.matchesRoleFilter({ role: 'REPEATER', protocol: 'meshcore' }), true);
    assert.equal(t.matchesRoleFilter({ role: 'ROUTER', protocol: 'meshtastic' }), false);
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
