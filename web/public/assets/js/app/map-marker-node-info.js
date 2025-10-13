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
 * Determine whether the provided value behaves like a plain object.
 *
 * @param {*} value Candidate value.
 * @returns {boolean} True when ``value`` is a non-null object.
 */
function isObject(value) {
  return value != null && typeof value === 'object';
}

/**
 * Convert a value to a trimmed string when possible.
 *
 * @param {*} value Input value.
 * @returns {string|null} Trimmed string or ``null`` when blank.
 */
function toTrimmedString(value) {
  if (value == null) return null;
  const str = String(value).trim();
  return str.length === 0 ? null : str;
}

/**
 * Attempt to coerce the provided value into a finite number.
 *
 * @param {*} value Raw value.
 * @returns {number|null} Finite number or ``null`` when coercion fails.
 */
function toFiniteNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Normalise a neighbour entry so that downstream consumers can display it.
 *
 * @param {*} entry Raw neighbour entry.
 * @returns {Object|null} Normalised neighbour reference or ``null`` when invalid.
 */
function normaliseNeighbor(entry) {
  if (!isObject(entry)) return null;
  const neighborId = toTrimmedString(entry.neighbor_id ?? entry.neighborId ?? entry.nodeId ?? entry.node_id);
  if (!neighborId) return null;
  const neighborShort = toTrimmedString(entry.neighbor_short_name ?? entry.neighborShortName ?? entry.short_name ?? entry.shortName);
  const neighborLong = toTrimmedString(entry.neighbor_long_name ?? entry.neighborLongName ?? entry.long_name ?? entry.longName);
  const neighborRole = toTrimmedString(entry.neighbor_role ?? entry.neighborRole ?? entry.role) || 'CLIENT';
  const node = {
    node_id: neighborId,
    short_name: neighborShort ?? '',
    long_name: neighborLong ?? '',
    role: neighborRole,
  };
  const snr = toFiniteNumber(entry.snr);
  const rxTime = toFiniteNumber(entry.rx_time ?? entry.rxTime);
  const result = { node };
  if (snr != null) {
    result.snr = snr;
  }
  if (rxTime != null) {
    result.rxTime = rxTime;
    result.rx_time = rxTime;
  }
  return result;
}

/**
 * Convert overlay node details into a map friendly payload.
 *
 * @param {*} source Raw overlay details.
 * @returns {Object} Map node payload containing snake_case keys.
 */
export function overlayToPopupNode(source) {
  if (!isObject(source)) {
    return {
      node_id: '',
      node_num: null,
      short_name: '',
      long_name: '',
      role: 'CLIENT',
      neighbors: [],
    };
  }

  const nodeId = toTrimmedString(source.nodeId ?? source.node_id ?? source.id) ?? '';
  const nodeNum = toFiniteNumber(source.nodeNum ?? source.node_num ?? source.num);
  const role = toTrimmedString(source.role) || 'CLIENT';
  const neighbours = Array.isArray(source.neighbors)
    ? source.neighbors.map(normaliseNeighbor).filter(Boolean)
    : [];

  const payload = {
    node_id: nodeId,
    node_num: nodeNum,
    short_name: toTrimmedString(source.shortName ?? source.short_name ?? source.name) ?? '',
    long_name: toTrimmedString(source.longName ?? source.long_name ?? source.fullName ?? '') ?? '',
    role,
    hw_model: toTrimmedString(source.hwModel ?? source.hw_model ?? source.hardware) ?? '',
    battery_level: toFiniteNumber(source.battery ?? source.battery_level),
    voltage: toFiniteNumber(source.voltage),
    uptime_seconds: toFiniteNumber(source.uptime ?? source.uptime_seconds),
    channel_utilization: toFiniteNumber(source.channel ?? source.channel_utilization),
    air_util_tx: toFiniteNumber(source.airUtil ?? source.air_util_tx),
    temperature: toFiniteNumber(source.temperature),
    relative_humidity: toFiniteNumber(source.humidity ?? source.relative_humidity),
    barometric_pressure: toFiniteNumber(source.pressure ?? source.barometric_pressure),
    telemetry_time: toFiniteNumber(source.telemetryTime ?? source.telemetry_time),
    last_heard: toFiniteNumber(source.lastHeard ?? source.last_heard),
    position_time: toFiniteNumber(source.positionTime ?? source.position_time),
    latitude: toFiniteNumber(source.latitude),
    longitude: toFiniteNumber(source.longitude),
    altitude: toFiniteNumber(source.altitude),
    neighbors: neighbours,
  };

  if (!payload.long_name && payload.short_name) {
    payload.long_name = payload.short_name;
  }

  return payload;
}

