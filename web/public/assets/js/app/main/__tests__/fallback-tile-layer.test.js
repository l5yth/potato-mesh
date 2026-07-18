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
  HOT_TILE_CLASS,
  FALLBACK_TILE_CLASS,
  buildFallbackTileUrl,
  wireTileFallback,
  createFallbackTileLayer,
} from '../fallback-tile-layer.js';
import {
  makeFakeTile,
  makeLeafletTileLayerStub,
  withImgDocument,
} from './tile-test-helpers.js';

const CARTO_TEMPLATE = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';

/**
 * Build a recording ``done`` callback for tile-ready assertions.
 *
 * @returns {{done: Function, calls: Array<{err: *, tile: *}>}} The callback and its call log.
 */
function makeDone() {
  const calls = [];
  return {
    done: (err, tile) => calls.push({ err, tile }),
    calls,
  };
}

// ---------------------------------------------------------------------------
// buildFallbackTileUrl
// ---------------------------------------------------------------------------

test('buildFallbackTileUrl substitutes subdomain and coords without a retina suffix', () => {
  const url = buildFallbackTileUrl(
    { x: 3, y: 2, z: 5 },
    { template: CARTO_TEMPLATE, subdomains: 'abcd', retina: false }
  );
  // (3 + 2) % 4 = 1 -> 'b'
  assert.equal(url, 'https://b.basemaps.cartocdn.com/dark_all/5/3/2.png');
});

test('buildFallbackTileUrl appends @2x when retina is requested', () => {
  const url = buildFallbackTileUrl(
    { x: 1, y: 0, z: 4 },
    { template: CARTO_TEMPLATE, subdomains: 'abcd', retina: true }
  );
  // (1 + 0) % 4 = 1 -> 'b'
  assert.equal(url, 'https://b.basemaps.cartocdn.com/dark_all/4/1/0@2x.png');
});

test('buildFallbackTileUrl defaults the subdomains when none are configured', () => {
  const url = buildFallbackTileUrl(
    { x: 0, y: 0, z: 2 },
    { template: CARTO_TEMPLATE, retina: false }
  );
  // subdomains default 'abc'; (0 + 0) % 3 = 0 -> 'a'
  assert.equal(url, 'https://a.basemaps.cartocdn.com/dark_all/2/0/0.png');
});

test('buildFallbackTileUrl uses the absolute coord sum for the subdomain index', () => {
  const url = buildFallbackTileUrl(
    { x: -1, y: -2, z: 3 },
    { template: CARTO_TEMPLATE, subdomains: 'abcd', retina: false }
  );
  // abs(-1 + -2) = 3 -> 3 % 4 = 3 -> 'd'
  assert.equal(url, 'https://d.basemaps.cartocdn.com/dark_all/3/-1/-2.png');
});

// ---------------------------------------------------------------------------
// wireTileFallback
// ---------------------------------------------------------------------------

test('wireTileFallback resolves on a HOT load and cancels the timer', () => {
  const tile = makeFakeTile();
  const { done, calls } = makeDone();
  let clearedId = null;
  const handle = wireTileFallback(tile, {
    hotUrl: 'hot',
    fallbackUrl: 'carto',
    timeoutMs: 1000,
    done,
    setTimeoutFn: () => 7,
    clearTimeoutFn: (id) => {
      clearedId = id;
    },
  });
  assert.equal(tile.src, 'hot');
  tile.dispatch('load');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].err, null);
  assert.equal(calls[0].tile, tile);
  assert.equal(clearedId, 7);
  assert.equal(handle.isSettled(), true);
  assert.equal(handle.isFallback(), false);
});

test('wireTileFallback swaps to CARTO on a HOT error and resolves on the fallback load', () => {
  const tile = makeFakeTile();
  const { done, calls } = makeDone();
  const handle = wireTileFallback(tile, {
    hotUrl: 'hot',
    fallbackUrl: 'carto',
    timeoutMs: 1000,
    done,
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });
  tile.dispatch('error');
  assert.equal(tile.src, 'carto');
  assert.equal(tile.classList.contains(FALLBACK_TILE_CLASS), true);
  assert.equal(tile.classList.contains(HOT_TILE_CLASS), false);
  assert.equal(handle.isFallback(), true);
  assert.equal(calls.length, 0);
  // The old HOT load handler was removed; only the fallback resolves the tile.
  assert.equal(tile.listenerCount('load'), 1);
  tile.dispatch('load');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].err, null);
});

