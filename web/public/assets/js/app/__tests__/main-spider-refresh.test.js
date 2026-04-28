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

/**
 * Build a stub Leaflet map that reports a configurable zoom level.  The
 * other Leaflet-projection methods are kept identical to ``makeStubMap`` so
 * the helper composes with existing harness shapes that exercise both
 * ``getZoom`` and the projection.
 *
 * @param {number} zoom Zoom level to report from ``getZoom()``.
 * @returns {Object} Stub map.
 */
function makeStubMapAtZoom(zoom) {
  const base = makeStubMap();
  base.getZoom = () => zoom;
  return base;
}

/**
 * Replace ``globalThis.fetch`` with a stub that returns a never-resolving
 * promise.  Several tests below indirectly invoke ``applyFilter`` (via the
 * threshold-cross handler or the hub click), which kicks off
 * ``fetchActiveNodeStats``; without a stub the real ``fetch`` would try to
 * reach ``/api/nodes`` and the rejection (or even a successful response)
 * would trip ``.then(...)`` callbacks that touch DOM elements after the
 * harness has already cleaned them up, producing an ``unhandledRejection``
 * after the test ended.  Pinning the response to ``new Promise(() => {})``
 * means the chain never advances past the await, keeping the assertions
 * synchronous.  Returns a restore function the caller invokes from a
 * ``finally`` block.
 *
 * @returns {function(): void} Restore handle.
 */
function stubFetchForApplyFilter() {
  const previous = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});
  return () => {
    globalThis.fetch = previous;
  };
}

test('currentZoomBucket returns "low" below the threshold and "high" at/above', () => {
  withApp((t) => {
    // No map injected → defensive default keeps the feature visible so the
    // test harness behaves identically to today's no-Leaflet path.
    assert.equal(t._currentZoomBucketForTests(), 'high');

    t._setMapForTests(makeStubMapAtZoom(12));
    assert.equal(t._currentZoomBucketForTests(), 'low');

    t._setMapForTests(makeStubMapAtZoom(13));
    assert.equal(t._currentZoomBucketForTests(), 'high');

    t._setMapForTests(makeStubMapAtZoom(18));
    assert.equal(t._currentZoomBucketForTests(), 'high');

    // Non-finite zoom (e.g. before the projection is ready) must not flip
    // the user into the low-zoom branch — fall back to 'high' so the
    // current rendering remains usable.
    t._setMapForTests(makeStubMapAtZoom(Number.NaN));
    assert.equal(t._currentZoomBucketForTests(), 'high');

    // Map without a getZoom method (e.g. a stub used purely for projection
    // round-trips) is also treated as 'high' rather than throwing.
    t._setMapForTests({});
    assert.equal(t._currentZoomBucketForTests(), 'high');

    t._setMapForTests(null);
  });
});

test('handleZoomEndForColocatedHubs clears expanded keys when crossing the threshold', () => {
  const restoreFetch = stubFetchForApplyFilter();
  try {
    withApp((t) => {
      // Pre-stage state as if the previous render was at high zoom with one
      // group expanded; a zoomend that drops us below the threshold should
      // erase that state.
      t._setLastRenderedZoomBucketForTests('high');
      const seeded = new Set(['10.00000,20.00000']);
      t._setExpandedColocatedKeysForTests(seeded);
      t._setMapForTests(makeStubMapAtZoom(12));

      t.handleZoomEndForColocatedHubs();

      assert.equal(t._getExpandedColocatedKeysForTests().size, 0);
      t._setMapForTests(null);
    });
  } finally {
    restoreFetch();
  }
});

test('handleZoomEndForColocatedHubs leaves expanded keys alone when bucket is unchanged', () => {
  withApp((t) => {
    // Same bucket as the last render → no clear, no applyFilter side effect.
    t._setLastRenderedZoomBucketForTests('high');
    const seeded = new Set(['1.00000,2.00000']);
    t._setExpandedColocatedKeysForTests(seeded);
    t._setMapForTests(makeStubMapAtZoom(15));

    t.handleZoomEndForColocatedHubs();

    assert.equal(t._getExpandedColocatedKeysForTests(), seeded);
    assert.ok(seeded.has('1.00000,2.00000'));
    t._setMapForTests(null);
  });
});

test('handleZoomEndForColocatedHubs handles zooming back up through the threshold', () => {
  const restoreFetch = stubFetchForApplyFilter();
  try {
    withApp((t) => {
      // Previous render was low; zoom back up to high → expanded keys are
      // (already) empty per the prior crossing, but the bucket flip must
      // still register so subsequent clicks behave correctly.
      t._setLastRenderedZoomBucketForTests('low');
      t._setExpandedColocatedKeysForTests(new Set());
      t._setMapForTests(makeStubMapAtZoom(14));

      assert.doesNotThrow(() => t.handleZoomEndForColocatedHubs());
      t._setMapForTests(null);
    });
  } finally {
    restoreFetch();
  }
});

