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
 * Pure data-merge helpers — fold position and telemetry packets into the
 * node collection without touching any closure or DOM state.
 *
 * @module main/data-merge
 */

import { resolveTimestampSeconds, toFiniteNumber } from './format-utils.js';

/**
 * Merge recent position packets into the node list.
 *
 * Mutates each node entry in place, updating coordinates / altitude /
 * position-time fields when the incoming packet carries a strictly newer
 * timestamp.
 *
 * @param {Array<Object>} nodes Node payloads.
 * @param {Array<Object>} positions Position entries.
 * @returns {void}
 */
export function mergePositionsIntoNodes(nodes, positions) {
  if (!Array.isArray(nodes) || !Array.isArray(positions) || nodes.length === 0) return;

  const nodesById = new Map();
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const key = typeof node.node_id === 'string' ? node.node_id : null;
    if (key) nodesById.set(key, node);
  }

  if (nodesById.size === 0) return;

  const updated = new Set();
  for (const pos of positions) {
    if (!pos || typeof pos !== 'object') continue;
    const nodeId = typeof pos.node_id === 'string' ? pos.node_id : null;
    if (!nodeId || updated.has(nodeId)) continue;
    const node = nodesById.get(nodeId);
    if (!node) continue;

    const lat = toFiniteNumber(pos.latitude);
    const lon = toFiniteNumber(pos.longitude);
    if (lat == null || lon == null) continue;

    const currentTimestamp = resolveTimestampSeconds(node.position_time, node.pos_time_iso);
    const incomingTimestamp = resolveTimestampSeconds(pos.position_time, pos.position_time_iso);
    if (currentTimestamp != null) {
      if (incomingTimestamp == null || incomingTimestamp <= currentTimestamp) {
        continue;
      }
    }

    updated.add(nodeId);
    node.latitude = lat;
    node.longitude = lon;

    const alt = toFiniteNumber(pos.altitude);
    if (alt != null) node.altitude = alt;

    const posTime = toFiniteNumber(pos.position_time);
    if (posTime != null) {
      node.position_time = posTime;
      node.pos_time_iso = typeof pos.position_time_iso === 'string' && pos.position_time_iso.length
        ? pos.position_time_iso
        : new Date(posTime * 1000).toISOString();
    } else if (typeof pos.position_time_iso === 'string' && pos.position_time_iso.length) {
      node.pos_time_iso = pos.position_time_iso;
    }

    if (pos.location_source != null && pos.location_source !== '') {
      node.location_source = pos.location_source;
    }

    const precision = toFiniteNumber(pos.precision_bits);
    if (precision != null) node.precision_bits = precision;
  }
}

/**
 * Build a lookup table of telemetry entries keyed by node identifier.
 *
 * @param {Array<Object>} entries Telemetry payloads.
 * @returns {{byNodeId: Map<string, {entry: Object, timestamp: number}>, byNodeNum: Map<number, {entry: Object, timestamp: number}>}}
 *   Indexed telemetry data.
 */
export function buildTelemetryIndex(entries) {
  const byNodeId = new Map();
  const byNodeNum = new Map();
  if (!Array.isArray(entries)) {
    return { byNodeId, byNodeNum };
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const nodeId = typeof entry.node_id === 'string' ? entry.node_id : (typeof entry.nodeId === 'string' ? entry.nodeId : null);
    const nodeNumRaw = entry.node_num ?? entry.nodeNum;
    const nodeNum = typeof nodeNumRaw === 'number' ? nodeNumRaw : Number(nodeNumRaw);
    const rxTime = toFiniteNumber(entry.rx_time ?? entry.rxTime);
    const telemetryTime = toFiniteNumber(entry.telemetry_time ?? entry.telemetryTime);
    const timestamp = rxTime != null ? rxTime : telemetryTime != null ? telemetryTime : Number.NEGATIVE_INFINITY;
    if (nodeId) {
      const existing = byNodeId.get(nodeId);
      if (!existing || timestamp > existing.timestamp) {
        byNodeId.set(nodeId, { entry, timestamp });
      }
    }
    if (Number.isFinite(nodeNum)) {
      const existing = byNodeNum.get(nodeNum);
      if (!existing || timestamp > existing.timestamp) {
        byNodeNum.set(nodeNum, { entry, timestamp });
      }
    }
  }
  return { byNodeId, byNodeNum };
}

/**
 * Merge telemetry metrics into the node list.
 *
 * Mutates each node entry in place, copying battery / voltage / channel
 * utilisation / environmental fields from the freshest telemetry packet that
 * matches by ``node_id`` or ``node_num``.
 *
 * @param {Array<Object>} nodes Node payloads.
 * @param {Array<Object>} telemetryEntries Telemetry data.
 * @returns {void}
 */
export function mergeTelemetryIntoNodes(nodes, telemetryEntries) {
  if (!Array.isArray(nodes) || !nodes.length) return;
  const { byNodeId, byNodeNum } = buildTelemetryIndex(telemetryEntries);
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const nodeId = typeof node.node_id === 'string' ? node.node_id : (typeof node.nodeId === 'string' ? node.nodeId : null);
    const nodeNumRaw = node.num ?? node.node_num ?? node.nodeNum;
    const nodeNum = typeof nodeNumRaw === 'number' ? nodeNumRaw : Number(nodeNumRaw);
    let telemetryEntry = null;
    if (nodeId && byNodeId.has(nodeId)) {
      telemetryEntry = byNodeId.get(nodeId).entry;
    } else if (Number.isFinite(nodeNum) && byNodeNum.has(nodeNum)) {
      telemetryEntry = byNodeNum.get(nodeNum).entry;
    }
    if (!telemetryEntry || typeof telemetryEntry !== 'object') continue;
    const metrics = {
      battery_level: toFiniteNumber(telemetryEntry.battery_level ?? telemetryEntry.batteryLevel),
      voltage: toFiniteNumber(telemetryEntry.voltage),
      uptime_seconds: toFiniteNumber(telemetryEntry.uptime_seconds ?? telemetryEntry.uptimeSeconds),
      channel_utilization: toFiniteNumber(telemetryEntry.channel_utilization ?? telemetryEntry.channelUtilization),
      air_util_tx: toFiniteNumber(telemetryEntry.air_util_tx ?? telemetryEntry.airUtilTx),
      temperature: toFiniteNumber(telemetryEntry.temperature),
      relative_humidity: toFiniteNumber(telemetryEntry.relative_humidity ?? telemetryEntry.relativeHumidity),
      barometric_pressure: toFiniteNumber(telemetryEntry.barometric_pressure ?? telemetryEntry.barometricPressure),
    };
    for (const [key, value] of Object.entries(metrics)) {
      if (value == null) continue;
      node[key] = value;
    }
    const telemetryTime = toFiniteNumber(telemetryEntry.telemetry_time ?? telemetryEntry.telemetryTime);
    if (telemetryTime != null) {
      node.telemetry_time = telemetryTime;
    }
    const rxTime = toFiniteNumber(telemetryEntry.rx_time ?? telemetryEntry.rxTime);
    if (rxTime != null) {
      node.telemetry_rx_time = rxTime;
    }
  }
}
