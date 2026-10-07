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
 * `renderChatTabs` as a keyed renderer (#881, SPEC DR1/DR3): a re-render
 * keeps the tab bar, every tab's button and panel and every content node that
 * stays, places changes without moving the rest, hands focus back, and never
 * animates a scroll restore.
 *
 * `chat-tabs.test.js` drives a mock without `insertBefore`, which takes the
 * reconciler's `replaceChildren` path. This file's local model has the real
 * primitives, one parent per node, and the browser's focus fix-up: a node
 * that leaves the tree, even for the instant of a move, drops focus inside it.
 * Every such removal is counted per node.
 *
 * @module __tests__/chat-tabs-keyed
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderChatTabs, __test__ } from '../chat-tabs.js';

/** Element with one parent, counted removals, focus and recorded scroll calls. */
class Element {
  /**
   * @param {Object} document Owner document double (tracks focus).
   * @param {string} tagName Tag name, stored upper-case.
   */
  constructor(document, tagName) {
    this.ownerDocument = document;
    this.tagName = tagName.toUpperCase();
    this.parentNode = null;
    this.childNodes = [];
    this.attributes = new Map();
    this.dataset = {};
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => this.classes.add(name)),
      remove: (...names) => names.forEach(name => this.classes.delete(name)),
      contains: name => this.classes.has(name)
    };
    this.listeners = new Map();
    this.hidden = false;
    this.textContent = '';
    this.value = '';
    this.removals = 0;
    this.scrollTop = 0;
    this.scrollHeight = 500;
    this.clientHeight = 100;
    this.scrollLeft = 0;
    this.scrollByCalls = [];
  }

  /** @returns {Array<Element>} Element children. */
  get children() {
    return this.childNodes.filter(node => node instanceof Element);
  }

  /**
   * Leave the parent, counting the removal and dropping focus inside.
   *
   * @returns {void}
   */
  leaveParent() {
    const parent = this.parentNode;
    if (!parent) return;
    parent.childNodes.splice(parent.childNodes.indexOf(this), 1);
    this.parentNode = null;
    const pending = [this];
    while (pending.length > 0) {
      const node = pending.pop();
      node.removals += 1;
      if (this.ownerDocument.activeElement === node) this.ownerDocument.activeElement = null;
      pending.push(...node.children);
    }
  }

  /**
   * @param {*} node Node or fragment to insert.
   * @param {?Element} ref Reference child, ``null`` to append.
   * @returns {*} The inserted node.
   */
  insertBefore(node, ref) {
    const incoming = node instanceof Fragment ? node.childNodes.splice(0) : [node];
    for (const child of incoming) {
      if (child instanceof Element) child.leaveParent();
      const index = ref === null ? this.childNodes.length : this.childNodes.indexOf(ref);
      if (index < 0) throw new Error('reference node is not a child');
      this.childNodes.splice(index, 0, child);
      if (child instanceof Element) child.parentNode = this;
    }
    return node;
  }

  /**
   * @param {*} node Node to append.
   * @returns {*} The node.
   */
  appendChild(node) {
    return this.insertBefore(node, null);
  }

  /**
   * @param {Element} node Child to remove.
   * @returns {Element} The node.
   */
  removeChild(node) {
    if (node.parentNode !== this) throw new Error('not a child');
    node.leaveParent();
    return node;
  }

  /**
   * @param {...*} nodes New children.
   * @returns {void}
   */
  replaceChildren(...nodes) {
    for (const child of [...this.children]) child.leaveParent();
    this.childNodes = [];
    for (const node of nodes) this.insertBefore(node, null);
  }

  /**
   * @param {string} name Attribute name.
   * @param {*} value Attribute value.
   * @returns {void}
   */
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  /**
   * @param {string} name Attribute name.
   * @returns {?string} Attribute value.
   */
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  /**
   * @param {string} type Event type.
   * @param {Function} handler Listener.
   * @returns {void}
   */
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  /**
   * Call every listener for ``type``.
   *
   * @param {string} type Event type.
   * @returns {void}
   */
  dispatch(type) {
    for (const handler of this.listeners.get(type) || []) handler({});
  }

  /**
   * @param {string} type Event type.
   * @returns {number} Listeners registered for ``type``.
   */
  listenerCount(type) {
    return (this.listeners.get(type) || []).length;
  }

  /**
   * Take focus when attached.
   *
   * @returns {void}
   */
  focus() {
    this.ownerDocument.activeElement = this;
  }

  /**
   * @param {Object} options Scroll options.
   * @returns {void}
   */
  scrollBy(options) {
    this.scrollByCalls.push(options);
  }

  /** @returns {void} */
  scrollIntoView() {}
}

