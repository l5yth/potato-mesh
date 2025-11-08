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
 * CSS selector used to locate the embedded configuration element.
 *
 * @type {string}
 */
const CONFIG_SELECTOR = '[data-app-config]';

/**
 * Read and parse the serialized application configuration from the DOM.
 *
 * @returns {Object<string, *>} Parsed configuration object or an empty object when unavailable.
 */
export function readAppConfig() {
  const el = document.querySelector(CONFIG_SELECTOR);
  if (!el) {
    return {};
  }
  const raw = el.getAttribute('data-app-config') || '';
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch (err) {
    console.error('Failed to parse application configuration', err);
    return {};
  }
}
