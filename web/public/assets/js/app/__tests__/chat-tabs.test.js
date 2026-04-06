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

import { renderChatTabs } from '../chat-tabs.js';

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
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    // children mirrors HTMLElement.children: element nodes only.
    this.children = [];
    // childNodes mirrors HTMLElement.childNodes: all nodes including text.
    this.childNodes = [];
    this.attributes = new Map();
    this.dataset = {};
    this.classList = new MockClassList();
    this.listeners = new Map();
    this.hidden = false;
    this.scrollTop = 0;
    this.scrollHeight = 200;
    this.scrollLeft = 0;
    this.clientWidth = 0;
    this.scrollWidth = 0;
    this.scrollIntoViewCalls = [];
  }

  appendChild(node) {
    this.childNodes.push(node);
    if (node instanceof MockElement) {
      this.children.push(node);
    }
    return node;
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.childNodes = [];
    for (const node of nodes) {
      if (!node) continue;
      if (node.isFragment && Array.isArray(node.children)) {
        this.children.push(...node.children);
        this.childNodes.push(...node.children);
      } else {
        this.childNodes.push(node);
        if (node instanceof MockElement) {
          this.children.push(node);
        }
      }
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

  addEventListener(event, handler) {
    this.listeners.set(event, handler);
  }

  dispatch(event) {
    const handler = this.listeners.get(event);
    if (handler) {
      handler({});
    }
  }

  scrollIntoView(opts) {
    this.scrollIntoViewCalls.push(opts);
  }

  scrollBy() {
    // no-op in tests; presence is enough to avoid guards
  }
}

class MockTextNode {
  constructor(text) {
    this.textContent = String(text);
    this.nodeType = 3;
  }
}

function createMockDocument() {
  return {
    createElement(tag) {
      return new MockElement(tag);
    },
    createDocumentFragment() {
      return new MockFragment();
    },
    createTextNode(text) {
      return new MockTextNode(text);
    }
  };
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
  // tabListWrapper holds [prevBtn, tabList, nextBtn]
  assert.equal(tabListWrapper.children.length, 3);
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
