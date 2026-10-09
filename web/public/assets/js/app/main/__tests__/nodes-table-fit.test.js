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
 * Unit coverage for the adaptive nodes-table fit (SPEC PO1): the pure
 * decision, the synchronous toggle-and-measure, and the wiring that re-checks
 * once per animation frame when the table's column resizes.
 *
 * @module main/__tests__/nodes-table-fit
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FIT_TOLERANCE_PX,
  SQUEEZED_CLASS,
  decideSqueezed,
  fitNodesTable,
  watchNodesTableFit,
} from '../nodes-table-fit.js';

/**
 * A table stand-in whose width depends on the squeezed class, as the real
 * table's does: unbroken it is `natural` wide, squeezed `squeezed` wide.
 *
 * @param {{natural?: number, squeezed?: number, on?: boolean}} [widths] Widths and initial state.
 * @returns {{table: Object, calls: Array<string>, reads: Array<boolean>, widths: Object}}
 *   The stand-in, its class writes in order, and the class state at each width read.
 */
function stubTable({ natural = 420, squeezed = 343, on = false } = {}) {
  const classes = new Set(on ? [SQUEEZED_CLASS] : []);
  const calls = [];
  const reads = [];
  const widths = { natural, squeezed };
  const table = {
    classList: {
      contains: name => classes.has(name),
      add: name => { calls.push(`add ${name}`); classes.add(name); },
      remove: name => { calls.push(`remove ${name}`); classes.delete(name); },
    },
    getBoundingClientRect: () => {
      const on = classes.has(SQUEEZED_CLASS);
      reads.push(on);
      return { width: on ? widths.squeezed : widths.natural };
    },
  };
  return { table, calls, reads, widths };
}

/**
 * A column stand-in of a given width; set its `width` to resize it.
 *
 * @param {number} width Box width.
 * @returns {{width: number, getBoundingClientRect: function(): {width: number}}} The column.
 */
const stubColumn = width => ({ width, getBoundingClientRect() { return { width: this.width }; } });

/** Reconcile counts of a render that created, moved and removed no row. */
const NO_ROW_CHANGED = Object.freeze({ created: 0, moved: 0, removed: 0 });

/**
 * A window stand-in with a manual animation-frame queue and, optionally, a
 * ResizeObserver whose callback the test fires.
 *
 * @param {{resizeObserver?: boolean, frames?: boolean, cancel?: boolean}} [options] Which APIs exist.
 * @returns {Object} The window, its frame queue, observers and listeners.
 */
function stubWindow({ resizeObserver = true, frames = true, cancel = true } = {}) {
  const queue = new Map();
  const observers = [];
  const listeners = new Map();
  let nextFrame = 1;
  const win = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
  };
  if (frames) {
    win.requestAnimationFrame = fn => { const id = nextFrame; nextFrame += 1; queue.set(id, fn); return id; };
  }
  if (cancel) win.cancelAnimationFrame = id => queue.delete(id);
  if (resizeObserver) {
    win.ResizeObserver = class {
      constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; observers.push(this); }
      observe(target) { this.targets.push(target); }
      disconnect() { this.disconnected = true; }
    };
  }
  /**
   * Run every queued animation frame.
   *
   * @returns {number} How many frames ran.
   */
  const flushFrames = () => {
    const pending = [...queue.values()];
    queue.clear();
    pending.forEach(fn => fn());
    return pending.length;
  };
  return { win, queue, observers, listeners, flushFrames };
}

/**
 * A ResizeObserver notification for a content box of the given size.
 *
 * @param {number} width Content width.
 * @param {number} [height] Content height.
 * @returns {Array<Object>} The entries.
 */
const resized = (width, height = 100) => [{ contentRect: { width, height } }];

test('decideSqueezed squeezes a table wider than its column, beyond the sub-pixel tolerance (PO1)', () => {
  assert.equal(decideSqueezed(420, 343), true);
  assert.equal(decideSqueezed(343 + FIT_TOLERANCE_PX + 0.01, 343), true);
  assert.equal(decideSqueezed(343 + FIT_TOLERANCE_PX, 343), false, 'within the tolerance it fits');
  assert.equal(decideSqueezed(343, 343), false);
  assert.equal(decideSqueezed(300, 343), false);
});

