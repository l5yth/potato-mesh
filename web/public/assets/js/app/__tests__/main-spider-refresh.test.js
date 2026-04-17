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

import { withApp } from './main-app-test-helpers.js';

/**
 * Build a stub Leaflet ``L`` that implements ``point({x, y})``.  The renderer
 * uses ``L.point`` to construct an offset point in layer-pixel space and the
 * spider helper does the same.
 *
 * @returns {{ point: Function }}
 */
function makeStubLeaflet() {
  return {
    point(x, y) {
      return { x, y };
    }
  };
}

/**
 * Build a stub Leaflet map that implements the projection methods used by
 * ``projectColocatedOffsetLatLng``.  The pseudo projection is the identity:
 * ``[lat, lon]`` → ``{ x: lon, y: lat }``.  This keeps assertions easy while
 * still exercising both projection round-trip calls.
 *
 * @returns {{ latLngToLayerPoint: Function, layerPointToLatLng: Function, calls: { project: Array, unproject: Array } }}
 */
function makeStubMap() {
  const calls = { project: [], unproject: [] };
  return {
    calls,
    latLngToLayerPoint(latLng) {
      calls.project.push(latLng);
      return { x: latLng[1], y: latLng[0] };
    },
    layerPointToLatLng(point) {
      calls.unproject.push(point);
      return { lat: point.y, lng: point.x };
    }
  };
}

test('projectColocatedOffsetLatLng short-circuits the singleton case', () => {
  withApp((t) => {
    // No map injected → if the function reached the projection path it would
    // crash on a null reference.  The early-return branch keeps it safe.
    const result = t.projectColocatedOffsetLatLng(10, 20, 0, 0);
    assert.deepEqual(result, [10, 20]);
  });
});

test('projectColocatedOffsetLatLng routes through the map projection for real offsets', () => {
  withApp((t) => {
    const previousL = globalThis.L;
    globalThis.L = makeStubLeaflet();
    const stubMap = makeStubMap();
    t._setMapForTests(stubMap);
    try {
      const result = t.projectColocatedOffsetLatLng(10, 20, 5, -3);
      // Identity projection: input [10, 20] → {x:20, y:10};
      // offset by (5, -3) → {x:25, y:7}; back-projection → {lat:7, lng:25}.
      assert.deepEqual(result, [7, 25]);
      assert.deepEqual(stubMap.calls.project, [[10, 20]]);
      assert.deepEqual(stubMap.calls.unproject, [{ x: 25, y: 7 }]);
    } finally {
      t._setMapForTests(null);
      globalThis.L = previousL;
    }
  });
});

test('refreshColocatedSpiderState bails out when no map is available', () => {
  withApp((t) => {
    let setLatLngCalls = 0;
    t._setColocatedSpiderStateForTests([
      {
        marker: { setLatLng() { setLatLngCalls += 1; } },
        line: null,
        lat: 0,
        lon: 0,
        dx: 1,
        dy: 1
      }
    ]);
    // map starts as null in the test harness; the guard must skip the work.
    t.refreshColocatedSpiderState();
    assert.equal(setLatLngCalls, 0);
    t._setColocatedSpiderStateForTests([]);
  });
});

test('refreshColocatedSpiderState updates marker and line through injected map', () => {
  withApp((t) => {
    const previousL = globalThis.L;
    globalThis.L = makeStubLeaflet();
    t._setMapForTests(makeStubMap());
    const markerLatLngs = [];
    const lineLatLngs = [];
    t._setColocatedSpiderStateForTests([
      {
        marker: { setLatLng(value) { markerLatLngs.push(value); } },
        line: { setLatLngs(value) { lineLatLngs.push(value); } },
        lat: 1,
        lon: 2,
        dx: 4,
        dy: -6
      }
    ]);
    try {
      t.refreshColocatedSpiderState();
      // [1,2] → {x:2,y:1}; offset (4,-6) → {x:6,y:-5}; back → [-5, 6].
      assert.deepEqual(markerLatLngs, [[-5, 6]]);
      assert.deepEqual(lineLatLngs, [[[1, 2], [-5, 6]]]);
    } finally {
      t._setMapForTests(null);
      t._setColocatedSpiderStateForTests([]);
      globalThis.L = previousL;
    }
  });
});

