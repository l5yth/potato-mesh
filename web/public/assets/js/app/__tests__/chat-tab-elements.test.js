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
 * Unit tests for the keyed chat tab elements (#881, SPEC DR1): a tab id keeps
 * its button and panel, and a refresh writes only what changed. The local
 * element model counts every write to a button's children and text.
 *
 * @module __tests__/chat-tab-elements
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { contentNodesOf, createTabRecord, syncTabRecords, writeTabLabel } from '../chat-tab-elements.js';

/** Minimal element: attributes, dataset, class list, listeners and counted writes. */
class Element {
  /**
   * @param {string} tagName Tag name, stored upper-case.
   */
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.dataset = {};
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => this.classes.add(name)),
      contains: name => this.classes.has(name)
    };
    this.childNodes = [];
    this.listeners = [];
    this._text = '';
    // Writes a refresh must avoid when nothing changed.
    this.textWrites = 0;
    this.childWrites = 0;
  }

  /** @returns {string} Stored text. */
  get textContent() {
    return this._text;
  }

  /** @param {*} value New text; counted. */
  set textContent(value) {
    this.textWrites += 1;
    this._text = String(value);
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
   * @param {...*} nodes New children; counted as one write.
   * @returns {void}
   */
  replaceChildren(...nodes) {
    this.childWrites += 1;
    this.childNodes = nodes;
  }

  /**
   * @param {string} type Event type.
   * @param {Function} handler Listener.
   * @returns {void}
   */
  addEventListener(type, handler) {
    this.listeners.push({ type, handler });
  }
}

/** Text node whose content can be rewritten in place, counting the writes. */
class Text {
  /**
   * @param {string} text Initial text.
   */
  constructor(text) {
    this._text = String(text);
    this.writes = 0;
  }

  /** @returns {string} Stored text. */
  get textContent() {
    return this._text;
  }

  /** @param {*} value New text; counted. */
  set textContent(value) {
    this.writes += 1;
    this._text = String(value);
  }
}

/**
 * Document double building the elements above.
 *
 * @param {{ stringText?: boolean }} [options] ``stringText`` makes text nodes
 *   plain strings, as the shared app-test mock does.
 * @returns {Object} Document double.
 */
function createDocument({ stringText = false } = {}) {
  return {
    createElement: tag => new Element(tag),
    createTextNode: text => (stringText ? String(text) : new Text(text))
  };
}

test('createTabRecord builds the tab button and panel markup with one click listener', () => {
  const activated = [];
  const record = createTabRecord(createDocument(), 'c1', id => activated.push(id));
  const { button, panel } = record;
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.type, 'button');
  assert.equal(button.className, 'chat-tab');
  assert.ok(button.classList.contains('chat-tab'));
  assert.equal(button.getAttribute('role'), 'tab');
  assert.equal(button.getAttribute('id'), 'chat-tab-c1');
  assert.equal(button.dataset.tabId, 'c1');
  assert.equal(button.getAttribute('aria-selected'), 'false');
  assert.equal(button.getAttribute('tabindex'), '-1');
  assert.equal(panel.className, 'chat-tabpanel');
  assert.ok(panel.classList.contains('chat-tabpanel'));
  assert.equal(panel.getAttribute('role'), 'tabpanel');
  assert.equal(panel.getAttribute('id'), 'chat-panel-c1');
  assert.equal(panel.getAttribute('aria-labelledby'), 'chat-tab-c1');
  assert.equal(panel.dataset.tabId, undefined, 'only the header carries data-tab-id (LV4 flash target)');
  assert.equal(panel.hidden, true);
  assert.deepEqual({ label: record.label, iconSrc: record.iconSrc, created: record.created }, { label: null, iconSrc: null, created: true });

  assert.equal(button.listeners.length, 1);
  button.listeners[0].handler({});
  assert.deepEqual(activated, ['c1']);
});

test('writeTabLabel writes a text label once and nothing while it is unchanged', () => {
  const document = createDocument();
  const record = createTabRecord(document, 'log', () => {});
  assert.equal(writeTabLabel(document, record, 'Log', null), true);
  assert.equal(record.button.textContent, 'Log');
  assert.equal(writeTabLabel(document, record, 'Log', null), false);
  assert.equal(record.button.textWrites, 1, 'an unchanged label is not written again');

  assert.equal(writeTabLabel(document, record, 'Log (2)', null), true);
  assert.equal(record.button.textContent, 'Log (2)');
  assert.equal(record.button.childWrites, 0, 'a text-only tab never rebuilds its children');
});

