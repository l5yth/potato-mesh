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

import { createDomEnvironment } from './dom-environment.js';
import { initializeApp } from '../main.js';
import { MINIMAL_CONFIG } from './main-app-test-helpers.js';

/**
 * Build a minimal stub of the Leaflet ``L`` global that supports the surface
 * area exercised during {@link initializeApp} setup and the subsequent
 * {@link renderMap} render path.  The stub is deliberately data-only — every
 * Leaflet object is a plain ``{}`` shape with the methods the production code
 * calls — so tests can introspect counts (e.g. how many markers were added
 * to a particular layer) without depending on a real Leaflet runtime.
 *
 * The returned object also exposes the ``_recorded`` reference which holds
 * arrays of created markers / lines / hubs so individual tests can assert on
 * what was drawn into each layer.  Layers themselves expose their internal
 * ``_layers`` array, allowing direct assertions like
 * ``stub.markersLayer._layers.length`` after a render.  The stub is kept
 * intentionally minimal — every method here corresponds to a call site in
 * production main.js, so adding a new Leaflet call generally requires a
 * matching entry here.
 *
 * @returns {Object} Stub Leaflet root with helper accessors.
 */
export function makeLeafletStub() {
  const recorded = {
    circleMarkers: [],
    polylines: [],
    markers: [],
    divIcons: [],
    layerGroups: [],
    domEventStopPropagation: 0
  };

  /**
   * Build a layer-group stub that records additions into an internal
   * ``_layers`` array so tests can introspect what was drawn there.
   *
   * @returns {Object} Layer group stub.
   */
  function makeLayerGroup() {
    const group = {
      _layers: [],
      addTo() {
        return group;
      },
      clearLayers() {
        group._layers.length = 0;
        return group;
      }
    };
    recorded.layerGroups.push(group);
    return group;
  }

  /**
   * Construct a marker-shaped stub with the subset of Leaflet's marker API
   * that production code interacts with.  Used as the base for both
   * ``L.circleMarker`` and ``L.marker`` results so the two share the
   * ``addTo`` / ``on`` / ``getElement`` surface.
   *
   * @param {[number, number]} latLng Initial coordinate pair.
   * @param {Object} [options] Marker options forwarded by the caller.
   * @returns {Object} Marker stub.
   */
  function makeMarker(latLng, options) {
    const eventHandlers = new Map();
    const marker = {
      _latLng: latLng,
      _addedTo: null,
      options: options || {},
      addTo(layer) {
        marker._addedTo = layer;
        if (layer && Array.isArray(layer._layers)) layer._layers.push(marker);
        return marker;
      },
      on(event, handler) {
        if (!eventHandlers.has(event)) eventHandlers.set(event, []);
        eventHandlers.get(event).push(handler);
        return marker;
      },
      _eventHandlers: eventHandlers
    };
    return marker;
  }

  /**
   * Construct a polyline-shaped stub for spider leader / neighbour /
   * trace lines.  Production code reads ``setLatLngs`` (used by the spider
   * refresh helper) but never the getters, so we keep the shape minimal.
   *
   * @param {Array<[number, number]>} latLngs Initial coordinate list.
   * @param {Object} [options] Polyline options.
   * @returns {Object} Polyline stub.
   */
  function makePolyline(latLngs, options) {
    const line = {
      _latLngs: latLngs,
      _addedTo: null,
      options: options || {},
      addTo(layer) {
        line._addedTo = layer;
        if (layer && Array.isArray(layer._layers)) layer._layers.push(line);
        return line;
      }
    };
    return line;
  }

  /**
   * Construct a tile-layer stub.  ``initializeApp`` registers
   * ``tileloadstart`` / ``tileload`` / ``load`` / ``tileerror`` handlers but
   * never fires them in the test environment, so the stub just stores the
   * registration for completeness.
   *
   * @param {string} url Tile URL template (ignored).
   * @param {Object} [options] Tile options.
   * @returns {Object} Tile-layer stub.
   */
  function makeTileLayer(url, options) {
    const tile = {
      _url: url,
      _events: new Map(),
      options: options || {},
      addTo() {
        return tile;
      },
      on(event, handler) {
        if (!tile._events.has(event)) tile._events.set(event, []);
        tile._events.get(event).push(handler);
        return tile;
      }
    };
    return tile;
  }

  /**
   * Construct the map stub returned by ``L.map()``.  ``getZoom`` is
   * mutable via ``_setZoom`` so individual tests can drive the dispatch
   * branches without re-instantiating the entire harness.
   *
   * @returns {Object} Map stub.
   */
  function makeMap() {
    let zoom = 14;
    const eventHandlers = new Map();
    const map = {
      _setZoom(value) {
        zoom = value;
      },
      fitBounds() {
        return map;
      },
      getZoom() {
        return zoom;
      },
      latLngToLayerPoint(latLng) {
        // Identity-ish: [lat, lon] → {x: lon, y: lat}.  Keeps offsets simple
        // to reason about in test assertions.
        const lat = Array.isArray(latLng) ? latLng[0] : latLng.lat;
        const lon = Array.isArray(latLng) ? latLng[1] : latLng.lng;
        return { x: lon, y: lat };
      },
      layerPointToLatLng(point) {
        return { lat: point.y, lng: point.x };
      },
      on(event, handler) {
        if (!eventHandlers.has(event)) eventHandlers.set(event, []);
        eventHandlers.get(event).push(handler);
        return map;
      },
      whenReady(cb) {
        // Fire synchronously so the harness does not have to drive an event
        // loop just to thread the ready-callback side effects.
        if (typeof cb === 'function') cb();
        return map;
      },
      invalidateSize() {
        return map;
      }
    };
    return map;
  }

  const stub = {
    map(_container, _options) {
      stub._map = makeMap();
      return stub._map;
    },
    tileLayer: makeTileLayer,
    layerGroup: makeLayerGroup,
    circleMarker(latLng, options) {
      const marker = makeMarker(latLng, options);
      recorded.circleMarkers.push(marker);
      return marker;
    },
    polyline(latLngs, options) {
      const line = makePolyline(latLngs, options);
      recorded.polylines.push(line);
      return line;
    },
    marker(latLng, options) {
      const marker = makeMarker(latLng, options);
      recorded.markers.push(marker);
      return marker;
    },
    divIcon(options) {
      const icon = { options: options || {} };
      recorded.divIcons.push(icon);
      return icon;
    },
    point(x, y) {
      return { x, y };
    },
    latLng(lat, lng) {
      // ``L.latLng`` is invoked once during ``initializeApp`` to seed the
      // initial map centre.  The stub returns a plain object since the rest
      // of the production code only reads ``.lat`` / ``.lng`` from it.
      return { lat, lng };
    },
    DomEvent: {
      stopPropagation() {
        recorded.domEventStopPropagation += 1;
      }
    },
    control(_options) {
      // ``initializeApp`` calls ``L.control(...)`` to construct the legend
      // toggle widget.  The stub returns a chainable shape with ``addTo`` so
      // the registration path completes without producing a real Leaflet
      // control instance.
      return {
        addTo() {
          return this;
        }
      };
    },
    _recorded: recorded
  };

  return stub;
}

