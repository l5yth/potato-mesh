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
 * Regression guard for the frontend perf fix that lazy-loads the node-detail
 * overlay. The overlay reuses the heavy node-detail renderer (node-page +
 * charts, ~125 KB), so main.js dynamic-`import()`s it on first open instead of
 * pulling it into the dashboard's synchronous boot graph. This test pins the
 * loader's memoisation and the click-path wiring.
 *
 * @module app/__tests__/main-node-overlay-lazy
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnvironment } from './dom-environment.js';
import { initializeApp } from '../main.js';

/** Minimal config that disables the auto-refresh timer so timing is ours. */
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

/** Resolve a fetch-style JSON response. */
function jsonResponse(body) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

/** Yield so the dynamic import + open settle. */
const settle = (ms = 40) => new Promise(r => setTimeout(r, ms));

/** Register a minimal but functional #nodeDetailOverlay so the lazily-imported
 *  factory returns a real manager (mirrors node-detail-overlay.test.js). */
function registerOverlay(env) {
  const noop = () => {};
  const dialog = { focus: noop, addEventListener: noop, setAttribute: noop, removeAttribute: noop };
  const closeButton = { addEventListener: noop };
  const content = { innerHTML: '', addEventListener: noop, replaceChildren: noop };
  const overlay = {
    hidden: true,
    style: { removeProperty: noop },
    addEventListener: noop,
    setAttribute: noop,
    removeAttribute: noop,
    querySelector(selector) {
      if (selector === '.node-detail-overlay__dialog') return dialog;
      if (selector === '.node-detail-overlay__close') return closeButton;
      if (selector === '.node-detail-overlay__content') return content;
      return null;
    },
  };
  env.registerElement('nodeDetailOverlay', overlay);
  return overlay;
}

test('lazily imports and memoizes the node-detail overlay manager (frontend perf)', async () => {
  const env = createDomEnvironment({ includeBody: true });
  registerOverlay(env);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => jsonResponse([]);
  try {
    const { _testUtils } = initializeApp(BASE_CONFIG);
    await _testUtils.initialLoad;

    // Two calls before the first resolves must share the in-flight import promise
    // (no double import); a call after resolution returns the cached manager.
    const p1 = _testUtils.loadNodeDetailOverlayManager();
    const p2 = _testUtils.loadNodeDetailOverlayManager();
    assert.strictEqual(p1, p2, 'concurrent opens reuse the single in-flight import');
    const manager = await p1;
    assert.ok(manager, 'the manager is created from the lazily-imported module');
    const cached = await _testUtils.loadNodeDetailOverlayManager();
    assert.strictEqual(cached, manager, 'the manager is memoized across subsequent opens');
  } finally {
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
});

test('a .node-long-link click lazy-opens the overlay (frontend perf)', async () => {
  const env = createDomEnvironment({ includeBody: true });
  registerOverlay(env);
  const originalFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = url => {
    fetched.push(url);
    // The overlay open fetches the node-detail fragment; any 200 body suffices.
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('<div>detail</div>'), json: () => Promise.resolve({}) });
  };
  try {
    initializeApp(BASE_CONFIG);
    // A synthetic click on a node long-link: dataset.nodeId drives the identifier,
    // and the registered overlay makes the guard pass so the lazy open fires.
    const link = {
      dataset: { nodeId: '!abcd0001' },
      textContent: 'Node ABCD',
      closest(selector) {
        return selector === '.node-long-link' ? this : null;
      },
    };
    let prevented = false;
    globalThis.document.dispatchEvent({
      type: 'click',
      target: link,
      preventDefault() {
        prevented = true;
      },
      stopPropagation() {},
    });
    await settle();

    assert.ok(prevented, 'the long-link click is handled (default prevented)');
    assert.ok(
      fetched.some(u => String(u).includes('/api/nodes/')),
      'the lazily-loaded overlay fetched the node detail on open',
    );
  } finally {
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
});

test('a failed overlay import is not cached — the next open retries (frontend perf)', async () => {
  const env = createDomEnvironment({ includeBody: true });
  registerOverlay(env);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => jsonResponse([]);
  try {
    const { _testUtils } = initializeApp(BASE_CONFIG);
    await _testUtils.initialLoad;

    // A transient chunk-load failure on the first open must not permanently
    // disable node links: the rejected import is dropped, not memoised.
    let attempts = 0;
    _testUtils._setNodeDetailOverlayImporter(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('chunk load failed'))
        : import('../node-detail-overlay.js');
    });

    await assert.rejects(_testUtils.loadNodeDetailOverlayManager(), /chunk load failed/);
    const manager = await _testUtils.loadNodeDetailOverlayManager();
    assert.ok(manager, 'a later open retries the import and resolves the manager');
    assert.equal(attempts, 2, 'the failed import was retried, not served from a cached rejection');
  } finally {
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
});
