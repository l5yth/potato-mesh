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
 * @returns {{ frequency: string|null, channelName: string|null, presetCode: string|null }}
 *   Normalized metadata values.
 */
export function extractChatMessageMetadata(message) {
  if (!message || typeof message !== 'object') {
    return { frequency: null, channelName: null, presetCode: null };
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

  const modemPreset = normalizePresetString(resolveModemPresetCandidate(message));
  const presetCode = modemPreset ? abbreviatePreset(modemPreset) : null;

  return { frequency, channelName, presetCode };
}

/**
 * Produce the formatted prefix for a chat message entry.
 *
 * Timestamp and frequency will each be wrapped in square brackets. Missing
 * metadata values result in empty brackets (with the frequency replaced by the
 * configured placeholder) to preserve the positional layout expected by
 * operators.
 *
 * @param {{
 *   timestamp: string,
 *   frequency: string|null
 * }} params Normalised and escaped display strings.
 * @returns {string} Prefix string suitable for HTML insertion.
 */
export function formatChatMessagePrefix({ timestamp, frequency }) {
  const ts = typeof timestamp === 'string' ? timestamp : '';
  const freq = normalizeFrequencySlot(frequency);
  return `[${ts}][${freq}]`;
}

/**
 * Render the channel tag that follows the short name in a chat message entry.
 *
 * Empty channel names remain blank within the brackets, mirroring the original
 * UI behaviour that reserves the slot without introducing placeholder text.
 *
 * @param {{ channelName: string|null }} params Normalised and escaped display strings.
 * @returns {string} Channel tag suitable for HTML insertion.
 */
export function formatChatChannelTag({ channelName }) {
  const channel = typeof channelName === 'string' ? channelName : channelName == null ? '' : String(channelName);
  return `[${channel}]`;
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
 * Render the preset hint bracket inserted between the prefix and short name.
 *
 * @param {{ presetCode: string|null }} params Normalized preset abbreviation.
 * @returns {string} HTML-ready bracket slot.
 */
export function formatChatPresetTag({ presetCode }) {
  const slot = normalizePresetSlot(presetCode);
  return `[${slot}]`;
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
 * HTML placeholder for missing preset abbreviations.
 * @type {string}
 */
const PRESET_PLACEHOLDER = '&nbsp;&nbsp;';

/**
 * Canonical preset abbreviations keyed by a normalized preset token.
 * @type {Record<string, string>}
 */
const PRESET_ABBREVIATIONS = {
  verylongslow: 'VL',
  longslow: 'LS',
  longmoderate: 'LM',
  longfast: 'LF',
  mediumslow: 'MS',
  mediumfast: 'MF',
  shortslow: 'SS',
  shortfast: 'SF',
  shortturbo: 'ST',
};

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

/**
 * Resolve a modem preset candidate from the provided source object.
 *
 * @param {*} source Source payload potentially containing modem metadata.
 * @param {Set<object>} [visited] Visited references to avoid recursion loops.
 * @returns {*|null} Raw modem preset candidate.
 */
function resolveModemPresetCandidate(source, visited = new Set()) {
  if (!source || typeof source !== 'object') {
    return null;
  }
  if (visited.has(source)) {
    return null;
  }
  visited.add(source);

  const candidate = firstNonNull(
    source.modemPreset,
    source.modem_preset,
    source.modempreset,
    source.ModemPreset
  );
  if (candidate != null) {
    return candidate;
  }

  if (source.node && typeof source.node === 'object') {
    const nested = resolveModemPresetCandidate(source.node, visited);
    if (nested != null) {
      return nested;
    }
  }

  return null;
}

/**
 * Convert arbitrary preset input to a trimmed string.
 *
 * @param {*} value Raw preset candidate.
 * @returns {string|null} Clean preset string.
 */
function normalizePresetString(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return null;
}

/**
 * Produce a two-character abbreviation for a modem preset.
 *
 * @param {string} preset Normalized preset string.
 * @returns {string|null} Uppercase abbreviation or ``null``.
 */
function abbreviatePreset(preset) {
  if (!preset) {
    return null;
  }
  const token = preset.replace(/[^A-Za-z]/g, '').toLowerCase();
  if (token && PRESET_ABBREVIATIONS[token]) {
    return PRESET_ABBREVIATIONS[token];
  }
  return derivePresetInitials(preset);
}

/**
 * Generate fallback initials for unmapped presets.
 *
 * @param {string} preset Raw preset string.
 * @returns {string|null} Derived initials.
 */
function derivePresetInitials(preset) {
  if (!preset) {
    return null;
  }
  const spaced = preset.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const tokens = spaced
    .split(/[\s_-]+/)
    .map(part => part.replace(/[^A-Za-z]/g, ''))
    .filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }
  if (tokens.length === 1) {
    const upper = tokens[0].toUpperCase();
    if (upper.length >= 2) {
      return upper.slice(0, 2);
    }
    if (upper.length === 1) {
      return `${upper}?`;
    }
    return null;
  }
  const initials = tokens.map(part => part[0].toUpperCase());
  if (initials.length >= 2) {
    return `${initials[0]}${initials[1]}`;
  }
  return null;
}

/**
 * Normalise the preset slot contents for the bracket display.
 *
 * @param {*} value Raw preset code.
 * @returns {string} HTML-ready preset slot.
 */
function normalizePresetSlot(value) {
  if (value == null) {
    return PRESET_PLACEHOLDER;
  }
  const trimmed = String(value).trim().toUpperCase();
  return trimmed.length > 0 ? trimmed.slice(0, 2) : PRESET_PLACEHOLDER;
}

export const __test__ = {
  firstNonNull,
  normalizeString,
  normalizeFrequency,
  formatChatMessagePrefix,
  formatNodeAnnouncementPrefix,
  normalizeFrequencySlot,
  FREQUENCY_PLACEHOLDER,
  formatChatChannelTag,
  resolveModemPresetCandidate,
  normalizePresetString,
  abbreviatePreset,
  derivePresetInitials,
  normalizePresetSlot,
  PRESET_PLACEHOLDER
};
