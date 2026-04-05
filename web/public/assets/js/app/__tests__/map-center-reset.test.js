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

import { createMapCenterResetHandler, DEFAULT_CENTER_RESET_ZOOM } from '../map-center-reset.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock map object whose setView calls are recorded.
 *
 * @returns {{ setView: Function, calls: Array }} Mock map.
 */
function mockMap() {
  const obj = {
    calls: [],
    setView(target, zoom, options) {
      obj.calls.push({ type: 'setView', target, zoom, options });
    }
  };
  return obj;
}

/**
 * Build a minimal autoFitController stub.
 *
 * @param {{ bounds?: object | null }} [opts]
 * @returns {object}
 */
function mockController(opts = {}) {
  const lastFit = opts.bounds !== undefined ? opts.bounds : null;
  const runs = [];
  return {
    runCallCount: 0,
    runs,
    getLastFit() { return lastFit; },
    runAutoFitOperation(fn) {
      this.runCallCount += 1;
      runs.push(fn);
      fn();
    }
  };
}

const CENTER = { lat: 38.76, lon: -27.09 };

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

test('createMapCenterResetHandler throws when getMap is not a function', () => {
  assert.throws(() => {
    createMapCenterResetHandler({
      getMap: null,
      autoFitController: mockController(),
      fitMapToBounds: () => {},
      mapCenterCoords: CENTER,
    });
  }, /getMap/);
});

test('createMapCenterResetHandler throws when autoFitController is missing getLastFit', () => {
  assert.throws(() => {
    createMapCenterResetHandler({
      getMap: () => mockMap(),
      autoFitController: {},
      fitMapToBounds: () => {},
      mapCenterCoords: CENTER,
    });
  }, /autoFitController/);
});

test('createMapCenterResetHandler throws when fitMapToBounds is not a function', () => {
  assert.throws(() => {
    createMapCenterResetHandler({
      getMap: () => mockMap(),
      autoFitController: mockController(),
      fitMapToBounds: null,
      mapCenterCoords: CENTER,
    });
  }, /fitMapToBounds/);
});

test('createMapCenterResetHandler throws when mapCenterCoords is invalid', () => {
  assert.throws(() => {
    createMapCenterResetHandler({
      getMap: () => mockMap(),
      autoFitController: mockController(),
      fitMapToBounds: () => {},
      mapCenterCoords: { lat: NaN, lon: 0 },
    });
  }, /mapCenterCoords/);

  assert.throws(() => {
    createMapCenterResetHandler({
      getMap: () => mockMap(),
      autoFitController: mockController(),
      fitMapToBounds: () => {},
      mapCenterCoords: null,
    });
  }, /mapCenterCoords/);
});

// ---------------------------------------------------------------------------
// No-op when map is unavailable
// ---------------------------------------------------------------------------