test('decideSqueezed makes no decision on an unusable measurement (PO1)', () => {
  assert.equal(decideSqueezed(Number.NaN, 343), null);
  assert.equal(decideSqueezed(420, Number.POSITIVE_INFINITY), null);
  assert.equal(decideSqueezed(420, 0), null, 'a hidden table has a column of no width');
  assert.equal(decideSqueezed(420, -1), null);
});

test('fitNodesTable adds the class to an overflowing table and leaves a fitting one untouched (PO1)', () => {
  const overflowing = stubTable({ natural: 420 });
  assert.equal(fitNodesTable(overflowing.table, stubColumn(343)), true, 'the class changed');
  assert.deepEqual(overflowing.calls, [`add ${SQUEEZED_CLASS}`]);
  const fitting = stubTable({ natural: 300 });
  assert.equal(fitNodesTable(fitting.table, stubColumn(343)), false);
  assert.deepEqual(fitting.calls, [], 'no class write when nothing changes');
});

test('fitNodesTable measures a squeezed table without the class and keeps the class only while it still overflows (PO1)', () => {
  const still = stubTable({ natural: 420, on: true });
  assert.equal(fitNodesTable(still.table, stubColumn(343)), false, 'the class is unchanged');
  assert.deepEqual(still.calls, [`remove ${SQUEEZED_CLASS}`, `add ${SQUEEZED_CLASS}`]);
  assert.deepEqual(still.reads, [false], 'the width is read without the class');
  const roomy = stubTable({ natural: 420, on: true });
  assert.equal(fitNodesTable(roomy.table, stubColumn(480)), true);
  assert.deepEqual(roomy.calls, [`remove ${SQUEEZED_CLASS}`]);
  assert.equal(roomy.table.classList.contains(SQUEEZED_CLASS), false);
});

test('fitNodesTable keeps the current class when the table cannot be measured (PO1)', () => {
  const hiddenOn = stubTable({ on: true });
  assert.equal(fitNodesTable(hiddenOn.table, stubColumn(0)), false);
  assert.equal(hiddenOn.table.classList.contains(SQUEEZED_CLASS), true, 'a hidden table keeps its class');
  const hiddenOff = stubTable();
  assert.equal(fitNodesTable(hiddenOff.table, stubColumn(0)), false);
  assert.deepEqual(hiddenOff.calls, []);
  const boxless = stubTable();
  delete boxless.table.getBoundingClientRect;
  assert.equal(fitNodesTable(boxless.table, stubColumn(343)), false, 'no box, no decision');
  assert.equal(fitNodesTable(stubTable().table, null), false, 'no column, no decision');
});

test('watchNodesTableFit is inert without a table, a class list or a column (PO1)', () => {
  const { win, observers, listeners } = stubWindow();
  for (const table of [null, {}, { classList: stubTable().table.classList }]) {
    const fit = watchNodesTableFit(table, { windowRef: win });
    assert.equal(fit.check(), false);
    assert.doesNotThrow(() => fit.disconnect());
  }
  assert.equal(observers.length, 0, 'nothing observed');
  assert.equal(listeners.size, 0, 'nothing listened to');
});

test('the render hook decides at once and repeated checks with the same widths keep the class stable (PO1)', () => {
  const { win } = stubWindow();
  const { table, calls, widths } = stubTable({ natural: 420 });
  const fit = watchNodesTableFit(table, { column: stubColumn(343), windowRef: win });
  assert.equal(fit.check(), true, 'the first render squeezes');
  assert.equal(fit.check(), false, 'a re-render with the same data changes nothing');
  assert.equal(table.classList.contains(SQUEEZED_CLASS), true);
  widths.natural = 300;
  calls.length = 0;
  assert.equal(fit.check(), true, 'narrower content fits again');
  assert.equal(fit.check(), false);
  assert.deepEqual(calls, [`remove ${SQUEEZED_CLASS}`], 'no class write once it fits');
});

