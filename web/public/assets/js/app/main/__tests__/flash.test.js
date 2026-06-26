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
  FLASH_CLASS,
  FLASH_DURATION_MS,
  WAVE_DURATION_MS,
  flashElement,
  flashElements,
  flashMarker,
  flashNodeTargets,
  flashMessageTargets,
  emitMarkerWave,
  emitNodeWaves,
} from '../flash.js';

/** A minimal element exposing a tracked classList. */
function fakeElement() {
  const classes = new Set();
  return {
    classes,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
  };
}

test('FLASH_DURATION_MS is ~1.2s for the LV1 role-colour fade', () => {
  assert.equal(FLASH_DURATION_MS, 1200);
});

test('flashElement cancels a prior removal timer when re-flashed (LV2 stacking)', () => {
  const el = fakeElement();
  const cancelled = [];
  let n = 0;
  const schedule = () => { n += 1; return `t${n}`; };
  const cancel = (h) => cancelled.push(h);
  flashElement(el, { schedule, cancel }); // arms t1
  flashElement(el, { schedule, cancel }); // cancels t1, arms t2
  assert.deepEqual(cancelled, ['t1']);
  assert.equal(el.classList.contains(FLASH_CLASS), true, 're-flash keeps the class on');
});

test('flashElement clears its per-element handle once the removal timer fires', () => {
  const el = fakeElement();
  let removal = null;
  flashElement(el, { schedule: (cb) => { removal = cb; return 'h'; } });
  removal(); // fire the scheduled removal
  assert.equal(el.classList.contains(FLASH_CLASS), false);
  // A later flash must not try to cancel the now-stale handle.
  const cancelled = [];
  flashElement(el, { schedule: () => 'h2', cancel: (h) => cancelled.push(h) });
  assert.deepEqual(cancelled, []);
});

test('flashElement adds the class immediately, then removes it when the timer fires', () => {
  const el = fakeElement();
  let captured = null;
  const schedule = (cb) => {
    captured = cb;
  };

  assert.equal(flashElement(el, { schedule }), true);
  assert.equal(el.classList.contains(FLASH_CLASS), true, 'class added on flash');

  captured(); // fire the scheduled removal
  assert.equal(el.classList.contains(FLASH_CLASS), false, 'class removed after duration');
});

test('flashElement restarts an in-flight flash (remove then re-add)', () => {
  const el = fakeElement();
  const ops = [];
  el.classList.add = (c) => ops.push(`add:${c}`);
  el.classList.remove = (c) => ops.push(`remove:${c}`);

  flashElement(el, { schedule: () => {} });
  // The class is cleared before being re-added so the CSS animation restarts.
  assert.deepEqual(ops, [`remove:${FLASH_CLASS}`, `add:${FLASH_CLASS}`]);
});

test('flashElement passes the duration to the scheduler', () => {
  const el = fakeElement();
  let seenDelay = null;
  flashElement(el, { duration: 42, schedule: (_cb, delay) => {
    seenDelay = delay;
  } });
  assert.equal(seenDelay, 42);
});