/** Fragment double: hands its children over when inserted. */
class Fragment {
  constructor() {
    this.childNodes = [];
  }

  /**
   * @param {*} node Node to hold.
   * @returns {*} The node.
   */
  appendChild(node) {
    this.childNodes.push(node);
    return node;
  }
}

/**
 * Document double for the model above.
 *
 * @returns {Object} Document with ``createElement``, ``createTextNode``,
 *   ``createDocumentFragment`` and ``activeElement``.
 */
function createDocument() {
  const document = {
    activeElement: null,
    createElement: tag => new Element(document, tag),
    createTextNode: text => ({ nodeType: 3, textContent: String(text) }),
    createDocumentFragment: () => new Fragment()
  };
  return document;
}

/**
 * Render helper: tabs with labels from ``labels`` and the given content.
 *
 * @param {Object} document Document double.
 * @param {Element} container Chat container.
 * @param {Array<[string, string, *]>} tabs ``[id, label, content]`` triples.
 * @param {Object} [extra] More ``renderChatTabs`` options.
 * @returns {?string} Active tab id.
 */
function render(document, container, tabs, extra = {}) {
  return renderChatTabs({
    document,
    container,
    tabs: tabs.map(([id, label, content]) => ({ id, label, content })),
    defaultActiveTabId: 'c0',
    ...extra
  });
}

/**
 * The parts of a rendered chat container.
 *
 * @param {Element} container Chat container.
 * @returns {Object} Wrapper, arrows, strip, select, panel wrapper, buttons, panels.
 */
function parts(container) {
  const [wrapper, panelWrapper] = container.children;
  const [prev, strip, next, select] = wrapper.children;
  return { wrapper, prev, strip, next, select, panelWrapper, buttons: strip.children, panels: panelWrapper.children };
}

/**
 * ``count`` entry elements.
 *
 * @param {Object} document Document double.
 * @param {number} count How many.
 * @returns {Array<Element>} Entries.
 */
function entries(document, count) {
  return Array.from({ length: count }, () => document.createElement('div'));
}

test('a re-render keeps the bar, every tab and every content node that stays (DR1, #881)', () => {
  const document = createDocument();
  const container = document.createElement('div');
  const log = entries(document, 3);
  const chan = entries(document, 4);
  render(document, container, [['log', 'Log', log], ['c0', 'Primary (4)', chan]]);
  const before = parts(container);
  const kept = [before.wrapper, before.prev, before.strip, before.next, before.select, before.panelWrapper,
    ...before.buttons, ...before.panels, ...log, ...chan];

  const fresh = document.createElement('div');
  render(document, container, [['log', 'Log', log], ['c0', 'Primary (5)', [...chan, fresh]]]);
  const after = parts(container);
  for (const name of ['wrapper', 'prev', 'strip', 'next', 'select', 'panelWrapper']) {
    assert.ok(after[name] === before[name], `${name} is kept`);
  }
  assert.ok(after.buttons.every((button, index) => button === before.buttons[index]));
  assert.ok(after.panels.every((panel, index) => panel === before.panels[index]));
  assert.deepEqual(after.panels[1].children, [...chan, fresh], 'the new entry is appended');
  assert.deepEqual(kept.map(node => node.removals).filter(Boolean), [], 'nothing left the tree, not even to move');
  assert.equal(after.buttons[1].textContent, 'Primary (5)');
});

test('each tab button keeps one click listener, and a click drives the current render (DR1, #881)', () => {
  const document = createDocument();
  const container = document.createElement('div');
  render(document, container, [['log', 'Log', null], ['c0', 'Primary', null]]);
  render(document, container, [['log', 'Log', null], ['c0', 'Primary', null], ['c1', 'Alpha', null]]);
  const { buttons, panels } = parts(container);
  assert.deepEqual(buttons.map(button => button.listenerCount('click')), [1, 1, 1]);

  buttons[0].dispatch('click');
  assert.equal(container.dataset.activeTab, 'log');
  assert.deepEqual(panels.map(panel => panel.hidden), [false, true, true], 'the tab added later is hidden too');
  buttons[2].dispatch('click');
  assert.deepEqual(panels.map(panel => panel.hidden), [true, true, false]);
  assert.equal(parts(container).select.value, 'c1');
});