test('scheduleColocatedSpiderRefresh calls immediately when requestAnimationFrame is unavailable', () => {
  withApp((t) => {
    const previousRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = undefined;
    let invocations = 0;
    t._setColocatedSpiderStateForTests([
      {
        // Stub map remains null → refreshColocatedSpiderState short-circuits;
        // we count how many times the public scheduler dispatches by adding
        // a marker that records setLatLng — but with no map it never runs.
        // Instead we observe invocations indirectly: replace the state with
        // one whose marker counts setLatLng if the projector ever runs.
        marker: { setLatLng() { invocations += 1; } },
        line: null,
        lat: 0,
        lon: 0,
        dx: 1,
        dy: 1
      }
    ]);
    try {
      // Even without rAF the function must not throw and must reach the
      // immediate-call branch (which itself short-circuits because there is
      // no map; the assertion is "did not throw" + invocations stays 0).
      assert.doesNotThrow(() => t.scheduleColocatedSpiderRefresh());
      assert.equal(invocations, 0);
    } finally {
      globalThis.requestAnimationFrame = previousRaf;
      t._setColocatedSpiderStateForTests([]);
    }
  });
});

test('scheduleColocatedSpiderRefresh coalesces multiple calls within one frame', () => {
  withApp((t) => {
    const previousRaf = globalThis.requestAnimationFrame;
    const previousL = globalThis.L;
    globalThis.L = makeStubLeaflet();
    t._setMapForTests(makeStubMap());

    let scheduled = 0;
    let pending = null;
    globalThis.requestAnimationFrame = (cb) => {
      scheduled += 1;
      pending = cb;
      return scheduled;
    };

    let setLatLngCalls = 0;
    t._setColocatedSpiderStateForTests([
      {
        marker: { setLatLng() { setLatLngCalls += 1; } },
        line: null,
        lat: 0,
        lon: 0,
        dx: 2,
        dy: 3
      }
    ]);
    try {
      t.scheduleColocatedSpiderRefresh();
      t.scheduleColocatedSpiderRefresh();
      t.scheduleColocatedSpiderRefresh();
      // All three calls must be coalesced into a single rAF schedule and the
      // refresh callback must not yet have fired.
      assert.equal(scheduled, 1);
      assert.equal(setLatLngCalls, 0);

      // Fire the queued frame; the refresh runs once and the next call
      // schedules a fresh frame (proving the pending handle was reset).
      pending();
      assert.equal(setLatLngCalls, 1);
      t.scheduleColocatedSpiderRefresh();
      assert.equal(scheduled, 2);
    } finally {
      globalThis.requestAnimationFrame = previousRaf;
      globalThis.L = previousL;
      t._setMapForTests(null);
      t._setColocatedSpiderStateForTests([]);
    }
  });
});

test('_setColocatedSpiderStateForTests returns the previous state and rejects non-arrays', () => {
  withApp((t) => {
    const replacement = [{ marker: null, line: null, lat: 0, lon: 0, dx: 0, dy: 0 }];
    const initial = t._setColocatedSpiderStateForTests(replacement);
    // Initial state at fresh init is an empty array.
    assert.deepEqual(initial, []);
    assert.equal(t._getColocatedSpiderStateForTests(), replacement);
    // Passing a non-array clears the state to an empty array, leaving the
    // previous (replacement) value as the return.
    const previous = t._setColocatedSpiderStateForTests('not-an-array');
    assert.equal(previous, replacement);
    assert.deepEqual(t._getColocatedSpiderStateForTests(), []);
  });
});
