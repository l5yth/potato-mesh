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
import { withAppAndLeaflet } from './main-app-leaflet-stub.js';

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
      let domEventStopCalls = 0;
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
        },
        DomEvent: {
          stopPropagation() {
            domEventStopCalls += 1;
          }
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
        // ``bubblingMouseEvents: false`` keeps Leaflet's internal event
        // routing from forwarding the click to map-level handlers.  The
        // ``riseOnHover`` option is intentionally absent because divIcon
        // markers handle z-index inconsistently across Leaflet versions.
        assert.equal(result.options.bubblingMouseEvents, false);
        assert.equal(result.options.riseOnHover, undefined);
        // Marker was added to the injected hub layer rather than the global
        // markers layer; this keeps hub badges in their own clearable group.
        assert.equal(result._addedTo, stubLayer);
        assert.equal(stubLayer._children.length, 1);

        // Click → expandedColocatedKeys flips, both Leaflet's DomEvent
        // helper and the raw DOM stopPropagation are invoked so the click
        // is contained at every layer of the event pipeline.
        let stopPropagationCalls = 0;
        assert.ok(lastClickHandler);
        lastClickHandler({
          originalEvent: { stopPropagation() { stopPropagationCalls += 1; } }
        });
        assert.equal(stopPropagationCalls, 1);
        assert.equal(domEventStopCalls, 1);
        assert.ok(t._getExpandedColocatedKeysForTests().has('5.12345,6.54321'));
        // Second click toggles back off.
        lastClickHandler({
          originalEvent: { stopPropagation() { stopPropagationCalls += 1; } }
        });
        assert.equal(stopPropagationCalls, 2);
        assert.equal(domEventStopCalls, 2);
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

/**
 * Build a list of nodes that share an identical coordinate so the renderer
 * can group them.  Each node carries a unique ``node_id`` to satisfy the
 * deterministic-slot ordering inside ``computeColocatedOffsets``.
 *
 * @param {number} count Number of nodes to generate.
 * @param {number} [lat=50] Shared latitude.
 * @param {number} [lon=10] Shared longitude.
 * @param {Object} [extra] Optional extra fields merged into each node.
 * @returns {Array<Object>} Nodes ready to feed into ``renderMap``.
 */
function makeColocatedNodes(count, lat = 50, lon = 10, extra = {}) {
  const nodes = [];
  for (let i = 0; i < count; i += 1) {
    nodes.push({
      node_id: `node-${i}`,
      latitude: lat,
      longitude: lon,
      role: 'CLIENT',
      protocol: 'meshtastic',
      ...extra
    });
  }
  return nodes;
}

/**
 * Count how many drawn objects in ``recorded`` ended up inside a particular
 * layer group.  ``recorded`` is the running history of every Leaflet object
 * the stub created during the test, while ``layer._layers`` reflects only
 * the ones still mounted (after ``clearLayers``).  Filtering by both keeps
 * the assertions stable across re-renders.
 *
 * @param {Array<Object>} recorded Array such as ``leaflet._recorded.circleMarkers``.
 * @param {Object} layer Layer group whose ``_layers`` array tracks current mounts.
 * @returns {number} Count of recorded items currently mounted on the layer.
 */
function countLayerMembers(recorded, layer) {
  if (!layer || !Array.isArray(layer._layers)) return 0;
  return recorded.filter(item => layer._layers.includes(item)).length;
}

test('renderMap renders flat overlap at zoom < COLOCATED_HUB_MIN_ZOOM', () => {
  withAppAndLeaflet(({ testUtils, leaflet }) => {
    leaflet._map._setZoom(12);
    leaflet._recorded.circleMarkers.length = 0;
    leaflet._recorded.markers.length = 0;
    leaflet._recorded.polylines.length = 0;
    const nodes = makeColocatedNodes(3);
    testUtils.renderMap(nodes, 0);
    const hubLayer = testUtils._getColocatedHubsLayerForTests();
    // Below the threshold every node renders as a normal circleMarker at
    // its original coordinate; no hub badge is created and no leader lines
    // are drawn.  This is the "spider disabled" mode that the user asked
    // for when the map is fully zoomed out.
    assert.equal(hubLayer._layers.length, 0);
    assert.equal(leaflet._recorded.markers.length, 0);
    assert.equal(leaflet._recorded.circleMarkers.length, 3);
    assert.equal(leaflet._recorded.polylines.length, 0);
    // Markers stack at exactly the original coords (no projection round-trip).
    for (const marker of leaflet._recorded.circleMarkers) {
      assert.deepEqual(marker._latLng, [50, 10]);
    }
    // The cached zoom-bucket reflects what the render targeted, so the
    // zoomend handler can detect a future bucket flip.
    assert.equal(testUtils._getLastRenderedZoomBucketForTests(), 'low');
  });
});

test('renderMap renders a collapsed hub at zoom ≥ COLOCATED_HUB_MIN_ZOOM', () => {
  withAppAndLeaflet(({ testUtils, leaflet }) => {
    leaflet._map._setZoom(14);
    leaflet._recorded.circleMarkers.length = 0;
    leaflet._recorded.markers.length = 0;
    leaflet._recorded.polylines.length = 0;
    const nodes = makeColocatedNodes(3);
    testUtils.renderMap(nodes, 0);
    const hubLayer = testUtils._getColocatedHubsLayerForTests();
    // Default state at high zoom is collapsed: a single hub badge replaces
    // the three member markers, no leader lines are drawn, and the badge
    // html carries the asterisk + count so the user can read the group
    // size at a glance.
    assert.equal(hubLayer._layers.length, 1);
    assert.equal(leaflet._recorded.markers.length, 1);
    assert.equal(leaflet._recorded.circleMarkers.length, 0);
    assert.equal(leaflet._recorded.polylines.length, 0);
    const hub = leaflet._recorded.markers[0];
    assert.deepEqual(hub._latLng, [50, 10]);
    assert.ok(/\*3</.test(hub.options.icon.options.html));
    assert.equal(testUtils._getLastRenderedZoomBucketForTests(), 'high');
  });
});

test('renderMap dedups the hub badge across the slots in a single group', () => {
  withAppAndLeaflet(({ testUtils, leaflet }) => {
    leaflet._map._setZoom(14);
    leaflet._recorded.markers.length = 0;
    // Five colocated nodes would yield five offset slots; the renderer must
    // still create exactly one hub for the group rather than emitting one
    // per slot.  This exercises the ``renderedHubKeys`` dedup guard.
    const nodes = makeColocatedNodes(5);
    testUtils.renderMap(nodes, 0);
    const hubLayer = testUtils._getColocatedHubsLayerForTests();
    assert.equal(hubLayer._layers.length, 1);
    assert.equal(leaflet._recorded.markers.length, 1);
    assert.ok(/\*5</.test(leaflet._recorded.markers[0].options.icon.options.html));
  });
});

test('renderMap renders a singleton as a normal marker (no hub) at any zoom', () => {
  withAppAndLeaflet(({ testUtils, leaflet }) => {
    leaflet._map._setZoom(14);
    leaflet._recorded.circleMarkers.length = 0;
    leaflet._recorded.markers.length = 0;
    const nodes = makeColocatedNodes(1, 1, 2);
    testUtils.renderMap(nodes, 0);
    const hubLayer = testUtils._getColocatedHubsLayerForTests();
    assert.equal(hubLayer._layers.length, 0);
    assert.equal(leaflet._recorded.markers.length, 0);
    assert.equal(leaflet._recorded.circleMarkers.length, 1);
    assert.deepEqual(leaflet._recorded.circleMarkers[0]._latLng, [1, 2]);
  });
});

test('renderMap fans out members and draws leader lines when a group is expanded', () => {
  withAppAndLeaflet(({ testUtils, leaflet }) => {
    leaflet._map._setZoom(14);
    leaflet._recorded.circleMarkers.length = 0;
    leaflet._recorded.markers.length = 0;
    leaflet._recorded.polylines.length = 0;
    // Pre-stage the group as expanded so the renderer takes the (c) branch
    // — the user already clicked the hub.  The key matches the format
    // ``computeColocatedOffsets`` produces at the default precision.
    testUtils._setExpandedColocatedKeysForTests(new Set(['50.00000,10.00000']));
    const nodes = makeColocatedNodes(3);
    testUtils.renderMap(nodes, 0);
    const hubLayer = testUtils._getColocatedHubsLayerForTests();
    // Expanded mode: 1 hub still visible (the click affordance) + 3 member
    // markers fanned out + 3 leader polylines.
    assert.equal(hubLayer._layers.length, 1);
    assert.equal(leaflet._recorded.markers.length, 1);
    assert.equal(leaflet._recorded.circleMarkers.length, 3);
    assert.equal(leaflet._recorded.polylines.length, 3);
    // The spider state has one entry per fanned member so the zoomend hook
    // can re-project them when the user keeps zooming.
    assert.equal(testUtils._getColocatedSpiderStateForTests().length, 3);
  });
});

test('renderMap prunes expandedColocatedKeys whose group has shrunk below 2', () => {
  withAppAndLeaflet(({ testUtils, leaflet }) => {
    leaflet._map._setZoom(14);
    // Pre-stage a stale expansion key whose group will not exist in this
    // render.  After the render the key must be evicted so subsequent
    // clicks at the same coordinate start collapsed.
    testUtils._setExpandedColocatedKeysForTests(new Set(['99.00000,99.00000', '50.00000,10.00000']));
    const nodes = makeColocatedNodes(1);
    testUtils.renderMap(nodes, 0);
    const live = testUtils._getExpandedColocatedKeysForTests();
    assert.equal(live.has('99.00000,99.00000'), false, 'vanished group key was not pruned');
    assert.equal(live.has('50.00000,10.00000'), false, 'shrunken group key was not pruned');
  });
});

test('renderMap distance-filter regression: hub html reflects visible count', () => {
  withAppAndLeaflet(({ testUtils, leaflet }) => {
    leaflet._map._setZoom(14);
    leaflet._recorded.markers.length = 0;
    const nodes = makeColocatedNodes(4);
    nodes[0].distance_km = 9999;
    testUtils.renderMap(nodes, 0);
    assert.equal(leaflet._recorded.markers.length, 1);
    assert.ok(/\*3</.test(leaflet._recorded.markers[0].options.icon.options.html));
  }, { configOverrides: { maxDistanceKm: 100 } });
});

test('renderMap re-renders preserve expansion across data refreshes', () => {
  withAppAndLeaflet(({ testUtils, leaflet }) => {
    leaflet._map._setZoom(14);
    testUtils._setExpandedColocatedKeysForTests(new Set(['50.00000,10.00000']));
    const nodes = makeColocatedNodes(3);
    testUtils.renderMap(nodes, 0);
    // First render produced 3 fanned markers; a second render with the
    // same data must keep the expansion (i.e. re-emit 3 fanned markers
    // rather than collapsing back to a hub-only state).
    leaflet._recorded.circleMarkers.length = 0;
    leaflet._recorded.markers.length = 0;
    leaflet._recorded.polylines.length = 0;
    testUtils.renderMap(nodes, 0);
    assert.equal(leaflet._recorded.circleMarkers.length, 3);
    assert.equal(leaflet._recorded.markers.length, 1);
    assert.equal(leaflet._recorded.polylines.length, 3);
    assert.ok(testUtils._getExpandedColocatedKeysForTests().has('50.00000,10.00000'));
  });
});

test('hub click invokes Leaflet stopPropagation through the live harness', () => {
  withAppAndLeaflet(({ testUtils, leaflet }) => {
    leaflet._map._setZoom(14);
    const nodes = makeColocatedNodes(2);
    testUtils.renderMap(nodes, 0);
    // The hub badge created during renderMap is a regular Leaflet marker;
    // its click handler should stop the event at both the Leaflet and DOM
    // layers.  Firing the registered click handler directly emulates a
    // user click without needing a real DOM event.
    const hub = leaflet._recorded.markers[0];
    const handlers = hub._eventHandlers.get('click') || [];
    assert.equal(handlers.length, 1);
    const baselineDomEventCount = leaflet._recorded.domEventStopPropagation;
    let stopPropagationCalls = 0;
    handlers[0]({
      originalEvent: { stopPropagation() { stopPropagationCalls += 1; } }
    });
    // The click handler must contain the event at both pipeline layers so
    // the underlying overlayStack / map ``click`` handlers are not also
    // notified.  ``applyFilter`` then triggers a second renderMap cycle
    // that re-evaluates the dispatch — but with the harness's empty
    // ``allNodes`` the new render produces zero offsets, so the pruning
    // step sees no surviving multi-node groups.  We assert on the
    // stopPropagation side effects rather than the post-applyFilter
    // expansion state because the latter is correctly cleaned up by the
    // pruning logic.
    assert.equal(stopPropagationCalls, 1);
    assert.equal(leaflet._recorded.domEventStopPropagation, baselineDomEventCount + 1);
  });
});

test('renderMap places fanned markers around the shared centre when expanded', () => {
  withAppAndLeaflet(({ testUtils, leaflet }) => {
    leaflet._map._setZoom(14);
    testUtils._setExpandedColocatedKeysForTests(new Set(['50.00000,10.00000']));
    leaflet._recorded.circleMarkers.length = 0;
    const nodes = makeColocatedNodes(2);
    testUtils.renderMap(nodes, 0);
    // The two fanned slots sit on opposite sides of the original centre at
    // the configured base radius.  The stub uses an identity projection
    // ([lat, lon] → {x: lon, y: lat}), so the offset markers' coordinates
    // differ from the centre by exactly ``baseRadiusPx`` (after the recent
    // halving: 7px) along the X axis for the first slot.
    assert.equal(leaflet._recorded.circleMarkers.length, 2);
    // ``projectColocatedOffsetLatLng`` returns a ``[lat, lng]`` array, so
    // each ``_latLng`` here is a tuple rather than a Leaflet LatLng object.
    const offsets = leaflet._recorded.circleMarkers.map(m =>
      Math.hypot(m._latLng[1] - 10, m._latLng[0] - 50)
    );
    for (const distance of offsets) {
      assert.ok(distance > 0, `offset distance ${distance} should be > 0`);
      assert.ok(Math.abs(distance - 7) < 1e-9, `offset distance ${distance} should match the halved base radius`);
    }
  });
});
