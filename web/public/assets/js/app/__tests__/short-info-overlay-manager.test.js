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

import { createShortInfoOverlayStack } from '../short-info-overlay-manager.js';

/**
 * Minimal DOM element implementation tailored for overlay manager tests.
 */
class StubElement {
  /**
   * @param {string} [tagName='div'] Element tag identifier.
   */
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this.className = '';
    this.innerHTML = '';
    this.attributes = new Map();
    this.eventHandlers = new Map();
    this._rect = { left: 0, top: 0, width: 120, height: 80 };
  }

  /**
   * Append ``child`` to the element.
   *
   * @param {StubElement} child Child node to append.
   * @returns {StubElement} Appended node.
   */
  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  /**
   * Remove ``child`` from the element.
   *
   * @param {StubElement} child Child node to remove.
   * @returns {void}
   */
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
  }

  /**
   * Remove the element from its parent tree.
   *
   * @returns {void}
   */
  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  /**
   * Assign an attribute to the element.
   *
   * @param {string} name Attribute identifier.
   * @param {string} value Stored attribute value.
   * @returns {void}
   */
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class' || name === 'className') {
      this.className = String(value);
    }
  }

  /**
   * Remove an attribute from the element.
   *
   * @param {string} name Attribute identifier.
   * @returns {void}
   */
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'class' || name === 'className') {
      this.className = '';
    }
  }

  /**
   * Register an event handler for the element.
   *
   * @param {string} event Event identifier.
   * @param {Function} handler Handler invoked during tests.
   * @returns {void}
   */
  addEventListener(event, handler) {
    this.eventHandlers.set(event, handler);
  }

  /**
   * Retrieve the first descendant matching a simple class selector.
   *
   * @param {string} selector CSS selector (class only).
   * @returns {?StubElement} Matching element or ``null``.
   */
  querySelector(selector) {
    if (!selector || selector[0] !== '.') {
      return null;
    }
    const className = selector.slice(1);
    return this._findByClass(className);
  }

  /**
   * Recursively search for an element with ``className``.
   *
   * @param {string} className Class identifier to match.
   * @returns {?StubElement} Matching element or ``null``.
   */
  _findByClass(className) {
    const classes = (this.className || '').split(/\s+/).filter(Boolean);
    if (classes.includes(className)) {
      return this;
    }
    for (const child of this.children) {
      const found = child._findByClass(className);
      if (found) {
        return found;
      }
    }
    return null;
  }

  /**
   * Determine whether ``candidate`` is a descendant of the element.
   *
   * @param {StubElement} candidate Potential child node.
   * @returns {boolean} ``true`` when the node is contained within the element.
   */
  contains(candidate) {
    if (this === candidate) {
      return true;
    }
    for (const child of this.children) {
      if (child.contains(candidate)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Return the mock bounding rectangle for the element.
   *
   * @returns {{ left: number, top: number, width: number, height: number }}
   */
  getBoundingClientRect() {
    return { ...this._rect };
  }

  /**
   * Override the bounding rectangle used during positioning tests.
   *
   * @param {{ left?: number, top?: number, width?: number, height?: number }} rect
   * @returns {void}
   */
  setBoundingRect(rect) {
    this._rect = { ...this._rect, ...rect };
  }

  /**
   * Create a deep clone of the element.
   *
   * @param {boolean} [deep=false] When ``true`` clone the children as well.
   * @returns {StubElement} Cloned element instance.
   */
  cloneNode(deep = false) {
    const clone = new StubElement(this.tagName);
    clone.className = this.className;
    clone.style = { ...this.style };
    clone.dataset = { ...this.dataset };
    clone.innerHTML = this.innerHTML;
    clone._rect = { ...this._rect };
    clone.attributes = new Map(this.attributes);
    if (deep) {
      for (const child of this.children) {
        clone.appendChild(child.cloneNode(true));
      }
    }
    return clone;
  }

  /**
   * Locate the nearest ancestor carrying ``selector``.
   *
   * @param {string} selector CSS selector (class only).
   * @returns {?StubElement} Matching ancestor or ``null``.
   */
  closest(selector) {
    if (!selector || selector[0] !== '.') {
      return null;
    }
    const className = selector.slice(1);
    let current = this;
    while (current) {
      const classes = (current.className || '').split(/\s+/).filter(Boolean);
      if (classes.includes(className)) {
        return current;
      }
      current = current.parentNode;
    }
    return null;
  }
}

/**
 * Build a minimal DOM document stub for overlay manager tests.
 *
 * @returns {{ document: Document, window: Window, factory: Function, anchor: StubElement, body: StubElement }}
 */
function createStubDom() {
  const body = new StubElement('body');
  body.contains = body.contains.bind(body);
  const listenerMap = new Map();
  const document = {
    body,
    documentElement: { clientWidth: 640, clientHeight: 480 },
    createElement(tagName) {
      return new StubElement(tagName);
    },
    getElementById() {
      return null;
    },
    addEventListener(event, handler) {
      if (!listenerMap.has(event)) {
        listenerMap.set(event, new Set());
      }
      listenerMap.get(event).add(handler);
    },
    removeEventListener(event, handler) {
      if (!listenerMap.has(event)) {
        return;
      }
      listenerMap.get(event).delete(handler);
    },
    _dispatch(event) {
      if (!listenerMap.has(event)) {
        return;
      }
      for (const handler of Array.from(listenerMap.get(event))) {
        handler();
      }
    },
  };
  const window = {
    scrollX: 10,
    scrollY: 20,
    innerWidth: 640,
    innerHeight: 480,
    requestAnimationFrame(callback) {
      callback();
    },
  };
  function factory() {
    const overlay = document.createElement('div');
    overlay.className = 'short-info-overlay';
    const closeButton = document.createElement('button');
    closeButton.className = 'short-info-close';
    const content = document.createElement('div');
    content.className = 'short-info-content';
    overlay.appendChild(closeButton);
    overlay.appendChild(content);
    return { overlay, closeButton, content };
  }
  const anchor = document.createElement('span');
  anchor.setBoundingRect({ left: 40, top: 50, width: 16, height: 16 });
  body.appendChild(anchor);
  return { document, window, factory, anchor, body };
}

test('render opens overlays and positions them relative to anchors', () => {
  const { document, window, factory, anchor, body } = createStubDom();
  const stack = createShortInfoOverlayStack({ document, window, factory });
  stack.render(anchor, '<strong>Node</strong>');
  const open = stack.getOpenOverlays();
  assert.equal(open.length, 1);
  const overlay = open[0].element;
  assert.equal(overlay.parentNode, body);
  assert.equal(overlay.style.position, 'absolute');
  const content = overlay.querySelector('.short-info-content');
  assert.ok(content);
  assert.equal(content.innerHTML, '<strong>Node</strong>');
  assert.equal(overlay.style.left, '50px');
  assert.equal(overlay.style.top, '70px');
});

test('request tokens track anchors independently', () => {
  const { document, window, factory, anchor } = createStubDom();
  const stack = createShortInfoOverlayStack({ document, window, factory });
  const token1 = stack.incrementRequestToken(anchor);
  const token2 = stack.incrementRequestToken(anchor);
  assert.equal(token2, token1 + 1);
  stack.render(anchor, 'Loading…');
  assert.equal(stack.isTokenCurrent(anchor, token2), true);
  stack.close(anchor);
  assert.equal(stack.isTokenCurrent(anchor, token2), false);
});

test('overlays stack and close independently', () => {
  const { document, window, factory, anchor, body } = createStubDom();
  const stack = createShortInfoOverlayStack({ document, window, factory });
  const secondAnchor = document.createElement('span');
  secondAnchor.setBoundingRect({ left: 200, top: 120 });
  body.appendChild(secondAnchor);
  stack.render(anchor, 'First');
  stack.render(secondAnchor, 'Second');
  const open = stack.getOpenOverlays();
  assert.equal(open.length, 2);
  assert.equal(stack.isOpen(anchor), true);
  assert.equal(stack.isOpen(secondAnchor), true);
  stack.close(anchor);
  assert.equal(stack.isOpen(anchor), false);
  assert.equal(stack.isOpen(secondAnchor), true);
  stack.closeAll();
  assert.equal(stack.getOpenOverlays().length, 0);
});

test('cleanupOrphans removes overlays whose anchors disappear', () => {
  const { document, window, factory, anchor } = createStubDom();
  const stack = createShortInfoOverlayStack({ document, window, factory });
  stack.render(anchor, 'Orphaned');
  anchor.remove();
  stack.cleanupOrphans();
  assert.equal(stack.getOpenOverlays().length, 0);
});

test('containsNode recognises overlay descendants', () => {
  const { document, window, factory, anchor } = createStubDom();
  const stack = createShortInfoOverlayStack({ document, window, factory });
  stack.render(anchor, 'Descendant');
  const [entry] = stack.getOpenOverlays();
  const content = entry.element.querySelector('.short-info-content');
  assert.ok(stack.containsNode(content));
  const stray = new StubElement('div');
  assert.equal(stack.containsNode(stray), false);
});

test('overlays migrate into and out of fullscreen hosts', () => {
  const { document, window, factory, anchor, body } = createStubDom();
  const fullscreenRoot = document.createElement('div');
  body.appendChild(fullscreenRoot);
  const stack = createShortInfoOverlayStack({ document, window, factory });
  stack.render(anchor, 'Fullscreen');
  const [entry] = stack.getOpenOverlays();
  assert.equal(entry.element.parentNode, body);
  assert.equal(entry.element.style.position, 'absolute');

  document.fullscreenElement = fullscreenRoot;
  document._dispatch('fullscreenchange');
  assert.equal(entry.element.parentNode, fullscreenRoot);
  assert.equal(entry.element.style.position, 'fixed');
  assert.equal(entry.element.style.left, '40px');
  assert.equal(entry.element.style.top, '50px');

  document.fullscreenElement = null;
  document._dispatch('fullscreenchange');
  assert.equal(entry.element.parentNode, body);
  assert.equal(entry.element.style.position, 'absolute');
  assert.equal(entry.element.style.left, '50px');
  assert.equal(entry.element.style.top, '70px');
});

test('rendered overlays do not swallow click events by default', () => {
  const { document, window, factory, anchor } = createStubDom();
  const stack = createShortInfoOverlayStack({ document, window, factory });
  stack.render(anchor, 'Event test');
  const [entry] = stack.getOpenOverlays();
  assert.ok(entry);
  assert.equal(entry.element.eventHandlers.has('click'), false);
});
