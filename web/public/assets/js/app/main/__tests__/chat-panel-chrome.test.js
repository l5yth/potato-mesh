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
 * Unit tests for the kept day dividers and empty-state notes of the chat
 * panels (#881, SPEC DR1).
 *
 * @module main/__tests__/chat-panel-chrome
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createChatPanelChrome } from '../chat-panel-chrome.js';
import { formatDate } from '../format-utils.js';

/**
 * Document double whose elements count text writes.
 *
 * @returns {{ createElement: Function, created: function(): number }} Fake document.
 */
function makeDoc() {
  let created = 0;
  return {
    createElement(tag) {
      created += 1;
      const node = { tagName: tag.toUpperCase(), className: '', textWrites: 0, _text: '' };
      Object.defineProperty(node, 'textContent', {
        get: () => node._text,
        set: value => {
          node.textWrites += 1;
          node._text = String(value);
        }
      });
      return node;
    },
    created: () => created
  };
}

/** Noon of the current local day, Unix seconds (far from any midnight). */
const NOON = (() => {
  const day = new Date();
  day.setHours(12, 0, 0, 0);
  return Math.floor(day.getTime() / 1000);
})();
const DAY = 24 * 60 * 60;

test('createChatPanelChrome needs a document with createElement', () => {
  assert.throws(() => createChatPanelChrome({ documentRef: {} }), TypeError);
  assert.throws(() => createChatPanelChrome({ documentRef: null }), TypeError);
});

test('a build hands out one divider per day, before the first entry of the day', () => {
  const chrome = createChatPanelChrome({ documentRef: makeDoc() });
  const build = chrome.begin('channel-0');
  assert.equal(build.divider(0), null, 'no timestamp, no divider');
  assert.equal(build.divider(undefined), null);
  const yesterday = build.divider(NOON - DAY);
  assert.equal(yesterday.tagName, 'DIV');
  assert.equal(yesterday.className, 'chat-entry-date');
  assert.equal(yesterday.textContent, `-- ${formatDate(new Date((NOON - DAY) * 1000))} --`);
  assert.equal(build.divider(NOON - DAY + 60), null, 'the same day continues');
  const today = build.divider(NOON);
  assert.notEqual(today, yesterday);
  assert.equal(today.textContent, `-- ${formatDate(new Date(NOON * 1000))} --`);
  build.finish();
  assert.equal(chrome.size('channel-0'), 2);
});

test('a later build of the same panel reuses its dividers and writes nothing (DR1, #881)', () => {
  const doc = makeDoc();
  const chrome = createChatPanelChrome({ documentRef: doc });
  const first = chrome.begin('log');
  const dividers = [first.divider(NOON - DAY), first.divider(NOON)];
  first.finish();
  const created = doc.created();

  const second = chrome.begin('log');
  assert.ok(second.divider(NOON - DAY + 5) === dividers[0]);
  assert.ok(second.divider(NOON + 5) === dividers[1]);
  second.finish();
  assert.equal(doc.created(), created, 'no new node');
  assert.deepEqual(dividers.map(node => node.textWrites), [1, 1], 'no text rewritten');
});

test('entries out of time order start a day twice and keep a divider per run', () => {
  const chrome = createChatPanelChrome({ documentRef: makeDoc() });
  const build = chrome.begin('log');
  const firstRun = build.divider(NOON);
  build.divider(NOON - DAY);
  const secondRun = build.divider(NOON + 60);
  assert.ok(secondRun && secondRun !== firstRun, 'each run of a day has its own divider');
  assert.equal(secondRun.textContent, firstRun.textContent);
  build.finish();
  assert.equal(chrome.size('log'), 3);

  const again = chrome.begin('log');
  assert.ok(again.divider(NOON) === firstRun);
  again.divider(NOON - DAY);
  assert.ok(again.divider(NOON + 60) === secondRun, 'the second run keeps its own divider');
});

test('finish forgets the dividers of days that left the panel', () => {
  const chrome = createChatPanelChrome({ documentRef: makeDoc() });
  const first = chrome.begin('c1');
  const old = first.divider(NOON - DAY);
  first.divider(NOON);
  first.finish();

  const second = chrome.begin('c1');
  second.divider(NOON);
  second.finish();
  assert.equal(chrome.size('c1'), 1);
  const third = chrome.begin('c1');
  assert.notEqual(third.divider(NOON - DAY), old, 'a day that returns gets a new divider');
});

test('the empty-state note is one node per panel and its text is written only on a change', () => {
  const doc = makeDoc();
  const chrome = createChatPanelChrome({ documentRef: doc });
  const note = chrome.begin('c1').empty('No messages on this channel.');
  assert.equal(note.tagName, 'P');
  assert.equal(note.className, 'chat-empty');
  assert.equal(note.textContent, 'No messages on this channel.');
  assert.ok(chrome.begin('c1').empty('No messages on this channel.') === note);
  assert.equal(note.textWrites, 1);
  chrome.begin('c1').empty('Nothing here.');
  assert.equal(note.textContent, 'Nothing here.');
  assert.notEqual(chrome.begin('c2').empty('Nothing here.'), note, 'each panel has its own note');
});

test('retainNamespaces forgets the panels of tabs that are gone', () => {
  const chrome = createChatPanelChrome({ documentRef: makeDoc() });
  for (const namespace of ['log', 'c1', 'c2']) {
    const build = chrome.begin(namespace);
    build.divider(NOON);
    build.finish();
  }
  chrome.retainNamespaces(new Set(['log', 'c2']));
  assert.deepEqual(['log', 'c1', 'c2'].map(chrome.size), [1, 0, 1]);
  chrome.retainNamespaces(['c2']);
  assert.deepEqual(['log', 'c1', 'c2'].map(chrome.size), [0, 0, 1]);
  assert.equal(chrome.size('unknown'), 0);
});

test('createChatPanelChrome falls back to the ambient document', () => {
  const original = globalThis.document;
  globalThis.document = makeDoc();
  try {
    assert.equal(createChatPanelChrome().begin('log').divider(NOON).className, 'chat-entry-date');
  } finally {
    if (original === undefined) delete globalThis.document;
    else globalThis.document = original;
  }
  assert.throws(() => createChatPanelChrome(), TypeError, 'no ambient document either');
});
