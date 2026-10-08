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
  fitLegendToMap,
  LEGEND_EDGE_PX,
  LEGEND_MIN_MAX_HEIGHT_PX,
  LEGEND_STACK_MARGIN_PX,
  resolveLegendVisibility,
} from '../map-legend-visibility.js';

test('resolveLegendVisibility hides when a default collapse is requested', () => {
  assert.equal(resolveLegendVisibility({ defaultCollapsed: true, mediaQueryMatches: false }), false);
  assert.equal(resolveLegendVisibility({ defaultCollapsed: true, mediaQueryMatches: true }), false);
});

test('resolveLegendVisibility always hides on the cramped dashboard', () => {
  assert.equal(
    resolveLegendVisibility({ defaultCollapsed: false, mediaQueryMatches: false, viewMode: 'dashboard' }),
    false
  );
});

// SPEC UX8 (audit D-011): the dedicated map view honours the template default
// — expanded on desktop, collapsed on small viewports.
test('resolveLegendVisibility expands the map view on desktop', () => {
  assert.equal(
    resolveLegendVisibility({ defaultCollapsed: false, mediaQueryMatches: false, viewMode: 'map' }),
    true
  );
  assert.equal(
    resolveLegendVisibility({ defaultCollapsed: false, mediaQueryMatches: true, viewMode: 'map' }),
    false
  );
});

test('resolveLegendVisibility follows the media query when not forced', () => {
  assert.equal(resolveLegendVisibility({ defaultCollapsed: false, mediaQueryMatches: false }), true);
  assert.equal(resolveLegendVisibility({ defaultCollapsed: false, mediaQueryMatches: true }), false);
});

// SPEC ML3: the legend panel is capped to the room its map leaves under the
// toolbar and scrolls, so it never runs past the map's top edge.

/**
 * An element stub with a settable viewport box.
 *
 * @param {number} top Top edge in px.
 * @param {number} height Height in px; 0 is not laid out.
 * @returns {{getBoundingClientRect: Function, place: Function}} Stub; `place`
 *   moves or resizes it.
 */
function box(top, height) {
  const rect = { top, height };
  return {
    getBoundingClientRect: () => ({ top: rect.top, height: rect.height, bottom: rect.top + rect.height }),
    place(nextTop, nextHeight) {
      rect.top = nextTop;
      rect.height = nextHeight;
    },
  };
}

/**
 * A map stub over a container at `top` with a 1 px border, recording its
 * `resize` handlers.
 *
 * @param {number} height Container padding-box height in px.
 * @param {number} [top] Container top edge in px.
 * @returns {{getContainer: Function, on: Function, container: Object, handlers: Array<Function>, resize: Function}}
 *   Stub; `resize` sets the height and runs the recorded handlers.
 */
function sizedMap(height, top = 100) {
  const container = {
    clientTop: 1,
    clientHeight: height,
    getBoundingClientRect: () => ({ top, height: container.clientHeight + 2, bottom: top + container.clientHeight + 2 }),
  };
  const handlers = [];
  return {
    container,
    handlers,
    getContainer: () => container,
    on(event, handler) {
      if (event === 'resize') handlers.push(handler);
    },
    resize(next) {
      container.clientHeight = next;
      handlers.forEach(handler => handler());
    },
  };
}

/** The map toolbar at a fine pointer: 12 px from the map's top, 32 px tall. */
const fineToolbar = () => box(101 + 12, 32);

test('fitLegendToMap caps the legend to the room under the toolbar (ML3)', () => {
  assert.equal(LEGEND_EDGE_PX, 40);
  const legend = { style: {} };
  const fit = fitLegendToMap(sizedMap(600), legend, { toolbar: fineToolbar() });
  assert.equal(typeof fit, 'function');
  // 600 px less the 44 px toolbar band and 40 px of edges, as 84 px before.
  assert.equal(legend.style.maxHeight, '516px');
});

