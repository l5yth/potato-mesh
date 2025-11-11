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
 * Maximum number of chat messages that the API can return in a single request.
 * @type {number}
 */
export const MESSAGE_LIMIT = 1000;

/**
 * Normalise a candidate limit for the messages API to remain within supported bounds.
 *
 * The API clamps responses to {@link MESSAGE_LIMIT}, so this helper ensures the
 * frontend always requests an allowed value while defaulting to the upper bound
 * when callers omit or provide invalid data.
 *
 * @param {*} limit Candidate limit value supplied by the caller.
 * @returns {number} Safe, positive limit capped at {@link MESSAGE_LIMIT}.
 */
export function normaliseMessageLimit(limit) {
  const parsed = Number.parseFloat(limit);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return MESSAGE_LIMIT;
  }
  const floored = Math.floor(parsed);
  if (floored <= 0) {
    return MESSAGE_LIMIT;
  }
  return Math.min(floored, MESSAGE_LIMIT);
}
