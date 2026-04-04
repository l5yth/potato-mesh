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
 * Node name and link rendering helpers shared across the dashboard and node
 * detail pages.
 *
 * These helpers produce HTML snippets referencing the canonical node detail
 * path (``/nodes/!<id>``).  They depend on {@link module:utils} for HTML
 * escaping and on {@link module:protocol-helpers} for protocol-specific icon
 * prefixes.
 *
 * @module node-rendering
 */

import { escapeHtml } from './utils.js';
import { protocolIconPrefixHtml } from './protocol-helpers.js';

/**
 * Normalise node name fields by trimming whitespace.
 *
 * Unlike ``stringOrNull`` (which returns ``null`` for blank values), this
 * function returns an empty string when the value is absent — the expected
 * shape for display-only name fields where a falsy string is preferable to
 * ``null``.
 *
 * @param {*} value Raw name value.
 * @returns {string} Sanitised name string, or empty string when blank/absent.
 */
export function normalizeNodeNameValue(value) {
  if (value == null) return '';
  const str = String(value).trim();
  return str.length ? str : '';
}

/**
 * Compute the node detail path for a given identifier.
 *
 * @param {string|null} identifier Node identifier (with or without ``!`` prefix).
 * @returns {string|null} Absolute-path string like ``/nodes/!aabbccdd``, or
 *   ``null`` when the identifier is absent or blank.
 */
export function buildNodeDetailHref(identifier) {
  if (identifier == null) return null;
  const trimmed = String(identifier).trim();
  if (!trimmed) return null;
  const body = trimmed.startsWith('!') ? trimmed.slice(1) : trimmed;
  if (!body) return null;
  const encoded = encodeURIComponent(body);
  return `/nodes/!${encoded}`;
}

/**
 * Ensure ``identifier`` includes the canonical ``!`` prefix.
 *
 * @param {*} identifier Candidate identifier.
 * @returns {string|null} Canonical ``!xxxxxxxx`` identifier or ``null``.
 */
export function canonicalNodeIdentifier(identifier) {
  if (identifier == null) return null;
  const trimmed = String(identifier).trim();
  if (!trimmed) return null;
  return trimmed.startsWith('!') ? trimmed : `!${trimmed}`;
}

/**
 * Render a linked long name pointing to the node detail view.
 *
 * When ``protocol`` is a known value (``"meshtastic"`` or ``"meshcore"``),
 * the matching protocol icon is prepended.  Absent or unknown protocol strings
 * produce no icon prefix.  An anchor element is only emitted when
 * ``identifier`` resolves to a non-null detail path.
 *
 * @param {string|null} longName Display name.
 * @param {string|null} identifier Node identifier.
 * @param {{ className?: string, protocol?: string|null }} [options] Rendering options.
 * @returns {string} Escaped HTML snippet.
 */
export function renderNodeLongNameLink(longName, identifier, { className = 'node-long-link', protocol = null } = {}) {
  const text = normalizeNodeNameValue(longName);
  if (!text) return '';
  const iconPrefix = protocolIconPrefixHtml(protocol);
  const href = buildNodeDetailHref(identifier);
  if (!href) {
    return `${iconPrefix}${escapeHtml(text)}`;
  }
  const classAttr = className ? ` class="${escapeHtml(className)}"` : '';
  const canonicalId = canonicalNodeIdentifier(identifier);
  const dataAttrs = canonicalId
    ? ` data-node-detail-link="true" data-node-id="${escapeHtml(canonicalId)}"`
    : ' data-node-detail-link="true"';
  return `<a${classAttr} href="${href}"${dataAttrs}>${iconPrefix}${escapeHtml(text)}</a>`;
}
