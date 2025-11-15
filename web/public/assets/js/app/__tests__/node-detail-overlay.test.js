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

import { createNodeDetailOverlayManager } from '../node-detail-overlay.js';

function createOverlayHarness() {
  const overlayListeners = new Map();
  const documentListeners = new Map();
  const content = { innerHTML: '' };
  const closeButton = {
    listeners: new Map(),
    focusCalled: false,
    addEventListener(event, handler) {
      this.listeners.set(event, handler);
    },
    click() {
      const handler = this.listeners.get('click');
      if (handler) handler({ preventDefault() {} });
    },
    focus() {
      this.focusCalled = true;
    },
  };
  const dialog = {
    focusCalled: false,
    focus() {
      this.focusCalled = true;
    },
  };
  const overlay = {
    hidden: true,
    style: {},
    addEventListener(event, handler) {
      overlayListeners.set(event, handler);
    },
    trigger(event, payload) {
      const handler = overlayListeners.get(event);
      if (handler) handler(payload);
    },
    querySelector(selector) {
      if (selector === '.node-detail-overlay__dialog') return dialog;
      if (selector === '.node-detail-overlay__close') return closeButton;
      if (selector === '.node-detail-overlay__content') return content;
      return null;
    },
  };
  const body = {
    style: {
      overflow: '',
      removeProperty(prop) {
        this[prop] = '';
      },
    },
  };
  const document = {
    body,
    getElementById(id) {
      return id === 'nodeDetailOverlay' ? overlay : null;
    },
    addEventListener(event, handler) {
      documentListeners.set(event, handler);
    },
    removeEventListener(event) {
      documentListeners.delete(event);
    },
    triggerKeydown(key) {
      const handler = documentListeners.get('keydown');
      if (handler) {
        handler({ key, preventDefault() {} });
      }
    },
  };
  return { document, overlay, content, closeButton };
}

test('createNodeDetailOverlayManager renders fetched markup and restores focus', async () => {
  const { document, overlay, content, closeButton } = createOverlayHarness();
  const focusTarget = {
    focusCalled: false,
    focus() {
      this.focusCalled = true;
    },
  };
  const manager = createNodeDetailOverlayManager({
    document,
    fetchNodeDetail: async reference => `<section class="node-detail">${reference.nodeId}</section>`,
  });
  assert.ok(manager);
  await manager.open({ nodeId: '!alpha' }, { trigger: focusTarget, label: 'Alpha' });
  assert.equal(overlay.hidden, false);
  assert.equal(content.innerHTML.includes('!alpha'), true);
  assert.equal(closeButton.focusCalled, true);
  manager.close();
  assert.equal(overlay.hidden, true);
  assert.equal(focusTarget.focusCalled, true);
});

test('createNodeDetailOverlayManager surfaces errors and supports escape closing', async () => {
  const { document, overlay, content } = createOverlayHarness();
  const errors = [];
  const manager = createNodeDetailOverlayManager({
    document,
    fetchNodeDetail: async () => {
      throw new Error('boom');
    },
    logger: {
      error(err) {
        errors.push(err);
      },
    },
  });
  assert.ok(manager);
  await manager.open({ nodeId: '!fail' });
  assert.equal(content.innerHTML.includes('Failed to load node details.'), true);
  assert.equal(errors.length, 1);
  document.triggerKeydown?.('Escape');
  assert.equal(overlay.hidden, true);
});
