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
 * The full-screen shells keep the dashboard's page gutter around the banner,
 * the header and the controls row (SPEC SR1).
 *
 * `/map`, `/chat`, `/nodes` and `/nodes/:id` drop the shell's side and bottom
 * padding so the map, the chat panel and the nodes table run edge to edge.
 * They dropped its top padding too: the banner and `#metaRow` sat on the
 * screen's edge, and the header's `padding-top: var(--pad)` replaced its own
 * 4 px, so its logo sat 4 px above the dashboard's. The shell now keeps the
 * top gutter inside its 100vh, the header its own padding, and the banner and
 * the controls row take the side gutter. The rendered insets and heights are
 * checked in headless Chromium (ACCEPTANCE SR-A4); this suite pins the rules
 * that decide them.
 *
 * @module app/__tests__/full-screen-gutter
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BASE_CSS_RULES, cssValue, declarationsFor } from './base-css-rules.js';

/** The full-screen shell's class, as a selector. */
const FULL = '.page-shell--full-screen';

test('a full-screen shell keeps the top gutter inside its 100vh, without side or bottom padding (SR1)', () => {
  const shell = declarationsFor(FULL);
  assert.equal(shell.padding, 'var(--pad) 0 0');
  // Without it the 16 px would add to `min-height: 100vh` (and the chat
  // view's `height: 100vh`), and /map and /chat would scroll or clip.
  assert.equal(shell['box-sizing'], 'border-box');
});

test('on a full-screen shell the banner and the controls row take the gutter on their sides (SR1)', () => {
  assert.equal(declarationsFor(`${FULL} .announcement-banner`).margin, '0 var(--pad)');
  const row = declarationsFor(`${FULL} .meta-controls`);
  assert.equal(row['padding-left'], 'var(--pad)');
  assert.equal(row['padding-right'], 'var(--pad)');
  assert.equal(row.padding, undefined, 'its 4px top and 8px bottom padding stay');
  assert.equal(row['padding-top'], undefined);
  assert.equal(row['padding-bottom'], undefined);
});

test("a full-screen header keeps the dashboard header's own top padding (SR1)", () => {
  // No full-screen rule sets the header's top padding, so `.site-header`'s
  // 4px follows the shell's gutter, with or without a banner above it.
  const rules = BASE_CSS_RULES.filter(rule =>
    rule.selectors.some(selector => selector.startsWith(FULL) && selector.endsWith('.site-header')),
  );
  assert.ok(rules.length > 0, 'the full-screen header still takes the side gutter');
  for (const rule of rules) {
    assert.equal(rule.declarations['padding-top'], undefined, rule.selector);
    assert.equal(rule.declarations.padding, undefined, rule.selector);
  }
  assert.equal(cssValue('.site-header', 'padding'), '4px 0');
});
