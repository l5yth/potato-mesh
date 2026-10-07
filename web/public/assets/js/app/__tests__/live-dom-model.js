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
 * Test-local live DOM model for the keyed nodes-table tests (#881, SPEC DR5).
 *
 * The shared `dom-environment.js` mock keeps children in a plain array and
 * stores `innerHTML` as one opaque string, so it cannot tell a kept row from a
 * rebuilt one and has no focus or selection. This model adds what the
 * reconciliation tests need to observe the browser behaviour #881 is about:
 *
 * - a real tree: `parentNode`, sibling links, `insertBefore`, `removeChild`,
 *   `replaceChildren`, `remove` and `moveBefore`;
 * - an `innerHTML` setter that parses the markup the table renders;
 * - removal accounting per parent: every detach counts, a move by
 *   `insertBefore` included, exactly as a `MutationObserver` reports it;
 * - the browser's focus fix-up: detaching the focused element (or an
 *   ancestor) drops focus to `<body>`, while `moveBefore` keeps it;
 * - a selection that collapses when its element leaves the tree or moves
 *   (measured in Chromium 153: both `insertBefore` and `moveBefore` drop it);
 * - row geometry for page-scroll anchoring: the rows of one tbody stack at a
 *   fixed height under a configurable table top, hidden rows take no space.
 *
 * Only the selector forms the dashboard and these tests use are supported:
 * `tag`, `#id`, `.class`, `[attr]`, `[attr="value"]`, compounds of those, the
 * descendant combinator and comma lists. A quoted value may carry the CSS
 * escapes `cssEscape` emits without `CSS.escape` (see {@link decodeCssEscapes});
 * hex escapes, and whitespace or a comma inside a value, are not supported.
 *
 * @module app/__tests__/live-dom-model
 */

import { inspect } from 'node:util';

import { createDomEnvironment } from './dom-environment.js';

/** Elements the HTML parser closes implicitly (no end tag). */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
]);

/** Named character references the rendered table markup uses. */
const NAMED_ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—',
});

/**
 * Decode the character references of one text or attribute run.
 *
 * @param {string} text Raw markup text.
 * @returns {string} Decoded text.
 */
function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : match;
  });
}

/**
 * Escape text for serialisation.
 *
 * @param {string} text Raw text.
 * @param {boolean} attribute Whether the text is an attribute value.
 * @returns {string} Escaped text.
 */
