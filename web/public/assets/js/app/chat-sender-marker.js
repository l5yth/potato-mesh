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
 * Unverified-sender marker for chat lines (SPEC SV3).
 *
 * A MeshCore channel message names its sender only in the ``Name:`` prefix of
 * its text, which no key backs. The web app serves such a row with
 * ``sender_verified: false`` (SPEC SV2), and the dashboard chat and the node
 * page mark the line with an "unverified" chip after the sender badge, titled
 * "Sender not verified". Visible text, not a glyph: a tooltip never shows on a
 * touch screen, and ``?`` already marks a badge whose node is unknown. A line
 * whose sender comes from an id the packet carries gets no marker.
 *
 * @module chat-sender-marker
 */

/**
 * Tooltip and accessible description of the marker.
 *
 * @type {string}
 */
export const SENDER_UNVERIFIED_LABEL = 'Sender not verified';

/**
 * Visible text of the marker.
 *
 * @type {string}
 */
export const SENDER_UNVERIFIED_TEXT = 'unverified';

/**
 * Whether a chat line's sender was attributed by name rather than by an id
 * the packet carries.
 *
 * @param {?Object} message Message payload.
 * @param {{ senderFromText?: boolean }} [options] ``senderFromText``: the
 *   renderer named the sender badge from the line's ``Name:`` prefix itself,
 *   which it does for a MeshCore channel line that came with no sender id
 *   (posted by an ingestor before 0.6.0).
 * @returns {boolean} ``true`` when the row carries ``sender_verified: false``
 *   or the badge was named from the text.
 */
export function isSenderUnverified(message, { senderFromText = false } = {}) {
  if (senderFromText === true) return true;
  return message != null && typeof message === 'object' && message.sender_verified === false;
}

/**
 * Render the unverified-sender marker of a chat line, placed right after the
 * sender badge and outside the 19ch prefix (FU9).
 *
 * @param {?Object} message Message payload.
 * @param {{ senderFromText?: boolean }} [options] See
 *   {@link isSenderUnverified}.
 * @returns {string} HTML for the marker with a leading space, or ``''`` for a
 *   sender that came from an id the packet carries.
 */
export function formatChatSenderMarker(message, options = {}) {
  if (!isSenderUnverified(message, options)) return '';
  return ` <span class="chat-sender-unverified" title="${SENDER_UNVERIFIED_LABEL}">${SENDER_UNVERIFIED_TEXT}</span>`;
}