test('wireTileFallback reports a tile error only when CARTO also fails', () => {
  const tile = makeFakeTile();
  const { done, calls } = makeDone();
  wireTileFallback(tile, {
    hotUrl: 'hot',
    fallbackUrl: 'carto',
    timeoutMs: 1000,
    done,
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });
  tile.dispatch('error'); // HOT fails -> swap
  assert.equal(calls.length, 0);
  tile.dispatch('error'); // CARTO fails -> terminal error
  assert.equal(calls.length, 1);
  assert.ok(calls[0].err instanceof Error);
  assert.equal(calls[0].tile, tile);
});

test('wireTileFallback passes an Error fallback event straight through', () => {
  const tile = makeFakeTile();
  const { done, calls } = makeDone();
  wireTileFallback(tile, {
    hotUrl: 'hot',
    fallbackUrl: 'carto',
    timeoutMs: 1000,
    done,
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });
  tile.dispatch('error'); // swap
  const original = new Error('carto down');
  tile.dispatch('error', original);
  assert.equal(calls[0].err, original);
});

test('wireTileFallback swaps to CARTO when HOT neither loads nor errors in time', () => {
  const tile = makeFakeTile();
  const { done, calls } = makeDone();
  let fire = null;
  const handle = wireTileFallback(tile, {
    hotUrl: 'hot',
    fallbackUrl: 'carto',
    timeoutMs: 1000,
    done,
    setTimeoutFn: (fn) => {
      fire = fn;
      return 1;
    },
    clearTimeoutFn: () => {},
  });
  assert.equal(handle.isFallback(), false);
  fire(); // the timeout elapses
  assert.equal(tile.src, 'carto');
  assert.equal(handle.isFallback(), true);
  assert.equal(calls.length, 0);
  tile.dispatch('load');
  assert.equal(calls.length, 1);
});

test('wireTileFallback is inert after it settles on a HOT load', () => {
  const tile = makeFakeTile();
  const { done, calls } = makeDone();
  let fire = null;
  const handle = wireTileFallback(tile, {
    hotUrl: 'hot',
    fallbackUrl: 'carto',
    timeoutMs: 1000,
    done,
    setTimeoutFn: (fn) => {
      fire = fn;
      return 1;
    },
    clearTimeoutFn: () => {},
  });
  tile.dispatch('load');
  assert.equal(calls.length, 1);
  tile.dispatch('load'); // second load -> handleHotLoad settled-guard
  fire(); // late timeout -> swapToFallback settled-guard
  assert.equal(tile.src, 'hot'); // never swapped
  assert.equal(handle.isFallback(), false);
  assert.equal(calls.length, 1);
});

test('wireTileFallback swaps safely when the tile has no classList', () => {
  const tile = makeFakeTile({ withClassList: false });
  const { done, calls } = makeDone();
  wireTileFallback(tile, {
    hotUrl: 'hot',
    fallbackUrl: 'carto',
    timeoutMs: 1000,
    done,
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });
  tile.dispatch('error'); // swap; the classList guard is skipped
  assert.equal(tile.src, 'carto');
  tile.dispatch('load');
  assert.equal(calls.length, 1);
});