function encodeText(text, attribute) {
  const escaped = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return attribute ? escaped.replace(/"/g, '&quot;') : escaped;
}

/**
 * Convert a `dataset` property name to its `data-*` attribute name.
 *
 * @param {string} prop camelCase dataset key.
 * @returns {string} Attribute name.
 */
function datasetAttribute(prop) {
  return `data-${String(prop).replace(/[A-Z]/g, ch => `-${ch.toLowerCase()}`)}`;
}

/**
 * Decode the CSS escapes of one quoted selector value, as a browser reads it:
 * a backslash before a character that is neither a hex digit nor whitespace
 * stands for that character (`\"` is `"`, `\!` is `!`). That is the only form
 * `cssEscape` (`main/format-utils.js`) emits without `CSS.escape`; the
 * selector grammar in {@link parseCompound} admits no other.
 *
 * @param {string} value Quoted value without its quotes.
 * @returns {string} The value the selector compares attributes against.
 */
function decodeCssEscapes(value) {
  return value.replace(/\\([\s\S])/g, '$1');
}

/**
 * Parse one compound selector (`tr.nodes-subrow[data-x="y"]`). A quoted
 * attribute value is compared with its CSS escapes decoded
 * ({@link decodeCssEscapes}); a raw `"` inside it ends the value, so the rest
 * of the selector fails to parse, as in a browser.
 *
 * @param {string} source Compound selector text.
 * @returns {{tag: ?string, id: ?string, classes: Array<string>, attrs: Array<{name: string, value: ?string}>}}
 *   Parsed parts.
 * @throws {Error} When the selector uses an unsupported form.
 */
function parseCompound(source) {
  const parts = { tag: null, id: null, classes: [], attrs: [] };
  let rest = source;
  const tag = /^([a-zA-Z][a-zA-Z0-9-]*|\*)/.exec(rest);
  if (tag) {
    parts.tag = tag[1] === '*' ? null : tag[1].toUpperCase();
    rest = rest.slice(tag[0].length);
  }
  // A quoted value runs to the first unescaped `"`; each backslash escapes
  // the next character, which must not be a hex digit or whitespace.
  const simple = /^(?:\.([a-zA-Z0-9_-]+)|#([a-zA-Z0-9_-]+)|\[([a-zA-Z0-9_-]+)(?:="((?:[^"\\]|\\[^0-9a-fA-F\s])*)")?\])/;
  while (rest.length) {
    const match = simple.exec(rest);
    if (!match) throw new Error(`live-dom-model: unsupported selector "${source}"`);
    if (match[1]) parts.classes.push(match[1]);
    else if (match[2]) parts.id = match[2];
    else parts.attrs.push({ name: match[3], value: match[4] === undefined ? null : decodeCssEscapes(match[4]) });
    rest = rest.slice(match[0].length);
  }
  return parts;
}

/**
 * Test one element against a parsed compound selector.
 *
 * @param {LiveElement} el Candidate element.
 * @param {ReturnType<typeof parseCompound>} parts Parsed selector.
 * @returns {boolean} Whether the element matches.
 */
function matchesCompound(el, parts) {
  if (!el || el.nodeType !== 1) return false;
  if (parts.tag && el.tagName !== parts.tag) return false;
  if (parts.id && el.getAttribute('id') !== parts.id) return false;
  for (const cls of parts.classes) if (!el.classList.contains(cls)) return false;
  for (const attr of parts.attrs) {
    if (!el.hasAttribute(attr.name)) return false;
    if (attr.value !== null && el.getAttribute(attr.name) !== attr.value) return false;
  }
  return true;
}

/**
 * Test one element against a selector list with descendant combinators.
 *
 * @param {LiveElement} el Candidate element.
 * @param {string} selector Selector list.
 * @returns {boolean} Whether any selector of the list matches.
 */
function matchesSelector(el, selector) {
  return String(selector).split(',').some(alternative => {
    const chain = alternative.trim().split(/\s+/).map(parseCompound);
    if (!matchesCompound(el, chain[chain.length - 1])) return false;
    let ancestor = el.parentNode;
    for (let i = chain.length - 2; i >= 0; i -= 1) {
      while (ancestor && !matchesCompound(ancestor, chain[i])) ancestor = ancestor.parentNode;
      if (!ancestor) return false;
      ancestor = ancestor.parentNode;
    }
    return true;
  });
}

/** Base node: tree links shared by elements, text nodes and fragments. */
class LiveNode {
  /**
   * @param {LiveDomModel} model Owning model.
   */
  constructor(model) {
    this._model = model;
    this.parentNode = null;
    this.childNodes = [];
  }

  /**
   * Short form for `util.inspect`, so an assertion diff names the node
   * instead of walking the whole model graph.
   *
   * @returns {string} `<tag key-attrs>` or the quoted text.
   */
  [inspect.custom]() {
    if (this.nodeType === 3) return `#text ${JSON.stringify(this.data)}`;
    if (this.nodeType !== 1) return '#document-fragment';
    const keys = ['id', 'class', 'data-node-row'].filter(name => this.hasAttribute(name));
    return `<${this.localName}${keys.map(name => ` ${name}="${this.getAttribute(name)}"`).join('')}>`;
  }

  /** @returns {?LiveNode} Following sibling. */
  get nextSibling() {
    const parent = this.parentNode;
    return parent ? parent.childNodes[parent.childNodes.indexOf(this) + 1] || null : null;
  }

  /** @returns {boolean} Whether the node hangs off the model's root. */
  get isConnected() {
    for (let node = this; node; node = node.parentNode) {
      if (node === this._model.root) return true;
    }
    return false;
  }

  /**
   * Inclusive-descendant test, as `Node.contains`.
   *
   * @param {?LiveNode} node Candidate.
   * @returns {boolean} Whether `node` is this node or below it.
   */
  contains(node) {
    for (let current = node; current; current = current.parentNode) {
      if (current === this) return true;
    }
    return false;
  }

  /** @returns {Array<LiveElement>} Element children. */
  get children() {
    return this.childNodes.filter(node => node.nodeType === 1);
  }

  /** @returns {?LiveElement} Following element sibling. */
  get nextElementSibling() {
    for (let node = this.nextSibling; node; node = node.nextSibling) if (node.nodeType === 1) return node;
    return null;
  }

  /**
   * Insert `node` before `ref`, detaching it from its old place first (a
   * removal, as in the DOM). Fragments contribute their children.
   *
   * @param {LiveNode} node Node to insert.
   * @param {?LiveNode} ref Child to insert before; `null` appends.
   * @returns {LiveNode} The inserted node.
   * @throws {Error} When `ref` is not a child of this node.
   */
  insertBefore(node, ref) {
    if (ref != null && ref.parentNode !== this) throw new Error('NotFoundError: ref is not a child');
    if (node.nodeType === 11) {
      for (const child of [...node.childNodes]) this.insertBefore(child, ref);
      return node;
    }
    if (node === ref) return node;
    if (node.parentNode) this._model.detach(node, { keepFocus: false });
    const index = ref == null ? this.childNodes.length : this.childNodes.indexOf(ref);
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    this._model.noteInsertion(this);
    return node;
  }

  /**
   * Append a child.
   *
   * @param {LiveNode} node Node to append.
   * @returns {LiveNode} The appended node.
   */
  appendChild(node) {
    return this.insertBefore(node, null);
  }

  /**
   * Move a connected node without the removal side effects on focus
   * (`ParentNode.moveBefore`). Both nodes must be connected, as in Chromium.
   *
   * @param {LiveNode} node Node to move.
   * @param {?LiveNode} ref Child to move before; `null` moves to the end.
   * @returns {void}
   * @throws {Error} When either node is disconnected or `ref` is foreign.
   */
  moveBefore(node, ref) {
    if (!this.isConnected || !node.isConnected) throw new Error('HierarchyRequestError: moveBefore needs connected nodes');
    if (ref != null && ref.parentNode !== this) throw new Error('NotFoundError: ref is not a child');
    if (node === ref) return;
    this._model.detach(node, { keepFocus: true });
    const index = ref == null ? this.childNodes.length : this.childNodes.indexOf(ref);
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
  }

  /**
   * Remove a child.
   *
   * @param {LiveNode} node Child to remove.
   * @returns {LiveNode} The removed node.
   * @throws {Error} When `node` is not a child of this node.
   */
  removeChild(node) {
    if (!node || node.parentNode !== this) throw new Error('NotFoundError: not a child');
    this._model.detach(node, { keepFocus: false });
    return node;
  }

  /**
   * Replace every child: each current child is removed (counted), even one
   * that is passed back in, exactly as the DOM does it.
   *
   * @param {...LiveNode} nodes New children.
   * @returns {void}
   */
  replaceChildren(...nodes) {
    for (const child of [...this.childNodes]) this._model.detach(child, { keepFocus: false });
    for (const node of nodes) this.appendChild(typeof node === 'string' ? this._model.createTextNode(node) : node);
  }

  /**
   * Detach this node from its parent.
   *
   * @returns {void}
   */
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  /** @returns {string} Concatenated descendant text. */
  get textContent() {
    return this.childNodes.map(node => node.textContent).join('');
  }

  /**
   * Replace the children with one text node.
   *
   * @param {*} value New text.
   */
  set textContent(value) {
    this.replaceChildren();
    const text = value == null ? '' : String(value);
    if (text) this.appendChild(this._model.createTextNode(text));
  }

  /**
   * Every descendant element matching `selector`, in document order.
   *
   * @param {string} selector Supported selector list.
   * @returns {Array<LiveElement>} Matches.
   */
  querySelectorAll(selector) {
    const matches = [];
    /**
     * Collect matching descendants of `node`, depth first.
     *
     * @param {LiveNode} node Subtree root.
     * @returns {void}
     */
    const visit = node => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        if (matchesSelector(child, selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  /**
   * First descendant element matching `selector`.
   *
   * @param {string} selector Supported selector list.
   * @returns {?LiveElement} First match.
   */
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

/** Text node. */
class LiveText extends LiveNode {
  /**
   * @param {LiveDomModel} model Owning model.
   * @param {string} data Text data.
   */
  constructor(model, data) {
    super(model);
    this.nodeType = 3;
    this.data = String(data);
  }

  /** @returns {string} The text data. */
  get textContent() {
    return this.data;
  }
}

/** Document fragment: a parentless container whose children move on insert. */
class LiveFragment extends LiveNode {
  /**
   * @param {LiveDomModel} model Owning model.
   */
  constructor(model) {
    super(model);
    this.nodeType = 11;
    this.tagName = '#DOCUMENT-FRAGMENT';
  }
}

/** Element node. */
class LiveElement extends LiveNode {
  /**
   * @param {LiveDomModel} model Owning model.
   * @param {string} tagName Element name.
   */
  constructor(model, tagName) {
    super(model);
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.localName = String(tagName).toLowerCase();
    this._attrs = new Map();
    this._listeners = new Map();
    const style = {};
    style.setProperty = (name, value) => { style[name] = String(value); };
    this.style = style;
    const element = this;
    this.dataset = new Proxy({}, {
      get: (target, prop) => (typeof prop === 'string' ? element.getAttribute(datasetAttribute(prop)) ?? undefined : undefined),
      set: (target, prop, value) => { element.setAttribute(datasetAttribute(prop), value); return true; },
    });
    this.classList = {
      add: (...names) => { const set = element._classSet(); names.forEach(n => n && set.add(n)); element._writeClasses(set); },
      remove: (...names) => { const set = element._classSet(); names.forEach(n => set.delete(n)); element._writeClasses(set); },
      contains: name => element._classSet().has(name),
      toggle: (name, force) => {
        const set = element._classSet();
        const next = force === undefined ? !set.has(name) : Boolean(force);
        if (next) set.add(name);
        else set.delete(name);
        element._writeClasses(set);
        return next;
      },
    };
  }

  /** @returns {Set<string>} Current class names. */
  _classSet() {
    return new Set(String(this.getAttribute('class') || '').split(/\s+/).filter(Boolean));
  }

  /**
   * Store a class set back into the `class` attribute.
   *
   * @param {Set<string>} set Class names.
   * @returns {void}
   */
  _writeClasses(set) {
    if (set.size) this._attrs.set('class', [...set].join(' '));
    else this._attrs.delete('class');
  }

  /**
   * @param {string} name Attribute name.
   * @param {*} value Attribute value.
   * @returns {void}
   */
  setAttribute(name, value) {
    this._attrs.set(String(name).toLowerCase(), String(value));
  }

  /**
   * @param {string} name Attribute name.
   * @returns {?string} Value, or `null` when absent.
   */
  getAttribute(name) {
    const key = String(name).toLowerCase();
    return this._attrs.has(key) ? this._attrs.get(key) : null;
  }

  /**
   * @param {string} name Attribute name.
   * @returns {boolean} Whether the attribute is present.
   */
  hasAttribute(name) {
    return this._attrs.has(String(name).toLowerCase());
  }

  /**
   * @param {string} name Attribute name.
   * @returns {void}
   */
  removeAttribute(name) {
    this._attrs.delete(String(name).toLowerCase());
  }

  /** @returns {string} The `class` attribute. */
  get className() {
    return this.getAttribute('class') || '';
  }

  /** @param {string} value New `class` attribute. */
  set className(value) {
    this.setAttribute('class', value);
  }

  /** @returns {boolean} Whether the `hidden` attribute is present. */
  get hidden() {
    return this.hasAttribute('hidden');
  }

  /** @param {boolean} value Whether to set the `hidden` attribute. */
  set hidden(value) {
    if (value) this.setAttribute('hidden', '');
    else this.removeAttribute('hidden');
  }

  /** @returns {string} Serialised children. */
  get innerHTML() {
    return this.childNodes.map(node => this._model.serialize(node)).join('');
  }

  /**
   * Replace the children with the parsed markup.
   *
   * @param {string} html Markup.
   */
  set innerHTML(html) {
    this.replaceChildren();
    this._model.parseInto(this, String(html));
  }

  /**
   * Nearest inclusive ancestor matching `selector`.
   *
   * @param {string} selector Supported selector list.
   * @returns {?LiveElement} Match or `null`.
   */
  closest(selector) {
    for (let node = this; node && node.nodeType === 1; node = node.parentNode) {
      if (matchesSelector(node, selector)) return node;
    }
    return null;
  }

  /**
   * @param {string} type Event type.
   * @param {Function} handler Listener.
   * @returns {void}
   */
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }

  /**
   * Dispatch an event that bubbles to the model root, then to the document
   * listeners of the shared environment, unless a listener stops it.
   *
   * @param {Object} event Event-like object with a `type`.
   * @returns {boolean} `false` when a listener called `preventDefault`.
   */
  dispatchEvent(event) {
    const evt = event;
    evt.target = evt.target || this;
    evt.defaultPrevented = Boolean(evt.defaultPrevented);
    if (typeof evt.preventDefault !== 'function') evt.preventDefault = () => { evt.defaultPrevented = true; };
    if (typeof evt.stopPropagation !== 'function') evt.stopPropagation = () => { evt.cancelBubble = true; };
    for (let node = this; node && !evt.cancelBubble; node = node.parentNode) {
      for (const handler of [...((node._listeners && node._listeners.get(evt.type)) || [])]) {
        evt.currentTarget = node;
        handler(evt);
      }
    }
    if (!evt.cancelBubble) this._model.dispatchToDocument(evt);
    return !evt.defaultPrevented;
  }

  /**
   * Dispatch a bubbling click.
   *
   * @returns {void}
   */
  click() {
    this.dispatchEvent({ type: 'click' });
  }

  /**
   * Focus this element when it is connected, recording the options.
   *
   * @param {{preventScroll?: boolean}} [options] Focus options.
   * @returns {void}
   */
  focus(options) {
    if (!this.isConnected) return;
    this._model.activeElement = this;
    this._model.focusCalls.push({ element: this, options: options || {} });
  }

  /**
   * Drop focus when this element holds it.
   *
   * @returns {void}
   */
  blur() {
    if (this._model.activeElement === this) this._model.activeElement = null;
  }

  /** @returns {{top: number, bottom: number, left: number, right: number, width: number, height: number, x: number, y: number}} Box. */
  getBoundingClientRect() {
    return this._model.rectOf(this);
  }
}

/**
 * The model: node factory, parser, accounting, focus, selection and geometry.
 */
class LiveDomModel {
  /**
   * @param {{rowHeight?: number, tableTop?: number, viewportHeight?: number,
   *   nativeScrollAnchoring?: boolean, withMoveBefore?: boolean}} options Geometry and capabilities.
   */
  constructor(options) {
    this.rowHeight = options.rowHeight ?? 20;
    this.tableTop = options.tableTop ?? 400;
    this.viewportHeight = options.viewportHeight ?? 600;
    this.nativeScrollAnchoring = Boolean(options.nativeScrollAnchoring);
    this.root = null;
    this.activeElement = null;
    this.focusCalls = [];
    this.selected = null;
    this.stats = new Map();
    this.scrollY = 0;
    this.scrollCalls = [];
    this.geometryParent = null;
    this.documentDispatcher = null;
    this.withMoveBefore = options.withMoveBefore !== false;
  }

  /**
   * Counters of one parent, created on first use.
   *
   * @param {LiveNode} parent Parent node.
   * @returns {{removed: number, moved: number, inserted: number}} Counters.
   */
  statsFor(parent) {
    if (!this.stats.has(parent)) this.stats.set(parent, { removed: 0, moved: 0, inserted: 0 });
    return this.stats.get(parent);
  }

  /**
   * Reset the counters of every parent and the focus-call log.
   *
   * @returns {void}
   */
  resetStats() {
    this.stats.clear();
    this.focusCalls = [];
    this.scrollCalls = [];
  }

  /**
   * Detach a node with the browser's side effects.
   *
   * @param {LiveNode} node Node to detach.
   * @param {{keepFocus: boolean}} options `keepFocus` models `moveBefore`.
   * @returns {void}
   */
  detach(node, { keepFocus }) {
    const parent = node.parentNode;
    const counters = this.statsFor(parent);
    if (keepFocus) counters.moved += 1;
    else counters.removed += 1;
    if (!keepFocus && this.activeElement && node.contains(this.activeElement)) this.activeElement = null;
    if (this.selected && node.contains(this.selected)) this.selected = null;
    parent.childNodes.splice(parent.childNodes.indexOf(node), 1);
    node.parentNode = null;
  }

  /**
   * Count an insertion under `parent`.
   *
   * @param {LiveNode} parent Parent node.
   * @returns {void}
   */
  noteInsertion(parent) {
    this.statsFor(parent).inserted += 1;
  }

  /**
   * @param {string} tagName Element name.
   * @returns {LiveElement} New element.
   */
  createElement(tagName) {
    const element = new LiveElement(this, tagName);
    if (!this.withMoveBefore) element.moveBefore = undefined;
    return element;
  }

  /**
   * @param {string} text Text data.
   * @returns {LiveText} New text node.
   */
  createTextNode(text) {
    return new LiveText(this, text);
  }

  /** @returns {LiveFragment} New fragment. */
  createDocumentFragment() {
    return new LiveFragment(this);
  }

  /**
   * Parse markup and append the nodes to `parent`.
   *
   * @param {LiveNode} parent Target parent.
   * @param {string} html Markup.
   * @returns {void}
   */
  parseInto(parent, html) {
    // Names and unquoted values exclude quotes, as in HTML, so a quoted value
    // matches one way only; overlapping classes backtrack exponentially on an
    // unclosed tag (CodeQL js/redos).
    const token = /<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>|<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;
    const stack = [parent];
    let last = 0;
    let match;
    /**
     * Append one text run to the innermost open element.
     *
     * @param {string} chunk Raw text between tags.
     * @returns {void}
     */
    const text = chunk => {
      if (chunk) stack[stack.length - 1].appendChild(this.createTextNode(decodeEntities(chunk)));
    };
    while ((match = token.exec(html)) !== null) {
      text(html.slice(last, match.index));
      last = token.lastIndex;
      if (match[1]) {
        const name = match[1].toUpperCase();
        for (let i = stack.length - 1; i > 0; i -= 1) {
          if (stack[i].tagName === name) {
            stack.length = i;
            break;
          }
        }
        continue;
      }
      const element = this.createElement(match[2]);
      const attrPattern = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let attr;
      while ((attr = attrPattern.exec(match[3] || '')) !== null) {
        element.setAttribute(attr[1], decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? ''));
      }
      stack[stack.length - 1].appendChild(element);
      if (!VOID_ELEMENTS.has(element.localName) && match[4] !== '/') stack.push(element);
    }
    text(html.slice(last));
  }

  /**
   * Serialise one node.
   *
   * @param {LiveNode} node Node to serialise.
   * @returns {string} Markup.
   */
  serialize(node) {
    if (node.nodeType === 3) return encodeText(node.data, false);
    const attrs = [...node._attrs].map(([name, value]) => ` ${name}="${encodeText(value, true)}"`).join('');
    if (VOID_ELEMENTS.has(node.localName)) return `<${node.localName}${attrs}>`;
    return `<${node.localName}${attrs}>${node.childNodes.map(child => this.serialize(child)).join('')}</${node.localName}>`;
  }

  /**
   * Viewport box of an element: the geometry tbody itself starts at the
   * table top and spans its visible rows; any other element takes the box
   * of the tbody row holding it, rows stacking at
   * {@link LiveDomModel#rowHeight} below the table top.
   *
   * @param {LiveElement} el Element.
   * @returns {{top: number, bottom: number, left: number, right: number, width: number, height: number, x: number, y: number}} Box.
   */
  rectOf(el) {
    /**
     * A full-width box at a viewport offset.
     *
     * @param {number} top Viewport offset of the top edge.
     * @param {number} height Box height.
     * @returns {Object} The box.
     */
    const box = (top, height) => ({ top, bottom: top + height, left: 0, right: 800, width: 800, height, x: 0, y: top });
    const tableTop = this.tableTop - this.scrollY;
    if (this.geometryParent && el === this.geometryParent) {
      return box(tableTop, el.children.filter(child => !child.hidden).length * this.rowHeight);
    }
    let row = el;
    while (row && row.parentNode !== this.geometryParent) row = row.parentNode;
    if (!row || !this.geometryParent) return box(0, 0);
    let top = tableTop;
    for (const child of this.geometryParent.children) {
      if (child === row) break;
      top += child.hidden ? 0 : this.rowHeight;
    }
    return box(top, row.hidden ? 0 : this.rowHeight);
  }

  /**
   * The geometry row at a viewport offset (the row "under the reader").
   *
   * @param {number} y Viewport offset in px.
   * @returns {?LiveElement} Row whose box covers `y`.
   */
  rowAt(y) {
    if (!this.geometryParent) return null;
    return this.geometryParent.children.find(row => {
      const rect = this.rectOf(row);
      return rect.height > 0 && rect.top <= y && y < rect.bottom;
    }) || null;
  }

  /**
   * Forward a bubbled event to the shared environment's document listener.
   *
   * @param {Object} event Event-like object.
   * @returns {void}
   */
  dispatchToDocument(event) {
    if (typeof this.documentDispatcher === 'function') this.documentDispatcher(event);
  }
}

/**
 * Build the model's root: `<html>` holding a `<body class="dark">`.
 *
 * @param {LiveDomModel} model Model to root.
 * @returns {LiveElement} The body.
 */
function createLiveRoot(model) {
  const root = model.createElement('html');
  const body = model.createElement('body');
  body.classList.add('dark');
  root.appendChild(body);
  model.root = root;
  return body;
}

/**
 * Install focus, selection, page scroll and `CSS.supports` backed by the
 * model onto a document and window object.
 *
 * @param {LiveDomModel} model Backing model.
 * @param {Object} doc Document object to extend.
 * @param {Object} win Window object to extend.
 * @param {LiveElement} body The model's body.
 * @returns {void}
 */
function installLiveViewport(model, doc, win, body) {
  Object.defineProperty(doc, 'activeElement', {
    configurable: true,
    get: () => model.activeElement || body,
  });
  /**
   * The tracked selection, shaped like `Selection`.
   *
   * @returns {{toString: function(): string}} Selection view.
   */
  const selection = () => ({
    toString: () => (model.selected && model.selected.isConnected ? model.selected.textContent : ''),
  });
  doc.getSelection = selection;
  win.getSelection = selection;
  Object.defineProperty(win, 'scrollY', { configurable: true, get: () => model.scrollY });
  win.innerHeight = model.viewportHeight;
  win.scrollBy = (x, y) => {
    model.scrollCalls.push(y);
    model.scrollY = Math.max(0, model.scrollY + y);
  };
  win.CSS = { supports: (property, value) => model.nativeScrollAnchoring && property === 'overflow-anchor' && value === 'auto' };
}

/**
 * A standalone live document for module tests: plain document and window
 * objects over a model, with no shared environment and no globals touched.
 *
 * @param {{rowHeight?: number, tableTop?: number, viewportHeight?: number,
 *   nativeScrollAnchoring?: boolean, withMoveBefore?: boolean}} [options] Model options.
 * @returns {{model: LiveDomModel, document: Object, window: Object, body: LiveElement}} Handles.
 */
export function createLiveDocument(options = {}) {
  const model = new LiveDomModel(options);
  const body = createLiveRoot(model);
  const doc = {
    body,
    documentElement: model.root,
    createElement: tag => model.createElement(tag),
    createTextNode: text => model.createTextNode(text),
    addEventListener() {},
  };
  const win = {};
  installLiveViewport(model, doc, win, body);
  model.resetStats();
  return { model, document: doc, window: win, body };
}

/**
 * Stand up the shared mock environment with a live body, a live `#nodes`
 * table and live element factories, and install focus, selection, scrolling
 * and `CSS.supports` on its document and window.
 *
 * @param {{rowHeight?: number, tableTop?: number, viewportHeight?: number,
 *   nativeScrollAnchoring?: boolean, withMoveBefore?: boolean}} [options] Model options.
 * @returns {{env: Object, model: LiveDomModel, document: Object, window: Object,
 *   body: LiveElement, table: LiveElement, tbody: LiveElement, filterInput: LiveElement,
 *   select: (el: LiveElement) => void, cleanup: () => void}} Handles.
 */
export function createLiveTableDom(options = {}) {
  const env = createDomEnvironment({ includeBody: true });
  const model = new LiveDomModel(options);
  const doc = env.document;
  const win = env.window;
  const body = createLiveRoot(model);
  // The filter box above the table: an `input` event on it runs
  // `applyFilter`, the user-action repaint that always includes the table.
  const filterInput = model.createElement('input');
  filterInput.setAttribute('id', 'filterInput');
  filterInput.value = '';
  body.appendChild(filterInput);
  const table = model.createElement('table');
  table.setAttribute('id', 'nodes');
  const tbody = model.createElement('tbody');
  table.appendChild(tbody);
  body.appendChild(table);
  model.geometryParent = tbody;
  model.documentDispatcher = event => doc.dispatchEvent(event);
  model.resetStats();

  doc.body = body;
  doc.createElement = tag => model.createElement(tag);
  doc.createTextNode = text => model.createTextNode(text);
  doc.createDocumentFragment = () => model.createDocumentFragment();
  doc.querySelector = selector => (selector === '#nodes tbody' ? tbody : body.querySelector(selector));
  doc.querySelectorAll = selector => body.querySelectorAll(selector);
  installLiveViewport(model, doc, win, body);
  env.registerElement('nodes', table);
  env.registerElement('filterInput', filterInput);

  return {
    env,
    model,
    document: doc,
    window: win,
    body,
    table,
    tbody,
    filterInput,
    /**
     * Select the contents of one element (the selection the tests track).
     *
     * @param {LiveElement} el Element whose contents are selected.
     * @returns {void}
     */
    select(el) {
      model.selected = el;
    },
    /**
     * Restore the globals the shared environment replaced.
     *
     * @returns {void}
     */
    cleanup() {
      env.cleanup();
    },
  };
}

export { LiveDomModel, LiveElement, LiveText, LiveFragment, matchesSelector, decodeEntities };