/**
 * Attach an asynchronous refresh handler to a Leaflet marker so that
 * up-to-date node information is fetched whenever the marker is clicked.
 *
 * @param {Object} options Behaviour configuration.
 * @param {Object} options.marker Leaflet marker instance supporting ``on``.
 * @param {Function} options.getOverlayFallback Returns the fallback overlay payload.
 * @param {Function} options.refreshNodeInformation Async function fetching node details.
 * @param {Function} options.mergeOverlayDetails Merge function combining fetched and fallback details.
 * @param {Function} options.createRequestToken Generates a token for cancellation tracking.
 * @param {Function} options.isTokenCurrent Tests whether a request token is still current.
 * @param {Function} [options.showLoading] Callback invoked before refreshing.
 * @param {Function} [options.showDetails] Callback invoked with merged overlay details.
 * @param {Function} [options.showError] Callback invoked when refreshing fails.
 * @param {Function} [options.updatePopup] Callback updating the marker popup contents.
 * @param {Function} [options.shouldHandleClick] Predicate that decides whether the click should trigger a refresh.
 * @returns {void}
 */
export function attachNodeInfoRefreshToMarker({
  marker,
  getOverlayFallback,
  refreshNodeInformation,
  mergeOverlayDetails,
  createRequestToken,
  isTokenCurrent,
  showLoading,
  showDetails,
  showError,
  updatePopup,
  shouldHandleClick,
}) {
  if (!isObject(marker) || typeof marker.on !== 'function') {
    throw new TypeError('A Leaflet marker with an on() method is required');
  }
  if (typeof refreshNodeInformation !== 'function') {
    throw new TypeError('A refreshNodeInformation function must be provided');
  }
  if (typeof mergeOverlayDetails !== 'function') {
    throw new TypeError('A mergeOverlayDetails function must be provided');
  }
  if (typeof createRequestToken !== 'function' || typeof isTokenCurrent !== 'function') {
    throw new TypeError('Token management callbacks must be provided');
  }

  marker.on('click', event => {
    if (event && event.originalEvent) {
      const original = event.originalEvent;
      if (typeof original.preventDefault === 'function') {
        original.preventDefault();
      }
      if (typeof original.stopPropagation === 'function') {
        original.stopPropagation();
      }
    }

    const fallbackOverlay = typeof getOverlayFallback === 'function' ? getOverlayFallback() : null;
    const anchor = typeof marker.getElement === 'function' ? marker.getElement() : null;

    if (!isObject(fallbackOverlay)) {
      if (anchor && typeof showDetails === 'function') {
        showDetails(anchor, {});
      }
      return;
    }

    if (typeof shouldHandleClick === 'function' && !shouldHandleClick(anchor, fallbackOverlay)) {
      return;
    }

    if (typeof updatePopup === 'function') {
      updatePopup(fallbackOverlay);
    }

    const nodeId = toTrimmedString(fallbackOverlay.nodeId ?? fallbackOverlay.node_id ?? fallbackOverlay.id);
    const nodeNum = toFiniteNumber(fallbackOverlay.nodeNum ?? fallbackOverlay.node_num ?? fallbackOverlay.num);

    if (!nodeId && nodeNum == null) {
      if (anchor && typeof showDetails === 'function') {
        showDetails(anchor, fallbackOverlay);
      }
      return;
    }

    const requestToken = createRequestToken();

    if (anchor && typeof showLoading === 'function') {
      showLoading(anchor, fallbackOverlay);
    }

    const reference = { fallback: fallbackOverlay };
    if (nodeId) reference.nodeId = nodeId;
    if (nodeNum != null) reference.nodeNum = nodeNum;

    let refreshPromise;
    try {
      refreshPromise = Promise.resolve(refreshNodeInformation(reference));
    } catch (error) {
      if (isTokenCurrent(requestToken)) {
        if (anchor && typeof showError === 'function') {
          showError(anchor, fallbackOverlay, error);
        }
      }
      return;
    }

    refreshPromise
      .then(details => {
        if (!isTokenCurrent(requestToken)) {
          return;
        }
        const merged = mergeOverlayDetails(details, fallbackOverlay);
        if (typeof updatePopup === 'function') {
          updatePopup(merged);
        }
        if (anchor && typeof showDetails === 'function') {
          showDetails(anchor, merged);
        }
      })
      .catch(error => {
        if (!isTokenCurrent(requestToken)) {
          return;
        }
        if (typeof updatePopup === 'function') {
          updatePopup(fallbackOverlay);
        }
        if (anchor && typeof showError === 'function') {
          showError(anchor, fallbackOverlay, error);
        }
      });
  });
}

export const __testUtils = {
  isObject,
  toTrimmedString,
  toFiniteNumber,
  normaliseNeighbor,
};