test('a tab that leaves loses its button and panel, and a returning id gets new ones', () => {
  const document = createDocument();
  const container = document.createElement('div');
  render(document, container, [['c0', 'Primary', null], ['c1', 'Alpha', null]]);
  const [, alphaButton] = parts(container).buttons;
  const [, alphaPanel] = parts(container).panels;

  render(document, container, [['c0', 'Primary', null]]);
  assert.equal(parts(container).buttons.length, 1);
  assert.equal(alphaButton.parentNode, null);
  assert.equal(alphaPanel.parentNode, null);

  render(document, container, [['c0', 'Primary', null], ['c1', 'Alpha', null]]);
  assert.ok(parts(container).buttons[1] !== alphaButton, 'a new button for the returning id');
});

test('a click on a button whose tab is gone selects nothing', () => {
  const document = createDocument();
  const container = document.createElement('div');
  render(document, container, [['c0', 'Primary', null], ['c1', 'Alpha', null]]);
  const [, alphaButton] = parts(container).buttons;
  render(document, container, [['c0', 'Primary', null]]);
  alphaButton.dispatch('click');
  assert.equal(container.dataset.activeTab, '');
});

test('a reorder moves one button and the focused button keeps focus (DR1, #881)', () => {
  const document = createDocument();
  const container = document.createElement('div');
  render(document, container, [['log', 'Log', null], ['c0', 'Primary', null], ['a', 'Alpha', null], ['b', 'Bravo', null]]);
  const [log, primary, alpha, bravo] = parts(container).buttons;
  alpha.focus();

  render(document, container, [['log', 'Log', null], ['c0', 'Primary', null], ['b', 'Bravo', null], ['a', 'Alpha', null]]);
  assert.deepEqual(parts(container).buttons, [log, primary, bravo, alpha]);
  assert.equal(alpha.removals, 1, 'the move took the focused button out for an instant');
  assert.equal(log.removals + primary.removals + bravo.removals, 0);
  assert.ok(document.activeElement === alpha, 'focus was handed back');
});

test('focus inside a replaced entry moves to the same control of its replacement (DR1, #881)', () => {
  const document = createDocument();
  const container = document.createElement('div');
  const build = () => {
    const entry = document.createElement('div');
    const link = document.createElement('a');
    entry.appendChild(document.createElement('span'));
    entry.appendChild(link);
    return { entry, link };
  };
  const stays = build();
  const old = build();
  render(document, container, [['c0', 'Primary', [stays.entry, old.entry]]]);
  old.link.focus();

  const rebuilt = build();
  render(document, container, [['c0', 'Primary', [stays.entry, rebuilt.entry]]], {
    replacementOf: node => (node === old.entry ? rebuilt.entry : null)
  });
  assert.ok(document.activeElement === rebuilt.link);
  assert.equal(stays.entry.removals, 0);
});

test('the reader\'s place: a caller capture wins, a kept panel is left alone, a pinned reader follows (CL-A3, DR3, #881)', () => {
  const document = createDocument();
  const container = document.createElement('div');
  // An initial render with the caller's capture of a panel that was replaced.
  render(document, container, [['c0', 'Primary', null]], { previousPanelScroll: { top: 40, pinned: false } });
  const [panel] = parts(container).panels;
  assert.equal(panel.scrollTop, 40, 'a fresh panel takes the captured offset');

  // The reader scrolls up; the kept panel keeps whatever offset it holds.
  panel.scrollTop = 120;
  let writes = 0;
  let top = 120;
  Object.defineProperty(panel, 'scrollTop', { configurable: true, get: () => top, set: value => { writes += 1; top = value; } });
  render(document, container, [['c0', 'Primary', null]], { previousPanelScroll: { top: 999, pinned: false } });
  assert.equal(writes, 0, 'no scroll write on the kept panel');
  assert.equal(top, 120);

  // At the bottom: follow the new entries.
  render(document, container, [['c0', 'Primary', null]], { previousPanelScroll: { top: 400, pinned: true } });
  assert.equal(top, panel.scrollHeight);
  // No capture at all, given or readable: pin to the newest entry.
  top = 0;
  render(document, container, [['c0', 'Primary', null]], { previousPanelScroll: null });
  assert.equal(top, panel.scrollHeight);
});

