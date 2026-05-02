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

import { createOfflineTileLayer } from '../offline-tile-layer.js';

/**
 * Build a minimal Leaflet stub exposing the methods the offline tile layer
 * needs (``L.gridLayer``).  The returned grid-layer object is otherwise a
 * plain bag whose ``createTile`` slot is reassigned by the production code.
 *
 * @returns {Object} Leaflet-compatible stub.
 */
function makeLeafletStub() {
  return {
    gridLayer(options) {
      return { options, createTile: null };
    },
  };
}

/**
 * Install a minimal ``document`` stub whose ``createElement`` returns objects
 * that satisfy the offline tile layer's small DOM contract: canvas elements
 * expose a configurable ``getContext`` slot, while plain ``div`` elements
 * expose ``style``, ``className`` and ``cloneNode``.
 *
 * @param {{ canvasContext?: any }} [options] Override the canvas 2D context.
 * @returns {{ restore: Function }} Teardown handle.
 */
function withDocumentStub({ canvasContext } = {}) {
  const previousDocument = globalThis.document;

  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => (canvasContext === undefined ? makeRecordingContext() : canvasContext),
        };
      }
      const element = {
        tag,
        className: '',
        style: {},
        textContent: '',
        cloneNode() {
          // Return a shallow copy that retains the recorded properties so
          // assertions can inspect what the production code rendered.
          return JSON.parse(JSON.stringify({
            tag: element.tag,
            className: element.className,
            style: element.style,
            textContent: element.textContent,
          }));
        },
      };
      return element;
    },
  };

  return {
    restore() {
      if (previousDocument === undefined) {
        delete globalThis.document;
      } else {
        globalThis.document = previousDocument;
      }
    },
  };
}

/**
 * Build a Canvas 2D context stub that records the calls it receives.  The
 * tests inspect the call list to ensure the production code follows the
 * expected drawing path.
 *
 * @returns {Object} Recording 2D context.
 */
function makeRecordingContext() {
  const calls = [];
  const ctx = {
    calls,
    fillStyle: null,
    strokeStyle: null,
    lineWidth: 0,
    font: '',
    textBaseline: '',
    textAlign: '',
    createLinearGradient(...args) {
      calls.push(['createLinearGradient', args]);
      return { addColorStop(...stop) { calls.push(['addColorStop', stop]); } };
    },
    fillRect(...args) {
      calls.push(['fillRect', args]);
    },
    beginPath() {
      calls.push(['beginPath']);
    },
    moveTo(...args) {
      calls.push(['moveTo', args]);
    },
    lineTo(...args) {
      calls.push(['lineTo', args]);
    },
    stroke() {
      calls.push(['stroke']);
    },
    fillText(...args) {
      calls.push(['fillText', args]);
    },
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// createOfflineTileLayer — early returns
// ---------------------------------------------------------------------------

test('createOfflineTileLayer returns null when Leaflet is missing', () => {
  assert.equal(createOfflineTileLayer(null), null);
  assert.equal(createOfflineTileLayer(undefined), null);
});

test('createOfflineTileLayer returns null when Leaflet has no gridLayer factory', () => {
  assert.equal(createOfflineTileLayer({}), null);
});

// ---------------------------------------------------------------------------
// createOfflineTileLayer — happy path
// ---------------------------------------------------------------------------

test('createOfflineTileLayer attaches a createTile method on success', () => {
  const stub = withDocumentStub();
  try {
    const layer = createOfflineTileLayer(makeLeafletStub());
    assert.ok(layer);
    assert.equal(typeof layer.createTile, 'function');
  } finally {
    stub.restore();
  }
});

test('createOfflineTileLayer renders a canvas tile when getContext succeeds', () => {
  const stub = withDocumentStub();
  try {
    const layer = createOfflineTileLayer(makeLeafletStub());
    const tile = layer.createTile({ x: 1, y: 1, z: 1 });
    // The returned element should be the canvas itself (has getContext).
    assert.equal(typeof tile.getContext, 'function');
    assert.equal(tile.width, 256);
    assert.equal(tile.height, 256);
  } finally {
    stub.restore();
  }
});

test('createOfflineTileLayer falls back to placeholder when canvas getContext returns null', () => {
  const stub = withDocumentStub({ canvasContext: null });
  // Silence the warn from the fallback branch so test output stays clean.
  const previousWarn = console.warn;
  console.warn = () => {};
  try {
    const layer = createOfflineTileLayer(makeLeafletStub());
    const tile = layer.createTile({ x: 0, y: 0, z: 0 });
    // Fallback is the cloned <div> — no getContext method.
    assert.equal(tile.getContext, undefined);
    assert.equal(tile.tag, 'div');
    assert.equal(tile.className, 'offline-tile-fallback');
  } finally {
    console.warn = previousWarn;
    stub.restore();
  }
});

test('createOfflineTileLayer reuses the cached fallback tile across invocations', () => {
  const stub = withDocumentStub({ canvasContext: null });
  const previousWarn = console.warn;
  console.warn = () => {};
  try {
    const layer = createOfflineTileLayer(makeLeafletStub());
    const first = layer.createTile({ x: 0, y: 0, z: 0 });
    const second = layer.createTile({ x: 1, y: 0, z: 0 });
    // Both calls produce equivalent fallback nodes (same shape).
    assert.deepEqual(first, second);
  } finally {
    console.warn = previousWarn;
    stub.restore();
  }
});

test('createOfflineTileLayer falls back when the canvas drawing path throws', () => {
  // Build a context whose `createLinearGradient` throws to force the
  // catch-and-fall-back branch.
  const ctx = makeRecordingContext();
  ctx.createLinearGradient = () => {
    throw new Error('boom');
  };
  const stub = withDocumentStub({ canvasContext: ctx });
  const previousError = console.error;
  console.error = () => {};
  try {
    const layer = createOfflineTileLayer(makeLeafletStub());
    const tile = layer.createTile({ x: 0, y: 0, z: 0 });
    // Production code logs and returns the fallback element.
    assert.equal(tile.getContext, undefined);
    assert.equal(tile.tag, 'div');
  } finally {
    console.error = previousError;
    stub.restore();
  }
});
