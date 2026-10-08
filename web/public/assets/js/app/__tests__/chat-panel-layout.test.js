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
 * The chat panel's stylesheet after the design review rc3 (C3, C5, C6; SPEC
 * CD5-CD8, GF2): the day divider is one centred rule, the tab-strip arrows
 * name the theme tokens, a tablet gives the chat 40vh under a 45vh map, and
 * the full-screen /chat sets 13px type in lines of at most 120ch inside a
 * border-box panel.
 *
 * @module __tests__/chat-panel-layout
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { declarationsFor, rulesFor } from './base-css-rules.js';

/** The tablet band of SPEC CD7: above the 659px phone band, up to the 1024px stack. */
const TABLET = '(min-width: 660px) and (max-width: 1024px)';

/** The band where /chat shows its tab strip (SPEC UX11 hides it at 900px and below). */
const WIDE = '(min-width: 901px)';

test('base.css draws the day divider as one centred rule with the label in --muted (CD5)', () => {
  assert.equal(rulesFor('.chat-entry-date').length, 1, 'the two divider rules are merged');
  const divider = declarationsFor('.chat-entry-date');
  assert.equal(divider.display, 'flex');
  assert.equal(divider['align-items'], 'center');
  assert.equal(divider.color, 'var(--muted)');
  assert.equal(divider['border-top'], undefined, 'the hairlines beside the label replace the top border');
  assert.equal(divider['font-weight'], undefined, 'not bold');
  for (const side of ['::before', '::after']) {
    const hairline = declarationsFor(`.chat-entry-date${side}`);
    assert.equal(hairline.content, '""', side);
    assert.equal(hairline.flex, '1', side);
    assert.equal(hairline.height, '1px', side);
    assert.equal(hairline.background, 'var(--line)', side);
  }
});

test('base.css draws the tab-strip arrows on --bg2 with --muted glyphs (CD6, GF2)', () => {
  const arrow = declarationsFor('.chat-tab-scroll-btn');
  assert.equal(arrow.background, 'var(--bg2)', 'was #1a1a1a');
  assert.equal(arrow.color, 'var(--muted)', 'was #aaa');
  assert.equal(arrow.border, 'none', 'no border to name a token for');
  assert.equal(arrow.width, '28px', 'the arrows stay 28px (UX-A9)');
});

test('base.css gives a tablet 40vh of chat under a 45vh map, phones unchanged (CD7, UX13)', () => {
  assert.equal(declarationsFor('.chat-panel', { media: TABLET }).height, '40vh');
  assert.equal(declarationsFor('#map', { media: TABLET }).height, '45vh');
  const stacked = { media: '(max-width: 1024px)' };
  assert.equal(declarationsFor('.chat-panel', stacked).order, '2', 'the chat still follows the map (UX13)');
  assert.equal(declarationsFor('.chat-panel', stacked).height, '30vh', 'phones keep their split until R1');
  assert.equal(declarationsFor('#map', stacked).height, '50vh');
});

test('base.css sets /chat in 13px type with lines of at most 120ch above 900px (CD8)', () => {
  assert.equal(declarationsFor('body.view-chat .chat-panel', { media: WIDE })['font-size'], '13px');
  assert.equal(declarationsFor('body.view-chat .chat-tabpanel', { media: WIDE }).padding, '10px 14px');
  for (const entry of ['body.view-chat .chat-entry-msg', 'body.view-chat .chat-entry-node']) {
    assert.equal(declarationsFor(entry, { media: WIDE })['max-width'], '120ch', entry);
  }
  assert.equal(declarationsFor('body.view-chat .chat-panel')['font-size'], undefined, 'a phone keeps 12px');
});

test('base.css sizes the full-screen chat panel border-box, so its right border is not clipped (CD8)', () => {
  assert.equal(declarationsFor('.chat-panel--full')['box-sizing'], 'border-box');
});
