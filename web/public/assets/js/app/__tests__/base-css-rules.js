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
 * Shared reader of base.css for stylesheet tests (SPEC GF7).
 *
 * Reads the dashboard stylesheet once, without its comments, so a class named
 * in a comment is never taken for a rule, and parses it into style rules: a
 * test asks for the declarations of a selector, at the top level or under one
 * `@media` or `@supports` condition, instead of matching `base.css` with a
 * regex of its own.
 *
 * @module app/__tests__/base-css-rules
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `base.css` with its comments removed.
 *
 * @type {string}
 */
export const BASE_CSS = readFileSync(fileURLToPath(new URL('../../../styles/base.css', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * One style rule of the stylesheet.
 *
 * @typedef {Object} CssRule
 * @property {?string} media Condition of the enclosing `@media`, such as
 *   `(max-width: 1024px)`, or `null` for a rule outside every `@media`.
 * @property {?string} supports Condition of the enclosing `@supports`, such as
 *   `not (color: color-mix(in srgb, #000 50%, transparent))`, or `null` for a
 *   rule outside every `@supports`.
 * @property {Array<string>} selectors The rule's selector list.
 * @property {string} selector The selector list joined with `, `.
 * @property {string} body The rule's text between its braces.
 * @property {Object<string, string>} declarations Property to value; a later
 *   declaration of the same property wins.
 */

/**
 * Collapse runs of whitespace to one space and trim.
 *
 * @param {string} text Raw CSS text.
 * @returns {string} Normalised text.
 */
function squash(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Split `text` at each `separator` outside parentheses and quotes, so a comma
 * inside `:is(…)` or a semicolon inside a string stays in its part.
 *
 * @param {string} text Text to split.
 * @param {string} separator One-character separator.
 * @returns {Array<string>} Normalised, non-empty parts.
 */
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    } else if (char === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map(squash).filter(Boolean);
}

/**
 * Index just past the `}` that closes the block opened at `open`.
 *
 * @param {string} css Stylesheet text.
 * @param {number} open Index of the block's `{`.
 * @returns {number} Index after the matching `}`.
 */
function blockEnd(css, open) {
  let depth = 0;
  let index = open;
  do {
    if (css[index] === '{') depth += 1;
    else if (css[index] === '}') depth -= 1;
    index += 1;
  } while (depth > 0 && index < css.length);
  return index;
}

/**
 * Parse the style rules of `css`, descending into `@media` and `@supports`
 * blocks and skipping other at-rules (`@keyframes` frames are not style
 * rules).
 *
 * @param {string} css Stylesheet text without comments.
 * @param {?string} [media=null] Condition of the enclosing `@media`.
 * @param {?string} [supports=null] Condition of the enclosing `@supports`.
 * @returns {Array<CssRule>} Rules in source order.
 */
function parseRules(css, media = null, supports = null) {
  const rules = [];
  let open = css.indexOf('{');
  let cursor = 0;
  while (open >= 0) {
    const head = squash(css.slice(cursor, open));
    const end = blockEnd(css, open);
    const body = css.slice(open + 1, end - 1);
    if (head.startsWith('@media')) {
      rules.push(...parseRules(body, squash(head.slice('@media'.length)), supports));
    } else if (head.startsWith('@supports')) {
      rules.push(...parseRules(body, media, squash(head.slice('@supports'.length))));
    } else if (!head.startsWith('@')) {
      const declarations = {};
      for (const declaration of splitTopLevel(body, ';')) {
        const colon = declaration.indexOf(':');
        declarations[squash(declaration.slice(0, colon))] = squash(declaration.slice(colon + 1));
      }
      const selectors = splitTopLevel(head, ',');
      rules.push({ media, supports, selectors, selector: selectors.join(', '), body, declarations });
    }
    cursor = end;
    open = css.indexOf('{', cursor);
  }
  return rules;
}

/**
 * Every style rule of `base.css`, in source order.
 *
 * @type {Array<CssRule>}
 */
export const BASE_CSS_RULES = parseRules(BASE_CSS);

/**
 * The rules whose selector list holds `selector` exactly.
 *
 * @param {string} selector Selector, written as in `base.css`.
 * @param {{ media?: ?string, supports?: ?string }} [options] `media`: the
 *   exact `@media` condition, or `null` (the default) for rules outside every
 *   `@media`; `supports`: the exact `@supports` condition, or `null` (the
 *   default) for rules outside every `@supports`.
 * @returns {Array<CssRule>} Matching rules, in source order.
 */
export function rulesFor(selector, { media = null, supports = null } = {}) {
  return BASE_CSS_RULES.filter(
    rule => rule.media === media && rule.supports === supports && rule.selectors.includes(selector),
  );
}

/**
 * The declarations of `selector` over all its rules in source order, as the
 * cascade merges rules of equal specificity.
 *
 * @param {string} selector Selector, written as in `base.css`.
 * @param {{ media?: ?string }} [options] See {@link rulesFor}.
 * @returns {Object<string, string>} Property to winning value.
 */
export function declarationsFor(selector, options = {}) {
  return Object.assign({}, ...rulesFor(selector, options).map(rule => rule.declarations));
}

/**
 * Every top-level rule of base.css (outside any `@media` and any
 * `@supports`), in source order.
 *
 * @type {ReadonlyArray<CssRule>}
 */
export const TOP_LEVEL_RULES = Object.freeze(
  BASE_CSS_RULES.filter(rule => rule.media === null && rule.supports === null),
);

/**
 * Every top-level rule whose whole selector list is `selectorList`.
 *
 * @param {string} selectorList Selector list; spacing around commas and line
 *   breaks do not matter.
 * @returns {Array<CssRule>} The rules in source order; the assertion fails
 *   when base.css has none.
 */
export function cssRules(selectorList) {
  const wanted = splitTopLevel(selectorList, ',').join(', ');
  const rules = TOP_LEVEL_RULES.filter(rule => rule.selector === wanted);
  assert.ok(rules.length > 0, `base.css has a top-level ${wanted} rule`);
  return rules;
}

/**
 * The value of the last declaration of `property` across the top-level rules
 * of `selectorList`: among rules of one selector, the one the cascade keeps.
 *
 * @param {string} selectorList Selector list, as for {@link cssRules}.
 * @param {string} property Property name, e.g. `border` or `border-color`.
 * @returns {?string} The value, or `null` when no such rule sets it.
 */
export function cssValue(selectorList, property) {
  const values = cssRules(selectorList)
    .map(rule => rule.declarations[property])
    .filter(value => value !== undefined);
  return values.length > 0 ? values.at(-1) : null;
}

/**
 * The custom properties `:root` declares, by name.
 *
 * @type {ReadonlyMap<string, string>}
 */
export const ROOT_TOKENS = new Map(
  cssRules(':root').flatMap(rule =>
    Object.entries(rule.declarations).filter(([name]) => name.startsWith('--')),
  ),
);

/**
 * Follow a `var(--token)` value through `:root` to the value it ends at.
 *
 * @param {string} value Declaration or token value.
 * @returns {string} `value` itself unless it is exactly one `var()`
 *   reference; the assertion fails when `:root` does not declare the token.
 */
export function resolveToken(value) {
  const reference = /^var\((--[\w-]+)\)$/.exec(value);
  if (!reference) return value;
  assert.ok(ROOT_TOKENS.has(reference[1]), `:root declares ${reference[1]}`);
  return resolveToken(ROOT_TOKENS.get(reference[1]));
}
