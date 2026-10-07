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
 * The nodes table's `+` disclosure as remembered state (SPEC UX9; #881,
 * SPEC DR1).
 *
 * The `+` cell toggled its hidden-field row in the DOM only, so every live
 * refresh, which rebuilt the row collapsed, closed it again. The open state
 * now lives in a set of node ids, like the identity carets'
 * `expandedIdentities`: the click flips the set and writes the DOM, and each
 * render writes the set back onto the rows it keeps or builds. The state is
 * kept out of the row signature, so opening a disclosure rebuilds nothing.
 *
 * @module main/node-extra-disclosure
 */

/** Class of the hidden-field disclosure row. */
export const NODE_EXTRA_ROW_CLASS = 'node-extra';

/** Class of the `+` toggle button. */
export const NODE_EXTRA_TOGGLE_CLASS = 'node-extra-toggle';

/** Glyph of an open disclosure's toggle (U+2212 MINUS SIGN). */
export const NODE_EXTRA_OPEN_GLYPH = '−';

/** Glyph of a closed disclosure's toggle. */
export const NODE_EXTRA_CLOSED_GLYPH = '+';

/**
 * Find the disclosure row of a node row: the next `.node-extra` row, past the
 * node's identity sub-rows (SPEC RA2) but never past another node's row.
 *
 * @param {?Element} row A node row.
 * @returns {?Element} Its disclosure row, or `null`.
 */
export function findNodeExtraRow(row) {
  for (let next = row ? row.nextElementSibling : null; next; next = next.nextElementSibling) {
    if (next.classList.contains(NODE_EXTRA_ROW_CLASS)) return next;
    if (!next.classList.contains('nodes-subrow')) return null;
  }
  return null;
}

/**
 * Write a disclosure state onto a `+` toggle, touching only what differs.
 *
 * @param {?Element} toggle The `.node-extra-toggle` button.
 * @param {boolean} open Whether the disclosure is open.
 * @returns {void}
 */
export function applyNodeExtraToggleState(toggle, open) {
  if (!toggle) return;
  const expanded = open ? 'true' : 'false';
  if (toggle.getAttribute('aria-expanded') !== expanded) toggle.setAttribute('aria-expanded', expanded);
  const glyph = open ? NODE_EXTRA_OPEN_GLYPH : NODE_EXTRA_CLOSED_GLYPH;
  if (toggle.textContent !== glyph) toggle.textContent = glyph;
}

/**
 * Show or hide a disclosure row, touching it only when the state differs.
 *
 * @param {?Element} extraRow The `.node-extra` row.
 * @param {boolean} open Whether the disclosure is open.
 * @returns {void}
 */
export function applyNodeExtraRowState(extraRow, open) {
  if (extraRow && extraRow.hidden === open) extraRow.hidden = !open;
}

/**
 * Handle a click on a `+` toggle: flip its node's disclosure, remember the
 * new state under the row's node id and write it to the DOM.
 *
 * @param {Set<string>} openNodeIds Node ids whose disclosure is open.
 * @param {Element} toggle The clicked `.node-extra-toggle`.
 * @returns {boolean} `true` when a disclosure row was found and toggled.
 */
export function toggleNodeExtra(openNodeIds, toggle) {
  const row = toggle.closest('tr');
  const extraRow = findNodeExtraRow(row);
  if (!extraRow) return false;
  const open = extraRow.hidden;
  const nodeId = row.dataset.nodeRow;
  if (nodeId) {
    if (open) openNodeIds.add(nodeId);
    else openNodeIds.delete(nodeId);
  }
  applyNodeExtraRowState(extraRow, open);
  applyNodeExtraToggleState(toggle, open);
  return true;
}
