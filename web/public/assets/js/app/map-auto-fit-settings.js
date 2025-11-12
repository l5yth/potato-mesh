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

const MINIMUM_AUTO_FIT_RANGE_KM = 0.25;
const AUTO_FIT_PADDING_FRACTION = 0.02;

/**
 * Resolve auto-fit bounds configuration for the active map constraints.
 *
 * @param {{ hasDistanceLimit: boolean, maxDistanceKm: number | null }} options
 *   - ``hasDistanceLimit`` indicates whether a maximum display radius is enforced.
 *   - ``maxDistanceKm`` provides the configured maximum distance in kilometres.
 * @returns {{ paddingFraction: number, minimumRangeKm: number }}
 *   Bounds options suitable for ``computeBoundsForPoints``.
 */
export function resolveAutoFitBoundsConfig({ hasDistanceLimit, maxDistanceKm } = {}) {
  const effectiveMaxDistance = Number.isFinite(maxDistanceKm) && maxDistanceKm > 0
    ? maxDistanceKm
    : null;

  if (!hasDistanceLimit || !effectiveMaxDistance) {
    return {
      paddingFraction: AUTO_FIT_PADDING_FRACTION,
      minimumRangeKm: MINIMUM_AUTO_FIT_RANGE_KM
    };
  }

  const minimumRange = Math.min(MINIMUM_AUTO_FIT_RANGE_KM, effectiveMaxDistance);
  const resolvedMinimumRange = Number.isFinite(minimumRange) && minimumRange > 0
    ? minimumRange
    : MINIMUM_AUTO_FIT_RANGE_KM;
  return {
    paddingFraction: AUTO_FIT_PADDING_FRACTION,
    minimumRangeKm: resolvedMinimumRange
  };
}

export const __testUtils = {
  MINIMUM_AUTO_FIT_RANGE_KM,
  AUTO_FIT_PADDING_FRACTION
};
