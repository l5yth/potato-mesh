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
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.classList = new MockClassList();
    this.listeners = new Map();
    this.hidden = false;
    this.scrollTop = 0;
    this.scrollHeight = 200;
  }

  appendChild(node) {
    this.children.push(node);
    return node;
  }

  replaceChildren(...nodes) {
    this.children = [];
    for (const node of nodes) {
      if (!node) continue;
      if (node.isFragment && Array.isArray(node.children)) {
        this.children.push(...node.children);
      } else {
        this.children.push(node);
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
}

function createMockDocument() {
  return {
    createElement(tag) {
      return new MockElement(tag);
    },
    createDocumentFragment() {
      return new MockFragment();
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
  assert.equal(container.children.length, 2);

  const [tabList, panelWrapper] = container.children;
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
  const [tabList, panels] = container.children;
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