test('a render that changed no row keeps the last decision without measuring while the column keeps its width (PO1)', () => {
  const { win } = stubWindow();
  const { table, calls, reads } = stubTable({ natural: 420 });
  const fit = watchNodesTableFit(table, { column: stubColumn(343), windowRef: win });
  assert.equal(fit.check(NO_ROW_CHANGED), true, 'the first render measures, changed rows or not');
  calls.length = 0;
  reads.length = 0;
  assert.equal(fit.check(NO_ROW_CHANGED), false);
  assert.deepEqual(reads, [], 'the table is not measured');
  assert.deepEqual(calls, [], 'the class is not written');
  assert.equal(table.classList.contains(SQUEEZED_CLASS), true, 'the previous decision stands');
});

test('a created, moved or removed row, a new column width or a check without counts measures again (PO1)', () => {
  for (const rows of [{ created: 1, moved: 0, removed: 0 }, { created: 0, moved: 1, removed: 0 }, { created: 0, moved: 0, removed: 1 }]) {
    const { win } = stubWindow();
    const { table, reads } = stubTable({ natural: 420 });
    const fit = watchNodesTableFit(table, { column: stubColumn(343), windowRef: win });
    fit.check(NO_ROW_CHANGED);
    reads.length = 0;
    fit.check(rows);
    assert.equal(reads.length, 1, `${JSON.stringify(rows)} measures`);
  }
  const { win } = stubWindow();
  const { table, reads } = stubTable({ natural: 420 });
  const column = stubColumn(343);
  const fit = watchNodesTableFit(table, { column, windowRef: win });
  fit.check(NO_ROW_CHANGED);
  column.width = 480;
  reads.length = 0;
  assert.equal(fit.check(NO_ROW_CHANGED), true, 'a wider column re-decides');
  assert.equal(reads.length, 1);
  reads.length = 0;
  fit.check();
  assert.equal(reads.length, 1, 'a check without counts, as from a resize, always measures');
});

test('a changed header, such as a sort arrow that moved, measures again although no row changed (PO1)', () => {
  const { win } = stubWindow();
  const { table, reads, widths } = stubTable({ natural: 340 });
  const head = { innerHTML: '<tr><th>Last Seen ▼</th><th>HW Model</th></tr>' };
  table.querySelector = selector => (selector === 'thead' ? head : null);
  const fit = watchNodesTableFit(table, { column: stubColumn(343), windowRef: win });
  assert.equal(fit.check(NO_ROW_CHANGED), false, 'the unbroken table fits');
  head.innerHTML = '<tr><th>Last Seen</th><th>HW Model ▲</th></tr>';
  widths.natural = 400;
  reads.length = 0;
  assert.equal(fit.check(NO_ROW_CHANGED), true, 'the moved arrow widened the table: squeezed');
  assert.equal(reads.length, 1, 'measured with the new header');
  reads.length = 0;
  assert.equal(fit.check(NO_ROW_CHANGED), false, 'a same-data repaint after the sort keeps the class');
  assert.deepEqual(reads, [], 'without measuring');
  assert.equal(table.classList.contains(SQUEEZED_CLASS), true);
  const headless = stubTable({ natural: 420 });
  headless.table.querySelector = () => null;
  const fit2 = watchNodesTableFit(headless.table, { column: stubColumn(343), windowRef: win });
  fit2.check(NO_ROW_CHANGED);
  headless.reads.length = 0;
  fit2.check(NO_ROW_CHANGED);
  assert.deepEqual(headless.reads, [], 'a table without a header skips on rows and width alone');
});

