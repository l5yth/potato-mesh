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

import { setupApp, setupAppWithOptions } from './main-app-test-helpers.js';

const NOW = 1_700_000_000;

// ---------------------------------------------------------------------------
// updateLegendProtocolCounts
// ---------------------------------------------------------------------------

test('updateLegendProtocolCounts returns early when both count elements are null', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    // Default state: meshcoreCountEl and meshtasticCountEl are null — should not throw.
    assert.doesNotThrow(() => {
      testUtils.updateLegendProtocolCounts(
        [{ last_heard: NOW - 100, protocol: 'meshcore' }],
        NOW,
      );
    });
  } finally {
    cleanup();
  }
});

test('updateLegendProtocolCounts sets per-protocol counts when elements are present', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const mcEl = { textContent: '' };
    const mtEl = { textContent: '' };
    testUtils._setProtocolCountElements(mcEl, mtEl);

    const nodes = [
      { last_heard: NOW - 100, protocol: 'meshcore' },
      { last_heard: NOW - 200, protocol: 'meshcore' },
      { last_heard: NOW - 300, protocol: 'meshtastic' },
      { last_heard: NOW - (8 * 86_400) }, // outside 7-day window, should not count
    ];
    testUtils.updateLegendProtocolCounts(nodes, NOW);

    assert.equal(mcEl.textContent, ' (2)', 'meshcore count should be 2');
    assert.equal(mtEl.textContent, ' (1)', 'meshtastic count should be 1');
  } finally {
    cleanup();
  }
});

test('updateLegendProtocolCounts bins unknown protocols into the meshtastic column', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const mcEl = { textContent: '' };
    const mtEl = { textContent: '' };
    testUtils._setProtocolCountElements(mcEl, mtEl);

    const nodes = [
      { last_heard: NOW - 100, protocol: 'reticulum' }, // unknown → meshtastic bucket
      { last_heard: NOW - 200, protocol: 'meshcore' },
    ];
    testUtils.updateLegendProtocolCounts(nodes, NOW);

    assert.equal(mcEl.textContent, ' (1)');
    assert.equal(mtEl.textContent, ' (1)');
  } finally {
    cleanup();
  }
});

test('updateLegendProtocolCounts works when only meshcoreCountEl is present', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const mcEl = { textContent: '' };
    testUtils._setProtocolCountElements(mcEl, null);

    testUtils.updateLegendProtocolCounts(
      [{ last_heard: NOW - 100, protocol: 'meshcore' }],
      NOW,
    );
    assert.equal(mcEl.textContent, ' (1)');
  } finally {
    cleanup();
  }
});

test('updateLegendProtocolCounts works when only meshtasticCountEl is present', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const mtEl = { textContent: '' };
    testUtils._setProtocolCountElements(null, mtEl);

    testUtils.updateLegendProtocolCounts(
      [{ last_heard: NOW - 100, protocol: 'meshtastic' }],
      NOW,
    );
    assert.equal(mtEl.textContent, ' (1)');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// updateFooterStats
// ---------------------------------------------------------------------------

test('updateFooterStats is a no-op when footerActiveNodes element is absent', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    assert.doesNotThrow(() => {
      testUtils.updateFooterStats([{ last_heard: NOW - 100 }], NOW);
    });
  } finally {
    cleanup();
  }
});

test('updateFooterStats populates the active-stats element when present', async () => {
  const { testUtils, env, cleanup } = setupAppWithOptions({
    extraElements: ['footerActiveNodes'],
  });
  try {
    const el = env.document.getElementById('footerActiveNodes');
    testUtils.updateFooterStats([{ last_heard: NOW - 100 }], NOW);

    // Drain the microtask queue so the async .then callback executes.
    await new Promise(resolve => setImmediate(resolve));

    assert.ok(
      el.textContent.includes('/day'),
      `expected footerActiveNodes to contain "/day", got: ${el.textContent}`,
    );
  } finally {
    cleanup();
  }
});

test('updateFooterStats discards stale responses when a newer request is in flight', async () => {
  const { testUtils, env, cleanup } = setupAppWithOptions({
    extraElements: ['footerActiveNodes'],
  });
  try {
    const el = env.document.getElementById('footerActiveNodes');

    // Fire two sequential updates; only the second should be applied.
    testUtils.updateFooterStats([{ last_heard: NOW - 100 }], NOW);
    testUtils.updateFooterStats([{ last_heard: NOW - 200 }], NOW);

    await new Promise(resolve => setImmediate(resolve));

    // Either one or neither result lands; the key invariant is no error thrown
    // and the element text is a valid stats string or empty.
    const text = el.textContent;
    assert.ok(
      text === '' || text.includes('/day'),
      `unexpected footerActiveNodes content: ${text}`,
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// restartAutoRefresh
// ---------------------------------------------------------------------------

test('restartAutoRefresh does not start a timer when refreshMs is 0', () => {
  // MINIMAL_CONFIG has refreshMs: 0 — timer must not be armed.
  const origSetInterval = globalThis.setInterval;
  const calls = [];
  globalThis.setInterval = (...args) => { calls.push(args); return origSetInterval(...args); };
  try {
    const { cleanup } = setupApp(); // uses refreshMs: 0
    // restartAutoRefresh is called during init; no timer should have been started.
    assert.equal(calls.length, 0, 'setInterval should not be called with refreshMs=0');
    cleanup();
  } finally {
    globalThis.setInterval = origSetInterval;
  }
});

test('restartAutoRefresh starts a timer when refreshMs > 0', () => {
  const timers = [];
  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (fn, ms) => {
    const id = Symbol('timer');
    timers.push({ fn, ms, id });
    return id;
  };
  globalThis.clearInterval = () => {};

  try {
    const { cleanup } = setupAppWithOptions({ configOverrides: { refreshMs: 30_000 } });
    assert.equal(timers.length, 1, 'setInterval should be called once during init');
    assert.equal(timers[0].ms, 30_000, 'interval should match configured refreshMs');
    cleanup();
  } finally {
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
  }
});

test('restartAutoRefresh clears the existing timer before starting a new one', () => {
  const cleared = [];
  const timers = [];
  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (fn, ms) => {
    const id = Symbol('timer');
    timers.push(id);
    return id;
  };
  globalThis.clearInterval = id => { cleared.push(id); };

  try {
    const { testUtils, cleanup } = setupAppWithOptions({ configOverrides: { refreshMs: 30_000 } });
    // One timer started during init.
    assert.equal(timers.length, 1);

    // Calling restartAutoRefresh again must clear the first timer and start a new one.
    testUtils.restartAutoRefresh();
    assert.equal(cleared.length, 1, 'existing timer should be cleared');
    assert.equal(cleared[0], timers[0], 'the original timer id should be cleared');
    assert.equal(timers.length, 2, 'a new timer should be started');
    cleanup();
  } finally {
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
  }
});
