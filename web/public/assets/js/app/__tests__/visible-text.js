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
 * Visible text of an HTML fragment, for test assertions (SPEC CQ3).
 *
 * Strips tags again until a pass changes nothing, as `federation-page.js`
 * does, so no tag survives a nested fragment, then reads `&nbsp;` and
 * U+00A0 as plain spaces.
 *
 * @module __tests__/visible-text
 */

/**
 * Return the text a reader sees in an HTML fragment.
 *
 * @param {*} html Fragment; any value is read as a string.
 * @returns {string} The fragment without tags, non-breaking spaces as spaces.
 */
export function visibleText(html) {
  let text = String(html);
  let previous;
  do {
    previous = text;
    text = text.replace(/<[^>]*>/g, '');
  } while (text !== previous);
  return text.replace(/&nbsp;| /g, ' ');
}
