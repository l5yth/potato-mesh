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
 * The dashboard and /map legend fits its map (SPEC ML3): `main.js` caps the
 * mounted panel to the room under the map toolbar, refits it when Leaflet
 * reports a resize, and base.css lets the capped panel scroll.
 *
 * @module app/__tests__/legend-fit
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { declarationsFor } from './base-css-rules.js';
import { bootLegendApp } from './legend-app-harness.js';

test('the dashboard legend is capped under its toolbar and refits on a resize (ML3)', async () => {
  const app = await bootLegendApp({ leaflet: true });
  try {
    // The harness map is 600 px tall and its toolbar ends 44 px below the
    // map's top; 40 px of edges stay free.
    assert.equal(app.legend.style.maxHeight, '516px', 'capped at mount');
    app.map._setSize(800, 461)._fire('resize');
    assert.equal(app.legend.style.maxHeight, '377px', 'refit on resize');
  } finally {
    await app.cleanup();
  }
});

test('base.css lets a capped legend scroll, with no sideways scrollbar (ML3)', () => {
  assert.equal(declarationsFor('.legend')['overflow-y'], 'auto');
  // A 100 % wide item with padding overflows a content-box column: the
  // Federation legend's <div> items did, by 4 px.
  assert.equal(declarationsFor('.legend-item')['box-sizing'], 'border-box');
  assert.equal(declarationsFor('.legend-item').width, '100%');
});
