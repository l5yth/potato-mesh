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
 * CL-A3 through the real refresh path (#881): a reader scrolled up in a
 * channel panel keeps their offset across a live refresh, and a reader at the
 * bottom keeps following new entries.
 *
 * Before the fix, `renderChatLog` built every tab's fragment from the memoised
 * entry nodes (CR-A1/CR-A2) before it called `renderChatTabs`, and appending a
 * cached node to the new fragment moved it out of the live panel.
 * `renderChatTabs` then read the scroll state of a panel that had already lost
 * its entries. A browser clamps that emptied panel's `scrollTop` to 0, so the
 * capture reported the reader as pinned to the bottom and the fresh panel was
 * pinned there. `renderChatLog` now reads the offset before it builds any tab
 * content (SPEC DR3).
 *
 * The shared DOM mock has no layout and never moves a node, and
 * `chat-tabs.test.js` passes fresh content nodes, so neither saw this. This
 * suite adds the two behaviours that matter, locally to this file: a node has
 * one parent at a time (appending moves it, a fragment empties into its new
 * parent), and a `.chat-tabpanel` derives `scrollHeight` from its entry
 * children and clamps `scrollTop` to its scroll range, as layout does.
 *
 * @module __tests__/main-chat-scroll-persistence
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnvironment } from './dom-environment.js';
import { buildStubFetch, makeFakeEventSource, SSE_BASE_CONFIG } from './sse-app-harness.js';
import { initializeApp } from '../main.js';

const NOW = Math.floor(Date.now() / 1000);
/** Modelled height of one chat entry, in px. */
const ENTRY_PX = 20;
/** Modelled visible height of a chat panel, in px. */
const PANEL_PX = 300;
/** Messages on the primary channel: 40 entries overflow the 300 px panel. */
const MESSAGE_COUNT = 40;

/**
 * Build `count` plaintext messages on channel 0, oldest first.
 *
 * @param {number} count Number of messages.
 * @returns {Array<Object>} Message rows as `/api/messages` serves them.
 */
function channelMessages(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    channel: 0,
    from_id: '!a',
    to_id: '^all',
    text: `history line ${index + 1}`,
    rx_time: NOW - 600 + index * 10,
    protocol: 'meshtastic',
  }));
}

/**
 * Teach the shared mock the DOM behaviour this defect depends on: single
 * parenthood (an append is a move) and panel scroll geometry. Patches the
 * mock's prototype and the environment's fragment factory.
 *
 * @param {Object} env Environment from {@link createDomEnvironment}.
 * @returns {Function} Undo function restoring the shared prototype.
 */
function installMoveAndLayoutModel(env) {
  const proto = Object.getPrototypeOf(env.createElement('div'));
  const saved = {
    appendChild: proto.appendChild,
    replaceChildren: proto.replaceChildren,
    replaceChild: proto.replaceChild,
  };
  const parentOf = new WeakMap();
  const scrollTops = new WeakMap();
  const isElement = node => Boolean(node) && typeof node === 'object' && Array.isArray(node.childNodes);
  const isFragment = node => isElement(node) && node.tagName === 'FRAGMENT';
  const isPanel = node => isElement(node) && node.classList.contains('chat-tabpanel');
  const detach = node => {
    const parent = isElement(node) ? parentOf.get(node) : null;
    if (!parent) return;
    const index = parent.childNodes.indexOf(node);
    if (index >= 0) parent.childNodes.splice(index, 1);
    parentOf.delete(node);
  };
  // A fragment hands its children over and is left empty, as in the DOM.
  const expand = nodes => nodes.flatMap(node => (isFragment(node) ? [...node.childNodes] : [node]));
  const adopt = (parent, node) => {
    detach(node);
    if (isElement(node)) parentOf.set(node, parent);
    return node;
  };

  proto.appendChild = function appendChild(node) {
    for (const child of expand([node])) this.childNodes.push(adopt(this, child));
    return node;
  };
  proto.replaceChildren = function replaceChildren(...nodes) {
    const incoming = expand(nodes.filter(Boolean)).map(child => {
      detach(child);
      return child;
    });
    for (const old of this.childNodes) if (isElement(old)) parentOf.delete(old);
    this.childNodes = [];
    for (const child of incoming) this.childNodes.push(adopt(this, child));
  };
  proto.replaceChild = function replaceChild(newNode, oldNode) {
    if (!this.childNodes.includes(oldNode)) throw new Error('replaceChild: oldNode is not a child of this element');
    detach(newNode);
    // Look the slot up after the detach: newNode may have been a sibling.
    const at = this.childNodes.indexOf(oldNode);
    this.childNodes[at] = newNode;
    if (isElement(newNode)) parentOf.set(newNode, this);
    parentOf.delete(oldNode);
    return oldNode;
  };
  // Fragments use the prototype methods above instead of their own push-only ones.
  env.document.createDocumentFragment = () => env.createElement('fragment');

  const entryCount = panel =>
    panel.childNodes.filter(node => isElement(node) && String(node.className || '').includes('chat-entry')).length;
  const maxScroll = panel => Math.max(PANEL_PX, entryCount(panel) * ENTRY_PX) - PANEL_PX;
  const clamp = (panel, value) => Math.min(Math.max(Number(value) || 0, 0), maxScroll(panel));
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get() {
      return isPanel(this) ? PANEL_PX : 0;
    },
  });
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get() {
      return isPanel(this) ? Math.max(PANEL_PX, entryCount(this) * ENTRY_PX) : 0;
    },
  });
  // Reading or writing a panel's offset flushes layout: it is clamped to the
  // range its current children give it.
  Object.defineProperty(proto, 'scrollTop', {
    configurable: true,
    get() {
      const stored = scrollTops.get(this) || 0;
      if (!isPanel(this)) return stored;
      const clamped = clamp(this, stored);
      scrollTops.set(this, clamped);
      return clamped;
    },
    set(value) {
      scrollTops.set(this, isPanel(this) ? clamp(this, value) : Number(value) || 0);
    },
  });

  return () => {
    Object.assign(proto, saved);
    delete proto.clientHeight;
    delete proto.scrollHeight;
    delete proto.scrollTop;
  };
}

