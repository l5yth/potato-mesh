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
 * Simple class list implementation supporting the subset of DOMTokenList
 * behaviour required by the tests.
 */
class MockClassList {
  constructor() {
    this._values = new Set();
  }

  /**
   * Add one or more CSS classes to the element.
   *
   * @param {...string} names Class names to insert into the list.
   * @returns {void}
   */
  add(...names) {
    names.forEach(name => {
      if (name) {
        this._values.add(name);
      }
    });
  }

  /**
   * Remove one or more CSS classes from the element.
   *
   * @param {...string} names Class names to delete from the list.
   * @returns {void}
   */
  remove(...names) {
    names.forEach(name => {
      if (name) {
        this._values.delete(name);
      }
    });
  }

  /**
   * Determine whether the class list currently contains ``name``.
   *
   * @param {string} name Target class name.
   * @returns {boolean} ``true`` when the class is present.
   */
  contains(name) {
    return this._values.has(name);
  }

  /**
   * Toggle the provided class name.
   *
   * @param {string} name Class name to toggle.
   * @param {boolean} [force] Optional forced state mirroring ``DOMTokenList``.
   * @returns {boolean} ``true`` when the class is present after toggling.
   */
  toggle(name, force) {
    if (force === true) {
      this._values.add(name);
      return true;
    }
    if (force === false) {
      this._values.delete(name);
      return false;
    }
    if (this._values.has(name)) {
      this._values.delete(name);
      return false;
    }
    this._values.add(name);
    return true;
  }
}

/**
 * Minimal DOM element implementation exposing the subset of behaviour exercised
 * by the frontend entrypoints.
 */
class MockElement {
  /**
   * @param {string} tagName Element name used for diagnostics.
   * @param {Map<string, MockElement>} registry Storage shared with the
   *   containing document to support ``getElementById``.
   */
  constructor(tagName, registry) {
    this.tagName = tagName.toUpperCase();
    this._registry = registry;
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.textContent = '';
    this.classList = new MockClassList();
    this.childNodes = [];
  }

  /**
   * Associate an attribute with the element.
   *
   * @param {string} name Attribute identifier.
   * @param {string} value Attribute value.
   * @returns {void}
   */
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'id' && this._registry) {
      this._registry.set(String(value), this);
    }
  }

  /**
   * Retrieve an attribute value.
   *
   * @param {string} name Attribute identifier.
   * @returns {?string} Matching attribute or ``null`` when absent.
   */
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  /**
   * Remove an attribute from the element.
   *
   * @param {string} name Attribute identifier.
   * @returns {void}
   */
  removeAttribute(name) {
    this.attributes.delete(name);
  }

  /**
   * Append a child node to this element.
   *
   * @param {Object} node Child node to append.
   * @returns {Object} Appended node.
   */
  appendChild(node) {
    this.childNodes.push(node);
    return node;
  }

  /**
   * Replace all existing children with the provided nodes.
   *
   * @param {...Object} nodes Child nodes to set on the element.
   * @returns {void}
   */
  replaceChildren(...nodes) {
    const expanded = [];
    nodes.forEach(node => {
      if (node && node.tagName === 'FRAGMENT' && Array.isArray(node.childNodes)) {
        expanded.push(...node.childNodes);
      } else {
        expanded.push(node);
      }
    });
    this.childNodes = expanded;
  }

  /**
   * Serialize the element's children into a naive HTML string for test
   * assertions. This intentionally covers only the subset of markup produced
   * in unit tests.
   *
   * @returns {string} Serialized HTML content.
   */
  get innerHTML() {
    return this.childNodes
      .map(node => {
        if (typeof node === 'string') return node;
        if (node && node.tagName) {
          const attrs = [];
          if (node.attributes.size) {
            node.attributes.forEach((value, key) => {
              attrs.push(`${key}="${value}"`);
            });
          }
          const classAttr = node.classList && node.classList._values && node.classList._values.size
            ? `class="${Array.from(node.classList._values).join(' ')}"`
            : null;
          if (classAttr) attrs.push(classAttr);
          const children = node.innerHTML || '';
          return `<${node.tagName.toLowerCase()}${attrs.length ? ' ' + attrs.join(' ') : ''}>${children}</${node.tagName.toLowerCase()}>`;
        }
        return '';
      })
      .join('');
  }

  /**
   * Setter to overwrite children from a raw HTML string in tests. This is a
   * minimal stub and only supports plain text content insertion.
   *
   * @param {string} value Raw HTML content.
   * @returns {void}
   */
  set innerHTML(value) {
    this.childNodes = [String(value)];
  }

  /**
   * Very small querySelectorAll implementation that supports ``.class`` lookups
   * used in unit tests.
   *
   * @param {string} selector CSS selector (class names only).
   * @returns {Array<MockElement>} Matching child nodes.
   */
  querySelectorAll(selector) {
    if (!selector || typeof selector !== 'string') return [];
    const classMatch = selector.match(/^\.(.+)$/);
    if (!classMatch) return [];
    const className = classMatch[1];
    const matches = [];
    const visit = node => {
      if (node && node.classList && typeof node.classList.contains === 'function') {
        if (node.classList.contains(className)) {
          matches.push(node);
        }
      }
      if (node && Array.isArray(node.childNodes)) {
        node.childNodes.forEach(child => visit(child));
      }
    };
    visit(this);
    return matches;
  }
}

