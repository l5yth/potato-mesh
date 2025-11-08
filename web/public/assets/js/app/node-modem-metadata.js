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
 * Convert arbitrary input into a trimmed string representation.
 *
 * @param {*} value Candidate value.
 * @returns {string|null} Trimmed string or ``null`` when empty.
 */
function toTrimmedString(value) {
  if (value == null) return null;
  const stringValue = String(value).trim();
  return stringValue.length > 0 ? stringValue : null;
}

/**
 * Normalize modem-related metadata from a node-shaped record.
 *
 * @param {*} source Arbitrary payload that may contain modem attributes.
 * @returns {{ modemPreset: (string|null), loraFreq: (number|null) }} Normalized modem metadata.
 */
export function extractModemMetadata(source) {
  if (!source || typeof source !== 'object') {
    return { modemPreset: null, loraFreq: null };
  }

  const presetCandidate =
    source.modemPreset ?? source.modem_preset ?? source.modempreset ?? source.ModemPreset ?? null;
  const modemPreset = toTrimmedString(presetCandidate);

  const freqCandidate = source.loraFreq ?? source.lora_freq ?? source.frequency ?? null;
  const parsedFreq = Number(freqCandidate);
  const loraFreq = Number.isFinite(parsedFreq) && parsedFreq > 0 ? parsedFreq : null;

  return { modemPreset, loraFreq };
}

/**
 * Format a numeric LoRa frequency in MHz with up to three fractional digits.
 *
 * @param {*} value Numeric frequency in MHz.
 * @returns {string|null} Formatted frequency with units or ``null`` when invalid.
 */
export function formatLoraFrequencyMHz(value) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  const formatter = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });

  return `${formatter.format(numeric)}MHz`;
}

/**
 * Produce a combined modem preset and frequency description suitable for overlays.
 *
 * @param {*} preset Raw modem preset value.
 * @param {*} frequency Raw frequency value expressed in MHz.
 * @returns {string|null} Human-readable description or ``null`` when no data available.
 */
export function formatModemDisplay(preset, frequency) {
  const presetText = toTrimmedString(preset);
  const freqText = formatLoraFrequencyMHz(frequency);

  if (!presetText && !freqText) {
    return null;
  }

  if (presetText && freqText) {
    return `${presetText} (${freqText})`;
  }

  return presetText ?? freqText;
}

export const __testUtils = {
  toTrimmedString,
};
