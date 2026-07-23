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
 * Nodes-table information architecture (SPEC UX9, audit D-006/007/017/023).
 *
 * Pure helpers behind the table's curated structure: the grouped second
 * header row (whose colspans must track the responsive hide tiers), the
 * numeric-column set, the mobile disclosure row, and whole-row activation.
 *
 * @module main/nodes-table-ia
 */

/**
 * Ordered column groups for the grouped header row. Columns appear exactly
 * once, in their template order, so contiguous colspans are well defined.
 *
 * @type {ReadonlyArray<{label: string, columns: ReadonlyArray<string>}>}
 */
export const NODES_TABLE_COLUMN_GROUPS = Object.freeze([
  Object.freeze({
    label: 'Identity',
    columns: Object.freeze([
      'nodes-col--protocol',
      'nodes-col--node-id',
      'nodes-col--short-name',
      'nodes-col--long-name',
    ]),
  }),
  Object.freeze({
    label: 'Radio',
    columns: Object.freeze(['nodes-col--frequency', 'nodes-col--modem-preset']),
  }),
  Object.freeze({
    label: 'Activity',
    columns: Object.freeze(['nodes-col--last-seen', 'nodes-col--role']),
  }),
  Object.freeze({
    label: 'Health',
    columns: Object.freeze([
      'nodes-col--hw-model',
      'nodes-col--battery',
      'nodes-col--voltage',
      'nodes-col--uptime',
    ]),
  }),
  Object.freeze({
    label: 'Utilization',
    columns: Object.freeze(['nodes-col--channel-util', 'nodes-col--air-util-tx']),
  }),
  Object.freeze({
    label: 'Environment',
    columns: Object.freeze([
      'nodes-col--temperature',
      'nodes-col--humidity',
      'nodes-col--pressure',
    ]),
  }),
  Object.freeze({
    label: 'Position',
    columns: Object.freeze([
      'nodes-col--latitude',
      'nodes-col--longitude',
      'nodes-col--altitude',
      'nodes-col--last-position',
    ]),
  }),
]);

/**
 * The responsive hide tiers, mirroring the `base.css` media blocks (SPEC
 * UX9: ≤ 659 px hides Role and keeps Battery). Kept as data so the group
 * header can recompute visibility without reading computed styles.
 *
 * @type {ReadonlyArray<{maxWidth: number, columns: ReadonlyArray<string>}>}
 */
export const NODES_TABLE_HIDE_TIERS = Object.freeze([
  Object.freeze({
    maxWidth: 1679,
    columns: Object.freeze([
      'nodes-col--node-id',
      'nodes-col--frequency',
      'nodes-col--modem-preset',
    ]),
  }),
  Object.freeze({
    maxWidth: 1559,
    columns: Object.freeze([
      'nodes-col--temperature',
      'nodes-col--humidity',
      'nodes-col--pressure',
    ]),
  }),
  Object.freeze({
    maxWidth: 1319,
    columns: Object.freeze([
      'nodes-col--latitude',
      'nodes-col--longitude',
      'nodes-col--last-position',
    ]),
  }),
  Object.freeze({
    maxWidth: 1109,
    columns: Object.freeze([
      'nodes-col--voltage',
      'nodes-col--air-util-tx',
      'nodes-col--altitude',
    ]),
  }),
  Object.freeze({
    maxWidth: 899,
    columns: Object.freeze(['nodes-col--uptime']),
  }),
  Object.freeze({
    maxWidth: 659,
    columns: Object.freeze([
      'nodes-col--role',
      'nodes-col--channel-util',
      'nodes-col--hw-model',
    ]),
  }),
]);

/** Column classes whose cells are numeric measurements (right-aligned mono). */
export const NUMERIC_COLUMN_CLASSES = Object.freeze([
  'nodes-col--frequency',
  'nodes-col--battery',
  'nodes-col--voltage',
  'nodes-col--uptime',
  'nodes-col--channel-util',
  'nodes-col--air-util-tx',
  'nodes-col--temperature',
  'nodes-col--humidity',
  'nodes-col--pressure',
  'nodes-col--latitude',
  'nodes-col--longitude',
  'nodes-col--altitude',
]);

/**
 * Compute the set of column classes hidden at a viewport width.
 *
 * @param {number} width Viewport width in CSS pixels.
 * @returns {Set<string>} Hidden column classes.
 */
export function hiddenColumnsForWidth(width) {
  const hidden = new Set();
  for (const tier of NODES_TABLE_HIDE_TIERS) {
    if (width <= tier.maxWidth) {
      for (const column of tier.columns) hidden.add(column);
    }
  }
  return hidden;
}

