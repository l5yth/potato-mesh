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
 * Table null-cell voice (SPEC UX4, audit D-020).
 *
 * The node table adopts the overlay's convention: a value that is absent
 * renders as a muted em-dash instead of an indistinguishable blank, so
 * "sensor absent / not reported" can be told apart from "still loading".
 *
 * @module main/table-cell-format
 */

/** Markup rendered for an absent value (styled muted via `.cell-empty`). */
export const EMPTY_CELL_HTML = '<span class="cell-empty">—</span>';

/**
 * Format one table cell value, substituting the muted dash for blanks.
 *
 * The input is the already-formatted (and where needed already-escaped)
 * display string produced by the existing formatters; only emptiness is
 * decided here.
 *
 * @param {*} value Formatted display value.
 * @returns {string} Cell HTML — the value verbatim, or the muted dash.
 */
export function formatTableCell(value) {
  if (value === null || value === undefined || value === '') return EMPTY_CELL_HTML;
  return String(value);
}
