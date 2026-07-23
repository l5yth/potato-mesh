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
 * Resolve the initial visibility of the map legend.
 *
 * The dashboard composite is too cramped for an open legend, so it always
 * starts collapsed there. Every other view — notably the dedicated map view,
 * whose colour encodings the legend keys (SPEC UX8, audit D-011) — honours
 * the template's `data-legend-collapsed` default, collapsing on small
 * viewports where the map area is scarce.
 *
 * @param {{ defaultCollapsed: boolean, mediaQueryMatches: boolean, viewMode?: string }} options
 *   `defaultCollapsed` mirrors the template flag; `mediaQueryMatches` is true
 *   on small viewports; `viewMode` names the rendering view.
 * @returns {boolean} True when the legend should be visible.
 */
export function resolveLegendVisibility({ defaultCollapsed, mediaQueryMatches, viewMode }) {
  if (viewMode === 'dashboard') return false;
  if (defaultCollapsed) return false;
  return !mediaQueryMatches;
}

/**
 * Compute the legend toggle's visible text and aria-label.
 *
 * Both layers gate their filter suffix on *active* filters (SPEC UX8, audit
 * D-012): a permanently appended "(filters)" mislabels the colour key as a
 * filter drawer.
 *
 * @param {boolean} visible Whether the legend is currently shown.
 * @param {boolean} hasFilters Whether any role filter is active.
 * @returns {{text: string, ariaLabel: string}} Label pair for the toggle.
 */
export function legendToggleLabel(visible, hasFilters) {
  const text = `${visible ? 'Hide' : 'Show'} legend${hasFilters ? ' (filters active)' : ''}`;
  const ariaLabel = `${visible ? 'Hide' : 'Show'} map legend${hasFilters ? ' (role filters active)' : ''}`;
  return { text, ariaLabel };
}
