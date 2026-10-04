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
 * MS-A4 (#882): the LV8 channel select is the only channel control at
 * <= 900 px, so every live-refresh path through the dashboard must leave the
 * same select element in `#chat`. Rebuilding it detaches the element a user's
 * open picker is bound to, and the pick is lost.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runLiveApp } from './sse-app-harness.js';

/**
 * Return the channel select rendered inside the dashboard's `#chat` container.
 *
 * @returns {Object} The select mock element.
 */
function chatSelect() {
  const chat = globalThis.document.getElementById('chat');
  return chat.children[0].children[3];
}

test('every live refresh path keeps the same channel select in #chat (MS-A4, #882)', async () => {
  await runLiveApp({}, async ({ testUtils, FakeEventSource }) => {
    const select = chatSelect();
    assert.equal(select.tagName, 'SELECT');
    const chosen = select.value;
    const stream = FakeEventSource.instances[0];
    const ping = async collection => {
      stream.dispatch('change', { data: JSON.stringify({ collection }) });
      await testUtils.flushLiveRefresh();
    };
    const paths = [
      ['a messages ping', () => ping('messages')],
      ['a nodes ping', () => ping('nodes')],
      [
        'a (re)connect resync',
        async () => {
          stream.dispatch('open', {});
          await testUtils.flushLiveRefresh();
        },
      ],
      ['the safety poll', () => testUtils.refresh()],
      ['a history backfill page', async () => testUtils.rerenderChatLog()],
    ];
    for (const [label, run] of paths) {
      await run();
      assert.ok(chatSelect() === select, `${label} keeps the select element`);
      assert.equal(select.value, chosen, `${label} keeps the chosen channel`);
    }
  });
});
