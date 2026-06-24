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
  flashElement,
  flashElements,
  flashMarker,
  flashNodeTargets,
  flashMessageTargets,
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

test('FLASH_DURATION_MS is below 100ms (VF5)', () => {
  assert.ok(FLASH_DURATION_MS < 100);
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