test('wireTileFallback uses real timers by default and clears them on load', () => {
  const tile = makeFakeTile();
  const { done, calls } = makeDone();
  wireTileFallback(tile, {
    hotUrl: 'hot',
    fallbackUrl: 'carto',
    timeoutMs: 5000,
    done,
  });
  tile.dispatch('load'); // cancels the real 5s timer via the default clearTimeout
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------------------
// createFallbackTileLayer
// ---------------------------------------------------------------------------

test('createFallbackTileLayer returns null when Leaflet is unavailable', () => {
  assert.equal(createFallbackTileLayer(null, {}), null);
  assert.equal(createFallbackTileLayer({}, {}), null);
  assert.equal(createFallbackTileLayer({ TileLayer: {} }, {}), null);
});

test('createFallbackTileLayer builds a layer from the HOT url and options', () => {
  const L = makeLeafletTileLayerStub();
  const layer = createFallbackTileLayer(L, {
    hotUrl: 'https://{s}.hot/{z}/{x}/{y}.png',
    hotOptions: { subdomains: 'abc', crossOrigin: 'anonymous' },
    fallbackUrl: CARTO_TEMPLATE,
    fallbackSubdomains: 'abcd',
    fallbackRetina: false,
    timeoutMs: 1000,
  });
  assert.ok(layer);
  assert.equal(layer._url, 'https://{s}.hot/{z}/{x}/{y}.png');
  assert.equal(layer.options.crossOrigin, 'anonymous');
});

test('createFallbackTileLayer.createTile builds a filtered HOT tile that falls back to CARTO', () => {
  const doc = withImgDocument();
  try {
    const L = makeLeafletTileLayerStub();
    const layer = createFallbackTileLayer(L, {
      hotUrl: 'https://{s}.hot/{z}/{x}/{y}.png',
      hotOptions: { subdomains: 'abc', crossOrigin: 'anonymous' },
      fallbackUrl: CARTO_TEMPLATE,
      fallbackSubdomains: 'abcd',
      fallbackRetina: true,
      timeoutMs: 1000,
    });
    const tile = layer.createTile({ x: 1, y: 1, z: 3 }, () => {});
    assert.equal(tile.classList.contains(HOT_TILE_CLASS), true);
    assert.equal(tile.crossOrigin, 'anonymous');
    assert.equal(tile.alt, '');
    assert.equal(tile._attrs.role, 'presentation');
    // (1 + 1) % 3 = 2 -> 'c'
    assert.equal(tile.src, 'https://c.hot/3/1/1.png');
    tile.dispatch('error'); // force the fallback
    // (1 + 1) % 4 = 2 -> 'c'; retina -> @2x
    assert.equal(tile.src, 'https://c.basemaps.cartocdn.com/dark_all/3/1/1@2x.png');
    assert.equal(tile.classList.contains(FALLBACK_TILE_CLASS), true);
  } finally {
    doc.restore();
  }
});

test('createFallbackTileLayer.createTile honours the crossOrigin option variants', () => {
  const L = makeLeafletTileLayerStub();
  const cases = [
    { crossOrigin: 'anonymous', expected: 'anonymous' },
    { crossOrigin: true, expected: '' },
    { crossOrigin: '', expected: '' },
    { crossOrigin: undefined, expected: undefined },
  ];
  for (const { crossOrigin, expected } of cases) {
    const doc = withImgDocument();
    try {
      const layer = createFallbackTileLayer(L, {
        hotUrl: 'https://{s}.hot/{z}/{x}/{y}.png',
        hotOptions: { subdomains: 'abc', crossOrigin },
        fallbackUrl: CARTO_TEMPLATE,
        fallbackSubdomains: 'abcd',
        fallbackRetina: false,
        timeoutMs: 1000,
      });
      const tile = layer.createTile({ x: 0, y: 0, z: 1 }, () => {});
      assert.equal(tile.crossOrigin, expected);
      tile.dispatch('load'); // settle to clear the scheduled timer
    } finally {
      doc.restore();
    }
  }
});

test('makeLeafletTileLayerStub applies option and subdomain defaults', () => {
  const L = makeLeafletTileLayerStub();
  const layer = new L.TileLayer('https://{s}.x/{z}/{x}/{y}.png'); // options omitted -> {}
  assert.deepEqual(layer.options, {});
  const url = layer.getTileUrl({ x: 0, y: 0, z: 1 }); // subdomains omitted -> 'abc'
  assert.equal(url, 'https://a.x/1/0/0.png');
});

test('makeFakeTile tolerates events for unregistered types', () => {
  const tile = makeFakeTile();
  // listenerCount / dispatch / removeEventListener must not throw for a type
  // that was never registered (the fake tile's defensive fallbacks).
  assert.equal(tile.listenerCount('load'), 0);
  tile.dispatch('load', {});
  tile.removeEventListener('load', () => {});
  assert.equal(tile.listenerCount('load'), 0);
});

test('withImgDocument restores a pre-existing document on teardown', () => {
  const sentinel = { marker: true };
  globalThis.document = sentinel;
  try {
    const doc = withImgDocument();
    assert.notEqual(globalThis.document, sentinel);
    doc.restore();
    assert.equal(globalThis.document, sentinel);
  } finally {
    delete globalThis.document;
  }
});

test('createFallbackTileLayer.createTile tolerates a tile element without classList', () => {
  const doc = withImgDocument({ tileFactory: () => makeFakeTile({ withClassList: false }) });
  try {
    const L = makeLeafletTileLayerStub();
    const layer = createFallbackTileLayer(L, {
      hotUrl: 'https://{s}.hot/{z}/{x}/{y}.png',
      hotOptions: { subdomains: 'abc', crossOrigin: 'anonymous' },
      fallbackUrl: CARTO_TEMPLATE,
      fallbackSubdomains: 'abcd',
      fallbackRetina: false,
      timeoutMs: 1000,
    });
    const tile = layer.createTile({ x: 0, y: 0, z: 1 }, () => {});
    assert.equal(tile.classList, undefined);
    assert.equal(tile.src, 'https://a.hot/1/0/0.png');
    tile.dispatch('load'); // settle to clear the scheduled timer
  } finally {
    doc.restore();
  }
});