/**
 * Compute the visible group headers with their colspans.
 *
 * Groups whose columns are all hidden are omitted entirely.
 *
 * @param {ReadonlyArray<{label: string, columns: ReadonlyArray<string>}>} groups
 *   Ordered column groups.
 * @param {function(string): boolean} isColumnVisible Predicate for one column
 *   class.
 * @returns {Array<{label: string, colspan: number}>} Visible group spans.
 */
export function computeGroupColspans(groups, isColumnVisible) {
  const spans = [];
  for (const group of groups) {
    const colspan = group.columns.filter(column => isColumnVisible(column)).length;
    if (colspan > 0) spans.push({ label: group.label, colspan });
  }
  return spans;
}

/**
 * Apply computed group colspans to the grouped header row (write-on-change).
 *
 * The row's `<th>` order matches {@link NODES_TABLE_COLUMN_GROUPS}; a group
 * with zero visible columns hides its header cell.
 *
 * @param {?Element} groupRow The `tr.nodes-group-header` element.
 * @param {ReadonlyArray<{label: string, columns: ReadonlyArray<string>}>} groups
 *   Ordered column groups.
 * @param {function(string): boolean} isColumnVisible Predicate for one column
 *   class.
 * @returns {void}
 */
export function syncGroupHeaderColspans(groupRow, groups, isColumnVisible) {
  if (!groupRow || typeof groupRow.querySelectorAll !== 'function') return;
  const cells = Array.from(groupRow.querySelectorAll('th[data-group]'));
  for (const cell of cells) {
    const group = groups.find(candidate => candidate.label === cell.getAttribute('data-group'));
    if (!group) continue;
    const colspan = group.columns.filter(column => isColumnVisible(column)).length;
    if (colspan === 0) {
      if (!cell.hidden) cell.hidden = true;
      continue;
    }
    if (cell.hidden) cell.hidden = false;
    if (String(cell.getAttribute('colspan')) !== String(colspan)) {
      cell.setAttribute('colspan', String(colspan));
    }
  }
}

/**
 * Total column count of the rendered nodes table: the 21 data columns plus
 * the disclosure (`+`) column.
 */
export const NODES_TABLE_TOTAL_COLUMNS = 22;

/**
 * Build the class and cell markup of the hidden-fields disclosure row.
 *
 * Split from {@link buildNodeExtraRowHtml} so render paths that create the
 * `<tr>` element themselves (setting `hidden` as a property) can reuse the
 * identical inner markup.
 *
 * @param {Array<{label: string, valueHtml: string}>} entries Hidden fields as
 *   pre-formatted label/value pairs (values already escaped by the caller's
 *   formatters).
 * @param {number} columnCount Total column count for the `colspan`.
 * @returns {{className: string, innerHtml: string}} Row parts.
 */
export function nodeExtraRowParts(entries, columnCount) {
  const items = entries
    .map(entry => `<dt>${entry.label}</dt><dd>${entry.valueHtml}</dd>`)
    .join('');
  return {
    className: 'node-extra',
    innerHtml:
      `<td colspan="${columnCount}">` +
      `<dl class="node-extra__list">${items}</dl></td>`,
  };
}

/**
 * Build the hidden-fields disclosure row for one node (mobile `+` cell).
 *
 * @param {Array<{label: string, valueHtml: string}>} entries Hidden fields as
 *   pre-formatted label/value pairs (values already escaped by the caller's
 *   formatters).
 * @param {number} columnCount Total column count for the `colspan`.
 * @returns {string} `<tr class="node-extra">` HTML.
 */
export function buildNodeExtraRowHtml(entries, columnCount) {
  const parts = nodeExtraRowParts(entries, columnCount);
  return `<tr class="${parts.className}" hidden>${parts.innerHtml}</tr>`;
}

/**
 * Resolve the navigation target of a whole-row activation.
 *
 * Clicks on interactive elements (links, buttons, form controls, badge
 * popovers) keep their own behaviour; anywhere else the row follows its
 * long-name link.
 *
 * @param {?Element} row The activated `<tr>`.
 * @param {?Element} target The event target inside the row.
 * @returns {?string} The href to follow, or `null` to leave the click alone.
 */
export function rowActivationHref(row, target) {
  if (!row || typeof row.querySelector !== 'function') return null;
  if (
    target &&
    typeof target.closest === 'function' &&
    target.closest('a, button, select, input, label, [data-node-info]')
  ) {
    return null;
  }
  const link = row.querySelector('.nodes-col--long-name a');
  if (!link || typeof link.getAttribute !== 'function') return null;
  return link.getAttribute('href') || null;
}