test('fitLegendToMap follows a taller toolbar, as on a coarse pointer (ML3, CT1)', () => {
  const legend = { style: {} };
  const toolbar = fineToolbar();
  const fit = fitLegendToMap(sizedMap(600), legend, { toolbar });
  toolbar.place(113, 44);
  fit();
  assert.equal(legend.style.maxHeight, '504px', '96 px kept free, not 84');
});

test('fitLegendToMap keeps the row of a stacked toggle free, read live (ML3)', () => {
  assert.equal(LEGEND_STACK_MARGIN_PX, 18);
  const legend = { style: {} };
  const toggle = box(0, 28);
  const toolbar = fineToolbar();
  const fit = fitLegendToMap(sizedMap(400), legend, { toolbar, stacked: toggle });
  assert.equal(legend.style.maxHeight, '270px', 'the 28 px toggle and its 18 px of margins');
  toggle.place(0, 44);
  toolbar.place(113, 44);
  fit();
  assert.equal(legend.style.maxHeight, '242px', 'a 44 px toggle under a 44 px toolbar');
});

test('fitLegendToMap uses the map top without a laid-out toolbar or toggle (ML3)', () => {
  const legend = { style: {} };
  fitLegendToMap(sizedMap(600), legend);
  assert.equal(legend.style.maxHeight, '560px', 'no toolbar');
  fitLegendToMap(sizedMap(600), legend, { toolbar: box(0, 0), stacked: box(0, 0) });
  assert.equal(legend.style.maxHeight, '560px', 'display: none boxes are 0 px tall');
  fitLegendToMap(sizedMap(600), legend, { toolbar: box(20, 10) });
  assert.equal(legend.style.maxHeight, '560px', 'a toolbar above the map does not lift the ceiling');
});

test('fitLegendToMap refits on every Leaflet resize when there is no ResizeObserver (ML3)', () => {
  const map = sizedMap(600);
  const legend = { style: {} };
  fitLegendToMap(map, legend, { toolbar: fineToolbar() });
  map.resize(461);
  assert.equal(legend.style.maxHeight, '377px');
  map.resize(900);
  assert.equal(legend.style.maxHeight, '816px');
});

test('fitLegendToMap refits whenever a ResizeObserver sees the map, toolbar or toggle change (ML3)', () => {
  const observers = [];
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      observers.push(this);
    }

    observe(target) {
      this.targets.push(target);
    }
  };
  try {
    const map = sizedMap(472);
    const legend = { style: {} };
    const toolbar = fineToolbar();
    const toggle = box(0, 28);
    fitLegendToMap(map, legend, { toolbar, stacked: toggle });
    assert.equal(legend.style.maxHeight, '342px');
    assert.equal(observers.length, 1);
    assert.deepEqual(observers[0].targets, [map.container, toolbar, toggle], 'the map, toolbar and toggle are observed');
    assert.equal(map.handlers.length, 0, 'the observer replaces the Leaflet resize event');
    // The page above the map reflows after load: no Leaflet resize, but the
    // container is shorter.
    map.container.clientHeight = 432;
    observers[0].callback();
    assert.equal(legend.style.maxHeight, '302px');
    fitLegendToMap(map, { style: {} });
    assert.deepEqual(observers[1].targets, [map.container], 'nothing else to observe');
  } finally {
    if (original === undefined) {
      delete globalThis.ResizeObserver;
    } else {
      globalThis.ResizeObserver = original;
    }
  }
});

test('fitLegendToMap never caps the legend below 120 px (ML3)', () => {
  assert.equal(LEGEND_MIN_MAX_HEIGHT_PX, 120);
  const legend = { style: {} };
  fitLegendToMap(sizedMap(150), legend, { toolbar: fineToolbar() });
  assert.equal(legend.style.maxHeight, '120px');
});

test('fitLegendToMap leaves a missing legend or a map without a container alone (ML3)', () => {
  assert.equal(fitLegendToMap(sizedMap(600), null), null);
  const legend = { style: {} };
  assert.equal(fitLegendToMap({ on() {} }, legend), null);
  assert.equal(fitLegendToMap(null, legend), null);
  assert.deepEqual(legend.style, {});
});
