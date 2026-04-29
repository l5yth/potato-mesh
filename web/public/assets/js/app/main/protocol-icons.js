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
 * Protocol-icon ``<img>`` builders shared between the legend and meta-row
 * controls.
 *
 * @module main/protocol-icons
 */

import { MESHTASTIC_ICON_SRC, MESHCORE_ICON_SRC } from '../protocol-helpers.js';

/**
 * Build a protocol icon image element with consistent attributes.
 *
 * Both the legend and the meta-row protocol toggle use this helper so the
 * output is identical regardless of insertion method.
 *
 * @param {string} src Absolute path to the SVG asset.
 * @param {string} variantClass BEM modifier class, e.g. ``protocol-icon--meshtastic``.
 * @returns {HTMLImageElement} Icon element ready to append.
 */
export function buildProtocolIconImg(src, variantClass) {
  const img = document.createElement('img');
  img.setAttribute('src', src);
  img.setAttribute('alt', '');
  img.setAttribute('width', '12');
  img.setAttribute('height', '12');
  img.setAttribute('aria-hidden', 'true');
  img.setAttribute('loading', 'lazy');
  img.setAttribute('decoding', 'async');
  img.className = `protocol-icon ${variantClass}`;
  return img;
}

/** @returns {HTMLImageElement} Meshtastic protocol icon element. */
export function buildMeshtasticIconImg() {
  return buildProtocolIconImg(MESHTASTIC_ICON_SRC, 'protocol-icon--meshtastic');
}

/** @returns {HTMLImageElement} MeshCore protocol icon element. */
export function buildMeshcoreIconImg() {
  return buildProtocolIconImg(MESHCORE_ICON_SRC, 'protocol-icon--meshcore');
}
