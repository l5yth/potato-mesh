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
 * Nodes-table empty-state voice (SPEC UX4, audit D-001).
 *
 * The server ships a waiting row inside the empty `<tbody>` so a pre-boot,
 * JS-failed, or genuinely empty mesh reads as "waiting", never as a silent
 * void. The render path keeps that row in sync: present while the node set is
 * empty, removed the moment real rows exist.
 *
 * @module main/table-empty-state
 */

/** Class name of the waiting row (shared with `_nodes_table.erb`). */
export const NODES_EMPTY_ROW_CLASS = 'nodes-empty-row';

/** Operator-facing waiting message (shared with `_nodes_table.erb`). */
export const NODES_EMPTY_MESSAGE = 'No nodes heard yet — waiting for the first ingestor report.';

/**
 * Keep the waiting row consistent with the rendered node count.
 *
 * Idempotent: an existing row is reused, a missing one is created only while
 * the table is empty, and the row is removed once nodes render.
 *
 * @param {?Element} tbody The `#nodes tbody` element.
 * @param {number} nodeCount Number of node rows about to be rendered.
 * @param {?Document} documentRef Document used to create the row when absent.
 * @param {number} columnCount Total column count for the `colspan`.
 * @returns {boolean} Whether the waiting row is present after the sync.
 */
export function syncNodesEmptyRow(tbody, nodeCount, documentRef, columnCount) {
  if (!tbody || typeof tbody.querySelector !== 'function') return false;
  const existing = tbody.querySelector(`.${NODES_EMPTY_ROW_CLASS}`);
  if (nodeCount > 0) {
    if (existing && typeof tbody.removeChild === 'function') tbody.removeChild(existing);
    return false;
  }
  if (existing) return true;
  if (!documentRef || typeof documentRef.createElement !== 'function') return false;
  const row = documentRef.createElement('tr');
  row.className = NODES_EMPTY_ROW_CLASS;
  row.innerHTML = `<td colspan="${columnCount}">${NODES_EMPTY_MESSAGE}</td>`;
  tbody.appendChild(row);
  return true;
}
