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
 * Shell stylesheet rules: the announcement banner (SPEC SH4), the region
 * toggle and header row (SH5, SH6) and the phone menu (SH2, SH7).
 *
 * The DOM stubs lay nothing out, so each rule is checked where it is decided:
 * which selector declares it, at which width, and whether that selector
 * outranks the rule it has to beat. The rendered results are checked in
 * headless Chromium (ACCEPTANCE SH-A2 to SH-A6).
 *
 * @module app/__tests__/shell-css
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BASE_CSS_RULES,
  TOP_LEVEL_RULES,
  cssValue,
  declarationsFor,
  resolveToken,
  rulesFor,
} from './base-css-rules.js';

/** Condition of the phone `@media` blocks. */
const PHONE = { media: '(max-width: 600px)' };

/** Selector naming the region toggle, by class or by id. */
const REGION_TOGGLE = /instance-selector-toggle|#instanceSelectToggle/;

/** Selectors of the generic `button:not(…)` reset and its hover rule. */
const BUTTON_RESET = TOP_LEVEL_RULES.flatMap((rule) => rule.selectors).filter((selector) =>
  selector.startsWith('button:not(')
);

/**
 * Specificity of one selector as a comparable number: ids, then classes,
 * attributes and pseudo-classes, then types and pseudo-elements. Covers the
 * selector syntax base.css uses: `:not()` and `:is()` count as their argument
 * and `:where()` counts nothing. Not in the shared base-css-rules helper.
 *
 * @param {string} selector One selector, without commas at the top level.
 * @returns {number} `ids * 1e6 + classes * 1e3 + types`.
 */
function specificity(selector) {
  const text = selector
    .replace(/"[^"]*"|'[^']*'/g, '""')
    .replace(/:where\([^)]*\)/g, ' ')
    .replace(/:(?:not|is)\(([^)]*)\)/g, ' $1 ');
  const ids = (text.match(/#[\w-]+/g) || []).length;
  const classes = (text.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):[\w-]+/g) || []).length;
  const types = (text.match(/(?:^|[\s>+~])[a-zA-Z][\w-]*|::[\w-]+/g) || []).length;
  return ids * 1e6 + classes * 1e3 + types;
}

test('banner links take the banner colour, underlined (SH4)', () => {
  const link = declarationsFor('.announcement-banner a');
  assert.equal(link.color, 'inherit');
  assert.equal(link['text-decoration'], 'underline');
  assert.equal(link['text-underline-offset'], '2px');
});

test('at <= 600px the banner grows to three whole lines, then an ellipsis (SH4)', () => {
  const banner = declarationsFor('.announcement-banner', PHONE);
  assert.equal(banner.height, 'auto');
  assert.equal(banner['max-height'], 'none');
  const content = declarationsFor('.announcement-banner__content', PHONE);
  assert.equal(content['white-space'], 'normal');
  assert.equal(content.display, '-webkit-box');
  assert.equal(content['-webkit-box-orient'], 'vertical');
  assert.equal(content['-webkit-line-clamp'], '3');
});

test('header glyphs keep their drawn size inside the padded buttons (SH5)', () => {
  assert.equal(cssValue('.icon-button > svg', 'flex'), 'none');
});

test('the open phone menu paints above the footer (SH2)', () => {
  // The footer keeps its z-index as a flex item even where it is static.
  const menu = Number(cssValue('.mobile-menu', 'z-index'));
  const footer = Number(cssValue('.app-footer', 'z-index'));
  assert.ok(menu > footer, `menu ${menu} above footer ${footer}`);
});

test('the phone menu panel fills the viewport height, padding included (SH2)', () => {
  // A stretched flex item: `height: 100%` added the 32 px of padding below the
  // viewport, so a panel that scrolls hid the end of its last link.
  const menu = declarationsFor('.mobile-menu');
  assert.equal(menu.display, 'flex');
  assert.equal(menu['align-items'], undefined);
  const panel = declarationsFor('.mobile-menu__panel');
  assert.equal(panel.height, undefined);
  assert.equal(panel['overflow-y'], 'auto');
});

test('the region toggle is neither greyscale nor dimmed (SH5)', () => {
  const toggleRules = BASE_CSS_RULES.filter((rule) => rule.selectors.some((s) => REGION_TOGGLE.test(s)));
  assert.ok(toggleRules.length > 0, 'base.css styles the region toggle');
  for (const rule of toggleRules) {
    assert.equal(rule.declarations.filter, undefined, rule.selector);
    assert.equal(rule.declarations.opacity, undefined, rule.selector);
  }
});

