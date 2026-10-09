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

import { visibleText } from './visible-text.js';

test('visibleText keeps the text of a rendered fragment', () => {
  assert.equal(visibleText('<span class="a">07:41</span> <b>SNS1</b> node info'), '07:41 SNS1 node info');
});

test('visibleText turns non-breaking spaces into spaces', () => {
  assert.equal(visibleText('a&nbsp;b c'), 'a b c');
});

test('visibleText strips until no tag is left and is stable', () => {
  const once = visibleText('<<b>i>x<span title="1 > 0">y</span>');
  assert.equal(once.includes('<'), false, once);
  assert.equal(visibleText(once), once);
});

test('visibleText reads any value as a string', () => {
  assert.equal(visibleText(42), '42');
});
