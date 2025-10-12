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

import test from 'node:test';
import assert from 'node:assert/strict';

import { supportsLeafletTileContainerFilters } from '../browser-capabilities.js';

const IPHONE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';
const IPAD_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1';
const DESKTOP_SAFARI_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const CHROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/**
 * Create a minimal environment stub exposing only the navigator fields used by
 * {@link supportsLeafletTileContainerFilters}.
 *
 * @param {Partial<Navigator>} navigatorOverrides Navigator property overrides.
 * @returns {{ navigator: Partial<Navigator> }} Environment shim.
 */
function createEnvironment(navigatorOverrides) {
  return { navigator: { ...navigatorOverrides } };
}

test('supportsLeafletTileContainerFilters defaults to safe behaviour', () => {
  assert.equal(supportsLeafletTileContainerFilters(), true);
  assert.equal(supportsLeafletTileContainerFilters(undefined), true);
  assert.equal(supportsLeafletTileContainerFilters({}), true);
});

test('mobile Safari environments disable container filters', () => {
  const iphoneEnv = createEnvironment({ userAgent: IPHONE_USER_AGENT, platform: 'iPhone', maxTouchPoints: 5 });
  assert.equal(supportsLeafletTileContainerFilters(iphoneEnv), false);

  const ipadEnv = createEnvironment({ userAgent: IPAD_USER_AGENT, platform: 'MacIntel', maxTouchPoints: 5 });
  assert.equal(supportsLeafletTileContainerFilters(ipadEnv), false);
});

test('desktop browsers retain container filter support', () => {
  const safariEnv = createEnvironment({ userAgent: DESKTOP_SAFARI_USER_AGENT, platform: 'MacIntel', maxTouchPoints: 0 });
  assert.equal(supportsLeafletTileContainerFilters(safariEnv), true);

  const chromeEnv = createEnvironment({ userAgent: CHROME_USER_AGENT, platform: 'Win32', maxTouchPoints: 0 });
  assert.equal(supportsLeafletTileContainerFilters(chromeEnv), true);
});
