/*
 * Copyright (C) 2025 l5yth
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

import { fetchTelemetryForNode, fetchPositionsForNode } from './node-view-data.js';
import { renderTelemetryPlot } from './node-view-telemetry.js';
import { initializeNodeMap } from './node-view-map.js';
import { readAppConfig } from './config.js';
import { mergeConfig } from './settings.js';

let telemetryFetcher = fetchTelemetryForNode;
let positionsFetcher = fetchPositionsForNode;
let mapInitializer = initializeNodeMap;

/**
 * Escape HTML entities in a string to prevent accidental injection.
 *
 * @param {string} value Raw string value.
 * @returns {string} Escaped representation safe for ``innerHTML`` usage.
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render a textual fallback message inside an element.
 *
 * @param {Element} container Target element to populate.
 * @param {string} message Message contents shown to the visitor.
 * @returns {void}
 */
function renderMessage(container, message) {
  if (!container || typeof container !== 'object') return;
  container.innerHTML = `<p class="node-view__plot-empty">${escapeHtml(message)}</p>`;
}

/**
 * Determine the current theme applied to the document.
 *
 * @param {Document} doc DOM document instance.
 * @returns {string} ``'dark'`` or ``'light'``.
 */
function resolveTheme(doc = document) {
  if (!doc) return 'light';
  const bodyTheme = doc.body?.dataset?.theme;
  if (bodyTheme === 'dark') return 'dark';
  const htmlTheme = doc.documentElement?.dataset?.theme;
  if (htmlTheme === 'dark') return 'dark';
  if (doc.body?.classList?.contains('dark')) return 'dark';
  return 'light';
}

/**
 * Bootstraps the node detail experience once the DOM is ready.
 *
 * @returns {void}
 */
function bootstrapNodeView() {
  const root = document.querySelector('.node-view');
  if (!root) return;
  const nodeId = root.getAttribute('data-node-id');
  if (!nodeId) {
    console.warn('Node view initialisation skipped: missing node id.');
    return;
  }

  const telemetryContainer = document.getElementById('nodeTelemetry');
  const mapContainer = document.getElementById('nodeMap');
  const theme = resolveTheme(document);

  // Load configuration to ensure settings such as map filters are hydrated.
  mergeConfig(readAppConfig());

  telemetryFetcher({ nodeId })
    .then(data => {
      if (!telemetryContainer) return;
      renderTelemetryPlot(telemetryContainer, data, { theme });
    })
    .catch(error => {
      console.error('Failed to render telemetry data', error);
      renderMessage(telemetryContainer, 'Telemetry data is temporarily unavailable.');
    });

  positionsFetcher({ nodeId })
    .then(data => {
      if (!mapContainer) return;
      if (!data.length) {
        renderMessage(mapContainer, 'No positions recorded in the last 7 days.');
        return;
      }
      mapInitializer({ container: mapContainer, positions: data, theme });
    })
    .catch(error => {
      console.error('Failed to render position data', error);
      renderMessage(mapContainer, 'Position data is temporarily unavailable.');
    });
}

if (typeof document !== 'undefined' && document?.addEventListener) {
  document.addEventListener('DOMContentLoaded', bootstrapNodeView);
}

/**
 * Allow tests to override asynchronous dependencies used by the view layer.
 *
 * @param {Object} overrides Replacement function map.
 * @param {Function} [overrides.fetchTelemetry] Replacement telemetry loader.
 * @param {Function} [overrides.fetchPositions] Replacement positions loader.
 * @param {Function} [overrides.initializeMap] Replacement map initialiser.
 * @returns {void}
 */
function setNodeViewDependencies({ fetchTelemetry, fetchPositions, initializeMap } = {}) {
  if (typeof fetchTelemetry === 'function') {
    telemetryFetcher = fetchTelemetry;
  }
  if (typeof fetchPositions === 'function') {
    positionsFetcher = fetchPositions;
  }
  if (typeof initializeMap === 'function') {
    mapInitializer = initializeMap;
  }
}

export { bootstrapNodeView, escapeHtml, renderMessage, resolveTheme, setNodeViewDependencies };
