/*
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

import { fetchTelemetryForNode, fetchPositionsForNode } from '../node-view-data.js';
import { initializeNodeMap } from '../node-view-map.js';
import {
  bootstrapNodeView,
  escapeHtml,
  renderMessage,
  resolveTheme,
  setNodeViewDependencies
} from '../node-view.js';

/**
 * Create a minimal DOM stub for node view tests.
 *
 * @returns {Object} Document stand-in.
 */
function createDocumentStub() {
  const telemetryContainer = { innerHTML: '', id: 'nodeTelemetry' };
  const mapContainer = { innerHTML: '', id: 'nodeMap' };
  const root = {
    className: 'node-view',
    getAttribute(name) {
      if (name === 'data-node-id') return '!node';
      return null;
    }
  };
  const body = {
    dataset: { theme: 'dark' },
    classList: {
      contains() {
        return true;
      }
    }
  };
  const doc = {
    body,
    documentElement: { dataset: {} },
    querySelector(selector) {
      if (selector === '.node-view') return root;
      return null;
    },
    getElementById(id) {
      if (id === 'nodeTelemetry') return telemetryContainer;
      if (id === 'nodeMap') return mapContainer;
      return null;
    },
    addEventListener() {
      // No-op for tests.
    }
  };
  return { document: doc, containers: { telemetryContainer, mapContainer }, root };
}

test('escapeHtml encodes unsafe characters', () => {
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
});

test('renderMessage writes text into the container', () => {
  const el = { innerHTML: '' };
  renderMessage(el, 'Hello & welcome');
  assert.match(el.innerHTML, /Hello &amp; welcome/);
});

test('resolveTheme inspects dataset and class list', () => {
  const doc = {
    body: { dataset: {}, classList: { contains: () => true } },
    documentElement: { dataset: {} }
  };
  assert.equal(resolveTheme(doc), 'dark');
  doc.body.classList.contains = () => false;
  doc.body.dataset.theme = 'light';
  doc.documentElement.dataset.theme = 'dark';
  assert.equal(resolveTheme(doc), 'dark');
  doc.documentElement.dataset.theme = 'light';
  assert.equal(resolveTheme(doc), 'light');
});

test('bootstrapNodeView coordinates data loading and rendering', async () => {
  const originalDocument = globalThis.document;
  const { document: doc, containers } = createDocumentStub();
  globalThis.document = doc;

  const telemetryCalls = [];
  const positionCalls = [];
  const mapCalls = [];

  setNodeViewDependencies({
    fetchTelemetry: async ({ nodeId }) => {
      telemetryCalls.push(nodeId);
      return [
        {
          timestampMs: Date.now(),
          batteryLevel: 50,
          channelUtilization: 30,
          airUtilTx: 10
        }
      ];
    },
    fetchPositions: async ({ nodeId }) => {
      positionCalls.push(nodeId);
      return [
        {
          timestampMs: Date.now(),
          latitude: 1,
          longitude: 2
        }
      ];
    },
    initializeMap: args => {
      mapCalls.push(args);
      return null;
    }
  });

  try {
    bootstrapNodeView();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(telemetryCalls, ['!node']);
    assert.deepEqual(positionCalls, ['!node']);
    assert.ok(containers.telemetryContainer.innerHTML.includes('Node telemetry'));
    assert.equal(mapCalls.length, 1);
  } finally {
    globalThis.document = originalDocument;
    setNodeViewDependencies({
      fetchTelemetry: fetchTelemetryForNode,
      fetchPositions: fetchPositionsForNode,
      initializeMap: initializeNodeMap
    });
  }
});
