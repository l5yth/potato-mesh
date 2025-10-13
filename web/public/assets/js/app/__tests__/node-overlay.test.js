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

import { createNodeOverlayController } from '../node-overlay.js';

/**
 * Minimal class list implementation to back stub elements.
 */
class StubClassList {
  constructor(owner) {
    this._owner = owner;
    this._values = new Set();
  }

  setFromString(value) {
    this._values = new Set((value || '').split(/\s+/).filter(Boolean));
    this._sync();
  }

  add(...names) {
    names.filter(Boolean).forEach(name => this._values.add(name));
    this._sync();
  }

  remove(...names) {
    names.filter(Boolean).forEach(name => this._values.delete(name));
    this._sync();
  }

  contains(name) {
    return this._values.has(name);
  }

  _sync() {
    this._owner._className = Array.from(this._values).join(' ');
  }
}

/**
 * Lightweight stand-in for DOM elements with event support.
 */
class StubElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this._className = '';
    this.classList = new StubClassList(this);
    this.attributes = new Map();
    this.eventHandlers = new Map();
    this._href = '';
    this._src = '';
  }

  set className(value) {
    this.classList.setFromString(String(value || ''));
  }

  get className() {
    return this._className;
  }

  set href(value) {
    this._href = String(value);
  }

  get href() {
    return this._href;
  }

  set src(value) {
    this._src = String(value);
  }

  get src() {
    return this._src;
  }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') {
      this.className = value;
    }
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  addEventListener(type, handler) {
    if (!this.eventHandlers.has(type)) {
      this.eventHandlers.set(type, []);
    }
    this.eventHandlers.get(type).push(handler);
  }

  dispatchEvent(event) {
    const handlers = this.eventHandlers.get(event.type) || [];
    const evt = event;
    if (!evt.preventDefault) {
      evt.preventDefault = () => {
        evt.defaultPrevented = true;
      };
    }
    if (typeof evt.defaultPrevented !== 'boolean') {
      evt.defaultPrevented = Boolean(evt.defaultPrevented);
    }
    evt.target = this;
    handlers.forEach(handler => handler(evt));
    return !evt.defaultPrevented;
  }

  focus() {
    if (this.ownerDocument) {
      this.ownerDocument.activeElement = this;
    }
  }
}

/**
 * Construct a stubbed document for overlay testing.
 *
 * @returns {{ document: Document, body: StubElement, createClickEvent: Function, triggerKey: Function }}
 */
function createStubDocument() {
  const handlers = new Map();
  const doc = {
    body: null,
    activeElement: null,
    eventHandlers: handlers,
    createElement(tag) {
      return new StubElement(tag, doc);
    },
    addEventListener(type, handler) {
      handlers.set(type, handler);
    },
    removeEventListener(type) {
      handlers.delete(type);
    },
    dispatchEvent(event) {
      const handler = handlers.get(event.type);
      if (handler) handler(event);
    }
  };
  doc.body = new StubElement('body', doc);

  function createClickEvent(overrides = {}) {
    return {
      type: 'click',
      button: overrides.button ?? 0,
      ctrlKey: Boolean(overrides.ctrlKey),
      metaKey: Boolean(overrides.metaKey),
      shiftKey: Boolean(overrides.shiftKey),
      altKey: Boolean(overrides.altKey),
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      }
    };
  }

  function triggerKey(key) {
    const handler = handlers.get('keydown');
    if (handler) {
      handler({ key });
    }
  }

  return { document: doc, body: doc.body, createClickEvent, triggerKey };
}

test('returns no-op controller without a document', () => {
  const controller = createNodeOverlayController();
  assert.equal(controller.isOpen(), false);
  assert.doesNotThrow(() => controller.open('/node/1'));
  assert.doesNotThrow(() => controller.close());
});

test('opens an overlay when a link is activated', () => {
  const env = createStubDocument();
  const controller = createNodeOverlayController({ document: env.document });
  const link = env.document.createElement('a');
  link.href = '/node/alpha';
  env.body.appendChild(link);
  controller.attach(link);

  const event = env.createClickEvent();
  link.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  const overlay = env.body.children.find(child => child.className === 'node-overlay');
  assert.ok(overlay, 'overlay should be appended to the body');
  assert.equal(overlay.hidden, false);
  const iframe = overlay.children[0].children.find(child => child.className === 'node-overlay__frame');
  assert.ok(iframe, 'iframe should be present');
  assert.equal(iframe.src, '/node/alpha');
  assert.equal(env.body.classList.contains('node-overlay-open'), true);
});

test('restores focus and hides overlay on close', () => {
  const env = createStubDocument();
  const controller = createNodeOverlayController({ document: env.document });
  const link = env.document.createElement('a');
  link.href = '/node/beta';
  env.body.appendChild(link);
  controller.attach(link);

  link.focus();
  link.dispatchEvent(env.createClickEvent());
  const overlay = env.body.children.find(child => child.className === 'node-overlay');
  controller.close();
  assert.equal(overlay.hidden, true);
  assert.equal(env.body.classList.contains('node-overlay-open'), false);
  assert.equal(env.document.activeElement, link);
});

test('modifier clicks bypass the overlay behaviour', () => {
  const env = createStubDocument();
  const controller = createNodeOverlayController({ document: env.document });
  const link = env.document.createElement('a');
  link.href = '/node/gamma';
  env.body.appendChild(link);
  controller.attach(link);

  const event = env.createClickEvent({ ctrlKey: true });
  link.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
  assert.equal(controller.isOpen(), false);
});

test('escape key closes an open overlay', () => {
  const env = createStubDocument();
  const controller = createNodeOverlayController({ document: env.document });
  const link = env.document.createElement('a');
  link.href = '/node/delta';
  env.body.appendChild(link);
  controller.attach(link);

  link.dispatchEvent(env.createClickEvent());
  assert.equal(controller.isOpen(), true);
  env.triggerKey('Escape');
  assert.equal(controller.isOpen(), false);
});
