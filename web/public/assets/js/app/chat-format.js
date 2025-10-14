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
 * Produce the formatted prefix for a chat message entry.
 *
 * Timestamp, frequency, and channel name will each be wrapped in square
 * brackets. Missing metadata values result in empty brackets to preserve the
 * positional layout expected by operators.
 *
 * @param {{
 *   timestamp: string,
 *   frequency: string|null,
 *   channelName: string|null
 * }} params Normalised and escaped display strings.
 * @returns {string} Prefix string suitable for HTML insertion.
 */
export function formatChatMessagePrefix({ timestamp, frequency, channelName }) {
  const ts = typeof timestamp === 'string' ? timestamp : '';
  const freq = normalizeFrequencySlot(frequency);
  const channel = typeof channelName === 'string' ? channelName : channelName == null ? '' : String(channelName);
  return `[${ts}][${freq}][${channel}]`;
}

/**
 * Create the formatted prefix for node announcements in the chat log.
 *
 * Both the timestamp and the optional frequency will be wrapped in brackets,
 * mirroring the chat message display while omitting the channel indicator.
 *
 * @param {{ timestamp: string, frequency: string|null }} params Display strings.
 * @returns {string} Prefix string suitable for HTML insertion.
 */
export function formatNodeAnnouncementPrefix({ timestamp, frequency }) {
  const ts = typeof timestamp === 'string' ? timestamp : '';
  const freq = normalizeFrequencySlot(frequency);
  return `[${ts}][${freq}]`;
}

/**
 * Produce a consistently formatted frequency slot for chat prefixes.
 *
 * A missing or empty frequency is rendered as three HTML non-breaking spaces to
 * ensure the UI maintains its expected alignment while clearly indicating the
 * absence of data.
 *
 * @param {*} value Frequency value that has already been escaped for HTML.
 * @returns {string} Frequency slot suitable for prefix rendering.
 */
function normalizeFrequencySlot(value) {
  if (value == null) {
    return FREQUENCY_PLACEHOLDER;
  }
  if (typeof value === 'string') {
    return value.length > 0 ? value : FREQUENCY_PLACEHOLDER;
  }
  const strValue = String(value);
  return strValue.length > 0 ? strValue : FREQUENCY_PLACEHOLDER;
}

/**
 * HTML entity sequence inserted when a frequency is unavailable.
 * @type {string}
 */
const FREQUENCY_PLACEHOLDER = '&nbsp;&nbsp;&nbsp;';

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
  normalizeFrequency,
  formatChatMessagePrefix,
  formatNodeAnnouncementPrefix,
  normalizeFrequencySlot,
  FREQUENCY_PLACEHOLDER
};
