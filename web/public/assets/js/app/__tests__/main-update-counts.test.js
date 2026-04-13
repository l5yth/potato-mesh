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
// updateTitleCount
// ---------------------------------------------------------------------------

test('updateTitleCount does not throw when title and header elements are absent', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    assert.doesNotThrow(() => {
      testUtils.updateTitleCount({ hour: 5, day: 20, week: 42, month: 100, sampled: false });
    });
  } finally {
    cleanup();
  }
});

test('updateTitleCount handles null and undefined stats gracefully', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    assert.doesNotThrow(() => testUtils.updateTitleCount(null));
    assert.doesNotThrow(() => testUtils.updateTitleCount(undefined));
    assert.doesNotThrow(() => testUtils.updateTitleCount({}));
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// updateLegendProtocolCounts
// ---------------------------------------------------------------------------

test('updateLegendProtocolCounts returns early when both count elements are null', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    // Default state: meshcoreCountEl and meshtasticCountEl are null — should not throw.
    assert.doesNotThrow(() => {
      testUtils.updateLegendProtocolCounts({
        week: 10,
        meshcore: { hour: 1, day: 2, week: 3, month: 4 },
        meshtastic: { hour: 5, day: 6, week: 7, month: 8 },
      });
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

    testUtils.updateLegendProtocolCounts({
      week: 3,
      meshcore: { hour: 1, day: 1, week: 2, month: 3 },
      meshtastic: { hour: 0, day: 1, week: 1, month: 2 },
    });

    assert.equal(mcEl.textContent, ' (2)', 'meshcore count should be 2');
    assert.equal(mtEl.textContent, ' (1)', 'meshtastic count should be 1');
  } finally {
    cleanup();
  }
});

test('updateLegendProtocolCounts handles missing per-protocol data gracefully', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const mcEl = { textContent: '' };
    const mtEl = { textContent: '' };
    testUtils._setProtocolCountElements(mcEl, mtEl);

    // Stats without per-protocol breakdowns (e.g. from an old instance).
    testUtils.updateLegendProtocolCounts({ week: 5 });

    assert.equal(mcEl.textContent, ' (0)');
    assert.equal(mtEl.textContent, ' (0)');
  } finally {
    cleanup();
  }
});

test('updateLegendProtocolCounts works when only meshcoreCountEl is present', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const mcEl = { textContent: '' };
    testUtils._setProtocolCountElements(mcEl, null);

    testUtils.updateLegendProtocolCounts({
      week: 5,
      meshcore: { hour: 0, day: 0, week: 1, month: 2 },
    });
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

    testUtils.updateLegendProtocolCounts({
      week: 5,
      meshtastic: { hour: 0, day: 0, week: 1, month: 2 },
    });
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
      testUtils.updateFooterStats({ day: 1, week: 2, month: 3, sampled: false });
    });
  } finally {
    cleanup();
  }
});

test('updateFooterStats populates the active-stats element when present', () => {
  const { testUtils, env, cleanup } = setupAppWithOptions({
    extraElements: ['footerActiveNodes'],
  });
  try {
    const el = env.document.getElementById('footerActiveNodes');
    testUtils.updateFooterStats({ day: 10, week: 20, month: 30, sampled: false });

    assert.ok(
      el.textContent.includes('/day'),
      `expected footerActiveNodes to contain "/day", got: ${el.textContent}`,
    );
    assert.ok(
      el.textContent.includes('10/day'),
      `expected footerActiveNodes to contain "10/day", got: ${el.textContent}`,
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// applyProtocolVisibility
// ---------------------------------------------------------------------------

test('applyProtocolVisibility hides meshcore column when meshcore week is 0', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const mcCol = { style: { display: '' } };
    const mtCol = { style: { display: '' } };
    testUtils._setProtocolColElements(mcCol, mtCol);

    testUtils.applyProtocolVisibility({
      meshcore: { hour: 0, day: 0, week: 0, month: 0 },
      meshtastic: { hour: 1, day: 5, week: 10, month: 20 },
    });

    assert.equal(mcCol.style.display, 'none', 'meshcore column should be hidden');
    assert.equal(mtCol.style.display, '', 'meshtastic column should remain visible');
  } finally {
    cleanup();
  }
});

test('applyProtocolVisibility hides meshtastic column when meshtastic week is 0', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const mcCol = { style: { display: '' } };
    const mtCol = { style: { display: '' } };
    testUtils._setProtocolColElements(mcCol, mtCol);

    testUtils.applyProtocolVisibility({
      meshcore: { hour: 1, day: 5, week: 10, month: 20 },
      meshtastic: { hour: 0, day: 0, week: 0, month: 0 },
    });

    assert.equal(mcCol.style.display, '', 'meshcore column should remain visible');
    assert.equal(mtCol.style.display, 'none', 'meshtastic column should be hidden');
  } finally {
    cleanup();
  }
});

test('applyProtocolVisibility shows both columns when both protocols have active nodes', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const mcCol = { style: { display: 'none' } };
    const mtCol = { style: { display: 'none' } };
    testUtils._setProtocolColElements(mcCol, mtCol);

    testUtils.applyProtocolVisibility({
      meshcore: { hour: 1, day: 2, week: 5, month: 10 },
      meshtastic: { hour: 2, day: 3, week: 8, month: 15 },
    });

    assert.equal(mcCol.style.display, '', 'meshcore column should be visible');
    assert.equal(mtCol.style.display, '', 'meshtastic column should be visible');
  } finally {
    cleanup();
  }
});

test('applyProtocolVisibility handles missing per-protocol data gracefully', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const mcCol = { style: { display: '' } };
    const mtCol = { style: { display: '' } };
    testUtils._setProtocolColElements(mcCol, mtCol);

    // No per-protocol data at all — treat as 0.
    testUtils.applyProtocolVisibility({ week: 5 });

    assert.equal(mcCol.style.display, 'none');
    assert.equal(mtCol.style.display, 'none');
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