test('createColocatedHubMarker emits "*<count>" html and toggles expansion on click', () => {
  const restoreFetch = stubFetchForApplyFilter();
  try {
  withApp((t) => {
    const previousL = globalThis.L;
    const created = [];
    let lastClickHandler = null;
    globalThis.L = {
      divIcon(opts) {
        return { _kind: 'divIcon', options: opts };
      },
      marker(latLng, opts) {
        const marker = {
          latLng,
          options: opts,
          _addedTo: null,
          on(event, handler) {
            if (event === 'click') lastClickHandler = handler;
            return marker;
          },
          addTo(layer) {
            marker._addedTo = layer;
            layer._children.push(marker);
            return marker;
          }
        };
        created.push(marker);
        return marker;
      }
    };
    const stubLayer = { _children: [] };
    t._setColocatedHubsLayerForTests(stubLayer);
    try {
      const result = t.createColocatedHubMarker('5.12345,6.54321', 4, 5.12345, 6.54321);
      assert.equal(created.length, 1);
      assert.equal(result, created[0]);
      assert.deepEqual(result.latLng, [5.12345, 6.54321]);
      // The divIcon receives the asterisk + count html and the spider hub
      // class so the CSS rules in base.css can style it as a clickable badge.
      const iconOptions = result.options.icon.options;
      assert.equal(iconOptions.className, 'colocated-spider-hub');
      assert.ok(/\*4</.test(iconOptions.html), `html ${iconOptions.html} should contain *4`);
      assert.deepEqual(iconOptions.iconSize, [16, 16]);
      assert.deepEqual(iconOptions.iconAnchor, [8, 8]);
      // Marker was added to the injected hub layer rather than the global
      // markers layer; this keeps hub badges in their own clearable group.
      assert.equal(result._addedTo, stubLayer);
      assert.equal(stubLayer._children.length, 1);

      // Click → expandedColocatedKeys flips, originalEvent.stopPropagation runs.
      let stopPropagationCalls = 0;
      assert.ok(lastClickHandler);
      lastClickHandler({
        originalEvent: { stopPropagation() { stopPropagationCalls += 1; } }
      });
      assert.equal(stopPropagationCalls, 1);
      assert.ok(t._getExpandedColocatedKeysForTests().has('5.12345,6.54321'));
      // Second click toggles back off.
      lastClickHandler({
        originalEvent: { stopPropagation() { stopPropagationCalls += 1; } }
      });
      assert.equal(stopPropagationCalls, 2);
      assert.equal(t._getExpandedColocatedKeysForTests().has('5.12345,6.54321'), false);

      // A click without an originalEvent (or without stopPropagation) must
      // still toggle without throwing — covers the defensive guard branch.
      assert.doesNotThrow(() => lastClickHandler(undefined));
      assert.ok(t._getExpandedColocatedKeysForTests().has('5.12345,6.54321'));
      assert.doesNotThrow(() => lastClickHandler({ originalEvent: {} }));
    } finally {
      t._setColocatedHubsLayerForTests(null);
      t._setExpandedColocatedKeysForTests(new Set());
      globalThis.L = previousL;
    }
  });
  } finally {
    restoreFetch();
  }
});

test('_setExpandedColocatedKeysForTests round-trips and rejects non-Set input', () => {
  withApp((t) => {
    // Initial state from init: empty Set.
    const initial = t._setExpandedColocatedKeysForTests(new Set(['a']));
    assert.ok(initial instanceof Set);
    assert.equal(initial.size, 0);
    const live = t._getExpandedColocatedKeysForTests();
    assert.ok(live.has('a'));
    // Non-Set input replaces the live set with a fresh empty Set, returning
    // the previous (now-stale) reference for the test to inspect.
    const previous = t._setExpandedColocatedKeysForTests('not-a-set');
    assert.equal(previous.size, 1);
    assert.equal(t._getExpandedColocatedKeysForTests().size, 0);
  });
});

test('_setColocatedHubsLayerForTests round-trips the hub layer reference', () => {
  withApp((t) => {
    const initial = t._setColocatedHubsLayerForTests('layer-a');
    // Initial value is null because the harness never instantiates Leaflet.
    assert.equal(initial, null);
    assert.equal(t._getColocatedHubsLayerForTests(), 'layer-a');
    const previous = t._setColocatedHubsLayerForTests(null);
    assert.equal(previous, 'layer-a');
    assert.equal(t._getColocatedHubsLayerForTests(), null);
  });
});

test('_setLastRenderedZoomBucketForTests round-trips the bucket marker', () => {
  withApp((t) => {
    const initial = t._setLastRenderedZoomBucketForTests('high');
    // Initial value is null because no render has yet captured a bucket.
    assert.equal(initial, null);
    assert.equal(t._getLastRenderedZoomBucketForTests(), 'high');
    const previous = t._setLastRenderedZoomBucketForTests('low');
    assert.equal(previous, 'high');
    assert.equal(t._getLastRenderedZoomBucketForTests(), 'low');
  });
});
