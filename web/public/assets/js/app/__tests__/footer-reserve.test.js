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
 * The phone footer no longer covers the end of the page (SPEC SH1, SH2).
 *
 * At <= 600 px the footer scrolls with the page instead of pinning a stack
 * taller than the 112 px the shell reserves, and its links row moves into the
 * phone menu. Above 600 px it stays pinned (SH3). The rendered geometry is
 * checked in headless Chromium (ACCEPTANCE SH-A1); this suite pins the
 * stylesheet rules that decide it.
 *
 * @module app/__tests__/footer-reserve
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { declarationsFor } from './base-css-rules.js';

/** Condition of the phone `@media` blocks. */
const PHONE = { media: '(max-width: 600px)' };

test('at <= 600px the footer scrolls with the page, without the lift shadow (SH1)', () => {
  const footer = declarationsFor('.app-footer', PHONE);
  assert.equal(footer.position, 'static');
  assert.equal(footer['box-shadow'], 'none');
});

test('at <= 600px only the shells that render a footer drop the 96px reserve (SH1)', () => {
  assert.equal(
    declarationsFor('.page-shell:not(.page-shell--full-screen)', PHONE)['padding-bottom'],
    'var(--pad)'
  );
  // An unscoped `.page-shell` padding here would come after the full-screen
  // shell's zero bottom padding and shrink the full-screen chat panel.
  for (const selector of ['.page-shell', '.page-shell--full-screen']) {
    const phone = declarationsFor(selector, PHONE);
    assert.equal(phone['padding-bottom'], undefined, selector);
    assert.equal(phone.padding, undefined, selector);
  }
});

test('the phone footer drops its links row, which the menu carries (SH2)', () => {
  const links = declarationsFor('.app-footer .footer-links', PHONE);
  assert.equal(links.display, 'none');
  assert.equal(links['flex-direction'], undefined);
});

test('above 600px the footer stays pinned over the 96px reserve, with its lift shadow (SH3)', () => {
  const footer = declarationsFor('.app-footer');
  assert.equal(footer.position, 'fixed');
  assert.equal(footer['box-shadow'], '0 -8px 24px rgba(0, 0, 0, 0.35)');
  assert.equal(declarationsFor('.page-shell')['padding-bottom'], 'calc(96px + var(--pad))');
  // The full-screen shell's padding (no bottom reserve) is SR1's:
  // full-screen-gutter.test.js.
});
