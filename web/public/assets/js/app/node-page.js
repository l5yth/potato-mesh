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
 * Node detail page entry point.
 *
 * Acts as a thin barrel re-exporting the public surface assembled in the
 * focused submodules under ``./node-page/`` so existing consumers
 * (``views/node_detail.erb``, ``node-detail-overlay.js``, ``charts-page.js``,
 * and the unit-test suite) keep working unchanged.
 *
 * @module node-page
 */

import { escapeHtml } from './utils.js';
import { numberOrNull, stringOrNull } from './value-helpers.js';
import { fetchMessages, fetchTracesForNode } from './node-page-data.js';
import {
  classifySnapshot,
  formatBattery,
  formatCoordinate,
  formatDurationSeconds,
  formatFrequency,
  formatHardwareModel,
  formatMessageTimestamp,
  formatRelativeSeconds,
  formatSnr,
  formatTimestamp,
  formatUptime,
  formatVoltage,
  padTwo,
} from './node-page-charts.js';
import {
  buildNeighborRoleIndex,
  cloneRoleIndex,
  fetchNodeDetailsIntoIndex,
  lookupNeighborDetails,
  lookupRole,
  normalizeNodeId,
  registerRoleCandidate,
  seedNeighborRoleIndex,
} from './node-page/role-index.js';
import {
  categoriseNeighbors,
  renderNeighborBadge,
  renderNeighborGroup,
  renderNeighborGroups,
} from './node-page/neighbor-rendering.js';
import { renderRoleAwareBadge } from './node-page/badge.js';
import { renderSingleNodeTable } from './node-page/single-node-table.js';
import { renderTelemetryCharts } from './node-page/telemetry-charts.js';
import { renderMessages } from './node-page/messages.js';
import {
  buildTraceRoleIndex,
  collectTraceNodeFetchMap,
  extractTracePath,
  normalizeTraceNodeRef,
  renderTracePath,
  renderTraceroutes,
} from './node-page/traces.js';
import { renderNodeDetailHtml } from './node-page/detail-html.js';
import {
  fetchNodeDetailHtml,
  initializeNodeDetailPage,
  normalizeNodeReference,
  parseReferencePayload,
  resolveRenderShortHtml,
} from './node-page/bootstrap.js';

export {
  fetchNodeDetailHtml,
  initializeNodeDetailPage,
  renderTelemetryCharts,
};

/**
 * Test surface used by ``__tests__/node-page.test.js``.  Built explicitly so
 * adding or removing a public helper triggers the test that asserts on this
 * map's shape.
 */
export const __testUtils = {
  stringOrNull,
  numberOrNull,
  escapeHtml,
  formatFrequency,
  formatBattery,
  formatVoltage,
  formatUptime,
  formatTimestamp,
  formatMessageTimestamp,
  formatHardwareModel,
  formatCoordinate,
  formatRelativeSeconds,
  formatDurationSeconds,
  formatSnr,
  padTwo,
  normalizeNodeId,
  cloneRoleIndex,
  registerRoleCandidate,
  lookupRole,
  lookupNeighborDetails,
  seedNeighborRoleIndex,
  buildNeighborRoleIndex,
  fetchNodeDetailsIntoIndex,
  collectTraceNodeFetchMap,
  buildTraceRoleIndex,
  categoriseNeighbors,
  renderNeighborBadge,
  renderNeighborGroup,
  renderNeighborGroups,
  renderRoleAwareBadge,
  renderSingleNodeTable,
  classifySnapshot,
  renderTelemetryCharts,
  renderMessages,
  renderTraceroutes,
  renderTracePath,
  extractTracePath,
  normalizeTraceNodeRef,
  renderNodeDetailHtml,
  parseReferencePayload,
  resolveRenderShortHtml,
  fetchMessages,
  fetchTracesForNode,
  fetchNodeDetailHtml,
  normalizeNodeReference,
};
