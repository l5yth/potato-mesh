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
 * Colocated-node hub icon geometry (SPEC UX11, audit D-031).
 *
 * The hub that expands stacked same-position nodes keeps its 16 px visual
 * glyph but claims a 32 px hit area so it is tappable on dense rooftop sites.
 * Pure definition builder — the app wraps it in `L.divIcon`.
 *
 * @module main/colocated-hub-icon
 */

/** Side length of the hub's tap/click hit area, in pixels. */
export const COLOCATED_HUB_HIT_SIZE = 32;

/**
 * Build the divIcon definition for a hub of the given group size.
 *
 * @param {number} groupSize Number of visible nodes stacked at the position.
 * @returns {{html: string, className: string, iconSize: number[], iconAnchor: number[]}}
 *   Options for `L.divIcon` — a 32 px box centring the 16 px glyph.
 */
export function colocatedHubIconDefinition(groupSize) {
  return {
    html: `<span class="colocated-spider-hub__glyph">*${groupSize}</span>`,
    className: 'colocated-spider-hub',
    iconSize: [COLOCATED_HUB_HIT_SIZE, COLOCATED_HUB_HIT_SIZE],
    iconAnchor: [COLOCATED_HUB_HIT_SIZE / 2, COLOCATED_HUB_HIT_SIZE / 2],
  };
}
