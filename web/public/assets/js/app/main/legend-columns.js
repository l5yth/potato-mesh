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
 * Map legend column skeleton (SPEC LS1/LS2).
 *
 * The legend lays its protocols out in two columns. The first, the stack,
 * holds the MeshCore group with the Reticulum group below it; the second is
 * the Meshtastic column. Each group, and the Meshtastic column, opens with a
 * protocol header: the tile, the label and a count span.
 *
 * This module builds those containers and headers only. `main.js` appends the
 * role filters and the Meshtastic toggles, fills the counts, and decides what
 * is in view (SPEC LP1); {@link legendStackInView} then says whether the
 * stack stays in the row.
 *
 * @module main/legend-columns
 */

import { buildMeshcoreIconImg, buildMeshtasticIconImg, buildReticulumIconImg } from './protocol-icons.js';

/**
 * Protocols grouped in the stack column, top to bottom (SPEC LS1).
 *
 * @type {ReadonlyArray<string>}
 */
export const LEGEND_STACK_PROTOCOLS = Object.freeze(['meshcore', 'reticulum']);

/**
 * Create an element with a class and append it to a parent.
 *
 * @param {HTMLElement} parent Element to append to.
 * @param {string} tagName Tag of the new element.
 * @param {string} className Its class attribute.
 * @returns {HTMLElement} The appended element.
 */
function appendElement(parent, tagName, className) {
  const element = document.createElement(tagName);
  element.className = className;
  parent.appendChild(element);
  return element;
}

/**
 * Append a protocol header: tile, label and an empty count span, which the
 * legend count updater fills with the 7-day figure.
 *
 * @param {HTMLElement} parent Group or column the header opens.
 * @param {function(): HTMLImageElement} buildIcon Protocol tile builder.
 * @param {string} label Protocol label.
 * @returns {HTMLElement} The header's count span.
 */
function appendProtocolHeader(parent, buildIcon, label) {
  const header = appendElement(parent, 'div', 'legend-column-header');
  header.appendChild(buildIcon());
  const title = document.createElement('span');
  title.textContent = label;
  header.appendChild(title);
  return appendElement(header, 'span', 'legend-protocol-count');
}

/**
 * The legend's columns, groups and header count spans.
 *
 * @typedef {Object} LegendColumns
 * @property {HTMLElement} stack First column: the MeshCore group above the
 *   Reticulum group.
 * @property {HTMLElement} meshtasticColumn Second column: the Meshtastic
 *   header, then its role filters and toggles.
 * @property {HTMLElement} meshcoreGroup MeshCore header and role filters.
 * @property {HTMLElement} reticulumGroup Reticulum header and role filters.
 * @property {{meshcore: HTMLElement, meshtastic: HTMLElement, reticulum: HTMLElement}} counts
 *   Each protocol header's count span.
 */

/**
 * Build the legend's two columns into the legend row (SPEC LS1): the stack,
 * holding the MeshCore group then the Reticulum group, and the Meshtastic
 * column. Each group and the Meshtastic column holds only its header; the
 * caller appends the role filters and toggles below it.
 *
 * @param {HTMLElement} container The legend row (`.legend-items--columns`).
 * @returns {LegendColumns} The columns, groups and count spans.
 */
export function buildLegendColumns(container) {
  const stack = appendElement(container, 'div', 'legend-column legend-column--stack');
  const meshcoreGroup = appendElement(stack, 'div', 'legend-group');
  const meshcoreCount = appendProtocolHeader(meshcoreGroup, buildMeshcoreIconImg, 'Meshcore');
  const reticulumGroup = appendElement(stack, 'div', 'legend-group');
  const reticulumCount = appendProtocolHeader(reticulumGroup, buildReticulumIconImg, 'Reticulum');
  const meshtasticColumn = appendElement(container, 'div', 'legend-column');
  const meshtasticCount = appendProtocolHeader(meshtasticColumn, buildMeshtasticIconImg, 'Meshtastic');
  return {
    stack,
    meshtasticColumn,
    meshcoreGroup,
    reticulumGroup,
    counts: { meshcore: meshcoreCount, meshtastic: meshtasticCount, reticulum: reticulumCount },
  };
}

/**
 * Whether the stack column stays in the legend row (SPEC LS1): while at
 * least one of its groups' protocols is in view. With both out of view the
 * column leaves the row, so no empty column keeps the gap beside it.
 *
 * @param {Set<string>} protocolsInView Protocols the legend lists, from
 *   `legendProtocolsInView` (SPEC LP1).
 * @returns {boolean} `true` while the MeshCore or the Reticulum group shows.
 */
export function legendStackInView(protocolsInView) {
  return LEGEND_STACK_PROTOCOLS.some(protocol => protocolsInView.has(protocol));
}
