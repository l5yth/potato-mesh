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

import { __test__ } from '../mobile-menu.js';

const { createMobileMenuController } = __test__;

function createClassList() {
  const values = new Set();
  return {
    add(...names) {
      names.forEach(name => values.add(name));
    },
    remove(...names) {
      names.forEach(name => values.delete(name));
    },
    contains(name) {
      return values.has(name);
    }
  };
}

function createElement(tagName = 'div') {
  const listeners = new Map();
  const attributes = new Map();
  return {
    tagName: tagName.toUpperCase(),
    attributes,
    classList: createClassList(),
    dataset: {},
    hidden: false,
    parentNode: null,
    nextSibling: null,
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    addEventListener(event, handler) {
      listeners.set(event, handler);
    },
    dispatchEvent(event) {
      const key = typeof event === 'string' ? event : event?.type;
      const handler = listeners.get(key);
      if (handler) {
        handler(event);
      }
    },
    appendChild(node) {
      this.lastAppended = node;
      return node;
    },
    insertBefore(node, nextSibling) {
      this.lastInserted = { node, nextSibling };
      return node;
    },
    focus() {
      globalThis.document.activeElement = this;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
}

function createDomStub() {
  const originalDocument = globalThis.document;
  const registry = new Map();
  const documentStub = {
    body: createElement('body'),
    activeElement: null,
    getElementById(id) {
      return registry.get(id) || null;
    }
  };
  globalThis.document = documentStub;
  return {
    documentStub,
    registry,
    cleanup() {
      globalThis.document = originalDocument;
    }
  };
}

function createWindowStub(matches = true) {
  const listeners = new Map();
  return {
    matchMedia() {
      return {
        matches,
        addEventListener(event, handler) {
          listeners.set(event, handler);
        }
      };
    },
    addEventListener(event, handler) {
      listeners.set(event, handler);
    }
  };
}

test('mobile menu toggles open state and aria-expanded', () => {
  const { documentStub, registry, cleanup } = createDomStub();
  const windowStub = createWindowStub(true);

  const menuToggle = createElement('button');
  const menu = createElement('div');
  const menuPanel = createElement('div');
  const menuControls = createElement('div');
  const closeButton = createElement('button');
  const navLink = createElement('a');
  const metaRow = createElement('div');

  menu.hidden = true;
  menuPanel.classList.add('mobile-menu__panel');

  menu.querySelector = selector => {
    if (selector === '.mobile-menu__panel') return menuPanel;
    if (selector === '[data-mobile-controls]') return menuControls;
    return null;
  };
  menu.querySelectorAll = selector => {
    if (selector === '[data-mobile-menu-close]') return [closeButton];
    if (selector === 'a') return [navLink];
    return [];
  };
  menuPanel.querySelectorAll = () => [closeButton, navLink];

  registry.set('mobileMenuToggle', menuToggle);
  registry.set('mobileMenu', menu);
  registry.set('metaRow', metaRow);

  try {
    const controller = createMobileMenuController({
      documentObject: documentStub,
      windowObject: windowStub
    });

    controller.initialize();

    menuToggle.dispatchEvent({ type: 'click', preventDefault() {} });
    assert.equal(menu.hidden, false);
    assert.equal(menuToggle.getAttribute('aria-expanded'), 'true');
    assert.equal(documentStub.body.classList.contains('menu-open'), true);

    closeButton.dispatchEvent({ type: 'click' });
    assert.equal(menu.hidden, true);
    assert.equal(menuToggle.getAttribute('aria-expanded'), 'false');
  } finally {
    cleanup();
  }
});
