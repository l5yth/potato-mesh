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

/**
 * Determine whether the current browser safely supports CSS filter effects on
 * Leaflet tile container elements.
 *
 * Safari on iOS and iPadOS mis-renders filtered containers by painting them
 * black. When this function returns {@code false} the application should avoid
 * applying filters beyond individual tile elements.
 *
 * @param {Pick<Window, 'navigator'>|undefined} environment Host environment or
 *        a lightweight shim containing a {@link Navigator} reference. Defaults
 *        to {@link globalThis} when omitted.
 * @returns {boolean} {@code true} when it is safe to filter container
 *          elements; {@code false} when filters should be limited to individual
 *          tiles.
 */
export function supportsLeafletTileContainerFilters(environment = globalThis) {
  const navigatorRef = environment?.navigator;
  if (!navigatorRef) {
    return true;
  }

  const userAgent = typeof navigatorRef.userAgent === 'string' ? navigatorRef.userAgent : '';
  const platform = typeof navigatorRef.platform === 'string' ? navigatorRef.platform : '';
  const touchPoints = typeof navigatorRef.maxTouchPoints === 'number' ? navigatorRef.maxTouchPoints : 0;

  const isIosDevice = /\b(iPad|iPhone|iPod)\b/i.test(userAgent);
  const isIpadOsDevice = platform === 'MacIntel' && touchPoints > 1 && /\bAppleWebKit\b/i.test(userAgent);

  return !(isIosDevice || isIpadOsDevice);
}

export const __testHooks = Object.freeze({ supportsLeafletTileContainerFilters });
