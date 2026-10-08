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
 * Above 1024 px the footer's brand group and its links share a row when both
 * fit (SPEC SR2).
 *
 * `.footer-brand-group` holds the brand, its separator and the version. At
 * 1024 px and below it lays out no box of its own (`display: contents`), so
 * PD2's tiers and the phone footer (SH1, SH2) are as before. Above 1024 px it
 * is one flex item, and the links drop PD2's `flex-basis: 100%`: the links
 * group joins the brand group's row, past a 24 px column gap and no separator,
 * when its one-line width fits beside it, and otherwise moves whole onto a row
 * of its own, as PD2's tier does. The rendered rows are checked in headless
 * Chromium (ACCEPTANCE SR-A4); this suite pins the rules that decide them.
 *
 * @module app/__tests__/footer-row
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { declarationsFor } from './base-css-rules.js';

/** Condition of the desktop footer row. */
const DESKTOP = { media: '(min-width: 1025px)' };

/** The brand, its separator and the version. */
const GROUP = '.app-footer .footer-brand-group';

test('above 1024px the brand group and the links share a row only when both fit (SR2)', () => {
  const row = declarationsFor('.app-footer .footer-content', DESKTOP);
  assert.deepEqual(row, { 'column-gap': '24px' }, 'a gap divides the groups; the row still wraps');
  const base = declarationsFor('.app-footer .footer-content');
  assert.equal(base['flex-wrap'], 'wrap');
  assert.equal(base.gap, '6px', 'the row gap stays 6px');
  // Only the tier's basis goes: the links' one-line width decides whether they
  // fit beside the brand group, and nothing pins them to its row.
  assert.deepEqual(declarationsFor('.app-footer .footer-links', DESKTOP), { 'flex-basis': 'auto' });
  assert.equal(declarationsFor('.app-footer .footer-links')['flex-wrap'], 'wrap');
});

test('above 1024px the brand, its separator and the version are one item, spaced as before (SR2)', () => {
  assert.equal(declarationsFor(GROUP).display, 'contents', 'at 1024px and below the group lays out no box');
  const group = declarationsFor(GROUP, DESKTOP);
  assert.equal(group.display, 'inline-flex');
  assert.equal(group['align-items'], 'center');
  assert.equal(group.gap, declarationsFor('.app-footer .footer-content').gap, "the footer row's 6px");
});

test('at 1024px and below the links keep their own tier (SR2, PD2)', () => {
  assert.equal(declarationsFor('.app-footer .footer-links')['flex-basis'], '100%');
  assert.equal(declarationsFor('.app-footer .footer-content')['flex-wrap'], 'wrap');
});
