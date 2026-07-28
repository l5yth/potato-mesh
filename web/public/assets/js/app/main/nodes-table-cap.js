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
 * Node-table render cap (frontend perf: render scale).
 *
 * The node table renders a main row plus a hidden UX9 disclosure row per node,
 * so a busy instance's full node set is thousands of DOM rows that stall layout
 * and interaction. These pure helpers let the table render only the top N nodes
 * (by the caller's already-sorted order) and offer a "show all" control that the
 * app wires to re-render the full set on demand.
 *
 * @module main/nodes-table-cap
 */

/** CSS class on the "show all" control row (delegated click target lives here). */
export const SHOW_ALL_ROW_CLASS = 'nodes-show-all-row';

/** CSS class on the "show all" button — the delegated click selector. */
export const SHOW_ALL_BUTTON_CLASS = 'nodes-show-all';

/**
 * Decide how many of the (already filtered + sorted) nodes to render.
 *
 * @param {Array<Object>} nodes The full filtered/sorted node list.
 * @param {number} cap Maximum rows to render when not expanded (a non-finite or
 *   non-positive cap disables capping).
 * @param {boolean} expanded When true the user asked to see every node, so the
 *   whole list renders regardless of the cap.
 * @returns {{ renderNodes: Array<Object>, capped: boolean }} The slice to render
 *   and whether it was truncated (i.e. a "show all" control is warranted).
 */
export function capNodesForRender(nodes, cap, expanded) {
  const list = Array.isArray(nodes) ? nodes : [];
  const capActive = !expanded && Number.isFinite(cap) && cap > 0 && list.length > cap;
  return { renderNodes: capActive ? list.slice(0, cap) : list, capped: capActive };
}

/**
 * Build the "show all" control row appended after the capped rows.
 *
 * @param {Document} documentRef DOM document used to create the elements.
 * @param {number} totalCount The full node count (shown in the button label).
 * @param {number} colspan Column count the control cell should span.
 * @returns {Element} A ``<tr>`` hosting the "show all" button.
 */
export function buildShowAllRow(documentRef, totalCount, colspan) {
  const tr = documentRef.createElement('tr');
  tr.className = SHOW_ALL_ROW_CLASS;
  const td = documentRef.createElement('td');
  td.className = 'nodes-show-all-cell';
  td.setAttribute('colspan', String(colspan));
  const button = documentRef.createElement('button');
  button.type = 'button';
  button.className = SHOW_ALL_BUTTON_CLASS;
  button.textContent = `Show all ${totalCount.toLocaleString()} nodes`;
  td.appendChild(button);
  tr.appendChild(td);
  return tr;
}
