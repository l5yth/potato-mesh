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
 * The walk of the chat history backfill (issue #802, SPEC BK1).
 *
 * After the first paint the dashboard pages the rest of the 7-day chat window
 * backward from the live frontier. The caller's ``commit`` merges each page
 * into the message state as it lands, so the loaded set is always current
 * (PL-A1), and queues the backfill's coalesced idle repaint instead of
 * rendering the chat (FP-A2). The walk commits one page before it requests
 * the next, and when it ends, after its last page or after a failed one, it
 * calls ``flush`` once, which paints whatever the pages queued at once rather
 * than at idle time. A failure on any of these steps is logged, never
 * rethrown, so the walk's promise always resolves. The repaint queue itself
 * stays with the caller, which shares it with the bulk-collection backfill and
 * the destination walk.
 *
 * @module main/chat-backfill
 */

/** The warning a failed page, commit or end-of-walk paint logs. */
const FAILURE_WARNING = 'chat history backfill failed; showing the most recent page only';

/**
 * Create the runner of the chat history backfill.
 *
 * @param {{
 *   pages: function(number): AsyncIterable<Array<Object>>,
 *   commit: function(Array<Object>): (void|Promise<void>),
 *   flush: function(): void,
 *   logger?: { warn: Function },
 * }} deps ``pages`` returns the backward pages below an inclusive
 *   ``before`` cursor, oldest last; ``commit`` merges one page and queues its
 *   repaint; ``flush`` paints what the pages queued; ``logger`` receives the
 *   warning of a failed walk (default ``console``).
 * @returns {{ run: function(number): Promise<void> }} The runner. ``run``
 *   walks from ``before`` and resolves when the walk has ended and flushed; it
 *   never rejects for a failed page, commit or flush.
 */
export function createChatBackfill({ pages, commit, flush, logger = console }) {
  // One walk at a time: a run while one is in flight returns at once.
  let running = false;

  /**
   * Walk the pages below ``before``, committing each one before the next is
   * requested, then flush once. A failed page or commit ends the walk; the
   * pages committed before it stay, and the failure is logged, not rethrown.
   * A flush that throws is logged the same way.
   *
   * @param {number} before Inclusive cursor (unix seconds) the walk pages
   *   backward from; a missing or non-positive cursor walks nothing.
   * @returns {Promise<void>} Resolves once the walk has ended and flushed.
   */
  async function run(before) {
    if (running || !(before > 0)) return;
    running = true;
    try {
      for await (const batch of pages(before)) {
        await commit(batch);
      }
    } catch (err) {
      logger.warn(FAILURE_WARNING, err);
    } finally {
      running = false;
    }
    // SPEC BK1: the walk is over, so paint what its pages queued now instead
    // of waiting for the idle callback. The paint renders the chat, so a
    // render error lands here, logged as a per-page render error was.
    try {
      flush();
    } catch (err) {
      logger.warn(FAILURE_WARNING, err);
    }
  }

  return { run };
}