test('handler returns without throwing when getMap returns null', () => {
  const fitCalls = [];
  const handler = createMapCenterResetHandler({
    getMap: () => null,
    autoFitController: mockController(),
    fitMapToBounds: (...args) => fitCalls.push(args),
    mapCenterCoords: CENTER,
  });
  assert.doesNotThrow(() => handler());
  assert.equal(fitCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Auto-fit checkbox re-enabling
// ---------------------------------------------------------------------------

test('handler enables fitBoundsEl when present and not disabled', () => {
  const dispatched = [];
  const fitBoundsEl = {
    checked: false,
    disabled: false,
    dispatchEvent(e) { dispatched.push(e.type); }
  };
  // Provide a lastFit so the fallback setView path does not run — this test
  // is only asserting the checkbox re-enable behaviour.
  const lastFit = { bounds: [[0, 0], [1, 1]], options: { paddingPx: 12 } };
  const controller = mockController({ bounds: lastFit });
  const handler = createMapCenterResetHandler({
    getMap: () => mockMap(),
    autoFitController: controller,
    fitBoundsEl,
    fitMapToBounds: () => {},
    mapCenterCoords: CENTER,
  });
  handler();
  assert.equal(fitBoundsEl.checked, true);
  assert.equal(controller.runCallCount, 1);
  assert.deepEqual(dispatched, ['change']);
});

test('handler dispatches a bubbling change event when re-enabling fitBoundsEl', () => {
  let capturedEvent = null;
  const fitBoundsEl = {
    checked: false,
    disabled: false,
    dispatchEvent(e) { capturedEvent = e; }
  };
  const handler = createMapCenterResetHandler({
    getMap: () => mockMap(),
    autoFitController: mockController(),
    fitBoundsEl,
    fitMapToBounds: () => {},
    mapCenterCoords: CENTER,
  });
  handler();
  assert.ok(capturedEvent, 'expected a change event to be dispatched');
  assert.equal(capturedEvent.type, 'change');
  assert.equal(capturedEvent.bubbles, true);
});

test('handler does not modify fitBoundsEl.checked when element is disabled', () => {
  const fitBoundsEl = { checked: false, disabled: true };
  // Provide a lastFit so the fallback setView path does not run — this test
  // is only asserting the checkbox non-modification when disabled.
  const lastFit = { bounds: [[0, 0], [1, 1]], options: { paddingPx: 12 } };
  const controller = mockController({ bounds: lastFit });
  const handler = createMapCenterResetHandler({
    getMap: () => mockMap(),
    autoFitController: controller,
    fitBoundsEl,
    fitMapToBounds: () => {},
    mapCenterCoords: CENTER,
  });
  handler();
  assert.equal(fitBoundsEl.checked, false);
  assert.equal(controller.runCallCount, 0);
});

test('handler does not throw when fitBoundsEl is null', () => {
  const handler = createMapCenterResetHandler({
    getMap: () => mockMap(),
    autoFitController: mockController(),
    fitBoundsEl: null,
    fitMapToBounds: () => {},
    mapCenterCoords: CENTER,
  });
  assert.doesNotThrow(() => handler());
});

test('handler does not throw when fitBoundsEl is omitted', () => {
  const handler = createMapCenterResetHandler({
    getMap: () => mockMap(),
    autoFitController: mockController(),
    fitMapToBounds: () => {},
    mapCenterCoords: CENTER,
  });
  assert.doesNotThrow(() => handler());
});

// ---------------------------------------------------------------------------
// Last-fit path
// ---------------------------------------------------------------------------

test('handler calls fitMapToBounds with last-fit bounds when available', () => {
  const fakeBounds = [[1, 2], [3, 4]];
  const lastFit = { bounds: fakeBounds, options: { paddingPx: 12, maxZoom: 13 } };
  const fitCalls = [];
  const map = mockMap();
  const handler = createMapCenterResetHandler({
    getMap: () => map,
    autoFitController: mockController({ bounds: lastFit }),
    fitMapToBounds: (bounds, opts) => fitCalls.push({ bounds, opts }),
    mapCenterCoords: CENTER,
  });
  handler();
  assert.equal(fitCalls.length, 1);
  assert.deepEqual(fitCalls[0].bounds, fakeBounds);
  assert.equal(fitCalls[0].opts.animate, true);
  assert.equal(fitCalls[0].opts.paddingPx, 12);
  assert.equal(fitCalls[0].opts.maxZoom, 13);
  // setView must NOT be called when last-fit path is taken
  assert.equal(map.calls.length, 0);
});

test('handler forwards paddingPx and maxZoom from last-fit options', () => {
  const lastFit = { bounds: [[0, 0], [1, 1]], options: { paddingPx: 8 } };
  const fitCalls = [];
  const handler = createMapCenterResetHandler({
    getMap: () => mockMap(),
    autoFitController: mockController({ bounds: lastFit }),
    fitMapToBounds: (b, o) => fitCalls.push(o),
    mapCenterCoords: CENTER,
  });
  handler();
  assert.equal(fitCalls[0].paddingPx, 8);
  assert.equal(fitCalls[0].maxZoom, undefined);
});

// ---------------------------------------------------------------------------
// Fallback path (no last fit recorded)
// ---------------------------------------------------------------------------

test('handler calls setView with configured centre when no last fit exists', () => {
  const map = mockMap();
  const controller = mockController({ bounds: null });
  const handler = createMapCenterResetHandler({
    getMap: () => map,
    autoFitController: controller,
    fitMapToBounds: () => {},
    mapCenterCoords: CENTER,
    mapZoomOverride: null,
  });
  handler();
  assert.equal(map.calls.length, 1);
  assert.deepEqual(map.calls[0].target, [CENTER.lat, CENTER.lon]);
  assert.equal(map.calls[0].zoom, DEFAULT_CENTER_RESET_ZOOM);
  assert.deepEqual(map.calls[0].options, { animate: true });
});

test('fallback setView is wrapped in runAutoFitOperation to prevent movestart/zoomstart unchecking auto-fit', () => {
  // Without the wrapper, the programmatic setView triggers movestart which calls
  // handleUserInteraction, undoing the auto-fit re-enable. runAutoFitOperation
  // sets autoFitInProgress=true so handleUserInteraction returns early.
  const map = mockMap();
  const controller = mockController({ bounds: null });
  const handler = createMapCenterResetHandler({
    getMap: () => map,
    autoFitController: controller,
    fitMapToBounds: () => {},
    mapCenterCoords: CENTER,
  });
  handler();
  // runAutoFitOperation must have been called at least once for the setView fallback
  assert.ok(controller.runCallCount >= 1, 'expected runAutoFitOperation to be called');
  assert.equal(map.calls.length, 1);
});

test('fallback uses mapZoomOverride when provided', () => {
  const map = mockMap();
  const handler = createMapCenterResetHandler({
    getMap: () => map,
    autoFitController: mockController({ bounds: null }),
    fitMapToBounds: () => {},
    mapCenterCoords: CENTER,
    mapZoomOverride: 15,
  });
  handler();
  assert.equal(map.calls[0].zoom, 15);
});

test('fallback uses DEFAULT_CENTER_RESET_ZOOM when mapZoomOverride is null', () => {
  const map = mockMap();
  const handler = createMapCenterResetHandler({
    getMap: () => map,
    autoFitController: mockController({ bounds: null }),
    fitMapToBounds: () => {},
    mapCenterCoords: CENTER,
    mapZoomOverride: null,
  });
  handler();
  assert.equal(map.calls[0].zoom, DEFAULT_CENTER_RESET_ZOOM);
});

test('fallback uses DEFAULT_CENTER_RESET_ZOOM when mapZoomOverride is zero', () => {
  const map = mockMap();
  const handler = createMapCenterResetHandler({
    getMap: () => map,
    autoFitController: mockController({ bounds: null }),
    fitMapToBounds: () => {},
    mapCenterCoords: CENTER,
    mapZoomOverride: 0,
  });
  handler();
  assert.equal(map.calls[0].zoom, DEFAULT_CENTER_RESET_ZOOM);
});

// ---------------------------------------------------------------------------
// Mutual exclusivity
// ---------------------------------------------------------------------------

test('fitMapToBounds and setView are mutually exclusive per invocation (last fit wins)', () => {
  const fitCalls = [];
  const map = mockMap();
  const lastFit = { bounds: [[0, 0], [1, 1]], options: { paddingPx: 12 } };
  const handler = createMapCenterResetHandler({
    getMap: () => map,
    autoFitController: mockController({ bounds: lastFit }),
    fitMapToBounds: (...args) => fitCalls.push(args),
    mapCenterCoords: CENTER,
  });
  handler();
  assert.equal(fitCalls.length, 1);
  assert.equal(map.calls.length, 0);
});

test('fitMapToBounds and setView are mutually exclusive per invocation (fallback wins)', () => {
  const fitCalls = [];
  const map = mockMap();
  const handler = createMapCenterResetHandler({
    getMap: () => map,
    autoFitController: mockController({ bounds: null }),
    fitMapToBounds: (...args) => fitCalls.push(args),
    mapCenterCoords: CENTER,
  });
  handler();
  assert.equal(fitCalls.length, 0);
  assert.equal(map.calls.length, 1);
});

// ---------------------------------------------------------------------------
// DEFAULT_CENTER_RESET_ZOOM export
// ---------------------------------------------------------------------------

test('DEFAULT_CENTER_RESET_ZOOM is a positive finite number', () => {
  assert.ok(Number.isFinite(DEFAULT_CENTER_RESET_ZOOM));
  assert.ok(DEFAULT_CENTER_RESET_ZOOM > 0);
});
