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

/**
 * Height the legend keeps clear of its own edges, in px (SPEC ML3): the 10 px
 * Leaflet corner margin under the panel, a 10 px gap under the map toolbar,
 * and the panel's 20 px of padding and border, which its `max-height` does not
 * count.
 */
export const LEGEND_EDGE_PX = 40;

/**
 * Margins of a control stacked over the legend in its corner, in px: the
 * Federation legend toggle's 8 px top margin (`.legend-toggle`) and its 10 px
 * Leaflet corner margin. The toggle's own height is read live.
 */
export const LEGEND_STACK_MARGIN_PX = 18;

/** Lowest height cap, in px: on a short map the legend still shows a few rows and scrolls. */
export const LEGEND_MIN_MAX_HEIGHT_PX = 120;

/**
 * An element's border box, or null when it has none laid out (absent, or
 * `display: none`).
 *
 * @param {?{getBoundingClientRect: Function}} element Element to measure.
 * @returns {?{bottom: number, height: number}} Its viewport box, in px.
 */
function laidOutBox(element) {
  const box = element ? element.getBoundingClientRect() : null;
  return box && box.height > 0 ? box : null;
}

/**
 * Cap the legend panel to the room its map leaves under the toolbar, now and
 * whenever that room changes.
 *
 * The legend sits in the map's bottom-right corner; taller than the map, it
 * ran past the map's top edge, where the map clips it (SPEC ML3). Capped, it
 * scrolls (`.legend { overflow-y: auto }`). The cap is read from the live
 * layout: the bottom of the map's padding box (the corner's anchor), the
 * toolbar's bottom edge and the height of a control stacked above the panel,
 * so a taller toolbar or toggle (44 px on a coarse pointer, SPEC CT1) lowers
 * it with them. Without a laid-out toolbar the map's top edge is the ceiling.
 *
 * @param {?{getContainer?: Function, on: Function}} map Leaflet map holding the legend.
 * @param {?{style: Object}} legend Legend panel element.
 * @param {{toolbar?: ?Object, stacked?: ?Object}} [options] `toolbar` is the
 *   map's `.map-toolbar`; `stacked` is a control stacked over the panel in its
 *   corner, as the Federation legend toggle is.
 * @returns {?Function} The refit callback, or null when there is no legend or
 *   no map container.
 */
export function fitLegendToMap(map, legend, { toolbar = null, stacked = null } = {}) {
  const container = typeof map?.getContainer === 'function' ? map.getContainer() : null;
  if (!legend || !container) return null;
  const fit = () => {
    // The map's padding box: the corner holding the legend sits inside it.
    const top = container.getBoundingClientRect().top + container.clientTop;
    const toolbarBox = laidOutBox(toolbar);
    const stackedBox = laidOutBox(stacked);
    const ceiling = toolbarBox ? Math.max(top, toolbarBox.bottom) : top;
    const row = stackedBox ? stackedBox.height + LEGEND_STACK_MARGIN_PX : 0;
    const room = Math.floor(top + container.clientHeight - ceiling - LEGEND_EDGE_PX - row);
    legend.style.maxHeight = `${Math.max(LEGEND_MIN_MAX_HEIGHT_PX, room)}px`;
  };
  if (typeof globalThis.ResizeObserver === 'function') {
    // Never disconnected: the observer lives as long as the map. It also sees
    // the map shrink when the page above it reflows after load, which
    // Leaflet's `resize` (window resize, fullscreen) never reports, and a
    // toolbar or toggle that grows.
    const observer = new globalThis.ResizeObserver(fit);
    [container, toolbar, stacked].filter(Boolean).forEach(element => observer.observe(element));
  } else {
    map.on('resize', fit);
  }
  fit();
  return fit;
}
