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

import { createDomEnvironment } from './dom-environment.js';
import { initializeApp } from '../main.js';

/**
 * Minimal {@link initializeApp} configuration shared across main.js test suites.
 * Frozen to prevent accidental mutation between tests.
 */
export const MINIMAL_CONFIG = Object.freeze({
  channel: 'Primary',
  frequency: '915MHz',
  refreshMs: 0,
  refreshIntervalSeconds: 30,
  chatEnabled: true,
  mapCenter: { lat: 0, lon: 0 },
  mapZoom: null,
  maxDistanceKm: 0,
  tileFilters: { light: '', dark: '' },
  instancesFeatureEnabled: false,
  instanceDomain: null,
  snapshotWindowSeconds: 3600,
});

/**
 * Spin up a minimal DOM environment, call {@link initializeApp} with a stub
 * config, and return the inner test utilities alongside a cleanup handle.
 *
 * @returns {{ testUtils: Object, cleanup: Function }}
 */
export function setupApp() {
  const env = createDomEnvironment({ includeBody: true });
  const { _testUtils } = initializeApp(MINIMAL_CONFIG);
  return { testUtils: _testUtils, cleanup: env.cleanup.bind(env) };
}

/**
 * Run a test body with a fresh app instance, ensuring cleanup regardless of
 * outcome.  Eliminates the repetitive try/finally boilerplate across tests.
 *
 * @param {function(Object): void} fn Receives the _testUtils object.
 */
export function withApp(fn) {
  const { testUtils, cleanup } = setupApp();
  try {
    fn(testUtils);
  } finally {
    cleanup();
  }
}

/**
 * Spin up a DOM environment, optionally pre-register elements by id, then
 * initialise the app with a custom config override.  Returns the test utils,
 * the environment (for DOM inspection), and a cleanup handle.
 *
 * @param {{ extraElements?: string[], configOverrides?: Object }} [opts]
 * @returns {{ testUtils: Object, env: Object, cleanup: Function }}
 */
export function setupAppWithOptions({ extraElements = [], configOverrides = {} } = {}) {
  const env = createDomEnvironment({ includeBody: true });
  for (const id of extraElements) {
    env.registerElement(id, env.createElement('span', id));
  }
  const config = { ...MINIMAL_CONFIG, ...configOverrides };
  const { _testUtils } = initializeApp(config);
  return { testUtils: _testUtils, env, cleanup: env.cleanup.bind(env) };
}

/**
 * Extract the serialised HTML string from a DOM element returned by the test
 * utils.  The stub environment exposes innerHTML as a plain string; this
 * normalises the fallback path for environments where it may not be.
 *
 * @param {HTMLElement} el
 * @returns {string}
 */
export function innerHtml(el) {
  return String(typeof el.innerHTML === 'string' ? el.innerHTML : el.childNodes?.[0] ?? '');
}
