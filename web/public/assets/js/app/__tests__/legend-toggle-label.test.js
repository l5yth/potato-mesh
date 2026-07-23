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

// Regression guard for audit finding D-012 (SPEC UX8 / ACCEPTANCE UX-A6):
// the legend toggle's visible label mirrors the aria gating — a filter suffix
// appears only while role filters are active.

import test from 'node:test';
import assert from 'node:assert/strict';

import { legendToggleLabel } from '../map-legend-visibility.js';

test('no filters: plain Hide/Show legend, no suffix', () => {
  assert.deepEqual(legendToggleLabel(true, false), {
    text: 'Hide legend',
    ariaLabel: 'Hide map legend',
  });
  assert.deepEqual(legendToggleLabel(false, false), {
    text: 'Show legend',
    ariaLabel: 'Show map legend',
  });
});

test('active filters: both label layers carry the filter suffix', () => {
  assert.deepEqual(legendToggleLabel(true, true), {
    text: 'Hide legend (filters active)',
    ariaLabel: 'Hide map legend (role filters active)',
  });
  assert.deepEqual(legendToggleLabel(false, true), {
    text: 'Show legend (filters active)',
    ariaLabel: 'Show map legend (role filters active)',
  });
});
