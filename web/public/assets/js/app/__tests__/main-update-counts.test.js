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
import { TICK_INTERVAL_MS } from '../main/relative-time-ticker.js';

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

test('updateLegendProtocolCounts sets the reticulum count too (RD7)', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const mcEl = { textContent: '' };
    const mtEl = { textContent: '' };
    const rtEl = { textContent: '' };
    testUtils._setProtocolCountElements(mcEl, mtEl, rtEl);

    testUtils.updateLegendProtocolCounts({
      meshcore: { week: 2 },
      meshtastic: { week: 1 },
      reticulum: { week: 7 },
    });

    assert.equal(rtEl.textContent, ' (7)', 'reticulum count should be 7');
    assert.equal(mcEl.textContent, ' (2)');
    assert.equal(mtEl.textContent, ' (1)');
  } finally {
    cleanup();
  }
});

test('updateLegendProtocolCounts zeroes an absent reticulum scope (RD7)', () => {
  // An instance with no RNS ingestor still renders the column honestly.
  const { testUtils, cleanup } = setupApp();
  try {
    const rtEl = { textContent: '' };
    testUtils._setProtocolCountElements(null, null, rtEl);
    testUtils.updateLegendProtocolCounts({ meshtastic: { week: 4 } });
    assert.equal(rtEl.textContent, ' (0)');
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
// updateProtocolToggleCounts (audit follow-up 04)
// ---------------------------------------------------------------------------

test('updateProtocolToggleCounts is a no-op when the count elements are absent', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    assert.doesNotThrow(() => {
      testUtils.updateProtocolToggleCounts({ meshcore: { week: 3 }, meshtastic: { week: 4 } });
    });
  } finally {
    cleanup();
  }
});

test('updateProtocolToggleCounts writes the 7-day per-protocol counts onto the toggles', () => {
  const { testUtils, env, cleanup } = setupAppWithOptions({
    extraElements: [
      'protocolToggleMeshcoreCount',
      'protocolToggleMeshtasticCount',
      'protocolToggleReticulumCount',
    ],
  });
  try {
    const mc = env.document.getElementById('protocolToggleMeshcoreCount');
    const mt = env.document.getElementById('protocolToggleMeshtasticCount');
    const rt = env.document.getElementById('protocolToggleReticulumCount');
    testUtils.updateProtocolToggleCounts({
      week: 143,
      meshcore: { hour: 1, day: 120, week: 123, month: 200 },
      meshtastic: { hour: 1, day: 20, week: 17, month: 40 },
      reticulum: { hour: 0, day: 2, week: 3, month: 3 },
    });
    // The toggle count mirrors the legend's 7-day figure so the same protocol
    // shows the same number in both places.
    assert.equal(mc.textContent, '123');
    assert.equal(mt.textContent, '17');
    assert.equal(rt.textContent, '3');
  } finally {
    cleanup();
  }
});

test('updateProtocolToggleCounts defaults missing per-protocol data to zero', () => {
  const { testUtils, env, cleanup } = setupAppWithOptions({
    extraElements: [
      'protocolToggleMeshcoreCount',
      'protocolToggleMeshtasticCount',
      'protocolToggleReticulumCount',
    ],
  });
  try {
    const mc = env.document.getElementById('protocolToggleMeshcoreCount');
    const mt = env.document.getElementById('protocolToggleMeshtasticCount');
    const rt = env.document.getElementById('protocolToggleReticulumCount');
    testUtils.updateProtocolToggleCounts({ week: 5 });
    assert.equal(mc.textContent, '0');
    assert.equal(mt.textContent, '0');
    assert.equal(rt.textContent, '0');
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

    // SPEC UX11 (audit D-026): worded vital sign with the day figure promoted.
    assert.ok(
      el.innerHTML.includes('10 nodes today'),
      `expected footerActiveNodes to contain "10 nodes today", got: ${el.innerHTML}`,
    );
    assert.ok(
      el.innerHTML.includes('meta-active-nodes__today'),
      `expected the day segment to be styleable, got: ${el.innerHTML}`,
    );
    assert.ok(
      el.innerHTML.includes('20 this week'),
      `expected footerActiveNodes to contain "20 this week", got: ${el.innerHTML}`,
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// meta-row protocol toggle click-to-filter (#888 follow-up)
// ---------------------------------------------------------------------------

test('clicking the reticulum toggle hides reticulum nodes, mirroring the meshcore chip', async () => {
  const { testUtils, env, cleanup } = setupAppWithOptions({
    extraElements: ['protocolToggleMeshcore', 'protocolToggleMeshtastic', 'protocolToggleReticulum'],
  });
  // Let the click's applyFilter() async fallout (stats refresh) settle while
  // the stub environment is still alive, so nothing rejects after cleanup.
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  try {
    const rt = env.document.getElementById('protocolToggleReticulum');
    const clickHandlers = rt._listeners?.get('click') ?? [];
    assert.equal(clickHandlers.length, 1, 'the reticulum toggle is wired at init');

    clickHandlers[0]();
    await settle();
    assert.ok(testUtils.hiddenProtocols.has('reticulum'), 'first click hides reticulum');
    assert.equal(
      testUtils.matchesProtocolFilter({ node_id: '!a1b2c3d4', protocol: 'reticulum' }),
      false,
      'reticulum nodes are filtered out while hidden',
    );
    assert.equal(
      testUtils.matchesProtocolFilter({ node_id: '!12ab34cd', protocol: 'meshtastic' }),
      true,
      'other protocols stay visible',
    );

    clickHandlers[0]();
    await settle();
    assert.ok(!testUtils.hiddenProtocols.has('reticulum'), 'second click shows reticulum again');
    assert.equal(
      testUtils.matchesProtocolFilter({ node_id: '!a1b2c3d4', protocol: 'reticulum' }),
      true,
    );
  } finally {
    cleanup();
  }
});

test('updateMetaProtocolToggleUI stamps pressed state and labels on the reticulum toggle', () => {
  const { testUtils, env, cleanup } = setupAppWithOptions({
    extraElements: ['protocolToggleMeshcore', 'protocolToggleMeshtastic', 'protocolToggleReticulum'],
  });
  try {
    const rt = env.document.getElementById('protocolToggleReticulum');
    testUtils.hiddenProtocols.add('reticulum');
    testUtils.updateMetaProtocolToggleUI();
    assert.equal(rt.getAttribute('aria-pressed'), 'true');
    assert.equal(rt.getAttribute('aria-label'), 'Show Reticulum nodes');

    testUtils.hiddenProtocols.delete('reticulum');
    testUtils.updateMetaProtocolToggleUI();
    assert.equal(rt.getAttribute('aria-pressed'), 'false');
    assert.equal(rt.getAttribute('aria-label'), 'Hide Reticulum nodes');
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

test('applyProtocolVisibility hides the reticulum column when its week is 0 (RD7)', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const mcCol = { style: { display: '' } };
    const mtCol = { style: { display: '' } };
    const rtCol = { style: { display: '' } };
    testUtils._setProtocolColElements(mcCol, mtCol, rtCol);

    testUtils.applyProtocolVisibility({
      meshcore: { week: 10 },
      meshtastic: { week: 20 },
      reticulum: { week: 0 },
    });

    assert.equal(rtCol.style.display, 'none', 'reticulum column should be hidden');
    assert.equal(mcCol.style.display, '');
    assert.equal(mtCol.style.display, '');
  } finally {
    cleanup();
  }
});

test('applyProtocolVisibility shows the reticulum column when it has activity (RD7)', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const mcCol = { style: { display: 'none' } };
    const mtCol = { style: { display: '' } };
    const rtCol = { style: { display: 'none' } };
    testUtils._setProtocolColElements(mcCol, mtCol, rtCol);

    testUtils.applyProtocolVisibility({
      meshcore: { week: 0 },
      meshtastic: { week: 20 },
      reticulum: { week: 3 },
    });

    assert.equal(rtCol.style.display, '', 'reticulum column should be shown');
    assert.equal(mcCol.style.display, 'none', 'meshcore stays hidden at zero');
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

test('applyProtocolVisibility shows all three toggles when all three protocols are active', () => {
  const { testUtils, env, cleanup } = setupAppWithOptions({
    extraElements: ['protocolToggleMeshcore', 'protocolToggleMeshtastic', 'protocolToggleReticulum'],
  });
  try {
    const mc = env.document.getElementById('protocolToggleMeshcore');
    const mt = env.document.getElementById('protocolToggleMeshtastic');
    const rt = env.document.getElementById('protocolToggleReticulum');
    mc.hidden = true;
    mt.hidden = true;
    rt.hidden = true;

    testUtils.applyProtocolVisibility({
      meshcore: { hour: 1, day: 2, week: 5, month: 10 },
      meshtastic: { hour: 2, day: 3, week: 8, month: 15 },
      reticulum: { hour: 1, day: 3, week: 3, month: 3 },
    });

    assert.equal(mc.hidden, false, 'meshcore toggle should be visible');
    assert.equal(mt.hidden, false, 'meshtastic toggle should be visible');
    assert.equal(rt.hidden, false, 'reticulum toggle should be visible');
  } finally {
    cleanup();
  }
});

test('applyProtocolVisibility shows the reticulum toggle alongside one other active protocol', () => {
  const { testUtils, env, cleanup } = setupAppWithOptions({
    extraElements: ['protocolToggleMeshcore', 'protocolToggleMeshtastic', 'protocolToggleReticulum'],
  });
  try {
    const mc = env.document.getElementById('protocolToggleMeshcore');
    const mt = env.document.getElementById('protocolToggleMeshtastic');
    const rt = env.document.getElementById('protocolToggleReticulum');

    testUtils.applyProtocolVisibility({
      meshcore: { hour: 0, day: 0, week: 0, month: 0 },
      meshtastic: { hour: 2, day: 3, week: 8, month: 15 },
      reticulum: { hour: 1, day: 3, week: 3, month: 3 },
    });

    assert.equal(mc.hidden, true, 'inactive meshcore toggle should stay hidden');
    assert.equal(mt.hidden, false, 'meshtastic toggle should be visible');
    assert.equal(rt.hidden, false, 'reticulum toggle should be visible');
  } finally {
    cleanup();
  }
});

test('applyProtocolVisibility hides every toggle when only one protocol is active', () => {
  const { testUtils, env, cleanup } = setupAppWithOptions({
    extraElements: ['protocolToggleMeshcore', 'protocolToggleMeshtastic', 'protocolToggleReticulum'],
  });
  try {
    const mc = env.document.getElementById('protocolToggleMeshcore');
    const mt = env.document.getElementById('protocolToggleMeshtastic');
    const rt = env.document.getElementById('protocolToggleReticulum');

    // Filtering is pointless with a single protocol — even when that sole
    // protocol is reticulum.
    testUtils.applyProtocolVisibility({
      meshcore: { hour: 0, day: 0, week: 0, month: 0 },
      meshtastic: { hour: 0, day: 0, week: 0, month: 0 },
      reticulum: { hour: 1, day: 3, week: 3, month: 3 },
    });

    assert.equal(mc.hidden, true);
    assert.equal(mt.hidden, true);
    assert.equal(rt.hidden, true);
  } finally {
    cleanup();
  }
});

test('applyProtocolVisibility un-strands a hidden protocol when its chip disappears', async () => {
  const { testUtils, env, cleanup } = setupAppWithOptions({
    extraElements: ['protocolToggleMeshcore', 'protocolToggleMeshtastic', 'protocolToggleReticulum'],
  });
  // Let the un-strand's applyFilter() async fallout (stats refresh) settle
  // while the stub environment is still alive, so nothing rejects after
  // cleanup.
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  try {
    const rt = env.document.getElementById('protocolToggleReticulum');

    // The user toggled reticulum off while its chip was visible...
    testUtils.hiddenProtocols.add('reticulum');
    // ...then reticulum activity dropped below the 2-protocol threshold, so
    // the chip is hidden by the visibility rule.
    testUtils.applyProtocolVisibility({
      meshcore: { hour: 0, day: 0, week: 0, month: 0 },
      meshtastic: { hour: 2, day: 3, week: 8, month: 15 },
      reticulum: { hour: 0, day: 0, week: 0, month: 0 },
    });
    await settle();

    assert.equal(rt.hidden, true, 'inactive reticulum chip is hidden');
    assert.ok(
      !testUtils.hiddenProtocols.has('reticulum'),
      'the chipless protocol leaves hiddenProtocols so its nodes are not stranded invisible',
    );
    assert.equal(
      testUtils.matchesProtocolFilter({ node_id: '!a1b2c3d4', protocol: 'reticulum' }),
      true,
      'reticulum nodes reappear once no chip can un-hide them',
    );
  } finally {
    cleanup();
  }
});

test('applyProtocolVisibility keeps a user-hidden protocol filtered while its chip stays visible', async () => {
  const { testUtils, env, cleanup } = setupAppWithOptions({
    extraElements: ['protocolToggleMeshcore', 'protocolToggleMeshtastic', 'protocolToggleReticulum'],
  });
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  try {
    const rt = env.document.getElementById('protocolToggleReticulum');

    testUtils.hiddenProtocols.add('reticulum');
    // Reticulum stays active alongside meshtastic: the chip remains visible,
    // so the user's explicit hide must be preserved.
    testUtils.applyProtocolVisibility({
      meshcore: { hour: 0, day: 0, week: 0, month: 0 },
      meshtastic: { hour: 2, day: 3, week: 8, month: 15 },
      reticulum: { hour: 1, day: 3, week: 3, month: 3 },
    });
    await settle();

    assert.equal(rt.hidden, false, 'active reticulum chip stays visible');
    assert.ok(
      testUtils.hiddenProtocols.has('reticulum'),
      'the explicit hide survives while the chip can still undo it',
    );
    assert.equal(
      testUtils.matchesProtocolFilter({ node_id: '!a1b2c3d4', protocol: 'reticulum' }),
      false,
      'reticulum nodes stay filtered out',
    );
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
// applyProtocolVisibility x meta-row protocol toggles (map-legend regression)
// ---------------------------------------------------------------------------

/**
 * Stats with 7-day activity on all three protocols, so every meta-row toggle
 * stays visible and the un-strand rule never fires.
 */
const ALL_ACTIVE_STATS = Object.freeze({
  meshcore: { hour: 1, day: 2, week: 5, month: 10 },
  meshtastic: { hour: 2, day: 3, week: 8, month: 15 },
  reticulum: { hour: 1, day: 3, week: 3, month: 3 },
});

/**
 * Inject three visible legend column stubs.
 *
 * @param {Object} testUtils App test utilities.
 * @returns {{mcCol: Object, mtCol: Object, rtCol: Object}} Column stubs.
 */
function injectVisibleColumns(testUtils) {
  const mcCol = { style: { display: '' } };
  const mtCol = { style: { display: '' } };
  const rtCol = { style: { display: '' } };
  testUtils._setProtocolColElements(mcCol, mtCol, rtCol);
  return { mcCol, mtCol, rtCol };
}

test('applyProtocolVisibility drops the legend column of a protocol hidden with its toggle', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const { mcCol, mtCol, rtCol } = injectVisibleColumns(testUtils);
    // The user turned MeshCore off with its meta-row toggle. Every protocol
    // keeps 7-day activity, so the toggle (the way back) stays on screen.
    testUtils.hiddenProtocols.add('meshcore');

    testUtils.applyProtocolVisibility(ALL_ACTIVE_STATS);

    assert.equal(mcCol.style.display, 'none', 'a protocol hidden from view leaves the map legend');
    assert.equal(mtCol.style.display, '', 'a protocol in view keeps its legend column');
    assert.equal(rtCol.style.display, '', 'a protocol in view keeps its legend column');
    assert.ok(testUtils.hiddenProtocols.has('meshcore'), 'the explicit hide is preserved');
  } finally {
    cleanup();
  }
});

test('applyProtocolVisibility returns a legend column when its protocol is shown again', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const { mcCol, mtCol, rtCol } = injectVisibleColumns(testUtils);
    testUtils.hiddenProtocols.add('meshcore');
    testUtils.hiddenProtocols.add('reticulum');
    testUtils.applyProtocolVisibility(ALL_ACTIVE_STATS);
    assert.equal(mcCol.style.display, 'none', 'hidden MeshCore leaves the legend');
    assert.equal(rtCol.style.display, 'none', 'hidden Reticulum leaves the legend');

    testUtils.hiddenProtocols.delete('reticulum');
    testUtils.applyProtocolVisibility(ALL_ACTIVE_STATS);

    assert.equal(rtCol.style.display, '', 'Reticulum shown again: its column returns');
    assert.equal(mcCol.style.display, 'none', 'MeshCore still hidden: its column stays out');
    assert.equal(mtCol.style.display, '');
  } finally {
    cleanup();
  }
});

test('applyProtocolVisibility gives an un-stranded protocol its column back in the same pass', async () => {
  const { testUtils, cleanup } = setupApp();
  // Let the un-strand's applyFilter() async fallout settle before cleanup.
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  try {
    const { mcCol } = injectVisibleColumns(testUtils);
    testUtils.hiddenProtocols.add('meshcore');
    // MeshCore is now the only active protocol: its toggle disappears, the
    // un-strand rule drops it from hiddenProtocols, and its nodes return.
    // Its column must return with them, not one stats round-trip later.
    testUtils.applyProtocolVisibility({
      meshcore: { hour: 1, day: 2, week: 5, month: 10 },
      meshtastic: { hour: 0, day: 0, week: 0, month: 0 },
      reticulum: { hour: 0, day: 0, week: 0, month: 0 },
    });

    assert.ok(!testUtils.hiddenProtocols.has('meshcore'), 'the chipless protocol is un-stranded');
    assert.equal(mcCol.style.display, '', 'the un-stranded protocol is back in view, so is its column');
    await settle();
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
    // restartAutoRefresh is called during init; no refresh timer should have
    // been started. The only interval armed at boot is the shared
    // relative-time ticker (SPEC RT2), identified by its 1 s cadence.
    const refreshCalls = calls.filter(args => args[1] !== TICK_INTERVAL_MS);
    assert.equal(refreshCalls.length, 0, 'setInterval should not be called with refreshMs=0');
    assert.equal(
      calls.filter(args => args[1] === TICK_INTERVAL_MS).length,
      1,
      'the shared relative-time ticker is armed at boot (RT2)'
    );
    cleanup();
  } finally {
    globalThis.setInterval = origSetInterval;
  }
});

test('restartAutoRefresh starts a timer when refreshMs > 0, once the initial load settles (OR1)', async () => {
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
    const { testUtils, cleanup } = setupAppWithOptions({ configOverrides: { refreshMs: 30_000 } });
    // SPEC OR1: no refresh timer while the initial load runs.
    assert.equal(timers.filter(t => t.ms === 30_000).length, 0, 'no refresh timer before the initial load settles');
    await testUtils.initialLoad;
    // The page open arms exactly one refresh timer plus the relative-time ticker (RT2).
    const refreshTimers = timers.filter(t => t.ms === 30_000);
    assert.equal(refreshTimers.length, 1, 'one refresh timer once the initial load settles');
    assert.equal(
      timers.filter(t => t.ms === TICK_INTERVAL_MS).length,
      1,
      'the relative-time ticker runs alongside the refresh timer'
    );
    cleanup();
  } finally {
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
  }
});

test('restartAutoRefresh clears the existing timer before starting a new one', async () => {
  const cleared = [];
  const timers = [];
  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (fn, ms) => {
    const id = Symbol('timer');
    timers.push({ id, ms });
    return id;
  };
  globalThis.clearInterval = id => { cleared.push(id); };

  try {
    const { testUtils, cleanup } = setupAppWithOptions({ configOverrides: { refreshMs: 30_000 } });
    // One refresh timer once the initial load settles (OR1; the 1 s interval is the ticker).
    await testUtils.initialLoad;
    const refreshTimers = () => timers.filter(t => t.ms === 30_000);
    assert.equal(refreshTimers().length, 1);
    const firstRefreshId = refreshTimers()[0].id;

    // Calling restartAutoRefresh again must clear the first refresh timer and
    // start a new one — without touching the relative-time ticker (RT3: the
    // presentation clock is independent of the data-refresh lifecycle).
    testUtils.restartAutoRefresh();
    assert.equal(cleared.length, 1, 'existing refresh timer should be cleared');
    assert.equal(cleared[0], firstRefreshId, 'the original refresh timer id should be cleared');
    assert.equal(refreshTimers().length, 2, 'a new refresh timer should be started');
    assert.equal(
      timers.filter(t => t.ms === TICK_INTERVAL_MS).length,
      1,
      'the ticker interval is untouched by a refresh restart'
    );
    cleanup();
  } finally {
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
  }
});
