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

const INSTANCES_ENDPOINT = '/api/instances';
const FETCH_OPTIONS = { cache: 'no-store' };

/**
 * Normalise an instance domain string.
 *
 * @param {unknown} domainValue Candidate domain value.
 * @returns {string|null} Lowercase domain string or ``null`` when invalid.
 */
function normalizeDomain(domainValue) {
  if (typeof domainValue !== 'string') {
    return null;
  }
  const trimmed = domainValue.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

/**
 * Normalise an instance entry from the API payload.
 *
 * @param {unknown} entry Raw payload entry.
 * @returns {{ domain: string, normalizedDomain: string, displayName: string }|null}
 *   Sanitised instance metadata ready for rendering.
 */
function normalizeInstanceEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const domainRaw = typeof entry.domain === 'string' ? entry.domain.trim() : '';
  if (!domainRaw) {
    return null;
  }
  const normalizedDomain = domainRaw.toLowerCase();
  const nameRaw = typeof entry.name === 'string' ? entry.name.trim() : '';
  const displayName = nameRaw || domainRaw;
  return {
    domain: domainRaw,
    normalizedDomain,
    displayName
  };
}

/**
 * Convert a mixed payload into a sorted list of unique instance entries.
 *
 * @param {unknown} payload Parsed JSON response.
 * @returns {Array<{ domain: string, normalizedDomain: string, displayName: string }>}
 *   Normalised and sorted instance metadata.
 */
function normalizeInstancePayload(payload) {
  if (!Array.isArray(payload)) {
    return [];
  }
  const unique = new Map();
  for (const entry of payload) {
    const normalized = normalizeInstanceEntry(entry);
    if (!normalized) {
      continue;
    }
    if (!unique.has(normalized.normalizedDomain)) {
      unique.set(normalized.normalizedDomain, normalized);
    }
  }
  return Array.from(unique.values()).sort((a, b) => {
    const nameA = a.displayName.toLowerCase();
    const nameB = b.displayName.toLowerCase();
    if (nameA < nameB) {
      return -1;
    }
    if (nameA > nameB) {
      return 1;
    }
    return a.normalizedDomain.localeCompare(b.normalizedDomain);
  });
}

/**
 * Format a domain string into a fully qualified URL.
 *
 * @param {string} domain Domain name selected by the user.
 * @param {Window} windowRef Active window reference.
 * @returns {string|null} Absolute URL or ``null`` when the domain is invalid.
 */
function formatDomainUrl(domain, windowRef) {
  if (typeof domain !== 'string') {
    return null;
  }
  const trimmed = domain.trim();
  if (!trimmed) {
    return null;
  }
  const protocol = typeof windowRef?.location?.protocol === 'string'
    ? windowRef.location.protocol
    : 'https:';
  const sanitizedProtocol = protocol === 'http:' || protocol === 'https:' ? protocol : 'https:';
  return `${sanitizedProtocol}//${trimmed}`;
}

/**
 * Create and initialise the federation instance selector.
 *
 * @param {{
 *   document: Document,
 *   window: Window,
 *   fetchImpl?: typeof fetch,
 *   config?: { instanceDomain?: string }
 * }} options Instance selector configuration.
 * @returns {{
 *   loadInstances: () => Promise<Array<{ domain: string, normalizedDomain: string, displayName: string }>>,
 *   __testHooks: {
 *     normalizeInstancePayload: typeof normalizeInstancePayload,
 *     formatDomainUrl: (domain: string) => string|null,
 *     handleChange: (event: { target: { value: string } }) => void
 *   }
 * }}
 */
export function createInstanceSelector({ document, window, fetchImpl = fetch, config = {} }) {
  const containerEl = document?.getElementById('instanceSelectorContainer');
  const selectEl = document?.getElementById('instanceSelect');
  const placeholderEl = document?.getElementById('instanceSelectPlaceholder');

  const normalizedSelfDomain = normalizeDomain(config?.instanceDomain);

  if (!containerEl || !selectEl || !placeholderEl) {
    return {
      async loadInstances() {
        return [];
      },
      __testHooks: {
        normalizeInstancePayload,
        formatDomainUrl: domain => formatDomainUrl(domain, window),
        handleChange() {}
      }
    };
  }

  /**
   * Update the select element to reflect a loading state.
   *
   * @returns {void}
   */
  function setLoadingState() {
    containerEl.hidden = true;
    selectEl.disabled = true;
    placeholderEl.textContent = 'Loading instances…';
    placeholderEl.selected = true;
    if (typeof selectEl.replaceChildren === 'function') {
      selectEl.replaceChildren(placeholderEl);
    }
  }

  setLoadingState();

  /**
   * Navigate the browser to the selected domain.
   *
   * @param {string} domain Domain chosen from the drop-down.
   * @returns {void}
   */
  function navigateToDomain(domain) {
    const url = formatDomainUrl(domain, window);
    if (!url) {
      return;
    }
    if (window?.location && typeof window.location.assign === 'function') {
      window.location.assign(url);
    } else if (typeof window?.open === 'function') {
      window.open(url, '_self');
    }
  }

  /**
   * Handle change events emitted by the instance selector.
   *
   * @param {{ target?: { value?: string } }} event DOM change event.
   * @returns {void}
   */
  function handleChange(event) {
    const value = event?.target?.value;
    if (typeof value !== 'string' || !value.trim()) {
      return;
    }
    navigateToDomain(value);
  }

  selectEl.addEventListener('change', handleChange);

  /**
   * Render normalised instance metadata into the select menu.
   *
   * @param {Array<{ domain: string, normalizedDomain: string, displayName: string }>} instances
   *   Normalised instance payload.
   * @returns {Array<{ domain: string, normalizedDomain: string, displayName: string }>}
   *   Rendered payload for caller reference.
   */
  function renderInstances(instances) {
    if (!instances.length) {
      setLoadingState();
      placeholderEl.textContent = 'Instances unavailable';
      return [];
    }

    const options = instances.map(instance => {
      const option = document.createElement('option');
      option.value = instance.domain;
      option.textContent = instance.displayName;
      return option;
    });

    if (typeof selectEl.replaceChildren === 'function') {
      selectEl.replaceChildren(placeholderEl, ...options);
    } else {
      while (selectEl.children.length) {
        selectEl.removeChild(selectEl.children[0]);
      }
      for (const option of [placeholderEl, ...options]) {
        if (typeof selectEl.appendChild === 'function') {
          selectEl.appendChild(option);
        }
      }
    }

    placeholderEl.textContent = 'Browse instances…';
    selectEl.disabled = false;
    containerEl.hidden = false;

    if (normalizedSelfDomain) {
      const match = instances.find(
        instance => instance.normalizedDomain === normalizedSelfDomain
      );
      if (match) {
        selectEl.value = match.domain;
        placeholderEl.selected = false;
        return instances;
      }
    }

    selectEl.value = '';
    placeholderEl.selected = true;
    return instances;
  }

  return {
    async loadInstances() {
      try {
        const response = await fetchImpl(INSTANCES_ENDPOINT, FETCH_OPTIONS);
        if (!response?.ok) {
          throw new Error(`Unexpected response status: ${response?.status}`);
        }
        const payload = await response.json();
        const instances = normalizeInstancePayload(payload);
        return renderInstances(instances);
      } catch (error) {
        console.error('Failed to load instance directory', error);
        setLoadingState();
        placeholderEl.textContent = 'Instances unavailable';
        return [];
      }
    },
    __testHooks: {
      normalizeInstancePayload,
      formatDomainUrl: domain => formatDomainUrl(domain, window),
      handleChange
    }
  };
}