test('writeTabLabel keeps the icon and rewrites only the label text beside it', () => {
  const document = createDocument();
  const record = createTabRecord(document, 'c0', () => {});
  writeTabLabel(document, record, 'Primary (3)', '/icon.svg');
  const [icon, text] = record.button.childNodes;
  assert.equal(icon.tagName, 'IMG');
  assert.deepEqual(
    Object.fromEntries(icon.attributes),
    { src: '/icon.svg', alt: '', width: '12', height: '12', 'aria-hidden': 'true', loading: 'lazy', decoding: 'async' }
  );
  assert.equal(icon.className, 'protocol-icon');
  assert.equal(text.textContent, 'Primary (3)');

  assert.equal(writeTabLabel(document, record, 'Primary (4)', '/icon.svg'), true);
  assert.ok(record.button.childNodes[0] === icon, 'the icon element stays');
  assert.ok(record.button.childNodes[1] === text, 'the same text node is rewritten');
  assert.equal(text.textContent, 'Primary (4)');
  assert.equal(text.writes, 1);
  assert.equal(record.button.childWrites, 1, 'only the first write built the children');

  assert.equal(writeTabLabel(document, record, 'Primary (4)', '/icon.svg'), false);
  assert.equal(text.writes, 1);
});

test('writeTabLabel rebuilds the label when the icon changes, appears or goes', () => {
  const document = createDocument();
  const record = createTabRecord(document, 'c0', () => {});
  writeTabLabel(document, record, 'Chan', null);
  writeTabLabel(document, record, 'Chan', '/a.svg');
  assert.equal(record.button.childNodes[0].getAttribute('src'), '/a.svg');

  writeTabLabel(document, record, 'Chan', '/b.svg');
  assert.equal(record.button.childNodes[0].getAttribute('src'), '/b.svg');
  assert.equal(record.button.childWrites, 2);

  writeTabLabel(document, record, 'Chan', null);
  assert.deepEqual(record.button.childNodes, [], 'the icon is dropped');
  assert.equal(record.button.textContent, 'Chan');
  assert.equal(record.labelNode, null);
});

test('writeTabLabel rebuilds the label when text nodes cannot be rewritten', () => {
  const document = createDocument({ stringText: true });
  const record = createTabRecord(document, 'c0', () => {});
  writeTabLabel(document, record, 'Primary (1)', '/icon.svg');
  writeTabLabel(document, record, 'Primary (2)', '/icon.svg');
  assert.equal(record.button.childNodes[1], 'Primary (2)');
  assert.equal(record.button.childWrites, 2);
});

test('syncTabRecords keeps the records of known ids, creates new ones and forgets gone ones', () => {
  const document = createDocument();
  const records = new Map();
  const onActivate = () => {};
  const first = syncTabRecords(document, records, [{ id: 'log', label: 'Log' }, { id: 'c0', label: 'Primary (1)' }], onActivate);
  assert.deepEqual(first.map(record => [record.id, record.created]), [['log', true], ['c0', true]]);

  const second = syncTabRecords(document, records, [{ id: 'c1' }, { id: 'c0', label: 'Primary (2)' }], onActivate);
  assert.deepEqual(second.map(record => [record.id, record.created]), [['c1', true], ['c0', false]]);
  assert.ok(second[1] === first[1], 'c0 keeps its record');
  assert.ok(second[1].button === first[1].button && second[1].panel === first[1].panel);
  assert.equal(second[1].button.textContent, 'Primary (2)');
  assert.equal(second[0].button.textContent, '', 'a tab without a label gets an empty one');
  assert.deepEqual([...records.keys()], ['c0', 'c1'], 'log is forgotten');
});

test('contentNodesOf lists the wanted panel children for every content form', () => {
  const node = new Element('div');
  const list = [node];
  assert.deepEqual(contentNodesOf(null), []);
  assert.deepEqual(contentNodesOf(undefined), []);
  assert.ok(contentNodesOf(list) === list, 'an array is used as is');
  const fragment = { nodeType: 11, childNodes: [node, new Element('p')] };
  const fromFragment = contentNodesOf(fragment);
  assert.deepEqual(fromFragment, fragment.childNodes);
  assert.ok(fromFragment !== fragment.childNodes, 'a fragment yields a copy of its children');
  assert.deepEqual(contentNodesOf(node), [node]);
});
