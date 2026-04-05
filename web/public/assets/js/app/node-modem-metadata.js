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
 * Named MeshCore modem preset definitions.
 *
 * Each entry describes a specific SF/BW/CR combination together with an
 * optional frequency gate.  Frequency-gated entries are skipped when
 * ``freqMHz`` is not known.
 *
 * @type {Array<{
 *   sf: number, bw: number, cr: number,
 *   longName: string,
 *   minFreqMHz?: number, maxFreqMHz?: number
 * }>}
 */
const MESHCORE_NAMED_PRESETS = [
  { sf: 10, bw: 250, cr: 5, longName: 'AU/NZ Wide'   },
  { sf: 10, bw:  62, cr: 5, longName: 'AU/NZ Narrow' },
  { sf: 11, bw: 250, cr: 5, longName: 'EU/UK Wide'   },
  { sf:  8, bw:  62, cr: 8, longName: 'EU/UK Narrow' },
  // SF7/BW62/CR5 is region-disambiguated by frequency threshold.
  { sf: 7, bw: 62, cr: 5, longName: 'CZ/SK Narrow', maxFreqMHz: 900 },
  { sf: 7, bw: 62, cr: 5, longName: 'US/CA Narrow', minFreqMHz: 900 },
];

/**
 * Parse an SF/BW/CR preset token string into its numeric components.
 *
 * Accepts any ordering of the three tokens separated by ``/``.  Returns
 * ``null`` when the string does not look like an SF/BW/CR pattern (e.g.
 * Meshtastic named presets such as ``"MediumFast"``).
 *
 * @param {*} preset Candidate preset string.
 * @returns {{ sf: number, bw: number, cr: number } | null} Parsed tokens or ``null``.
 */
function parseMeshcorePresetTokens(preset) {
  const str = toTrimmedString(preset);
  if (!str) return null;

  const parts = str.split('/');
  if (parts.length !== 3) return null;

  const values = { sf: null, bw: null, cr: null };
  for (const part of parts) {
    const match = part.match(/^(SF|BW|CR)(\d+(?:\.\d+)?)$/i);
    if (!match) return null;
    const key = match[1].toLowerCase();
    values[key] = Number(match[2]);
  }

  if (values.sf === null || values.bw === null || values.cr === null) return null;
  return { sf: values.sf, bw: values.bw, cr: values.cr };
}

/**
 * Map a LoRa bandwidth to the canonical short code used in preset display.
 *
 * Covers the three standard bandwidths (62 kHz / 62.5 kHz, 125 kHz,
 * 250 kHz).  Any other value returns ``null``.
 *
 * @param {number} bw Bandwidth in kHz.
 * @returns {'Na'|'St'|'Wi'|null} Short code or ``null``.
 */
function bwToShortCode(bw) {
  // Accept both 62 and 62.5 as the narrow band value.
  if (bw === 62 || bw === 62.5) return 'Na';
  if (bw === 125) return 'St';
  if (bw === 250) return 'Wi';
  return null;
}

/**
 * Resolve a MeshCore SF/BW/CR preset into display metadata.
 *
 * Returns ``null`` for any preset that is not in SF/BW/CR format (e.g.
 * Meshtastic named presets), so callers can fall back to their own
 * handling.
 *
 * Algorithm:
 * 1. Parse the preset into ``{sf, bw, cr}`` — return ``null`` if not parseable.
 * 2. Derive ``shortCode`` from BW alone (always BW-driven, not table-driven).
 * 3. Walk ``MESHCORE_NAMED_PRESETS`` for a matching ``{sf, bw, cr}`` entry
 *    respecting any frequency gate.  Frequency-gated entries are skipped when
 *    ``freqMHz`` is ``null``.
 * 4. Named match → ``displayString = longName``.
 *    No named match → ``longName = null``, ``displayString = "BW{bw}/SF{sf}/CR{cr}"``.
 *
 * @param {*} preset Raw preset string.
 * @param {number|null} freqMHz Frequency in MHz, or ``null`` when unknown.
 * @returns {{ longName: string|null, shortCode: string|null, displayString: string } | null}
 *   Display metadata, or ``null`` when not an SF/BW/CR string.
 */
export function resolveMeshcorePresetDisplay(preset, freqMHz) {
  const tokens = parseMeshcorePresetTokens(preset);
  if (!tokens) return null;

  const { sf, bw, cr } = tokens;
  const shortCode = bwToShortCode(bw);

  const match = MESHCORE_NAMED_PRESETS.find(entry => {
    if (entry.sf !== sf || entry.bw !== bw || entry.cr !== cr) return false;
    if (entry.maxFreqMHz !== undefined) {
      if (freqMHz === null || freqMHz === undefined) return false;
      if (freqMHz >= entry.maxFreqMHz) return false;
    }
    if (entry.minFreqMHz !== undefined) {
      if (freqMHz === null || freqMHz === undefined) return false;
      if (freqMHz < entry.minFreqMHz) return false;
    }
    return true;
  });

  if (match) {
    return { longName: match.longName, shortCode, displayString: match.longName };
  }

  return {
    longName: null,
    shortCode,
    displayString: `BW${bw}/SF${sf}/CR${cr}`,
  };
}

/**
 * Return the best available display string for a modem preset.
 *
 * For SF/BW/CR presets this returns either the named long name or the
 * re-ordered ``BW/SF/CR`` fallback.  For Meshtastic named presets and any
 * other non-SF/BW/CR strings the raw trimmed value is returned unchanged.
 *
 * @param {*} preset Raw preset value.
 * @param {number|null} [freqMHz] Frequency in MHz, used for frequency-gated lookups.
 * @returns {string|null} Display string or ``null`` when no preset is available.
 */
export function formatPresetDisplay(preset, freqMHz = null) {
  const resolved = resolveMeshcorePresetDisplay(preset, freqMHz);
  if (resolved !== null) return resolved.displayString;
  return toTrimmedString(preset) ?? null;
}

/**
 * Produce a combined modem preset and frequency description suitable for overlays.
 *
 * @param {*} preset Raw modem preset value.
 * @param {*} frequency Raw frequency value expressed in MHz.
 * @returns {string|null} Human-readable description or ``null`` when no data available.
 */
export function formatModemDisplay(preset, frequency) {
  const numericFreq = typeof frequency === 'number' ? frequency : Number(frequency);
  const presetText = formatPresetDisplay(preset, Number.isFinite(numericFreq) && numericFreq > 0 ? numericFreq : null);
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
  parseMeshcorePresetTokens,
  bwToShortCode,
};
