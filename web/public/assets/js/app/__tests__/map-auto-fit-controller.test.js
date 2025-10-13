/**
 * Copyright (C) 2025 l5yth
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

import { createMapAutoFitController } from '../map-auto-fit-controller.js';

class ToggleStub extends EventTarget {
  constructor(checked = true) {
    super();
    this.checked = checked;
  }

  /**
   * @param {Event} event - Event to dispatch to listeners.
   * @returns {boolean} Dispatch status.
   */
  dispatchEvent(event) {
    return super.dispatchEvent(event);
  }
}

class WindowStub {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type, listener) {
    const existing = this.listeners.get(type);
    if (existing === listener) {
      this.listeners.delete(type);
    }
  }

  emit(type) {
    const listener = this.listeners.get(type);
    if (listener) listener();
  }
}

test('recordFit stores and clones the last fit snapshot', () => {
  const toggle = new ToggleStub(true);
  const controller = createMapAutoFitController({ toggleEl: toggle, defaultPaddingPx: 20 });

  assert.equal(controller.getLastFit(), null);

  controller.recordFit([[10, 20], [30, 40]], { paddingPx: 12, maxZoom: 9 });
  const snapshot = controller.getLastFit();
  assert.ok(snapshot);
  assert.deepEqual(snapshot.bounds, [[10, 20], [30, 40]]);
  assert.deepEqual(snapshot.options, { paddingPx: 12, maxZoom: 9 });

  snapshot.bounds[0][0] = -999;
  snapshot.options.paddingPx = -1;
  const secondSnapshot = controller.getLastFit();
  assert.deepEqual(secondSnapshot?.bounds, [[10, 20], [30, 40]]);
  assert.deepEqual(secondSnapshot?.options, { paddingPx: 12, maxZoom: 9 });
});


test('recordFit ignores invalid bounds and normalises fit options', () => {
  const controller = createMapAutoFitController({ defaultPaddingPx: 16 });

  controller.recordFit(null);
  assert.equal(controller.getLastFit(), null);

  controller.recordFit([[10, Number.NaN], [20, 30]]);
  assert.equal(controller.getLastFit(), null);

  controller.recordFit([[10, 11], [12, 13]], { paddingPx: -5, maxZoom: 0 });
  const snapshot = controller.getLastFit();
  assert.ok(snapshot);
  assert.deepEqual(snapshot.options, { paddingPx: 16 });
});


test('handleUserInteraction disables auto-fit unless suppressed', () => {
  const toggle = new ToggleStub(true);
  let changeEvents = 0;
  toggle.addEventListener('change', () => {
    changeEvents += 1;
  });
  const controller = createMapAutoFitController({ toggleEl: toggle });

  controller.runAutoFitOperation(() => {
    assert.equal(controller.handleUserInteraction(), false);
    assert.equal(toggle.checked, true);
  });
  assert.equal(changeEvents, 0);

  assert.equal(controller.handleUserInteraction(), true);
  assert.equal(toggle.checked, false);
  assert.equal(changeEvents, 1);

  assert.equal(controller.handleUserInteraction(), false);
  assert.equal(changeEvents, 1);
});


test('isAutoFitEnabled reflects the toggle state', () => {
  const toggle = new ToggleStub(false);
  const controller = createMapAutoFitController({ toggleEl: toggle });
  assert.equal(controller.isAutoFitEnabled(), false);
  toggle.checked = true;
  assert.equal(controller.isAutoFitEnabled(), true);
});


test('runAutoFitOperation returns callback results and tolerates missing functions', () => {
  const controller = createMapAutoFitController();
  assert.equal(controller.runAutoFitOperation(), undefined);
  let active = false;
  const result = controller.runAutoFitOperation(() => {
    active = true;
    return 42;
  });
  assert.equal(active, true);
  assert.equal(result, 42);
});


test('attachResizeListener forwards snapshots and supports teardown', () => {
  const windowStub = new WindowStub();
  const controller = createMapAutoFitController({ windowObject: windowStub, defaultPaddingPx: 24 });
  controller.recordFit([[1, 2], [3, 4]], { paddingPx: 30 });

  let snapshots = [];
  const detach = controller.attachResizeListener(snapshot => {
    snapshots.push(snapshot);
  });

  windowStub.emit('resize');
  windowStub.emit('orientationchange');
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots[0], { bounds: [[1, 2], [3, 4]], options: { paddingPx: 30 } });

  detach();
  windowStub.emit('resize');
  assert.equal(snapshots.length, 2);

  const noop = controller.attachResizeListener();
  assert.equal(typeof noop, 'function');
  noop();
});
