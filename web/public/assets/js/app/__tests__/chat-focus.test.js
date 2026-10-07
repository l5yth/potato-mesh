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
 * Unit tests for focus across a chat refresh (#881, SPEC DR1). The local tree
 * model drops focus from an element that leaves the tree, as a browser does,
 * so "focus survives" means the code handed it back.
 *
 * @module __tests__/chat-focus
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { captureChatFocus, restoreChatFocus } from '../chat-focus.js';

/** Tree node with one parent, element children, and focus on a shared document. */
class Element {
  /**
   * @param {Object} document Owner document double.
   * @param {string} tagName Tag name, stored upper-case.
   */
  constructor(document, tagName) {
    this.document = document;
    this.tagName = tagName.toUpperCase();
    this.parentNode = null;
    this.children = [];
    this.focusCalls = [];
  }

  /**
   * Append children, detaching each from its old parent.
   *
   * @param {...Element} nodes Children to append.
   * @returns {Element} This element.
   */
  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      this.children.push(node);
      node.parentNode = this;
    }
    return this;
  }

  /**
   * Leave the parent; a focused element inside loses focus.
   *
   * @returns {void}
   */
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
    for (let node = this.document.activeElement; node; node = node.parentNode) {
      if (node === this) {
        this.document.activeElement = null;
        break;
      }
    }
  }

  /**
   * Take focus, recording the options.
   *
   * @param {Object} options Focus options.
   * @returns {void}
   */
  focus(options) {
    this.focusCalls.push(options);
    this.document.activeElement = this;
  }
}

/**
 * A chat container with one panel holding two entries, each with a link.
 *
 * @returns {Object} Document, container, panel, entries and links.
 */
function chatTree() {
  const document = { activeElement: null };
  const make = tag => new Element(document, tag);
  const container = make('div');
  const panel = make('div');
  const entries = [make('div'), make('div')];
  const links = entries.map(entry => {
    const link = make('a');
    entry.append(make('span'), link);
    return link;
  });
  panel.append(...entries);
  container.append(make('div'), panel);
  return { document, make, container, panel, entries, links };
}

test('captureChatFocus records a control focused inside the container', () => {
  const { document, container, panel, entries, links } = chatTree();
  links[1].focus();
  const snapshot = captureChatFocus(document, container);
  assert.ok(snapshot.element === links[1]);
  assert.deepEqual(snapshot.chain, [links[1], entries[1], panel]);
  assert.deepEqual(snapshot.path, [1, 1], 'second child of the entry, second entry of the panel');
});

test('captureChatFocus ignores focus outside the container, on it, or nowhere', () => {
  const { document, make, container } = chatTree();
  assert.equal(captureChatFocus(null, container), null);
  assert.equal(captureChatFocus(document, container), null, 'nothing focused');
  container.focus();
  assert.equal(captureChatFocus(document, container), null, 'the container itself');
  make('input').focus();
  assert.equal(captureChatFocus(document, container), null, 'an element elsewhere');
});

test('restoreChatFocus does nothing without a snapshot or while focus stayed', () => {
  const { document, container, links } = chatTree();
  assert.equal(restoreChatFocus(document, container, null), false);
  links[0].focus();
  const snapshot = captureChatFocus(document, container);
  assert.equal(restoreChatFocus(document, container, snapshot), false);
  assert.equal(links[0].focusCalls.length, 1, 'no second focus call');
});

test('restoreChatFocus refocuses a kept control that a move unfocused, without scrolling', () => {
  const { document, container, panel, entries, links } = chatTree();
  links[0].focus();
  const snapshot = captureChatFocus(document, container);
  panel.append(entries[0]); // a reorder moves the entry: focus drops
  assert.equal(document.activeElement, null);
  assert.equal(restoreChatFocus(document, container, snapshot), true);
  assert.ok(document.activeElement === links[0]);
  assert.deepEqual(links[0].focusCalls.at(-1), { preventScroll: true });
});

test('restoreChatFocus moves focus to the same control of a replaced entry', () => {
  const { document, make, container, panel, entries, links } = chatTree();
  links[1].focus();
  const snapshot = captureChatFocus(document, container);
  const rebuilt = make('div');
  const rebuiltLink = make('a');
  rebuilt.append(make('span'), rebuiltLink);
  entries[1].remove();
  panel.append(rebuilt);
  const replacementOf = node => (node === entries[1] ? rebuilt : null);

  assert.equal(restoreChatFocus(document, container, snapshot), false, 'no replacement lookup, no target');
  assert.equal(restoreChatFocus(document, container, snapshot, replacementOf), true);
  assert.ok(document.activeElement === rebuiltLink);
  assert.deepEqual(rebuiltLink.focusCalls, [{ preventScroll: true }]);
});

test('restoreChatFocus gives up when the replacement has another shape or is not in the container', () => {
  const { document, make, container, panel, entries, links } = chatTree();
  links[1].focus();
  const snapshot = captureChatFocus(document, container);
  entries[1].remove();

  // A detached replacement is not a target, whatever its shape.
  const detached = make('div').append(make('span'), make('a'));
  assert.equal(restoreChatFocus(document, container, snapshot, () => detached), false);

  // Same place, but the control there is a span, or there is none at all.
  const reshaped = make('div').append(make('a'), make('span'));
  panel.append(reshaped);
  assert.equal(restoreChatFocus(document, container, snapshot, node => (node === entries[1] ? reshaped : null)), false);
  const empty = make('div');
  panel.append(empty);
  assert.equal(restoreChatFocus(document, container, snapshot, node => (node === entries[1] ? empty : null)), false);

  // A matching element that cannot take focus.
  const inert = { tagName: 'A' };
  const holder = make('div');
  holder.children = [{}, inert];
  panel.append(holder);
  assert.equal(restoreChatFocus(document, container, snapshot, node => (node === entries[1] ? holder : null)), false);
  assert.equal(document.activeElement, null);
});

test('restoreChatFocus copes with nodes that list no children', () => {
  const { document, container, panel, entries, links } = chatTree();
  // A focused control under a wrapper that exposes no child list records -1.
  const bare = { parentNode: entries[0] };
  entries[0].children.push(bare);
  const control = new Element(document, 'a');
  control.parentNode = bare;
  control.focus();
  const snapshot = captureChatFocus(document, container);
  assert.equal(snapshot.path[0], -1);

  // A replacement without a child list holds no matching control.
  links[1].focus();
  const linkSnapshot = captureChatFocus(document, container);
  entries[1].remove();
  const childless = { tagName: 'DIV', parentNode: panel };
  assert.equal(restoreChatFocus(document, container, linkSnapshot, node => (node === entries[1] ? childless : null)), false);
});