test('a column resize re-checks once in the next animation frame, and a height-only change not at all (PO1)', () => {
  const { win, observers, queue, flushFrames } = stubWindow();
  const { table, widths } = stubTable({ natural: 420 });
  const column = stubColumn(343);
  watchNodesTableFit(table, { column, windowRef: win });
  const [observer] = observers;
  assert.deepEqual(observer.targets, [column], 'the table\'s own column is observed');
  observer.callback(resized(343));
  observer.callback(resized(343.5));
  assert.equal(queue.size, 1, 'one frame for two notifications');
  assert.equal(table.classList.contains(SQUEEZED_CLASS), false, 'nothing decided before the frame');
  assert.equal(flushFrames(), 1);
  assert.equal(table.classList.contains(SQUEEZED_CLASS), true);
  observer.callback(resized(343.5, 900));
  assert.equal(queue.size, 0, 'rows that re-wrap change only the height: no check');
  widths.natural = 300;
  observer.callback(resized(600));
  flushFrames();
  assert.equal(table.classList.contains(SQUEEZED_CLASS), false, 'a wider column fits the table again');
});

test('without a ResizeObserver window resizes re-check once per frame, and disconnect stops them (PO1)', () => {
  const { win, listeners, queue, flushFrames } = stubWindow({ resizeObserver: false });
  const { table } = stubTable({ natural: 420 });
  const fit = watchNodesTableFit(table, { column: stubColumn(343), windowRef: win });
  const onResize = listeners.get('resize');
  onResize();
  onResize();
  assert.equal(queue.size, 1);
  flushFrames();
  assert.equal(table.classList.contains(SQUEEZED_CLASS), true);
  onResize();
  fit.disconnect();
  assert.equal(queue.size, 0, 'the pending frame is cancelled');
  assert.equal(listeners.has('resize'), false, 'the listener is removed');
});

test('disconnect stops the observer, and without animation frames a resize checks at once (PO1)', () => {
  const observed = stubWindow();
  const fit = watchNodesTableFit(stubTable().table, { column: stubColumn(343), windowRef: observed.win });
  fit.disconnect();
  assert.equal(observed.observers[0].disconnected, true);
  const frameless = stubWindow({ frames: false, cancel: false });
  const { table } = stubTable({ natural: 420 });
  const fit2 = watchNodesTableFit(table, { column: stubColumn(343), windowRef: frameless.win });
  frameless.observers[0].callback(resized(343));
  assert.equal(table.classList.contains(SQUEEZED_CLASS), true, 'checked without waiting for a frame');
  assert.doesNotThrow(() => fit2.disconnect());
});

test('a frame left pending after disconnect, where the window cannot cancel it, decides nothing (PO1)', () => {
  const { win, observers, queue, flushFrames } = stubWindow({ cancel: false });
  const { table, calls } = stubTable({ natural: 420 });
  const fit = watchNodesTableFit(table, { column: stubColumn(343), windowRef: win });
  observers[0].callback(resized(343));
  fit.disconnect();
  assert.equal(queue.size, 1, 'nothing to cancel it with');
  flushFrames();
  assert.deepEqual(calls, [], 'a disconnected watcher no longer writes the class');
});

test('watchNodesTableFit defaults to the table\'s parent and the global window, and works without either API (PO1)', () => {
  const parent = stubColumn(343);
  const { table } = stubTable({ natural: 420 });
  table.parentElement = parent;
  const { win, observers } = stubWindow();
  const saved = globalThis.window;
  globalThis.window = win;
  try {
    watchNodesTableFit(table);
    assert.deepEqual(observers[0].targets, [parent], 'the parent element is the column');
  } finally {
    if (saved === undefined) delete globalThis.window;
    else globalThis.window = saved;
  }
  const viaNode = stubTable({ natural: 420 });
  viaNode.table.parentNode = parent;
  const fit = watchNodesTableFit(viaNode.table);
  assert.equal(fit.check(), true, 'a parent node serves when there is no parent element, and no window is needed');
  assert.doesNotThrow(() => fit.disconnect());
  const explicit = watchNodesTableFit(stubTable({ natural: 420 }).table, { column: parent, windowRef: null });
  assert.equal(explicit.check(), true);
  const listenerless = watchNodesTableFit(stubTable({ natural: 420 }).table, { column: parent, windowRef: {} });
  assert.equal(listenerless.check(), true, 'without observer or listener the render hook still decides');
  assert.doesNotThrow(() => listenerless.disconnect());
});
