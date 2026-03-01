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

const MAX_VISIBLE_SITE_NAME_LENGTH = 32;
const TRUNCATION_SUFFIX = '...';
const TRUNCATED_SITE_NAME_LENGTH = MAX_VISIBLE_SITE_NAME_LENGTH - TRUNCATION_SUFFIX.length;
const SUPPRESSED_SITE_NAME_PATTERN = /(?:^|[^a-z0-9])(?:https?:\/\/|www\.)\S+/i;

/**
 * Read a federated instance site name as a trimmed string.
 *
 * @param {{ name?: string } | null | undefined} entry Federation instance payload entry.
 * @returns {string} Trimmed site name or an empty string when absent.
 */
function readSiteName(entry) {
  if (!entry || typeof entry !== 'object') {
    return '';
  }

  return typeof entry.name === 'string' ? entry.name.trim() : '';
}

/**
 * Read a federated instance domain as a trimmed string.
 *
 * @param {{ domain?: string } | null | undefined} entry Federation instance payload entry.
 * @returns {string} Trimmed domain or an empty string when absent.
 */
function readDomain(entry) {
  if (!entry || typeof entry !== 'object') {
    return '';
  }

  return typeof entry.domain === 'string' ? entry.domain.trim() : '';
}

/**
 * Determine whether a remote site name should be suppressed from frontend displays.
 *
 * @param {string} name Remote site name.
 * @returns {boolean} true when the name contains a URL-like advertising token.
 */
export function isSuppressedFederationSiteName(name) {
  if (typeof name !== 'string') {
    return false;
  }

  const trimmed = name.trim();
  if (!trimmed) {
    return false;
  }

  return SUPPRESSED_SITE_NAME_PATTERN.test(trimmed);
}

/**
 * Truncate an instance site name for frontend display without mutating source data.
 *
 * Names longer than 32 characters are shortened to stay within that 32-character
 * budget including the trailing ellipsis.
 *
 * @param {string} name Remote site name.
 * @returns {string} Display-ready site name.
 */
export function truncateFederationSiteName(name) {
  if (typeof name !== 'string') {
    return '';
  }

  const trimmed = name.trim();
  if (trimmed.length <= MAX_VISIBLE_SITE_NAME_LENGTH) {
    return trimmed;
  }

  return `${trimmed.slice(0, TRUNCATED_SITE_NAME_LENGTH)}${TRUNCATION_SUFFIX}`;
}

/**
 * Determine whether an instance should remain visible in frontend federation views.
 *
 * @param {{ name?: string } | null | undefined} entry Federation instance payload entry.
 * @returns {boolean} true when the entry should be shown to users.
 */
export function shouldDisplayFederationInstance(entry) {
  return !isSuppressedFederationSiteName(readSiteName(entry));
}

/**
 * Resolve a frontend display name for a federation instance.
 *
 * @param {{ name?: string } | null | undefined} entry Federation instance payload entry.
 * @returns {string} Display-ready site name or an empty string when absent.
 */
export function resolveFederationSiteNameForDisplay(entry) {
  const siteName = readSiteName(entry);
  return siteName ? truncateFederationSiteName(siteName) : '';
}

/**
 * Resolve the original trimmed site name for a federation instance.
 *
 * @param {{ name?: string } | null | undefined} entry Federation instance payload entry.
 * @returns {string} Full trimmed site name or an empty string when absent.
 */
export function resolveFederationSiteName(entry) {
  return readSiteName(entry);
}

/**
 * Determine the full sort value for an instance selector entry.
 *
 * Sorting must use the original trimmed site name so truncation does not collapse
 * multiple entries into the same comparison key.
 *
 * @param {{ name?: string, domain?: string } | null | undefined} entry Federation instance payload entry.
 * @returns {string} Full trimmed site name falling back to the domain.
 */
export function resolveFederationInstanceSortValue(entry) {
  const siteName = resolveFederationSiteName(entry);
  return siteName || readDomain(entry);
}

/**
 * Determine the most suitable display label for an instance list entry.
 *
 * @param {{ name?: string, domain?: string } | null | undefined} entry Federation instance payload entry.
 * @returns {string} Display label falling back to the domain.
 */
export function resolveFederationInstanceLabel(entry) {
  const siteName = resolveFederationSiteNameForDisplay(entry);
  if (siteName) {
    return siteName;
  }

  return readDomain(entry);
}

/**
 * Filter a federation payload down to the instances that should remain visible.
 *
 * @param {Array<object>} entries Federation payload from the API.
 * @returns {Array<object>} Visible instances for frontend rendering.
 */
export function filterDisplayableFederationInstances(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries.filter(shouldDisplayFederationInstance);
}

export const __test__ = {
  MAX_VISIBLE_SITE_NAME_LENGTH,
  TRUNCATION_SUFFIX,
  TRUNCATED_SITE_NAME_LENGTH,
  readDomain,
  readSiteName,
  SUPPRESSED_SITE_NAME_PATTERN
};
