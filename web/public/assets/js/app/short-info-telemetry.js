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
 * Determine whether ``value`` can be treated as a finite number.
 *
 * @param {*} value Candidate numeric value.
 * @returns {boolean} ``true`` when the value parses to a finite number.
 */
function isFiniteNumber(value) {
  if (value == null || value === '') return false;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number);
}

/**
 * Retrieve the first defined property from ``container`` using ``keys``.
 *
 * @param {Object} container Object inspected for values.
 * @param {Array<string>} keys Candidate property names.
 * @returns {*} First non-nullish value discovered.
 */
function pickFirstValue(container, keys) {
  if (!container || typeof container !== 'object') {
    return undefined;
  }
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(container, key)) {
      const candidate = container[key];
      if (candidate != null && (candidate !== '' || candidate === 0)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * Format arbitrary telemetry values using a numeric suffix.
 *
 * @param {*} value Raw value to format.
 * @param {string} suffix Unit suffix appended when formatting succeeds.
 * @returns {string} Formatted value or an empty string for invalid input.
 */
export function fmtAlt(value, suffix) {
  if (!isFiniteNumber(value) && !(value === 0 || value === '0')) {
    return '';
  }
  return `${Number(value)}${suffix}`;
}

/**
 * Format utilisation metrics as percentages.
 *
 * @param {*} value Raw utilisation value.
 * @param {number} [decimals=3] Decimal precision applied to the percentage.
 * @returns {string} Formatted percentage string.
 */
export function fmtTx(value, decimals = 3) {
  if (!isFiniteNumber(value)) return '';
  const num = Number(value);
  return `${num.toFixed(decimals)}%`;
}

/**
 * Format temperature telemetry in degrees Celsius.
 *
 * @param {*} value Raw temperature reading.
 * @returns {string} Formatted temperature string.
 */
export function fmtTemperature(value) {
  if (!isFiniteNumber(value)) return '';
  const num = Number(value);
  return `${num.toFixed(1)}°C`;
}

/**
 * Format relative humidity telemetry as a percentage.
 *
 * @param {*} value Raw humidity reading.
 * @returns {string} Formatted humidity string.
 */
export function fmtHumidity(value) {
  if (!isFiniteNumber(value)) return '';
  const num = Number(value);
  return `${num.toFixed(1)}%`;
}

/**
 * Format barometric pressure telemetry in hectopascals.
 *
 * @param {*} value Raw pressure value.
 * @returns {string} Formatted pressure string.
 */
export function fmtPressure(value) {
  if (!isFiniteNumber(value)) return '';
  const num = Number(value);
  return `${num.toFixed(1)} hPa`;
}

/**
 * Format current telemetry, automatically scaling to milliamperes when
 * appropriate.
 *
 * @param {*} value Raw current reading expressed in amperes.
 * @returns {string} Formatted current string.
 */
export function fmtCurrent(value) {
  if (!isFiniteNumber(value)) return '';
  const num = Number(value);
  if (Math.abs(num) < 1) {
    return `${(num * 1000).toFixed(1)} mA`;
  }
  return `${num.toFixed(2)} A`;
}

/**
 * Format gas resistance telemetry using a human readable Ohm prefix.
 *
 * @param {*} value Raw resistance value expressed in Ohms.
 * @returns {string} Formatted resistance string.
 */
export function fmtGasResistance(value) {
  if (!isFiniteNumber(value)) return '';
  const num = Number(value);
  const absVal = Math.abs(num);
  if (absVal >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(2)} MΩ`;
  }
  if (absVal >= 1_000) {
    return `${(num / 1_000).toFixed(2)} kΩ`;
  }
  return `${num.toFixed(2)} Ω`;
}

/**
 * Format generic distance telemetry in metres.
 *
 * @param {*} value Raw distance value.
 * @returns {string} Formatted distance string.
 */
export function fmtDistance(value) {
  if (!isFiniteNumber(value)) return '';
  const num = Number(value);
  return `${num.toFixed(2)} m`;
}

/**
 * Format optical telemetry in lux.
 *
 * @param {*} value Raw lux reading.
 * @returns {string} Formatted lux string.
 */
export function fmtLux(value) {
  if (!isFiniteNumber(value)) return '';
  const num = Number(value);
  return `${num.toFixed(1)} lx`;
}

/**
 * Format wind direction telemetry in degrees.
 *
 * @param {*} value Raw wind direction reading.
 * @returns {string} Formatted wind direction string.
 */
export function fmtWindDirection(value) {
  if (!isFiniteNumber(value)) return '';
  const num = Number(value);
  return `${Math.round(num)}°`;
}

/**
 * Format wind speed telemetry in metres per second.
 *
 * @param {*} value Raw wind speed reading.
 * @returns {string} Formatted wind speed string.
 */
export function fmtWindSpeed(value) {
  if (!isFiniteNumber(value)) return '';
  const num = Number(value);
  return `${num.toFixed(1)} m/s`;
}

/**
 * Format weight telemetry in kilograms.
 *
 * @param {*} value Raw weight value.
 * @returns {string} Formatted weight string.
 */
export function fmtWeight(value) {
  if (!isFiniteNumber(value)) return '';
  const num = Number(value);
  return `${num.toFixed(2)} kg`;
}

/**
 * Format radiation telemetry using microsieverts per hour.
 *
 * @param {*} value Raw radiation value.
 * @returns {string} Formatted radiation string.
 */
export function fmtRadiation(value) {
  if (!isFiniteNumber(value)) return '';
  const num = Number(value);
  return `${num.toFixed(2)} µSv/h`;
}

/**
 * Format rainfall telemetry using millimetres.
 *
 * @param {*} value Raw rainfall accumulation value.
 * @returns {string} Formatted rainfall string.
 */
export function fmtRainfall(value) {
  if (!isFiniteNumber(value)) return '';
  const num = Number(value);
  return `${num.toFixed(2)} mm`;
}

/**
 * Format soil moisture telemetry. The metrics are typically raw sensor values
 * without defined units, therefore the raw integer is surfaced unchanged.
 *
 * @param {*} value Raw soil moisture reading.
 * @returns {string} Soil moisture string.
 */
export function fmtSoilMoisture(value) {
  if (!isFiniteNumber(value)) return '';
  const num = Number(value);
  return `${Math.round(num)}`;
}

/**
 * Format soil temperature telemetry in degrees Celsius.
 *
 * @param {*} value Raw soil temperature reading.
 * @returns {string} Formatted soil temperature string.
 */
export function fmtSoilTemperature(value) {
  return fmtTemperature(value);
}

/**
 * Format indoor air quality index values.
 *
 * @param {*} value Raw IAQ reading.
 * @returns {string} IAQ string.
 */
export function fmtIaq(value) {
  if (!isFiniteNumber(value)) return '';
  const num = Number(value);
  return `${Math.round(num)}`;
}

/**
 * Telemetry descriptors consumed by the short-info overlay.
 *
 * Each descriptor includes a canonical key, display label, candidate source
 * property names, and a formatter that converts numeric values into a human
 * readable string.
 */
export const TELEMETRY_FIELDS = [
  { key: 'battery', label: 'Battery', sources: ['battery', 'battery_level', 'batteryLevel'], formatter: value => fmtAlt(value, '%') },
  { key: 'voltage', label: 'Voltage', sources: ['voltage'], formatter: value => fmtAlt(value, 'V') },
  { key: 'current', label: 'Current', sources: ['current'], formatter: fmtCurrent },
  { key: 'uptime', label: 'Uptime', sources: ['uptime', 'uptime_seconds', 'uptimeSeconds'], formatter: (value, utils) => (typeof utils.formatUptime === 'function' ? utils.formatUptime(value) : '') },
  {
    key: 'channel',
    label: 'Channel Util',
    sources: ['channel_utilization', 'channelUtilization'],
    formatter: value => fmtTx(value),
  },
  {
    key: 'airUtil',
    label: 'Air Util Tx',
    sources: ['air_util_tx', 'airUtilTx', 'airUtil'],
    formatter: value => fmtTx(value),
  },
  { key: 'temperature', label: 'Temperature', sources: ['temperature', 'temp'], formatter: fmtTemperature },
  { key: 'humidity', label: 'Humidity', sources: ['humidity', 'relative_humidity', 'relativeHumidity'], formatter: fmtHumidity },
  { key: 'pressure', label: 'Pressure', sources: ['pressure', 'barometric_pressure', 'barometricPressure'], formatter: fmtPressure },
  { key: 'gasResistance', label: 'Gas Resistance', sources: ['gas_resistance', 'gasResistance'], formatter: fmtGasResistance },
  { key: 'iaq', label: 'IAQ', sources: ['iaq'], formatter: fmtIaq },
  { key: 'distance', label: 'Distance', sources: ['distance'], formatter: fmtDistance },
  { key: 'lux', label: 'Lux', sources: ['lux'], formatter: fmtLux },
  { key: 'whiteLux', label: 'White Lux', sources: ['white_lux', 'whiteLux'], formatter: fmtLux },
  { key: 'irLux', label: 'IR Lux', sources: ['ir_lux', 'irLux'], formatter: fmtLux },
  { key: 'uvLux', label: 'UV Lux', sources: ['uv_lux', 'uvLux'], formatter: fmtLux },
  { key: 'windDirection', label: 'Wind Direction', sources: ['wind_direction', 'windDirection'], formatter: fmtWindDirection },
  { key: 'windSpeed', label: 'Wind Speed', sources: ['wind_speed', 'windSpeed', 'windSpeedMps'], formatter: fmtWindSpeed },
  { key: 'windGust', label: 'Wind Gust', sources: ['wind_gust', 'windGust'], formatter: fmtWindSpeed },
  { key: 'windLull', label: 'Wind Lull', sources: ['wind_lull', 'windLull'], formatter: fmtWindSpeed },
  { key: 'weight', label: 'Weight', sources: ['weight'], formatter: fmtWeight },
  { key: 'radiation', label: 'Radiation', sources: ['radiation', 'radiationLevel'], formatter: fmtRadiation },
  { key: 'rainfall1h', label: 'Rainfall 1h', sources: ['rainfall_1h', 'rainfall1h', 'rainfall1H'], formatter: fmtRainfall },
  { key: 'rainfall24h', label: 'Rainfall 24h', sources: ['rainfall_24h', 'rainfall24h', 'rainfall24H'], formatter: fmtRainfall },
  { key: 'soilMoisture', label: 'Soil Moisture', sources: ['soil_moisture', 'soilMoisture'], formatter: fmtSoilMoisture },
  { key: 'soilTemperature', label: 'Soil Temperature', sources: ['soil_temperature', 'soilTemperature'], formatter: fmtSoilTemperature },
];

/**
 * Collect telemetry metrics from arbitrary node payloads.
 *
 * The function inspects common top-level, device metric, and environment
 * metric collections in order to surface numeric telemetry values.
 *
 * @param {*} source Node payload that may contain telemetry.
 * @returns {Object} Object containing numeric telemetry keyed by descriptor.
 */
export function collectTelemetryMetrics(source) {
  const metrics = {};
  if (!source || typeof source !== 'object') {
    return metrics;
  }

  const potentialContainers = [
    source.telemetry,
    source.device_metrics,
    source.deviceMetrics,
    source.environment_metrics,
    source.environmentMetrics,
    source.raw && typeof source.raw === 'object' ? source.raw.device_metrics : null,
    source.raw && typeof source.raw === 'object' ? source.raw.deviceMetrics : null,
    source,
  ];

  const containers = [];
  for (const container of potentialContainers) {
    if (!container || typeof container !== 'object') {
      continue;
    }
    if (!containers.includes(container)) {
      containers.push(container);
    }
  }

  for (const field of TELEMETRY_FIELDS) {
    const keys = Array.isArray(field.sources) && field.sources.length > 0
      ? field.sources
      : [field.key];
    for (const container of containers) {
      const raw = pickFirstValue(container, keys);
      if (!isFiniteNumber(raw) && !(raw === 0 || raw === '0')) {
        continue;
      }
      const num = Number(raw);
      if (Number.isFinite(num)) {
        metrics[field.key] = num;
        break;
      }
    }
  }
  return metrics;
}

/**
 * Build display entries for telemetry values suitable for short-info overlays.
 *
 * @param {Object} telemetry Telemetry metrics keyed by descriptor ``key``.
 * @param {{formatUptime?: Function}} [utils] Optional formatter overrides.
 * @returns {Array<{label: string, value: string}>} Renderable telemetry entries.
 */
export function buildTelemetryDisplayEntries(telemetry, utils = {}) {
  const entries = [];
  if (!telemetry || typeof telemetry !== 'object') {
    return entries;
  }
  for (const field of TELEMETRY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(telemetry, field.key)) {
      continue;
    }
    const value = telemetry[field.key];
    if (value == null) {
      continue;
    }
    const formatted = typeof field.formatter === 'function'
      ? field.formatter(value, utils)
      : String(value);
    if (formatted == null || formatted === '') {
      continue;
    }
    entries.push({ label: field.label, value: formatted });
  }
  return entries;
}

export default {
  TELEMETRY_FIELDS,
  collectTelemetryMetrics,
  buildTelemetryDisplayEntries,
  fmtAlt,
  fmtTx,
  fmtTemperature,
  fmtHumidity,
  fmtPressure,
  fmtCurrent,
  fmtGasResistance,
  fmtDistance,
  fmtLux,
  fmtWindDirection,
  fmtWindSpeed,
  fmtWeight,
  fmtRadiation,
  fmtRainfall,
  fmtSoilMoisture,
  fmtSoilTemperature,
  fmtIaq,
};
