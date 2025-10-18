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
 * Determine the most suitable label for an instance list entry.
 *
 * @param {{ name?: string, domain?: string }} entry Instance record as returned by the API.
 * @returns {string} Preferred display label falling back to the domain.
 */
function resolveInstanceLabel(entry) {
  if (!entry || typeof entry !== 'object') {
    return '';
  }

  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  if (name.length > 0) {
    return name;
  }

  const domain = typeof entry.domain === 'string' ? entry.domain.trim() : '';
  return domain;
}

/**
 * Construct a navigable URL for the provided instance domain.
 *
 * @param {string} domain Instance domain as returned by the federation catalog.
 * @returns {string|null} Navigable absolute URL or ``null`` when the domain is empty.
 */
export function buildInstanceUrl(domain) {
  if (typeof domain !== 'string') {
    return null;
  }

  const trimmed = domain.trim();
  if (!trimmed) {
    return null;
  }

  if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed}`;
}

/**
 * Populate and activate the federation instance selector control.
 *
 * @param {{
 *   selectElement: HTMLSelectElement | null,
 *   fetchImpl?: typeof fetch,
 *   windowObject?: Window,
 *   documentObject?: Document,
 *   instanceDomain?: string,
 *   defaultLabel?: string,
 *   navigate?: (url: string) => void,
 * }} options Configuration for the selector behaviour.
 * @returns {Promise<void>} Promise resolving once the selector has been initialised.
 */
export async function initializeInstanceSelector(options) {
  const {
    selectElement,
    fetchImpl = typeof fetch === 'function' ? fetch : null,
    windowObject = typeof window !== 'undefined' ? window : undefined,
    documentObject = typeof document !== 'undefined' ? document : undefined,
    instanceDomain,
    defaultLabel = 'Select region ...',
    navigate,
  } = options;

  if (!selectElement || typeof selectElement !== 'object') {
    return;
  }

  const doc = documentObject || windowObject?.document || null;

  if (selectElement.options.length === 0) {
    if (doc && typeof doc.createElement === 'function') {
      const placeholderOption = doc.createElement('option');
      placeholderOption.value = '';
      placeholderOption.textContent = defaultLabel;
      selectElement.appendChild(placeholderOption);
    } else {
      selectElement.insertAdjacentHTML?.('beforeend', `<option value="">${defaultLabel}</option>`);
    }
  } else if (selectElement.options[0]) {
    selectElement.options[0].textContent = defaultLabel;
    selectElement.options[0].value = '';
  }

  if (typeof fetchImpl !== 'function') {
    return;
  }

  let response;
  try {
    response = await fetchImpl('/api/instances', {
      headers: { Accept: 'application/json' },
      credentials: 'omit',
    });
  } catch (error) {
    console.warn('Failed to load federation instances', error);
    return;
  }

  if (!response || typeof response.json !== 'function') {
    return;
  }

  if (!response.ok) {
    return;
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    console.warn('Invalid federation instances payload', error);
    return;
  }

  if (!Array.isArray(payload)) {
    return;
  }

  const sanitizedDomain = typeof instanceDomain === 'string' ? instanceDomain.trim().toLowerCase() : null;

  const sortedEntries = payload
    .filter(entry => entry && typeof entry.domain === 'string' && entry.domain.trim() !== '')
    .map(entry => ({
      domain: entry.domain.trim(),
      label: resolveInstanceLabel(entry),
    }))
    .sort((a, b) => {
      const labelA = a.label || a.domain;
      const labelB = b.label || b.domain;
      return labelA.localeCompare(labelB, undefined, { sensitivity: 'base' });
    });

  while (selectElement.options.length > 1) {
    selectElement.remove(1);
  }

  let matchedIndex = 0;

  sortedEntries.forEach((entry, index) => {
    if (!doc || typeof doc.createElement !== 'function') {
      return;
    }

    const option = doc.createElement('option');
    const optionLabel = entry.label && entry.label.trim().length > 0 ? entry.label : entry.domain;
    const label = optionLabel.trim();

    option.value = entry.domain;
    option.textContent = label;
    option.dataset.instanceDomain = entry.domain;

    selectElement.appendChild(option);

    if (sanitizedDomain && entry.domain.toLowerCase() === sanitizedDomain) {
      matchedIndex = index + 1;
    }
  });

  if (matchedIndex > 0 && selectElement.options[matchedIndex]) {
    selectElement.selectedIndex = matchedIndex;
  } else {
    selectElement.selectedIndex = 0;
  }

  const navigateTo = typeof navigate === 'function'
    ? navigate
    : url => {
        if (!url || !windowObject || !windowObject.location) {
          return;
        }
        if (typeof windowObject.location.assign === 'function') {
          windowObject.location.assign(url);
        } else {
          windowObject.location.href = url;
        }
      };

  selectElement.addEventListener('change', event => {
    const target = event?.target;
    if (!target || typeof target.value !== 'string' || target.value.trim() === '') {
      return;
    }

    const url = buildInstanceUrl(target.value);
    if (url) {
      navigateTo(url);
    }
  });
}

export const __test__ = { resolveInstanceLabel };
