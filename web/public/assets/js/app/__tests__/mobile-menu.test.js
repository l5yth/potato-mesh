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

import { __test__, initializeMobileMenu } from '../mobile-menu.js';

const { createMobileMenuController, resolveFocusableElements } = __test__;

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

function createElement(tagName = 'div', initialId = '') {
  const listeners = new Map();
  const attributes = new Map();
  if (initialId) {
    attributes.set('id', String(initialId));
  }
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
    querySelectorAll() {
      return [];
    },
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
  const mediaListeners = new Map();
  return {
    matchMedia() {
      return {
        matches,
        addEventListener(event, handler) {
          mediaListeners.set(event, handler);
        }
      };
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
    dispatchMediaChange() {
      const handler = mediaListeners.get('change');
      if (handler) {
        handler();
      }
    }
  };
}

function createWindowStubWithListener(matches = true) {
  const listeners = new Map();
  let mediaHandler = null;
  return {
    matchMedia() {
      return {
        matches,
        addListener(handler) {
          mediaHandler = handler;
        }
      };
    },
    addEventListener(event, handler) {
      listeners.set(event, handler);
    },
    dispatchMediaChange() {
      if (mediaHandler) {
        mediaHandler();
      }
    }
  };
}

test('mobile menu toggles open state and aria-expanded', () => {
  const { documentStub, registry, cleanup } = createDomStub();
  const windowStub = createWindowStub(true);

  const menuToggle = createElement('button');
  const menu = createElement('div');
  const menuPanel = createElement('div');
  const closeButton = createElement('button');
  const navLink = createElement('a');

  menu.hidden = true;
  menuPanel.classList.add('mobile-menu__panel');

  menu.querySelector = selector => {
    if (selector === '.mobile-menu__panel') return menuPanel;
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

  try {
    const controller = createMobileMenuController({
      documentObject: documentStub,
      windowObject: windowStub
    });

    controller.initialize();
    windowStub.dispatchMediaChange();

    menuToggle.dispatchEvent({ type: 'click', preventDefault() {} });
    assert.equal(menu.hidden, false);
    assert.equal(menuToggle.getAttribute('aria-expanded'), 'true');
    assert.equal(documentStub.body.classList.contains('menu-open'), true);

    navLink.dispatchEvent({ type: 'click' });
    assert.equal(menu.hidden, true);

    closeButton.dispatchEvent({ type: 'click' });
    assert.equal(menu.hidden, true);
    assert.equal(menuToggle.getAttribute('aria-expanded'), 'false');
  } finally {
    cleanup();
  }
});

test('mobile menu closes on escape and route changes', () => {
  const { documentStub, registry, cleanup } = createDomStub();
  const windowStub = createWindowStub(true);

  const menuToggle = createElement('button');
  const menu = createElement('div');
  const menuPanel = createElement('div');
  const closeButton = createElement('button');

  menu.hidden = true;
  menuPanel.classList.add('mobile-menu__panel');

  menu.querySelector = selector => {
    if (selector === '.mobile-menu__panel') return menuPanel;
    return null;
  };
  menu.querySelectorAll = selector => {
    if (selector === '[data-mobile-menu-close]') return [closeButton];
    return [];
  };
  menuPanel.querySelectorAll = () => [closeButton];

  registry.set('mobileMenuToggle', menuToggle);
  registry.set('mobileMenu', menu);

  try {
    const controller = createMobileMenuController({
      documentObject: documentStub,
      windowObject: windowStub
    });

    controller.initialize();

    menuPanel.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
    assert.equal(menu.hidden, true);

    menuToggle.dispatchEvent({ type: 'click', preventDefault() {} });
    assert.equal(menu.hidden, false);

    menuPanel.dispatchEvent({ type: 'keydown', key: 'ArrowDown' });
    assert.equal(menu.hidden, false);

    menuPanel.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
    assert.equal(menu.hidden, true);

    menuToggle.dispatchEvent({ type: 'click', preventDefault() {} });
    windowStub.dispatchEvent({ type: 'hashchange' });
    assert.equal(menu.hidden, true);

    menuToggle.dispatchEvent({ type: 'click', preventDefault() {} });
    windowStub.dispatchEvent({ type: 'popstate' });
    assert.equal(menu.hidden, true);
  } finally {
    cleanup();
  }
});

test('mobile menu traps focus within the panel', () => {
  const { documentStub, registry, cleanup } = createDomStub();
  const windowStub = createWindowStub(true);

  const menuToggle = createElement('button');
  const menu = createElement('div');
  const menuPanel = createElement('div');
  const firstLink = createElement('a');
  const lastButton = createElement('button');

  menuPanel.classList.add('mobile-menu__panel');
  menuPanel.querySelectorAll = () => [firstLink, lastButton];
  menu.querySelector = selector => {
    if (selector === '.mobile-menu__panel') return menuPanel;
    return null;
  };
  menu.querySelectorAll = () => [];

  registry.set('mobileMenuToggle', menuToggle);
  registry.set('mobileMenu', menu);

  try {
    const controller = createMobileMenuController({
      documentObject: documentStub,
      windowObject: windowStub
    });

    controller.initialize();
    menuToggle.dispatchEvent({ type: 'click', preventDefault() {} });

    documentStub.activeElement = lastButton;
    menuPanel.dispatchEvent({ type: 'keydown', key: 'Tab', preventDefault() {}, shiftKey: false });
    assert.equal(documentStub.activeElement, firstLink);

    documentStub.activeElement = firstLink;
    menuPanel.dispatchEvent({ type: 'keydown', key: 'Tab', preventDefault() {}, shiftKey: true });
    assert.equal(documentStub.activeElement, lastButton);
  } finally {
    cleanup();
  }
});

test('resolveFocusableElements filters out aria-hidden nodes', () => {
  const hiddenButton = createElement('button');
  hiddenButton.getAttribute = name => (name === 'aria-hidden' ? 'true' : null);
  const openLink = createElement('a');
  const bareNode = { tagName: 'DIV' };
  const container = {
    querySelectorAll() {
      return [hiddenButton, bareNode, openLink];
    }
  };

  const focusables = resolveFocusableElements(container);
  assert.equal(focusables.length, 1);
  assert.equal(focusables[0], openLink);
});

test('resolveFocusableElements handles empty containers', () => {
  assert.deepEqual(resolveFocusableElements(null), []);
  assert.deepEqual(resolveFocusableElements({}), []);
});

test('mobile menu focuses the panel when no focusables exist', () => {
  const { documentStub, registry, cleanup } = createDomStub();
  const windowStub = createWindowStub(true);

  const menuToggle = createElement('button');
  const menu = createElement('div');
  const menuPanel = createElement('div');
  const lastActive = createElement('button');

  menuPanel.classList.add('mobile-menu__panel');
  menuPanel.querySelectorAll = () => [];
  menu.querySelector = selector => {
    if (selector === '.mobile-menu__panel') return menuPanel;
    return null;
  };
  menu.querySelectorAll = () => [];

  registry.set('mobileMenuToggle', menuToggle);
  registry.set('mobileMenu', menu);
  documentStub.activeElement = lastActive;

  try {
    const controller = createMobileMenuController({
      documentObject: documentStub,
      windowObject: windowStub
    });

    controller.initialize();
    menuToggle.dispatchEvent({ type: 'click', preventDefault() {} });
    assert.equal(documentStub.activeElement, menuPanel);

    menuToggle.dispatchEvent({ type: 'click', preventDefault() {} });
    assert.equal(documentStub.activeElement, lastActive);
  } finally {
    cleanup();
  }
});

test('mobile menu registers legacy media query listeners', () => {
  const { documentStub, registry, cleanup } = createDomStub();
  const windowStub = createWindowStubWithListener(true);

  const menuToggle = createElement('button');
  const menu = createElement('div');
  const menuPanel = createElement('div');

  menuPanel.classList.add('mobile-menu__panel');
  menu.querySelector = selector => {
    if (selector === '.mobile-menu__panel') return menuPanel;
    return null;
  };
  menu.querySelectorAll = () => [];

  registry.set('mobileMenuToggle', menuToggle);
  registry.set('mobileMenu', menu);

  try {
    const controller = createMobileMenuController({
      documentObject: documentStub,
      windowObject: windowStub
    });

    controller.initialize();
    windowStub.dispatchMediaChange();
    assert.equal(menuToggle.getAttribute('aria-expanded'), 'false');
  } finally {
    cleanup();
  }
});

test('mobile menu safely no-ops without required nodes', () => {
  const { documentStub, cleanup } = createDomStub();
  const windowStub = createWindowStub(true);

  try {
    const controller = createMobileMenuController({
      documentObject: documentStub,
      windowObject: windowStub
    });

    controller.initialize();
    controller.openMenu();
    controller.closeMenu();
    controller.syncLayout();
    assert.equal(documentStub.body.classList.contains('menu-open'), false);
  } finally {
    cleanup();
  }
});

test('initializeMobileMenu returns a controller', () => {
  const { documentStub, registry, cleanup } = createDomStub();
  const windowStub = createWindowStub(true);

  const menuToggle = createElement('button');
  const menu = createElement('div');
  const menuPanel = createElement('div');

  menuPanel.classList.add('mobile-menu__panel');
  menu.querySelector = selector => {
    if (selector === '.mobile-menu__panel') return menuPanel;
    return null;
  };
  menu.querySelectorAll = () => [];

  registry.set('mobileMenuToggle', menuToggle);
  registry.set('mobileMenu', menu);

  try {
    const controller = initializeMobileMenu({
      documentObject: documentStub,
      windowObject: windowStub
    });
    assert.equal(typeof controller.openMenu, 'function');
  } finally {
    cleanup();
  }
});
