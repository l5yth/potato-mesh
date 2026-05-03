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
 * Helpers used by the long-name link click router and overlay name fallback.
 *
 * @module main/long-link-router
 */

import { canonicalNodeIdentifier, normalizeNodeNameValue } from '../node-rendering.js';

/**
 * Determine whether a long name link should trigger the overlay behaviour.
 *
 * @param {?Element} link Anchor element.
 * @returns {boolean} ``true`` when the link participates in overlays.
 */
export function shouldHandleNodeLongLink(link) {
  if (!link || !link.dataset) return false;
  if ('nodeDetailLink' in link.dataset && link.dataset.nodeDetailLink === 'false') {
    return false;
  }
  return true;
}

/**
 * Extract the canonical identifier from a node detail hyperlink.
 *
 * @param {string} href Link href attribute.
 * @returns {string} Canonical identifier or ``''``.
 */
export function extractIdentifierFromHref(href) {
  if (typeof href !== 'string' || href.length === 0) {
    return '';
  }
  const match = href.match(/\/nodes\/(![^/?#]+)/i);
  if (!match || !match[1]) {
    return '';
  }
  try {
    const decoded = decodeURIComponent(match[1]);
    return canonicalNodeIdentifier(decoded) ?? '';
  } catch {
    return canonicalNodeIdentifier(match[1]) ?? '';
  }
}

/**
 * Extract the canonical node identifier from the provided link element.
 *
 * @param {?Element} link Anchor element.
 * @returns {string} Canonical node identifier or ``''`` when unavailable.
 */
export function getNodeIdentifierFromLink(link) {
  if (!link) return '';
  const datasetIdentifier = link.dataset && typeof link.dataset.nodeId === 'string'
    ? canonicalNodeIdentifier(link.dataset.nodeId)
    : null;
  if (datasetIdentifier) {
    return datasetIdentifier;
  }
  if (typeof link.getAttribute === 'function') {
    const attrHref = link.getAttribute('href');
    const canonicalFromAttr = extractIdentifierFromHref(attrHref);
    if (canonicalFromAttr) {
      return canonicalFromAttr;
    }
  }
  if (typeof link.href === 'string') {
    const canonicalFromProperty = extractIdentifierFromHref(link.href);
    if (canonicalFromProperty) {
      return canonicalFromProperty;
    }
  }
  return '';
}

/**
 * Determine the preferred display name for overlay content.
 *
 * @param {Object} node Node payload.
 * @returns {string} Friendly display name.
 */
export function getNodeDisplayNameForOverlay(node) {
  if (!node || typeof node !== 'object') return '';
  return (
    normalizeNodeNameValue(node.long_name ?? node.longName) ||
    normalizeNodeNameValue(node.short_name ?? node.shortName) ||
    (typeof node.node_id === 'string' ? node.node_id : '')
  );
}

/**
 * Populate missing node name fields with sensible defaults.
 *
 * @param {Object} node Node payload.
 * @returns {void}
 */
export function applyNodeNameFallback(node) {
  if (!node || typeof node !== 'object') return;
  const short = normalizeNodeNameValue(node.short_name ?? node.shortName);
  const long = normalizeNodeNameValue(node.long_name ?? node.longName);
  if (short || long) return;
  const nodeId = normalizeNodeNameValue(node.node_id ?? node.nodeId);
  if (!nodeId) return;
  const fallbackShort = nodeId.slice(-4);
  const fallbackLong = `Meshtastic ${nodeId}`;
  node.short_name = fallbackShort;
  node.long_name = fallbackLong;
  if ('shortName' in node) node.shortName = fallbackShort;
  if ('longName' in node) node.longName = fallbackLong;
}