/**
 * Create a deterministic DOM environment that provides just enough behaviour
 * for the UI scripts to execute inside Node.js unit tests.
 *
 * @param {{
 *   readyState?: 'loading' | 'interactive' | 'complete',
 *   cookie?: string,
 *   includeBody?: boolean,
 *   bodyHasDarkClass?: boolean
 * }} [options]
 * @returns {{
 *   window: Window & { dispatchEvent: Function },
 *   document: Document,
 *   createElement: (tagName?: string, id?: string) => MockElement,
 *   registerElement: (id: string, element: MockElement) => void,
 *   setComputedStyleImplementation: (impl: Function) => void,
 *   triggerDOMContentLoaded: () => void,
 *   dispatchWindowEvent: (event: string) => void,
 *   getCookieString: () => string,
 *   setCookieString: (value: string) => void,
 *   cleanup: () => void
 * }}
 */
export function createDomEnvironment(options = {}) {
  const {
    readyState = 'complete',
    cookie = '',
    includeBody = true,
    bodyHasDarkClass = true
  } = options;

  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;

  const registry = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  let computedStyleImpl = null;
  let cookieStore = cookie;

  const document = {
    readyState,
    documentElement: new MockElement('html', registry),
    body: includeBody ? new MockElement('body', registry) : null,
    addEventListener(event, handler) {
      documentListeners.set(event, handler);
    },
    removeEventListener(event) {
      documentListeners.delete(event);
    },
    dispatchEvent(event) {
      const key = typeof event === 'string' ? event : event?.type;
      const handler = documentListeners.get(key);
      if (handler) handler(event);
    },
    getElementById(id) {
      return registry.get(id) || null;
    },
    querySelector() {
      return null;
    },
    createElement(tagName) {
      return new MockElement(tagName, registry);
    },
    createDocumentFragment() {
      const fragment = new MockElement('fragment', null);
      fragment.childNodes = [];
      fragment.appendChild = node => {
        fragment.childNodes.push(node);
        return node;
      };
      fragment.replaceChildren = (...nodes) => {
        fragment.childNodes = [...nodes];
      };
      return fragment;
    }
  };

  if (document.body && bodyHasDarkClass) {
    document.body.classList.add('dark');
  }

  Object.defineProperty(document, 'cookie', {
    get() {
      return cookieStore;
    },
    set(value) {
      cookieStore = cookieStore ? `${cookieStore}; ${value}` : value;
    }
  });

  const window = {
    document,
    addEventListener(event, handler) {
      windowListeners.set(event, handler);
    },
    removeEventListener(event) {
      windowListeners.delete(event);
    },
    dispatchEvent(event) {
      const key = typeof event === 'string' ? event : event?.type;
      const handler = windowListeners.get(key);
      if (handler) handler(event);
    },
    getComputedStyle(target) {
      if (typeof computedStyleImpl === 'function') {
        return computedStyleImpl(target);
      }
      return {
        getPropertyValue() {
          return '';
        }
      };
    }
  };

  globalThis.window = window;
  globalThis.document = document;

  /**
   * Create and optionally register a mock element.
   *
   * @param {string} [tagName='div'] Tag name of the element.
   * @param {string} [id] Optional identifier registered with the document.
   * @returns {MockElement} New mock element instance.
   */
  function createElement(tagName = 'div', id) {
    const element = new MockElement(tagName, registry);
    if (id) {
      element.setAttribute('id', id);
    }
    return element;
  }

  /**
   * Register an element instance so that ``getElementById`` can resolve it.
   *
   * @param {string} id Element identifier.
   * @param {MockElement} element Element instance to register.
   * @returns {void}
   */
  function registerElement(id, element) {
    registry.set(id, element);
  }

  return {
    window,
    document,
    createElement,
    registerElement,
    setComputedStyleImplementation(impl) {
      computedStyleImpl = impl;
    },
    triggerDOMContentLoaded() {
      const handler = documentListeners.get('DOMContentLoaded');
      if (handler) handler();
    },
    dispatchWindowEvent(event) {
      const handler = windowListeners.get(event);
      if (handler) handler();
    },
    getCookieString() {
      return cookieStore;
    },
    setCookieString(value) {
      cookieStore = value;
    },
    cleanup() {
      globalThis.window = originalWindow;
      globalThis.document = originalDocument;
    }
  };
}
