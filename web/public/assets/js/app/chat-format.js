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

/**
 * Extract channel metadata from a message payload for chat display.
 *
 * @param {Object} message Raw message payload from the API.
 * @returns {{ frequency: string|null, channelName: string|null }}
 *   Normalized metadata values.
 */
export function extractChatMessageMetadata(message) {
  if (!message || typeof message !== 'object') {
    return { frequency: null, channelName: null };
  }

  const frequency = normalizeFrequency(
    firstNonNull(
      message.region_frequency,
      message.regionFrequency,
      message.lora_freq,
      message.loraFreq,
      message.frequency
    )
  );

  const channelName = normalizeString(
    firstNonNull(message.channel_name, message.channelName)
  );

  return { frequency, channelName };
}

/**
 * Return the first value in ``candidates`` that is not ``null`` or ``undefined``.
 *
 * @param {...*} candidates Candidate values.
 * @returns {*} First present value or ``null`` when missing.
 */
function firstNonNull(...candidates) {
  for (const value of candidates) {
    if (value !== null && value !== undefined) {
      return value;
    }
  }
  return null;
}

/**
 * Normalise potential channel name values to trimmed strings.
 *
 * @param {*} value Raw value.
 * @returns {string|null} Sanitised channel name.
 */
function normalizeString(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return String(value);
  }
  return null;
}

/**
 * Convert various frequency representations into clean strings.
 *
 * @param {*} value Raw frequency value.
 * @returns {string|null} Frequency in MHz as a string, when available.
 */
function normalizeFrequency(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numericMatch = trimmed.match(/\d+(?:\.\d+)?/);
    if (numericMatch) {
      const parsed = Number(numericMatch[0]);
      if (Number.isFinite(parsed) && parsed > 0) {
        return Number.isInteger(parsed) ? String(Math.trunc(parsed)) : String(parsed);
      }
    }
    return trimmed;
  }
  return null;
}

export const __test__ = {
  firstNonNull,
  normalizeString,
  normalizeFrequency
};