/**
 * Boot the dashboard over a fake `EventSource` and a stub `fetch` with the
 * move-and-layout model installed, run `fn`, then tear everything down.
 *
 * @param {Object<string, *>} responses URL-substring -> JSON body.
 * @param {(ctx: { testUtils: Object, stream: Object, chat: Object }) => Promise<void>} fn Body.
 * @returns {Promise<void>}
 */
async function runChatApp(responses, fn) {
  const env = createDomEnvironment({ includeBody: true });
  const restoreModel = installMoveAndLayoutModel(env);
  const chat = env.createElement('div', 'chat');
  env.registerElement('chat', chat);
  const originalFetch = globalThis.fetch;
  const originalES = globalThis.EventSource;
  const originalIdb = globalThis.indexedDB;
  globalThis.fetch = buildStubFetch(responses).fetch;
  globalThis.indexedDB = undefined;
  const FakeEventSource = makeFakeEventSource();
  globalThis.EventSource = FakeEventSource;
  let testUtils = null;
  try {
    ({ _testUtils: testUtils } = initializeApp({ ...SSE_BASE_CONFIG }));
    await testUtils.initialLoad;
    await testUtils.flushBackfill();
    await fn({ testUtils, stream: FakeEventSource.instances[0], chat });
  } finally {
    if (testUtils) await testUtils.flushCacheWrites();
    for (let i = 0; i < 3; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
    if (testUtils) testUtils.stopAutoRefresh();
    globalThis.fetch = originalFetch;
    if (originalES === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = originalES;
    globalThis.indexedDB = originalIdb;
    restoreModel();
    env.cleanup();
  }
}

/**
 * The chat panel currently shown in `#chat`.
 *
 * @param {Object} chat The `#chat` container.
 * @returns {?Object} The visible `.chat-tabpanel`.
 */
function visiblePanel(chat) {
  const panelWrapper = chat.children[1];
  return panelWrapper ? panelWrapper.children.find(panel => panel.hidden === false) || null : null;
}

/**
 * Responses for one node and its channel history. The encrypted feed is
 * listed first so it does not also match the plaintext `/api/messages` key.
 *
 * @param {Array<Object>} messages Plaintext channel messages.
 * @returns {Object<string, *>} Stub-fetch response map.
 */
function chatResponses(messages) {
  return {
    'encrypted=true': [],
    '/api/nodes': [{ node_id: '!a', short_name: 'A', long_name: 'Node A', last_heard: NOW, protocol: 'meshtastic' }],
    '/api/messages': messages,
  };
}

/**
 * Deliver one SSE `messages` ping and wait for its refresh to render.
 *
 * @param {{ testUtils: Object, stream: Object }} ctx App context.
 * @returns {Promise<void>}
 */
async function livePing({ testUtils, stream }) {
  stream.dispatch('change', { data: JSON.stringify({ collection: 'messages' }) });
  await testUtils.flushLiveRefresh();
}

test('a reader scrolled up in a channel keeps their offset across a live refresh (CL-A3, #881)', async () => {
  const messages = channelMessages(MESSAGE_COUNT);
  await runChatApp(chatResponses(messages), async ctx => {
    const panel = visiblePanel(ctx.chat);
    assert.ok(panel, 'the primary channel panel is visible');
    assert.ok(panel.scrollHeight - panel.clientHeight > 120, 'the history overflows the panel');
    assert.equal(panel.scrollTop, panel.scrollHeight - panel.clientHeight, 'the first render opens at the newest entry');

    panel.scrollTop = 120; // the reader scrolls up to read history
    messages.push({ ...channelMessages(MESSAGE_COUNT + 1)[MESSAGE_COUNT], rx_time: NOW });
    await livePing(ctx);

    assert.equal(
      visiblePanel(ctx.chat).scrollTop,
      120,
      'a passive live refresh must leave a scrolled-up reader where they were, not at the bottom',
    );
  });
});

test('a reader at the bottom follows a new entry across a live refresh (CL-A3 tail-follow, #881)', async () => {
  const messages = channelMessages(MESSAGE_COUNT);
  await runChatApp(chatResponses(messages), async ctx => {
    const panel = visiblePanel(ctx.chat);
    const heightBefore = panel.scrollHeight;
    assert.equal(panel.scrollTop, heightBefore - panel.clientHeight, 'the reader starts at the newest entry');

    messages.push({ ...channelMessages(MESSAGE_COUNT + 1)[MESSAGE_COUNT], rx_time: NOW });
    await livePing(ctx);

    const next = visiblePanel(ctx.chat);
    assert.ok(next.scrollHeight > heightBefore, 'the new entry rendered');
    assert.equal(
      next.scrollTop,
      next.scrollHeight - next.clientHeight,
      'a reader pinned to the bottom stays pinned to the new bottom',
    );
  });
});
