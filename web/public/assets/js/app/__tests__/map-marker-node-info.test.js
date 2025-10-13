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

import { attachNodeInfoRefreshToMarker, overlayToPopupNode } from '../map-marker-node-info.js';

function createFakeMarker(anchor) {
  const handlers = {};
  return {
    handlers,
    on(name, handler) {
      if (!handlers[name]) handlers[name] = [];
      handlers[name].push(handler);
      return this;
    },
    getElement() {
      return anchor;
    },
    trigger(name, payload) {
      for (const handler of handlers[name] || []) {
        handler(payload);
      }
    },
  };
}

test('attachNodeInfoRefreshToMarker refreshes markers with merged overlay details', async () => {
  const anchor = { id: 'anchor-el' };
  const marker = createFakeMarker(anchor);
  const popupUpdates = [];
  const detailCalls = [];
  let prevented = false;
  let stopped = false;
  let token = 0;
  const refreshCalls = [];

  attachNodeInfoRefreshToMarker({
    marker,
    getOverlayFallback: () => ({ nodeId: '!foo', shortName: 'Foo', role: 'CLIENT', neighbors: [] }),
    refreshNodeInformation: async reference => {
      refreshCalls.push(reference);
      return { battery: 55.5, telemetryTime: 123, neighbors: [{ neighbor_id: '!bar', snr: 9.5 }] };
    },
    mergeOverlayDetails: (primary, fallback) => ({ ...fallback, ...primary }),
    createRequestToken: el => {
      assert.equal(el, anchor);
      return ++token;
    },
    isTokenCurrent: (el, candidate) => {
      assert.equal(el, anchor);
      return candidate === token;
    },
    showLoading: (el, info) => {
      assert.equal(el, anchor);
      assert.equal(info.nodeId, '!foo');
    },
    showDetails: (el, info) => {
      detailCalls.push({ el, info });
    },
    showError: () => {
      assert.fail('showError should not be invoked on success');
    },
    updatePopup: info => {
      popupUpdates.push(info);
    },
  });

  const clickEvent = {
    originalEvent: {
      preventDefault() {
        prevented = true;
      },
      stopPropagation() {
        stopped = true;
      },
    },
  };

  marker.trigger('click', clickEvent);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(refreshCalls.length, 1);
  assert.deepEqual(refreshCalls[0], {
    nodeId: '!foo',
    fallback: { nodeId: '!foo', shortName: 'Foo', role: 'CLIENT', neighbors: [] },
  });
  assert.ok(popupUpdates.length >= 1);
  const merged = popupUpdates[popupUpdates.length - 1];
  assert.equal(merged.battery, 55.5);
  assert.equal(merged.telemetryTime, 123);
  assert.equal(detailCalls.length, 1);
  assert.equal(detailCalls[0].el, anchor);
  assert.equal(detailCalls[0].info.battery, 55.5);
});

test('attachNodeInfoRefreshToMarker surfaces errors with fallback overlays', async () => {
  const anchor = { id: 'anchor' };
  const marker = createFakeMarker(anchor);
  let token = 0;
  let errorCaptured = null;
  let detailCalls = 0;
  let updateCalls = 0;

  attachNodeInfoRefreshToMarker({
    marker,
    getOverlayFallback: () => ({ nodeId: '!oops', shortName: 'Oops' }),
    refreshNodeInformation: async () => {
      throw new Error('boom');
    },
    mergeOverlayDetails: (primary, fallback) => ({ ...fallback, ...primary }),
    createRequestToken: el => {
      assert.equal(el, anchor);
      return ++token;
    },
    isTokenCurrent: (el, candidate) => {
      assert.equal(el, anchor);
      return candidate === token;
    },
    showLoading: () => {},
    showDetails: () => {
      detailCalls += 1;
    },
    showError: (el, info, error) => {
      assert.equal(el, anchor);
      assert.equal(info.nodeId, '!oops');
      errorCaptured = error;
    },
    updatePopup: () => {
      updateCalls += 1;
    },
  });

  marker.trigger('click', { originalEvent: {} });
  await new Promise(resolve => setImmediate(resolve));

  assert.ok(errorCaptured instanceof Error);
  assert.equal(errorCaptured.message, 'boom');
  assert.equal(detailCalls, 0);
  assert.equal(updateCalls, 2);
});

test('attachNodeInfoRefreshToMarker skips refresh when identifiers are missing', async () => {
  const anchor = { id: 'anchor' };
  const marker = createFakeMarker(anchor);
  let token = 0;
  let refreshed = false;
  let detailsShown = 0;

  attachNodeInfoRefreshToMarker({
    marker,
    getOverlayFallback: () => ({ shortName: 'Unknown' }),
    refreshNodeInformation: async () => {
      refreshed = true;
    },
    mergeOverlayDetails: (primary, fallback) => ({ ...fallback, ...primary }),
    createRequestToken: el => {
      assert.equal(el, anchor);
      return ++token;
    },
    isTokenCurrent: (el, candidate) => {
      assert.equal(el, anchor);
      return candidate === token;
    },
    showLoading: () => {
      assert.fail('showLoading should not run without identifiers');
    },
    showDetails: (el, info) => {
      assert.equal(el, anchor);
      assert.equal(info.shortName, 'Unknown');
      detailsShown += 1;
    },
  });

  marker.trigger('click', { originalEvent: {} });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(refreshed, false);
  assert.equal(detailsShown, 1);
});

test('attachNodeInfoRefreshToMarker honours shouldHandleClick predicate', async () => {
  const marker = createFakeMarker({ id: 'anchor' });
  let token = 0;
  let refreshed = false;

  attachNodeInfoRefreshToMarker({
    marker,
    getOverlayFallback: () => ({ nodeId: '!skip' }),
    refreshNodeInformation: async () => {
      refreshed = true;
    },
    mergeOverlayDetails: (primary, fallback) => ({ ...fallback, ...primary }),
    createRequestToken: () => ++token,
    isTokenCurrent: (el, candidate) => candidate === token,
    shouldHandleClick: () => false,
  });

  marker.trigger('click', { originalEvent: {} });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(refreshed, false);
});

test('overlayToPopupNode normalises raw overlay payloads', () => {
  const overlay = {
    nodeId: '!foo',
    nodeNum: 42,
    shortName: 'Foo',
    role: 'ROUTER',
    battery: '77.5',
    neighbors: [
      { neighbor_id: '!bar', snr: '12.5', neighbor_short_name: 'Bar' },
      null,
    ],
  };

  const popupNode = overlayToPopupNode(overlay);
  assert.equal(popupNode.node_id, '!foo');
  assert.equal(popupNode.node_num, 42);
  assert.equal(popupNode.short_name, 'Foo');
  assert.equal(popupNode.role, 'ROUTER');
  assert.equal(popupNode.battery_level, 77.5);
  assert.equal(Array.isArray(popupNode.neighbors), true);
  assert.equal(popupNode.neighbors.length, 1);
  assert.equal(popupNode.neighbors[0].node.node_id, '!bar');
  assert.equal(popupNode.neighbors[0].snr, 12.5);
});