test('flashElement uses the real timer by default', async () => {
  const el = fakeElement();
  flashElement(el, { duration: 1 }); // default schedule = setTimeout
  assert.equal(el.classList.contains(FLASH_CLASS), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(el.classList.contains(FLASH_CLASS), false, 'real timer removed the class');
});

test('flashElement is a safe no-op for missing or non-element arguments', () => {
  assert.equal(flashElement(null), false);
  assert.equal(flashElement(undefined), false);
  assert.equal(flashElement({}), false); // no classList
  assert.equal(flashElement({ classList: {} }), false); // classList without add()
});

test('flashElements flashes each valid element and counts them', () => {
  const a = fakeElement();
  const b = fakeElement();
  const count = flashElements([a, null, b, {}], { schedule: () => {} });
  assert.equal(count, 2);
  assert.equal(a.classList.contains(FLASH_CLASS), true);
  assert.equal(b.classList.contains(FLASH_CLASS), true);
});

test('flashElements returns 0 for nullish or non-iterable input', () => {
  assert.equal(flashElements(null), 0);
  assert.equal(flashElements(undefined), 0);
  assert.equal(flashElements(123), 0);
});

test('flashMarker overrides the marker fill to white, then restores it', () => {
  const styles = [];
  const marker = {
    options: { fillColor: '#abcdef', fillOpacity: 0.7 },
    setStyle: (s) => styles.push(s),
  };
  let captured = null;
  assert.equal(flashMarker(marker, { schedule: (cb) => {
    captured = cb;
  } }), true);
  assert.deepEqual(styles[0], { fillColor: '#ffffff', fillOpacity: 1 });

  captured();
  assert.deepEqual(styles[1], { fillColor: '#abcdef', fillOpacity: 0.7 });
});

test('flashMarker tolerates a marker without options', () => {
  const styles = [];
  const marker = { setStyle: (s) => styles.push(s) };
  assert.equal(flashMarker(marker, { schedule: (cb) => cb() }), true);
  assert.deepEqual(styles[1], { fillColor: undefined, fillOpacity: undefined });
});

test('flashMarker uses the real timer by default', async () => {
  const styles = [];
  const marker = { options: { fillColor: '#111', fillOpacity: 0.5 }, setStyle: (s) => styles.push(s) };
  flashMarker(marker, { duration: 1 }); // default schedule = setTimeout
  assert.deepEqual(styles[0], { fillColor: '#ffffff', fillOpacity: 1 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(styles[1], { fillColor: '#111', fillOpacity: 0.5 });
});

test('flashMarker is a no-op without setStyle', () => {
  assert.equal(flashMarker(null), false);
  assert.equal(flashMarker({}), false);
});

test('flashNodeTargets flashes each node row and marker', () => {
  const rowA = fakeElement();
  let markerFlashed = false;
  const markerA = {
    options: { fillColor: '#123', fillOpacity: 0.7 },
    setStyle: () => {
      markerFlashed = true;
    },
  };
  const documentRef = { querySelectorAll: (sel) => (sel.includes('"!a"') ? [rowA] : []) };
  const markerByNodeId = new Map([['!a', markerA]]);

  const count = flashNodeTargets(['!a'], {
    documentRef,
    markerByNodeId,
    flashOptions: { schedule: () => {} },
  });

  assert.equal(rowA.classList.contains(FLASH_CLASS), true, 'row flashed');
  assert.equal(markerFlashed, true, 'marker flashed');
  assert.equal(count, 2); // one row + one marker
});

test('flashNodeTargets skips a missing document and unmapped markers', () => {
  // No documentRef → no row flash; marker not in the map → no marker flash.
  assert.equal(flashNodeTargets(['!x'], { markerByNodeId: new Map() }), 0);
  // documentRef present but no matching row; no markerByNodeId at all.
  assert.equal(flashNodeTargets(['!x'], { documentRef: { querySelectorAll: () => [] } }), 0);
});

test('flashNodeTargets returns 0 for nullish or non-iterable ids', () => {
  assert.equal(flashNodeTargets(null), 0);
  assert.equal(flashNodeTargets(123), 0);
});

test('flashMessageTargets flashes message rows and each channel tab header once', () => {
  // Two messages on the same tab → the tab header is flashed only once.
  const rows = { 1: [fakeElement()], 2: [fakeElement()] };
  const tab = fakeElement();
  const documentRef = {
    querySelectorAll: (sel) => {
      const msg = sel.match(/data-message-id="([^"]+)"/);
      if (msg) return rows[msg[1]] || [];
      return sel.includes('data-tab-id="t-pub"') ? [tab] : [];
    },
  };
  const messageTabId = new Map([['1', 't-pub'], ['2', 't-pub']]);

  const count = flashMessageTargets(['1', '2'], {
    documentRef,
    messageTabId,
    flashOptions: { schedule: () => {} },
  });

  assert.equal(rows[1][0].classList.contains(FLASH_CLASS), true, 'row 1 flashed');
  assert.equal(rows[2][0].classList.contains(FLASH_CLASS), true, 'row 2 flashed');
  assert.equal(tab.classList.contains(FLASH_CLASS), true, 'tab header flashed');
  assert.equal(count, 3); // two rows + one tab (deduped)
});

test('flashMessageTargets skips tab flashing without a tab map or document', () => {
  // No messageTabId → no tab flash; rows still attempted via the document.
  const row = fakeElement();
  const documentRef = { querySelectorAll: (sel) => (sel.includes('"1"') ? [row] : []) };
  assert.equal(flashMessageTargets(['1'], { documentRef, flashOptions: { schedule: () => {} } }), 1);
  // No documentRef at all → nothing queried, but a mapped tab is still collected harmlessly.
  assert.equal(flashMessageTargets(['1'], { messageTabId: new Map([['1', 't']]) }), 0);
});

test('flashMessageTargets returns 0 for nullish or non-iterable ids', () => {
  assert.equal(flashMessageTargets(null), 0);
  assert.equal(flashMessageTargets(undefined), 0);
  assert.equal(flashMessageTargets(123), 0);
});


test('flashMessageTargets flashes only the message channel tab, never an unrelated/active tab (LV4)', () => {
  const msgRow = fakeElement();
  const ownTab = fakeElement();
  const activeTab = fakeElement();
  const documentRef = {
    querySelectorAll: (sel) => {
      if (sel.includes('data-message-id="9"')) return [msgRow];
      if (sel.includes('data-tab-id="c-test"')) return [ownTab];
      if (sel.includes('data-tab-id="c-primary"')) return [activeTab];
      return [];
    },
  };
  // The message belongs to #test; #primary happens to be the active tab.
  const messageTabId = new Map([['9', 'c-test']]);
  flashMessageTargets(['9'], { documentRef, messageTabId, flashOptions: { schedule: () => {} } });
  assert.equal(msgRow.classList.contains(FLASH_CLASS), true, 'message row flashed');
  assert.equal(ownTab.classList.contains(FLASH_CLASS), true, "message's own channel tab flashed");
  assert.equal(activeTab.classList.contains(FLASH_CLASS), false, 'the unrelated/active tab is NOT flashed');
});


test('emitMarkerWave adds a wave divIcon marker and removes it after the duration', () => {
  const added = [];
  const removed = [];
  const layer = { addLayer: (l) => added.push(l), removeLayer: (l) => removed.push(l) };
  let divIconOpts = null;
  let markerArgs = null;
  const leaflet = {
    divIcon: (opts) => { divIconOpts = opts; return { __icon: true }; },
    marker: (latlng, opts) => { markerArgs = { latlng, opts }; return { __wave: true }; },
  };
  let captured = null;
  const marker = { getLatLng: () => [1, 2] };
  assert.equal(emitMarkerWave(marker, {
    leaflet, layer, color: 'rgba(1, 2, 3, 0.85)', schedule: (cb) => { captured = cb; },
  }), true);
  assert.deepEqual(markerArgs.latlng, [1, 2]);
  assert.equal(markerArgs.opts.interactive, false);
  assert.match(divIconOpts.html, /live-flash-wave/);
  assert.match(divIconOpts.html, /--flash-role-color: rgba\(1, 2, 3, 0.85\)/);
  assert.deepEqual(added, [{ __wave: true }]);
  assert.deepEqual(removed, []);
  captured();
  assert.deepEqual(removed, [{ __wave: true }]);
});

test('emitMarkerWave defaults the colour and duration', () => {
  let divIconOpts = null;
  let seenDelay = null;
  const leaflet = { divIcon: (o) => { divIconOpts = o; return {}; }, marker: () => ({}) };
  const layer = { addLayer: () => {}, removeLayer: () => {} };
  emitMarkerWave({ getLatLng: () => [0, 0] }, { leaflet, layer, schedule: (_cb, delay) => { seenDelay = delay; } });
  assert.match(divIconOpts.html, /--flash-role-color: rgba\(255, 255, 255, 0.85\)/);
  assert.equal(seenDelay, WAVE_DURATION_MS);
});

test('emitMarkerWave is a safe no-op for a bad marker, leaflet, or layer', () => {
  const leaflet = { divIcon: () => ({}), marker: () => ({}) };
  const layer = { addLayer: () => {}, removeLayer: () => {} };
  assert.equal(emitMarkerWave(null, { leaflet, layer }), false);
  assert.equal(emitMarkerWave({}, { leaflet, layer }), false);
  assert.equal(emitMarkerWave({ getLatLng: () => [0, 0] }, { layer }), false);
  assert.equal(emitMarkerWave({ getLatLng: () => [0, 0] }, { leaflet }), false);
  assert.equal(emitMarkerWave({ getLatLng: () => [0, 0] }, { leaflet: {}, layer }), false);
});

test('emitNodeWaves emits a wave per node that has a marker, skipping the rest', () => {
  const waved = [];
  const leaflet = { divIcon: () => ({}), marker: () => ({ __w: true }) };
  const layer = { addLayer: (l) => waved.push(l), removeLayer: () => {} };
  const markerByNodeId = new Map([
    ['!a', { getLatLng: () => [1, 1] }],
    ['!b', { getLatLng: () => [2, 2] }],
  ]);
  const count = emitNodeWaves(['!a', '!b', '!missing'], {
    markerByNodeId, leaflet, layer,
    colorForNodeId: (id) => `c-${id}`,
    waveOptions: { schedule: () => {} },
  });
  assert.equal(count, 2);
  assert.equal(waved.length, 2);
});

test('emitNodeWaves defaults the colour when no resolver is given', () => {
  let html = null;
  const leaflet = { divIcon: (o) => { html = o.html; return {}; }, marker: () => ({}) };
  const layer = { addLayer: () => {}, removeLayer: () => {} };
  const markerByNodeId = new Map([['!a', { getLatLng: () => [0, 0] }]]);
  assert.equal(emitNodeWaves(['!a'], { markerByNodeId, leaflet, layer, waveOptions: { schedule: () => {} } }), 1);
  assert.match(html, /rgba\(255, 255, 255, 0.85\)/);
});

test('emitNodeWaves is a no-op for bad ids or a missing marker map', () => {
  assert.equal(emitNodeWaves(null, {}), 0);
  assert.equal(emitNodeWaves(123, {}), 0);
  assert.equal(emitNodeWaves(['!a'], {}), 0);
  assert.equal(emitNodeWaves(['!a'], { markerByNodeId: new Map() }), 0);
});


test('flashElement cancels the prior real timer on re-flash via the default canceller (LV2)', async () => {
  const el = fakeElement();
  // First flash arms a real 60ms removal timer; the re-flash (no injected cancel)
  // must clearTimeout it via the default canceller so the class is not removed at
  // the first timer's mark, only by the second (live) timer.
  flashElement(el, { duration: 60 });
  flashElement(el, { duration: 60 });
  assert.equal(el.classList.contains(FLASH_CLASS), true);
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(el.classList.contains(FLASH_CLASS), false, 'removed by the second (live) timer');
});