test('the header title and the region toggle share one row that wraps when narrow (SH6)', () => {
  const left = declarationsFor('.site-header__left');
  assert.equal(left['flex-direction'], 'row');
  assert.equal(left['flex-wrap'], 'wrap');
  const overrides = BASE_CSS_RULES.filter(
    (rule) => rule.media !== null && rule.selectors.includes('.site-header__left')
  );
  for (const rule of overrides) {
    assert.equal(rule.declarations['flex-direction'], undefined, rule.media);
    assert.equal(rule.declarations['flex-wrap'], undefined, rule.media);
  }
});

test('the region toggle draws its own pill and the open accent frame (SH6)', () => {
  assert.equal(cssValue('#instanceSelectToggle', 'height'), '28px');
  assert.equal(cssValue('#instanceSelectToggle', 'padding'), '0 8px');
  assert.equal(cssValue('#instanceSelectToggle', 'border'), '1px solid var(--input-border)');
  assert.equal(cssValue('#instanceSelectToggle', 'border-radius'), '999px');
  assert.equal(cssValue('#instanceSelectToggle', 'color'), 'var(--muted)');
  const open = '#instanceSelectToggle[aria-expanded="true"]';
  assert.equal(cssValue(open, 'border-color'), 'var(--accent)');
  assert.equal(cssValue(open, 'background'), 'var(--input-bg)');
});

test('the new shell rules use only tokens that :root declares (SH1, SH2, SH6)', () => {
  const rules = [
    ...rulesFor('#instanceSelectToggle'),
    ...rulesFor('#instanceSelectToggle[aria-expanded="true"]'),
    ...rulesFor('.mobile-nav--pages'),
    ...rulesFor('.page-shell:not(.page-shell--full-screen)', PHONE),
  ];
  const references = rules.flatMap((rule) =>
    Object.values(rule.declarations).flatMap((value) => value.match(/var\(--[\w-]+\)/g) || [])
  );
  assert.deepEqual(references.sort(), [
    'var(--accent)',
    'var(--input-bg)',
    'var(--input-border)',
    'var(--line)',
    'var(--muted)',
    'var(--pad)',
  ]);
  // resolveToken asserts that :root declares each one, through any alias.
  for (const reference of references) {
    assert.doesNotMatch(resolveToken(reference), /^var\(/, reference);
  }
});

test('every region toggle rule outranks the generic button reset (SH6, FU2)', () => {
  assert.ok(BUTTON_RESET.length >= 2, 'base.css has the reset and its hover rule');
  const reset = Math.max(...BUTTON_RESET.map(specificity));
  const toggle = TOP_LEVEL_RULES.flatMap((rule) => rule.selectors).filter((s) => REGION_TOGGLE.test(s));
  assert.ok(toggle.length >= 2, 'base.css styles the closed and the open toggle');
  for (const selector of toggle) {
    assert.ok(specificity(selector) > reset, `${selector} outranks ${BUTTON_RESET.join(', ')}`);
  }
});

test('phone menu links are 44px tall from padding alone (SH7)', () => {
  // 10 px padding, a 22 px line and a 2 px border make 44 px; base.css has no
  // global border-box, so a min-height would add to the padding instead.
  const link = declarationsFor('.mobile-nav__link');
  assert.equal(link.padding, '10px 12px');
  assert.equal(link['min-height'], undefined);
});

test('the phone menu close button is a 44px target over the 36px icon button (SH7)', () => {
  const close = '.icon-button.mobile-menu__close';
  assert.equal(cssValue(close, 'width'), '44px');
  assert.equal(cssValue(close, 'height'), '44px');
  // `.icon-button` comes later in the file, so only a higher specificity wins.
  assert.ok(specificity(close) > specificity('.icon-button'));
});

test('specificity ranks ids over classes over types (local helper)', () => {
  assert.equal(specificity('#a'), 1e6);
  assert.equal(specificity('.a[b="c,d"]:hover'), 3e3);
  assert.equal(specificity('button:not(.a):not(.b)::before'), 2e3 + 2);
  assert.equal(specificity(':where(.a) a > b'), 2);
  assert.equal(specificity(':is(.a)'), 1e3);
});