test('a new strip that replaces foreign markup takes its offset instantly, never smoothly (LD-A2, DR3, #881)', () => {
  const document = createDocument();
  const scrolled = [];
  const createElement = document.createElement;
  document.createElement = tag => {
    const element = createElement(tag);
    element.scrollTo = options => scrolled.push(options);
    return element;
  };
  const container = createElement('div');
  const foreignBar = createElement('div');
  const foreignStrip = createElement('div');
  foreignStrip.className = 'chat-tablist';
  foreignStrip.scrollLeft = 90;
  foreignBar.appendChild(createElement('button'));
  foreignBar.appendChild(foreignStrip);
  container.appendChild(foreignBar);
  container.appendChild(createElement('div'));

  render(document, container, [['c0', 'Primary', null]]);
  assert.ok(parts(container).strip !== foreignStrip);
  assert.deepEqual(scrolled, [{ left: 90, behavior: 'instant' }]);
});

test('the arrows scroll the strip by 150 px each way, smoothly', () => {
  const document = createDocument();
  const container = document.createElement('div');
  render(document, container, [['c0', 'Primary', null]]);
  const { prev, next, strip } = parts(container);
  prev.dispatch('click');
  next.dispatch('click');
  assert.deepEqual(strip.scrollByCalls, [{ left: -150, behavior: 'smooth' }, { left: 150, behavior: 'smooth' }]);
  strip.scrollBy = undefined;
  assert.doesNotThrow(() => {
    prev.dispatch('click');
    next.dispatch('click');
  });
});

test('renderChatTabs needs a container and a document, and drops unusable tabs', () => {
  const document = createDocument();
  const container = document.createElement('div');
  assert.equal(renderChatTabs({ document, container: null, tabs: [] }), null);
  assert.equal(renderChatTabs({ document: null, container, tabs: [] }), null);

  const active = renderChatTabs({
    document,
    container,
    tabs: [null, { id: '' }, { id: 7 }, { id: 'c0', label: 'Primary' }, { id: 'c0', label: 'Again' }]
  });
  assert.equal(active, 'c0');
  assert.deepEqual(parts(container).buttons.map(button => button.textContent), ['Primary']);

  // Nothing usable left: the container is emptied, also without replaceChildren.
  container.replaceChildren = undefined;
  assert.equal(renderChatTabs({ document, container, tabs: [{ id: '' }] }), null);
  assert.equal(container.innerHTML, '');
  assert.equal(container.dataset.activeTab, '');
});

test('the scroll helpers and the fragment fallback', () => {
  const { restoreTabStripScroll, readPreviousTabStripScroll, createFragment, uniqueTabSpecs } = __test__;
  const strip = { scrollLeft: 0 };
  for (const left of [0, -5, Number.NaN, undefined]) restoreTabStripScroll(strip, left);
  assert.equal(strip.scrollLeft, 0, 'nothing to restore');
  restoreTabStripScroll(strip, 30);
  assert.equal(strip.scrollLeft, 30, 'a strip without scrollTo takes a plain write');

  assert.equal(readPreviousTabStripScroll({}), 0);
  assert.equal(readPreviousTabStripScroll({ children: [{ children: [{}, { className: 'other', scrollLeft: 9 }] }] }), 0);
  assert.equal(readPreviousTabStripScroll({ children: [{ children: [{}, { className: 'chat-tablist', scrollLeft: 9 }] }] }), 9);

  const fragment = createFragment({});
  const node = {};
  assert.ok(fragment.appendChild(node) === node);
  assert.deepEqual(fragment.childNodes, [node]);
  assert.deepEqual(uniqueTabSpecs('not a list'), []);
});

test('a dropdown change without a value switches nothing', () => {
  const document = createDocument();
  const container = document.createElement('div');
  render(document, container, [['c0', 'Primary', null], ['c1', 'Alpha', null]]);
  const { select, panels } = parts(container);
  select.value = '';
  select.dispatch('change');
  assert.equal(container.dataset.activeTab, 'c0');
  assert.deepEqual(panels.map(panel => panel.hidden), [false, true]);
});
