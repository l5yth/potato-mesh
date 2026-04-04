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

/** Relative URL of the Meshtastic protocol icon asset. */
export const MESHTASTIC_ICON_SRC = '/assets/img/meshtastic.svg';

/** Relative URL of the MeshCore protocol icon asset. */
export const MESHCORE_ICON_SRC = '/assets/img/meshcore.svg';

/**
 * Return true when the protocol value is explicitly ``"meshtastic"``.
 *
 * Absent, null, or empty values return ``false`` — no default is applied.
 * An icon is only shown when the protocol is positively known.
 *
 * Comparison is case-sensitive: only the lowercase value ``"meshtastic"``
 * matches — mixed-case strings such as ``"Meshtastic"`` return ``false``.
 * The backend always stores protocol values in lowercase, so this is
 * intentional.
 *
 * @param {string|null|undefined} protocol Protocol string from the API.
 * @returns {boolean} Whether the protocol is explicitly Meshtastic.
 */
export function isMeshtasticProtocol(protocol) {
  if (protocol == null) return false;
  return String(protocol).trim() === 'meshtastic';
}

/**
 * Build an HTML snippet that renders the Meshtastic logo as an inline icon.
 *
 * The image is intentionally small (12 × 12 px) so it fits comfortably inline
 * with text in chat entries, table cells, and legend buttons.
 *
 * @returns {string} HTML string containing an {@code <img>} element.
 */
export function meshtasticIconHtml() {
  return `<img src="${MESHTASTIC_ICON_SRC}" alt="" width="12" height="12"` +
    ' class="protocol-icon protocol-icon--meshtastic" loading="lazy" decoding="async"' +
    ' aria-hidden="true">';
}

/**
 * Return true when the protocol value represents MeshCore.
 *
 * @param {string|null|undefined} protocol Protocol string from the API.
 * @returns {boolean} Whether the protocol is MeshCore.
 */
export function isMeshcoreProtocol(protocol) {
  if (protocol == null) return false;
  return String(protocol).trim() === 'meshcore';
}

/**
 * Build an HTML snippet that renders the MeshCore logo as an inline icon.
 *
 * Follows the same sizing and attribute conventions as {@link meshtasticIconHtml}
 * so both icons are visually consistent when placed side-by-side in the UI.
 *
 * @returns {string} HTML string containing an {@code <img>} element.
 */
export function meshcoreIconHtml() {
  return `<img src="${MESHCORE_ICON_SRC}" alt="" width="12" height="12"` +
    ' class="protocol-icon protocol-icon--meshcore" loading="lazy" decoding="async"' +
    ' aria-hidden="true">';
}

/**
 * Build an HTML prefix (protocol icon plus a trailing space) for inline UI.
 *
 * Returns the matching icon only when the protocol is positively known:
 * ``"meshtastic"`` → Meshtastic icon, ``"meshcore"`` → MeshCore icon.
 * Absent, null, or unrecognised protocol strings yield an empty string —
 * no default icon is assumed.
 *
 * @param {string|null|undefined} protocol Protocol string from the API.
 * @returns {string} HTML fragment safe to concatenate before visible text.
 */
export function protocolIconPrefixHtml(protocol) {
  if (isMeshcoreProtocol(protocol)) {
    return `${meshcoreIconHtml()} `;
  }
  if (isMeshtasticProtocol(protocol)) {
    return `${meshtasticIconHtml()} `;
  }
  return '';
}

