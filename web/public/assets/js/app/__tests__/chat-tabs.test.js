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

import { renderChatTabs, __test__ } from '../chat-tabs.js';

class MockClassList {
  constructor() {
    this._values = new Set();
  }

  add(...names) {
    names.forEach(name => {
      if (name) this._values.add(name);
    });
  }

  remove(...names) {
    names.forEach(name => {
      if (name) this._values.delete(name);
    });
  }

  contains(name) {
    return this._values.has(name);
  }
}

class MockFragment {
  constructor() {
    this.children = [];
    this.isFragment = true;
  }

  appendChild(node) {
    this.children.push(node);
    return node;
  }
}

class MockElement {
  /**
   * Create a detached mock element.
   *
   * @param {string} tagName Element tag name, stored upper-case.
   * @param {?Object} [ownerDocument=null] Mock document that created the
   *   element; it tracks focus (``activeElement``) for the #882 tests.
   */
  constructor(tagName, ownerDocument = null) {
    this.tagName = tagName.toUpperCase();
    // The mock document that created this element (tracks focus).
    this.ownerDocument = ownerDocument;
    // Parent element; null while detached or held by a fragment.
    this.parentNode = null;
    // Times this node left the tree, by its own removal or an ancestor's.
    // A DOM "move" (re-inserting an attached node) counts too (#882).
    this.detachCount = 0;
    // Backing fields of the counted textContent / value accessors below.
    this._textContent = '';
    this._value = '';
    // Writes through those accessors: an idle render must make none (#882).
    this.textWrites = 0;
    this.valueWrites = 0;
    // children mirrors HTMLElement.children: element nodes only.
    this.children = [];
    // childNodes mirrors HTMLElement.childNodes: all nodes including text.
    this.childNodes = [];
    this.attributes = new Map();
    this.dataset = {};
    this.classList = new MockClassList();
    // event -> every registered handler, so a pile-up is observable.
    this.listeners = new Map();
    this.hidden = false;
    this.scrollTop = 0;
    this.scrollHeight = 200;
    this.scrollLeft = 0;
    this.clientWidth = 0;
    this.scrollWidth = 0;
    this.scrollIntoViewCalls = [];
  }

  /**
   * Text of the element.
   *
   * @returns {string} The stored text.
   */
  get textContent() {
    return this._textContent;
  }

  /**
   * Store ``text``, counting the write in ``textWrites``.
   *
   * @param {*} text New text.
   */
  set textContent(text) {
    this.textWrites += 1;
    this._textContent = String(text);
  }

  /**
   * Value of the element; for a ``<select>``, the selected option's value.
   *
   * @returns {string} The current value.
   */
  get value() {
    return this._value;
  }

  /**
   * Store ``next``, counting the write in ``valueWrites``. Like a browser, a
   * ``<select>`` selects the option with that value, or none (``''``).
   *
   * @param {*} next New value.
   */
  set value(next) {
    this.valueWrites += 1;
    const text = String(next);
    if (this.tagName === 'SELECT') {
      this._value = this.children.some(option => option.value === text) ? text : '';
    } else {
      this._value = text;
    }
  }

  /**
   * Append ``node``, first removing it from its current parent (a DOM move).
   *
   * @param {*} node Node to append.
   * @returns {*} The appended node.
   */
  appendChild(node) {
    detachFromParent(node);
    this.childNodes.push(node);
    if (node instanceof MockElement) {
      this.children.push(node);
      node.parentNode = this;
    }
    return node;
  }

  /**
   * Replace every child with ``nodes``, expanding fragments, and record each
   * removal as the DOM would.
   *
   * @param {...*} nodes New children; falsy entries are skipped.
   * @returns {void}
   */
  replaceChildren(...nodes) {
    const incoming = [];
    for (const node of nodes) {
      if (!node) continue;
      if (node.isFragment && Array.isArray(node.children)) {
        incoming.push(...node.children);
      } else {
        incoming.push(node);
      }
    }
    // DOM order: the new nodes leave their old parents, then every current
    // child is removed, so passing an existing child re-inserts it.
    incoming.forEach(detachFromParent);
    this.children.forEach(markDetached);
    this.children = [];
    this.childNodes = [];
    for (const node of incoming) {
      this.childNodes.push(node);
      if (node instanceof MockElement) {
        this.children.push(node);
        node.parentNode = this;
      }
    }
    // A browser <select> whose options are replaced resets to its first
    // option, so code that wants another channel must write it back (#882).
    if (this.tagName === 'SELECT') {
      this._value = this.children.length > 0 ? this.children[0].value : '';
    }
  }

  /**
   * Replace ``oldNode`` with ``newNode`` in place, mirroring
   * ``Node.replaceChild``; ``newNode`` first leaves its current parent.
   *
   * @param {MockElement} newNode Node to insert.
   * @param {MockElement} oldNode Existing child to replace.
   * @returns {MockElement} The replaced node.
   * @throws {Error} When ``oldNode`` is not a child of this element.
   */
  replaceChild(newNode, oldNode) {
    if (!this.children.includes(oldNode)) {
      throw new Error('replaceChild: oldNode is not a child of this element');
    }
    detachFromParent(newNode);
    this.children[this.children.indexOf(oldNode)] = newNode;
    this.childNodes[this.childNodes.indexOf(oldNode)] = newNode;
    newNode.parentNode = this;
    markDetached(oldNode);
    return oldNode;
  }

