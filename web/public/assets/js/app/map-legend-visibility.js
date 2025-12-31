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
 * @param {{ defaultCollapsed: boolean, mediaQueryMatches: boolean, viewMode?: string }} options
 * @returns {boolean} True when the legend should be visible.
 */
export function resolveLegendVisibility({ defaultCollapsed, mediaQueryMatches, viewMode }) {
  if (defaultCollapsed || viewMode === 'dashboard' || viewMode === 'map') return false;
  return !mediaQueryMatches;
}
