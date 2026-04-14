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

import test from 'node:test';
import assert from 'node:assert/strict';

import { withApp } from './main-app-test-helpers.js';

// ---------------------------------------------------------------------------
// isAutorefreshPaused
// ---------------------------------------------------------------------------

test('isAutorefreshPaused returns false by default', () => {
  withApp((t) => {
    assert.equal(t.isAutorefreshPaused(), false);
  });
});

// ---------------------------------------------------------------------------
// restartAutoRefresh is safe when called without a timer
// ---------------------------------------------------------------------------

test('restartAutoRefresh does not throw when invoked with refreshMs 0', () => {
  withApp((t) => {
    assert.doesNotThrow(() => t.restartAutoRefresh());
  });
});