  /**
   * Make this element the owner document's ``activeElement``.
   *
   * @returns {void}
   */
  focus() {
    if (this.ownerDocument) {
      this.ownerDocument.activeElement = this;
    }
  }

  setAttribute(name, value) {
    const strValue = String(value);
    this.attributes.set(name, strValue);
    if (name === 'id') {
      this.id = strValue;
    }
    if (name.startsWith('data-')) {
      const key = name
        .slice(5)
        .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = strValue;
    }
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  /**
   * Register ``handler`` for ``event``, keeping every registration.
   *
   * @param {string} event Event type.
   * @param {Function} handler Listener.
   * @returns {void}
   */
  addEventListener(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
  }

  /**
   * Call every handler registered for ``event``.
   *
   * @param {string} event Event type.
   * @returns {void}
   */
  dispatch(event) {
    for (const handler of this.listeners.get(event) || []) {
      handler({});
    }
  }

  /**
   * Count the handlers registered for ``event``.
   *
   * @param {string} event Event type.
   * @returns {number} Number of registrations.
   */
  listenerCount(event) {
    return (this.listeners.get(event) || []).length;
  }

  scrollIntoView(opts) {
    this.scrollIntoViewCalls.push(opts);
  }

  scrollBy() {
    // no-op in tests; presence is enough to avoid guards
  }
}

/**
 * Record that ``node`` and its whole subtree left the tree. A focused node
 * loses focus, mirroring the HTML focus fix-up (and an open native picker
 * closing with it).
 *
 * @param {MockElement} node Root of the removed subtree.
 * @returns {void}
 */
function markDetached(node) {
  node.parentNode = null;
  const pending = [node];
  while (pending.length > 0) {
    const current = pending.pop();
    current.detachCount += 1;
    if (current.ownerDocument && current.ownerDocument.activeElement === current) {
      current.ownerDocument.activeElement = null;
    }
    pending.push(...current.children);
  }
}

/**
 * Remove ``node`` from its parent element, if it has one.
 *
 * @param {*} node Node about to be inserted elsewhere.
 * @returns {void}
 */
function detachFromParent(node) {
  const parent = node && node.parentNode;
  if (!parent) return;
  parent.children.splice(parent.children.indexOf(node), 1);
  parent.childNodes.splice(parent.childNodes.indexOf(node), 1);
  markDetached(node);
}

class MockTextNode {
  constructor(text) {
    this.textContent = String(text);
    this.nodeType = 3;
  }
}

/**
 * Build a minimal mock ``document`` whose elements know their owner, so focus
 * (``activeElement``) can be tracked and cleared when a focused element
 * leaves the tree.
 *
 * @returns {Object} Mock document with ``createElement``, ``createTextNode``,
 *   ``createDocumentFragment`` and ``activeElement``.
 */
function createMockDocument() {
  const document = {
    // Focused element; cleared when it leaves the tree (see markDetached).
    activeElement: null,
    createElement(tag) {
      return new MockElement(tag, document);
    },
    createDocumentFragment() {
      return new MockFragment();
    },
    createTextNode(text) {
      return new MockTextNode(text);
    }
  };
  return document;
}

test('renderChatTabs creates tab markup and selects default active tab', () => {
  const document = createMockDocument();
  const container = new MockElement('div');

  const tabs = [
    { id: 'log', label: 'Log', content: new MockElement('div') },
    { id: 'channel-0', label: 'Default', content: new MockElement('div') },
    { id: 'channel-1', label: 'Alt', content: new MockElement('div') }
  ];

  const active = renderChatTabs({
    document,
    container,
    tabs,
    defaultActiveTabId: 'channel-0'
  });

  assert.equal(active, 'channel-0');
  assert.equal(container.dataset.activeTab, 'channel-0');
  // container now holds [tabListWrapper, panelWrapper]
  assert.equal(container.children.length, 2);

  const [tabListWrapper, panelWrapper] = container.children;
  // tabListWrapper holds [prevBtn, tabList, nextBtn, tabSelect] (LV8 dropdown is 4th)
  assert.equal(tabListWrapper.children.length, 4);
  const [, tabList] = tabListWrapper.children;
  assert.equal(tabList.children.length, 3);
  assert.equal(panelWrapper.children.length, 3);
  assert.equal(panelWrapper.children[1].hidden, false);
  assert.equal(panelWrapper.children[1].scrollTop, panelWrapper.children[1].scrollHeight);
  assert.equal(panelWrapper.children[0].hidden, true);

  tabList.children[0].dispatch('click');
  assert.equal(container.dataset.activeTab, 'log');
  assert.equal(panelWrapper.children[0].hidden, false);
  assert.equal(panelWrapper.children[1].hidden, true);
});

test('renderChatTabs reuses previous active tab when still available', () => {
  const document = createMockDocument();
  const container = new MockElement('div');
  container.dataset.activeTab = 'log';

  const tabs = [
    { id: 'log', label: 'Log', content: new MockElement('div') },
    { id: 'channel-0', label: 'Default', content: new MockElement('div') }
  ];

  const active = renderChatTabs({
    document,
    container,
    tabs,
    previousActiveTabId: 'log',
    defaultActiveTabId: 'channel-0'
  });

  assert.equal(active, 'log');
  const [tabListWrapper, panels] = container.children;
  const [, tabList] = tabListWrapper.children;
  assert.equal(tabList.children[0].getAttribute('aria-selected'), 'true');
  assert.equal(panels.children[0].hidden, false);
});

test('renderChatTabs clears container when no tabs exist', () => {
  const document = createMockDocument();
  const container = new MockElement('div');
  container.replaceChildren(new MockElement('span'));

  const active = renderChatTabs({ document, container, tabs: [] });
  assert.equal(active, null);
  assert.equal(container.children.length, 0);
  assert.equal(container.dataset.activeTab, '');
});

test('renderChatTabs renders icon img child when tab.iconSrc is provided', () => {
  const document = createMockDocument();
  const container = new MockElement('div');

  const tabs = [
    { id: 'channel-0', label: 'LongFast', iconSrc: '/assets/img/meshtastic.svg' }
  ];

  renderChatTabs({ document, container, tabs });

  const [tabListWrapper] = container.children;
  const [, tabList] = tabListWrapper.children;
  const button = tabList.children[0];
  // Button has one element child (the icon <img>) and one text node — two childNodes total.
  assert.equal(button.children.length, 1, 'should have exactly one element child (icon img)');
  assert.equal(button.childNodes.length, 2, 'should have two child nodes (icon img + text node)');
  const iconImg = button.children[0];
  assert.equal(iconImg.tagName, 'IMG', 'first element child should be an img');
  assert.equal(iconImg.getAttribute('src'), '/assets/img/meshtastic.svg', 'img src should match iconSrc');
  assert.equal(iconImg.getAttribute('aria-hidden'), 'true', 'img should be hidden from AT');
  const textNode = button.childNodes[1];
  assert.equal(textNode.nodeType, 3, 'second child node should be a text node');
  assert.equal(textNode.textContent, 'LongFast');
});

test('renderChatTabs uses textContent when no iconSrc is provided', () => {
  const document = createMockDocument();
  const container = new MockElement('div');

  const tabs = [{ id: 'log', label: 'Log' }];

  renderChatTabs({ document, container, tabs });

  const [tabListWrapper] = container.children;
  const [, tabList] = tabListWrapper.children;
  const button = tabList.children[0];
  assert.equal(button.textContent, 'Log');
  // No icon child elements
  assert.equal(button.children.length, 0);
});

test('renderChatTabs includes prev and next scroll buttons inside the wrapper', () => {
  const document = createMockDocument();
  const container = new MockElement('div');

  renderChatTabs({
    document,
    container,
    tabs: [{ id: 'log', label: 'Log', content: new MockElement('div') }]
  });

  const [tabListWrapper] = container.children;
  const [prevBtn, , nextBtn] = tabListWrapper.children;
  assert.equal(prevBtn.getAttribute('aria-hidden'), 'true');
  assert.equal(nextBtn.getAttribute('aria-hidden'), 'true');
  assert.ok(prevBtn.className.includes('chat-tab-scroll-btn--prev'));
  assert.ok(nextBtn.className.includes('chat-tab-scroll-btn--next'));
  // Both start hidden (no overflow in test environment)
  assert.equal(prevBtn.hidden, true);
  assert.equal(nextBtn.hidden, true);
});

test('renderChatTabs scrolls active button into view on tab switch', () => {
  const document = createMockDocument();
  const container = new MockElement('div');

  const tabs = [
    { id: 'log', label: 'Log', content: new MockElement('div') },
    { id: 'ch1', label: 'Channel (5)', content: new MockElement('div') }
  ];

  renderChatTabs({ document, container, tabs, defaultActiveTabId: 'log' });

  const [tabListWrapper] = container.children;
  const [, tabList] = tabListWrapper.children;
  const ch1Button = tabList.children[1];

  ch1Button.dispatch('click');
  assert.equal(container.dataset.activeTab, 'ch1');
  assert.equal(ch1Button.scrollIntoViewCalls.length, 1);
  assert.deepEqual(ch1Button.scrollIntoViewCalls[0], { block: 'nearest', inline: 'nearest' });
});

test('renderChatTabs arrow buttons reflect scroll position via scroll event', () => {
  const document = createMockDocument();
  const container = new MockElement('div');

  renderChatTabs({
    document,
    container,
    tabs: [{ id: 'log', label: 'Log', content: new MockElement('div') }]
  });

  const [tabListWrapper] = container.children;
  const [prevBtn, tabList, nextBtn] = tabListWrapper.children;

  // Simulate a scrollable list: total width 400, viewport 100, scrolled 50.
  tabList.scrollLeft = 50;
  tabList.clientWidth = 100;
  tabList.scrollWidth = 400;

  // Fire the scroll event so updateArrows recalculates.
  tabList.dispatch('scroll');

  // scrolled past start → prev should be visible
  assert.equal(prevBtn.hidden, false);
  // not yet at end (50 + 100 = 150 < 400 - 1) → next should be visible
  assert.equal(nextBtn.hidden, false);

  // Scroll to the very end.
  tabList.scrollLeft = 300; // 300 + 100 = 400 >= 400 - 1
  tabList.dispatch('scroll');
  assert.equal(prevBtn.hidden, false);
  assert.equal(nextBtn.hidden, true);

  // Scroll back to start.
  tabList.scrollLeft = 0;
  tabList.dispatch('scroll');
  assert.equal(prevBtn.hidden, true);
  assert.equal(nextBtn.hidden, false);
});

/**
 * Count writes to ``element.scrollLeft`` from now on, keeping its value.
 *
 * @param {MockElement} element Element whose offset is watched.
 * @returns {function(): number} Reads the number of writes so far.
 */
function countScrollLeftWrites(element) {
  let value = element.scrollLeft;
  let writes = 0;
  Object.defineProperty(element, 'scrollLeft', {
    configurable: true,
    get: () => value,
    set: next => {
      writes += 1;
      value = next;
    }
  });
  return () => writes;
}

test('renderChatTabs preserves the tablist horizontal scroll across a re-render (LD-A2, DR3, #881)', () => {
  const document = createMockDocument();
  const container = new MockElement('div');
  const tabs = [
    { id: 'log', label: 'Log', content: new MockElement('div') },
    { id: 'c0', label: 'Default', content: new MockElement('div') },
    { id: 'c1', label: 'Alpha', content: new MockElement('div') },
    { id: 'c2', label: 'Bravo', content: new MockElement('div') }
  ];
  renderChatTabs({ document, container, tabs, defaultActiveTabId: 'log' });
  const tabList1 = container.children[0].children[1];
  tabList1.scrollLeft = 120;
  const writes = countScrollLeftWrites(tabList1);

  renderChatTabs({ document, container, tabs, defaultActiveTabId: 'log' });
  const tabList2 = container.children[0].children[1];

  // The strip is kept (DR1), so it still holds the offset and nothing writes
  // it: a write on a smooth-scrolling strip is what animated it (DR3).
  assert.ok(tabList2 === tabList1, 'the tab strip is kept');
  assert.equal(tabList1.detachCount, 0);
  assert.equal(tabList2.scrollLeft, 120);
  assert.equal(writes(), 0, 'a passive re-render writes no scrollLeft');
});

test('renderChatTabs does not scroll the active tab into view on a passive re-render', () => {
  const document = createMockDocument();
  const container = new MockElement('div');
  const tabs = [
    { id: 'log', label: 'Log', content: new MockElement('div') },
    { id: 'c0', label: 'Default', content: new MockElement('div') }
  ];
  renderChatTabs({ document, container, tabs, defaultActiveTabId: 'c0' });
  const tabList = container.children[0].children[1];
  const totalScrollIntoView = tabList.children.reduce(
    (n, button) => n + (button.scrollIntoViewCalls ? button.scrollIntoViewCalls.length : 0),
    0
  );
  assert.equal(totalScrollIntoView, 0);
});


/** Return the single visible (active) panel within a rendered container. */
function activePanel(container) {
  const panelWrapper = container.children[1];
  if (!panelWrapper || !Array.isArray(panelWrapper.children)) return null;
  return panelWrapper.children.find(panel => panel && panel.hidden === false) || null;
}

test('renderChatTabs preserves the active panel vertical scroll across a passive re-render (bugfix B)', () => {
  const document = createMockDocument();
  const container = new MockElement('div');
  const tabs = () => [
    { id: 'log', label: 'Log', content: new MockElement('div') },
    { id: 'c0', label: 'Default', content: new MockElement('div') }
  ];
  renderChatTabs({ document, container, tabs: tabs(), defaultActiveTabId: 'c0' });

  // The user scrolls up to read history: the panel is no longer at the bottom.
  const panel1 = activePanel(container);
  panel1.scrollHeight = 1000;
  panel1.clientHeight = 300;
  panel1.scrollTop = 120; // 1000 - 120 - 300 = 580 px from the bottom → not pinned

  // A passive live refresh (no tab switch) re-renders the same tabs.
  renderChatTabs({ document, container, tabs: tabs(), defaultActiveTabId: 'c0' });
  const panel2 = activePanel(container);

  assert.ok(panel2 === panel1, 'the panel is kept (DR1, #881)');
  assert.equal(
    panel2.scrollTop,
    120,
    'a passive re-render must preserve the vertical scroll, not yank the reader to the bottom'
  );
});

test('renderChatTabs keeps a bottom-pinned reader pinned across a passive re-render (tail-follow, bugfix B)', () => {
  const document = createMockDocument();
  const container = new MockElement('div');
  const tabs = () => [
    { id: 'log', label: 'Log', content: new MockElement('div') },
    { id: 'c0', label: 'Default', content: new MockElement('div') }
  ];
  renderChatTabs({ document, container, tabs: tabs(), defaultActiveTabId: 'c0' });

  // The user is at the bottom, reading the newest entries.
  const panel1 = activePanel(container);
  panel1.scrollHeight = 1000;
  panel1.clientHeight = 300;
  panel1.scrollTop = 700; // 1000 - 700 - 300 = 0 → pinned to the bottom

  renderChatTabs({ document, container, tabs: tabs(), defaultActiveTabId: 'c0' });
  const panel2 = activePanel(container);

  // Still pinned: scrolled to the new bottom so freshly-arrived entries stay visible.
  assert.equal(
    panel2.scrollTop,
    panel2.scrollHeight,
    'a bottom-pinned reader must stay pinned to the new bottom (tail-follow)'
  );
});

test('capturePreviousActivePanelScroll returns null when there is no prior panel (bugfix B)', () => {
  const { capturePreviousActivePanelScroll } = __test__;
  assert.equal(capturePreviousActivePanelScroll(null), null);
  assert.equal(capturePreviousActivePanelScroll({}), null);
  assert.equal(capturePreviousActivePanelScroll({ children: [] }), null);
});

test('capturePreviousActivePanelScroll returns null when every panel is hidden (bugfix B)', () => {
  const { capturePreviousActivePanelScroll } = __test__;
  const container = { children: [{}, { children: [null, { hidden: true }, { hidden: true }] }] };
  assert.equal(capturePreviousActivePanelScroll(container), null);
});

test('capturePreviousActivePanelScroll reports the visible panel offset and pinned state (bugfix B)', () => {
  const { capturePreviousActivePanelScroll, SCROLL_PIN_TOLERANCE_PX } = __test__;
  assert.equal(SCROLL_PIN_TOLERANCE_PX, 4);

  // A hidden panel precedes the visible one (mirrors the Log tab before a channel).
  const pinnedPanel = { hidden: false, scrollTop: 700, scrollHeight: 1000, clientHeight: 300 };
  const pinned = capturePreviousActivePanelScroll({ children: [{}, { children: [{ hidden: true }, pinnedPanel] }] });
  assert.deepEqual(pinned, { top: 700, pinned: true }); // 1000 - 700 - 300 = 0 <= tol

  const scrolledUp = { hidden: false, scrollTop: 100, scrollHeight: 1000, clientHeight: 300 };
  const up = capturePreviousActivePanelScroll({ children: [{}, { children: [scrolledUp] }] });
  assert.deepEqual(up, { top: 100, pinned: false }); // 600 px from the bottom > tol
});

test('applyActivePanelScroll pins, preserves, or no-ops on a missing panel (bugfix B)', () => {
  const { applyActivePanelScroll } = __test__;
  // No panel → no throw, nothing to do.
  assert.doesNotThrow(() => applyActivePanelScroll(null, { top: 5, pinned: false }));

  // No prior state (initial render) → pin to the bottom.
  const initial = { scrollTop: 0, scrollHeight: 900 };
  applyActivePanelScroll(initial, null);
  assert.equal(initial.scrollTop, 900);

  // Was pinned → pin to the new bottom (tail-follow).
  const pinned = { scrollTop: 0, scrollHeight: 900 };
  applyActivePanelScroll(pinned, { top: 42, pinned: true });
  assert.equal(pinned.scrollTop, 900);

  // Was scrolled up → restore the exact offset.
  const preserved = { scrollTop: 0, scrollHeight: 900 };
  applyActivePanelScroll(preserved, { top: 42, pinned: false });
  assert.equal(preserved.scrollTop, 42);
});

test('renderChatTabs renders a channel dropdown selector that jumps to a tab (LV8)', () => {
  const document = createMockDocument();
  const container = new MockElement('div');
  const tabs = [
    { id: 'log', label: 'Log', content: new MockElement('div') },
    { id: 'c0', label: 'Default', content: new MockElement('div') },
    { id: 'c1', label: 'Alpha', content: new MockElement('div') }
  ];
  renderChatTabs({ document, container, tabs, defaultActiveTabId: 'log' });
  const tabListWrapper = container.children[0];
  const tabSelect = tabListWrapper.children[3];
  assert.equal(tabSelect.tagName, 'SELECT');
  // One option per tab, in order.
  assert.deepEqual(tabSelect.children.map(option => option.value), ['log', 'c0', 'c1']);
  // The dropdown reflects the active tab ...
  assert.equal(tabSelect.value, 'log');
  // ... and choosing a channel from it activates that tab.
  tabSelect.value = 'c1';
  tabSelect.dispatch('change');
  assert.equal(container.dataset.activeTab, 'c1');
});

/**
 * Return the LV8 channel select of a rendered container (the tab bar's 4th child).
 *
 * @param {MockElement} container Container ``renderChatTabs`` rendered into.
 * @returns {MockElement} The channel select.
 */
function channelSelect(container) {
  return container.children[0].children[3];
}

/**
 * Build the tab set a live refresh re-renders: fixed ids, with labels carrying
 * the message counts that change as messages arrive (#882).
 *
 * @param {{ c0: number, c1: number }} [counts] Message count per channel.
 * @returns {Array<Object>} Tabs for ``renderChatTabs``.
 */
function liveTabs(counts = { c0: 3, c1: 1 }) {
  return [
    { id: 'log', label: 'Log', content: new MockElement('div') },
    { id: 'c0', label: `Primary (${counts.c0})`, content: new MockElement('div') },
    { id: 'c1', label: `Alpha (${counts.c1})`, content: new MockElement('div') }
  ];
}

test('renderChatTabs keeps the channel select in the document across a passive re-render (MS1, #882)', () => {
  const document = createMockDocument();
  const container = new MockElement('div');
  renderChatTabs({ document, container, tabs: liveTabs(), defaultActiveTabId: 'c0' });
  const select = channelSelect(container);
  select.focus();

  // Two live refreshes: identical data, then a new message on c0.
  renderChatTabs({ document, container, tabs: liveTabs(), defaultActiveTabId: 'c0' });
  renderChatTabs({ document, container, tabs: liveTabs({ c0: 4, c1: 1 }), defaultActiveTabId: 'c0' });

  assert.ok(channelSelect(container) === select, 'the rendered select is the one the user holds');
  // Re-inserting a reused select is a removal too: it must never leave the tree.
  assert.equal(select.detachCount, 0);
  assert.ok(document.activeElement === select, 'a focused select keeps focus');
});

test('renderChatTabs routes a channel chosen after a re-render to the current render (MS1/MS2, #882)', () => {
  const document = createMockDocument();
  const container = new MockElement('div');
  renderChatTabs({ document, container, tabs: liveTabs(), defaultActiveTabId: 'c0' });
  // The user opens the picker on this select, live refreshes land, then they pick c1.
  const select = channelSelect(container);
  renderChatTabs({ document, container, tabs: liveTabs(), defaultActiveTabId: 'c0' });
  renderChatTabs({ document, container, tabs: liveTabs({ c0: 4, c1: 1 }), defaultActiveTabId: 'c0' });
  select.value = 'c1';
  select.dispatch('change');

  const panel = activePanel(container);
  assert.equal(panel.id, 'chat-panel-c1', 'the live DOM shows the chosen channel');
  assert.equal(container.dataset.activeTab, 'c1');
  assert.equal(channelSelect(container).value, 'c1');
  // An explicit switch jumps to the newest entry (CL-A3).
  assert.equal(panel.scrollTop, panel.scrollHeight);
  assert.equal(select.listenerCount('change'), 1, 'one listener, not one per render');
});

test('renderChatTabs reconciles the channel options in place and leaves an idle select untouched (MS3, #882)', () => {
  const document = createMockDocument();
  const container = new MockElement('div');
  renderChatTabs({ document, container, tabs: liveTabs(), defaultActiveTabId: 'c0' });
  const select = channelSelect(container);
  const options = [...select.children];
  // Every write the mock counts on the select and its options, by option index.
  const writes = () => ({
    value: select.valueWrites,
    optionValue: options.map(option => option.valueWrites),
    text: options.map(option => option.textWrites),
    detached: options.map(option => option.detachCount)
  });
  const sameOptionNodes = () => select.children.every((option, index) => option === options[index]);

  // An idle refresh (same ids, labels and active tab) writes nothing at all.
  const beforeIdle = writes();
  renderChatTabs({ document, container, tabs: liveTabs(), defaultActiveTabId: 'c0' });
  assert.ok(sameOptionNodes(), 'option nodes are kept');
  assert.deepEqual(writes(), beforeIdle, 'an idle re-render writes nothing to the select or its options');

  // A new message on c0: exactly one text write, on c0's own option node.
  const beforeMessage = writes();
  renderChatTabs({ document, container, tabs: liveTabs({ c0: 9, c1: 1 }), defaultActiveTabId: 'c0' });
  const afterMessage = writes();
  assert.ok(sameOptionNodes(), 'option nodes are kept');
  assert.deepEqual(afterMessage.text.map((count, index) => count - beforeMessage.text[index]), [0, 1, 0]);
  assert.equal(options[1].textContent, 'Primary (9)');
  assert.equal(afterMessage.value, beforeMessage.value, 'the active tab is unchanged, so value is not written');
  assert.deepEqual(afterMessage.optionValue, beforeMessage.optionValue, 'no option value is rewritten');
  assert.deepEqual(afterMessage.detached, [0, 0, 0], 'no option node was replaced');

  // A channel appears while the active one ages out of the window.
  renderChatTabs({
    document,
    container,
    tabs: [
      { id: 'log', label: 'Log', content: null },
      { id: 'c1', label: 'Alpha (1)', content: null },
      { id: 'c2', label: 'Bravo (1)', content: null }
    ],
    defaultActiveTabId: 'c1'
  });
  assert.ok(channelSelect(container) === select, 'the select survives a tab-set change');
  assert.deepEqual(select.children.map(option => option.value), ['log', 'c1', 'c2']);
  assert.equal(select.value, 'c1');
  assert.equal(container.dataset.activeTab, 'c1');
});

test('renderChatTabs keeps the active channel selected when a re-render rebuilds the options (MS3, #882)', () => {
  const document = createMockDocument();
  const container = new MockElement('div');
  renderChatTabs({ document, container, tabs: liveTabs(), defaultActiveTabId: 'c0' });
  const select = channelSelect(container);
  select.value = 'c1';
  select.dispatch('change');
  assert.equal(container.dataset.activeTab, 'c1');

  // A channel appears: rebuilding the options resets a browser select to its
  // first option, so the unchanged active channel has to be written back.
  const bravo = { id: 'c2', label: 'Bravo (1)', content: null };
  renderChatTabs({ document, container, tabs: [...liveTabs(), bravo], defaultActiveTabId: 'c0' });
  assert.equal(select.value, 'c1');
  assert.equal(activePanel(container).id, 'chat-panel-c1');

  // Alpha overtakes Primary: the same channels in a new order, options rebuilt.
  const [log, primary, alpha] = liveTabs();
  renderChatTabs({ document, container, tabs: [log, alpha, primary, bravo], defaultActiveTabId: 'c0' });
  assert.deepEqual(select.children.map(option => option.value), ['log', 'c1', 'c0', 'c2']);
  assert.equal(select.value, 'c1');
});

test('renderChatTabs scrolls nothing into view on a passive re-render through the persistent bar (LD-A2, #882)', () => {
  const document = createMockDocument();
  const container = new MockElement('div');
  renderChatTabs({ document, container, tabs: liveTabs(), defaultActiveTabId: 'c0' });
  const select = channelSelect(container);
  for (const counts of [{ c0: 3, c1: 1 }, { c0: 4, c1: 1 }]) {
    renderChatTabs({ document, container, tabs: liveTabs(counts), defaultActiveTabId: 'c0' });
    assert.ok(channelSelect(container) === select, 'the re-render took the persistent path');
    const buttons = container.children[0].children[1].children;
    const calls = buttons.reduce((total, button) => total + button.scrollIntoViewCalls.length, 0);
    assert.equal(calls, 0);
  }
});

test('renderChatTabs builds a working channel select again after the tab set empties (#882)', () => {
  const document = createMockDocument();
  const container = new MockElement('div');
  renderChatTabs({ document, container, tabs: liveTabs(), defaultActiveTabId: 'c0' });
  const first = channelSelect(container);

  // Nothing left to choose from: the whole bar goes, select included.
  renderChatTabs({ document, container, tabs: [] });
  assert.equal(container.children.length, 0);
  assert.equal(first.detachCount, 1);

  renderChatTabs({ document, container, tabs: liveTabs(), defaultActiveTabId: 'c0' });
  const second = channelSelect(container);
  assert.ok(second !== first, 'a fresh select once tabs return');
  second.value = 'c1';
  second.dispatch('change');
  assert.equal(activePanel(container).id, 'chat-panel-c1');
});

test('renderChatTabs observes the tab list once, and a re-render keeps that list (#882, DR1, #881)', () => {
  const observed = [];
  const originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    observe(target) {
      observed.push(target);
    }
  };
  try {
    const document = createMockDocument();
    const container = new MockElement('div');
    renderChatTabs({ document, container, tabs: liveTabs(), defaultActiveTabId: 'c0' });
    renderChatTabs({ document, container, tabs: liveTabs(), defaultActiveTabId: 'c0' });
    assert.equal(observed.length, 1, 'one observer for the life of the strip');
    assert.ok(observed[0] === container.children[0].children[1], 'the live tab list is observed');
    assert.equal(observed[0].detachCount, 0, 'the tab list never left the tree');
  } finally {
    if (originalResizeObserver === undefined) {
      delete globalThis.ResizeObserver;
    } else {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  }
});

test('renderChatTabs names a channel option by its id when the tab has no label', () => {
  const document = createMockDocument();
  const container = new MockElement('div');
  renderChatTabs({ document, container, tabs: [{ id: 'c9', content: null }] });
  assert.deepEqual(channelSelect(container).children.map(option => option.textContent), ['c9']);
});

test('renderChatTabs appends the fragment when the container has no replaceChildren', () => {
  const document = createMockDocument();
  const container = new MockElement('div');
  container.replaceChildren = undefined;
  const active = renderChatTabs({ document, container, tabs: liveTabs(), defaultActiveTabId: 'c0' });
  assert.equal(active, 'c0');
  const [fragment] = container.childNodes;
  assert.equal(fragment.isFragment, true);
  assert.deepEqual(fragment.children.map(node => node.className), ['chat-tablist-wrapper', 'chat-tabpanels']);
});

test('createTabSelect ignores a change before any render activates it (#882)', () => {
  const { createTabSelect } = __test__;
  const select = createTabSelect(createMockDocument());
  assert.equal(select.className, 'chat-tab-select');
  assert.equal(select.getAttribute('aria-label'), 'Jump to channel');
  assert.equal(select.listenerCount('change'), 1);
  assert.doesNotThrow(() => select.dispatch('change'));
});

test('findPersistentTabBar reuses only a tab bar a previous render built (#882)', () => {
  const { findPersistentTabBar } = __test__;
  // No children to read, or no previous render.
  assert.equal(findPersistentTabBar({}), null);
  assert.equal(findPersistentTabBar(new MockElement('div')), null);
  // Foreign markup: a wrapper without children, or a select no render activated.
  assert.equal(findPersistentTabBar({ children: [{}, {}] }), null);
  const foreignSelect = new MockElement('select');
  const foreignBar = { children: [null, null, null, foreignSelect] };
  assert.equal(findPersistentTabBar({ children: [foreignBar, {}], replaceChild() {} }), null);

  const document = createMockDocument();
  const container = new MockElement('div');
  renderChatTabs({ document, container, tabs: liveTabs() });
  const bar = findPersistentTabBar(container);
  assert.ok(bar.wrapper === container.children[0]);
  assert.ok(bar.select === channelSelect(container));
  assert.ok(bar.panelWrapper === container.children[1]);
  // The keyed bar is updated in place, so the container needs no replaceChild
  // (#881); a panel wrapper that is not the bar's own is foreign markup.
  assert.ok(findPersistentTabBar({ children: container.children }) === bar);
  assert.equal(findPersistentTabBar({ children: [container.children[0], new MockElement('div')] }), null);
});

test('syncTabSelectOptions rebuilds the options, not the select, when the channel order changes (#882)', () => {
  const { syncTabSelectOptions } = __test__;
  const document = createMockDocument();
  const select = document.createElement('select');
  syncTabSelectOptions(document, select, [
    { id: 'log', label: 'Log' },
    { id: 'c0', label: 'Primary (2)' },
    { id: 'c1', label: 'Alpha (1)' }
  ]);
  const [logOption] = select.children;

  // Alpha overtakes Primary on activity: same count of channels, new order.
  syncTabSelectOptions(document, select, [
    { id: 'log', label: 'Log' },
    { id: 'c1', label: 'Alpha (3)' },
    { id: 'c0', label: 'Primary (2)' }
  ]);
  assert.deepEqual(
    select.children.map(option => [option.value, option.textContent]),
    [['log', 'Log'], ['c1', 'Alpha (3)'], ['c0', 'Primary (2)']]
  );
  assert.ok(select.children[0] !== logOption, 'a reorder rebuilds the option nodes');
});

/**
 * Count writes to ``element.hidden`` from now on, keeping its value.
 *
 * @param {MockElement} element Element whose ``hidden`` is watched.
 * @returns {function(): number} Reads the number of writes so far.
 */
function countHiddenWrites(element) {
  let value = element.hidden;
  let writes = 0;
  Object.defineProperty(element, 'hidden', {
    configurable: true,
    get: () => value,
    set: next => {
      writes += 1;
      value = next;
    }
  });
  return () => writes;
}

test('renderChatTabs shows the channel select only while the strip overflows, measured without it (LV8, CD6)', () => {
  const document = createMockDocument();
  const container = new MockElement('div');
  renderChatTabs({ document, container, tabs: liveTabs(), defaultActiveTabId: 'c0' });
  const wrapper = container.children[0];
  const [prevBtn, tabList, nextBtn, select] = wrapper.children;
  assert.equal(select.hidden, false, 'a strip that is not laid out (≤ 900 px) leaves the select in place');

  // Dashboard at 1024 px: the select and the ▶ arrow leave the strip 804 px for
  // 943 px of tabs, but the bar is 960 px wide, so the tabs fit without them.
  wrapper.clientWidth = 960;
  tabList.clientWidth = 804;
  tabList.scrollWidth = 943;
  renderChatTabs({ document, container, tabs: liveTabs(), defaultActiveTabId: 'c0' });
  assert.equal(select.hidden, true, 'the tabs fit once the select is gone');
  assert.equal(prevBtn.hidden, true);
  assert.equal(nextBtn.hidden, true, 'and the strip needs no arrow either');

  // The strip widens into the room the select left: still fits, no flip back.
  tabList.clientWidth = 960;
  tabList.dispatch('scroll');
  assert.equal(select.hidden, true, 'measuring the bar, not the strip, cannot flip');

  // Dashboard at 1366 px: 943 px of tabs in a 407 px bar overflow.
  wrapper.clientWidth = 407;
  tabList.clientWidth = 264;
  renderChatTabs({ document, container, tabs: liveTabs(), defaultActiveTabId: 'c0' });
  assert.equal(select.hidden, false, 'an overflowing strip shows the select');
  assert.equal(nextBtn.hidden, false, 'and the ▶ arrow');

  // ≤ 900 px hides the strip: it is not laid out, and the select stays (UX11).
  tabList.clientWidth = 0;
  tabList.scrollWidth = 0;
  renderChatTabs({ document, container, tabs: liveTabs(), defaultActiveTabId: 'c0' });
  assert.equal(select.hidden, false);
});

test('renderChatTabs writes the select\'s hidden only when it changes (MS3, CD6)', () => {
  const document = createMockDocument();
  const container = new MockElement('div');
  renderChatTabs({ document, container, tabs: liveTabs(), defaultActiveTabId: 'c0' });
  const wrapper = container.children[0];
  const [, tabList, , select] = wrapper.children;
  const writes = countHiddenWrites(select);
  wrapper.clientWidth = 900;
  tabList.clientWidth = 900;
  tabList.scrollWidth = 600;
  for (let render = 0; render < 3; render += 1) {
    renderChatTabs({ document, container, tabs: liveTabs(), defaultActiveTabId: 'c0' });
  }
  tabList.dispatch('scroll');
  assert.equal(select.hidden, true);
  assert.equal(writes(), 1, 'one write when the strip came to fit, none on the idle renders');
});