/**
 * Spin up the application with a Leaflet stub on ``window.L`` and a
 * pre-registered ``#map`` element so the map-init branch of
 * {@link initializeApp} runs to completion.  Network ``fetch`` is replaced
 * with a never-resolving promise so the trailing ``refresh()`` cycle does
 * not race against the test's cleanup (the same pattern documented in the
 * narrower ``stubFetchForApplyFilter`` helper).
 *
 * @param {Object} [opts]
 * @param {Object} [opts.configOverrides] Per-test overrides merged into
 *   {@link MINIMAL_CONFIG}.
 * @returns {{ testUtils: Object, env: Object, leaflet: Object, cleanup: Function }}
 */
export function setupAppWithLeaflet(opts = {}) {
  const env = createDomEnvironment({ includeBody: true });
  const mapContainer = env.createElement('div', 'map');
  env.registerElement('map', mapContainer);

  // ``applyFiltersToAllTiles`` writes to ``document.body.style`` via
  // ``setProperty``; the bare ``MockElement`` only exposes an empty object,
  // so extend it with the method.  The ``style.cssText`` accumulator is
  // diagnostic-only — production code never reads it back, but having it
  // lets tests inspect what filters were applied if needed.
  const bodyStyle = (env.window && env.window.document && env.window.document.body)
    ? env.window.document.body.style
    : null;
  if (bodyStyle && typeof bodyStyle.setProperty !== 'function') {
    bodyStyle._properties = bodyStyle._properties || {};
    bodyStyle.setProperty = (name, value) => {
      bodyStyle._properties[name] = value;
    };
  }

  // ``initializeApp`` calls ``window.matchMedia`` to set up a responsive
  // legend listener.  The base DOM mock does not provide it, so we install
  // a no-op shim that returns a never-firing ``MediaQueryList`` shape.
  if (env.window && typeof env.window.matchMedia !== 'function') {
    env.window.matchMedia = () => ({
      matches: false,
      media: '',
      addEventListener() {},
      removeEventListener() {}
    });
  }

  const previousWindowL = globalThis.window.L;
  const previousGlobalL = globalThis.L;
  const previousFetch = globalThis.fetch;

  const leaflet = makeLeafletStub();
  // Both ``window.L`` and the bare ``L`` global must be set: the
  // ``hasLeaflet`` capture reads ``window.L``, while the runtime references
  // ``L`` directly via the module's global scope.  Mirror the way the
  // browser's ``leaflet.js`` exposes the namespace.
  globalThis.window.L = leaflet;
  globalThis.L = leaflet;
  // Pinning fetch to a never-resolving promise keeps any
  // ``fetchActiveNodeStats`` / ``refresh`` chains from racing against the
  // test cleanup.  The promise never settles, so any future ``.then`` /
  // ``.catch`` attached downstream simply hangs harmlessly until the next
  // microtask cycle is abandoned by the test runner.
  globalThis.fetch = () => new Promise(() => {});

  const config = { ...MINIMAL_CONFIG, ...(opts.configOverrides || {}) };
  const { _testUtils } = initializeApp(config);

  return {
    testUtils: _testUtils,
    env,
    leaflet,
    cleanup() {
      globalThis.fetch = previousFetch;
      globalThis.window.L = previousWindowL;
      globalThis.L = previousGlobalL;
      env.cleanup();
    }
  };
}

/**
 * Mirror of {@link withApp} that uses the Leaflet-aware setup.  Ensures the
 * cleanup runs regardless of test outcome.
 *
 * @param {function({ testUtils: Object, leaflet: Object, env: Object }): void} fn
 *   Test body.
 * @param {Object} [opts] Forwarded to {@link setupAppWithLeaflet}.
 */
export function withAppAndLeaflet(fn, opts = {}) {
  const harness = setupAppWithLeaflet(opts);
  try {
    fn({ testUtils: harness.testUtils, leaflet: harness.leaflet, env: harness.env });
  } finally {
    harness.cleanup();
  }
}
