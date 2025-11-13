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

import test from 'node:test';
import assert from 'node:assert/strict';

import { refreshNodeInformation, __testUtils } from '../node-details.js';

const {
  toTrimmedString,
  toFiniteNumber,
  extractString,
  extractNumber,
  assignString,
  assignNumber,
  mergeModemMetadata,
  mergeNodeFields,
  mergeTelemetry,
  mergePosition,
  parseFallback,
  normalizeReference,
} = __testUtils;

function createResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

test('refreshNodeInformation merges telemetry metrics when the base node lacks them', async () => {
  const calls = [];
  const responses = new Map([
    ['/api/nodes/!test?limit=7', createResponse(200, {
      node_id: '!test',
      short_name: 'TST',
      battery_level: null,
      last_heard: 1_000,
      modem_preset: 'MediumFast',
      lora_freq: '868.1',
    })],
    ['/api/telemetry/!test?limit=7', createResponse(200, [{
      node_id: '!test',
      battery_level: 73.5,
      rx_time: 1_200,
      telemetry_time: 1_180,
      voltage: 4.1,
    }])],
    ['/api/positions/!test?limit=7', createResponse(200, [{
      node_id: '!test',
      latitude: 52.5,
      longitude: 13.4,
      rx_time: 1_100,
    }])],
    ['/api/neighbors/!test?limit=1000', createResponse(200, [{
      node_id: '!test',
      neighbor_id: '!peer',
      snr: 9.5,
      rx_time: 1_150,
    }])],
  ]);
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const response = responses.get(url);
    if (!response) {
      return createResponse(404, { error: 'not found' });
    }
    return response;
  };

  const fallback = { shortName: 'fallback', role: 'CLIENT' };
  const node = await refreshNodeInformation({ nodeId: '!test', fallback }, { fetchImpl });

  assert.equal(node.nodeId, '!test');
  assert.equal(node.shortName, 'TST');
  assert.equal(node.battery, 73.5);
  assert.equal(node.voltage, 4.1);
  assert.equal(node.role, 'CLIENT');
  assert.equal(node.modemPreset, 'MediumFast');
  assert.equal(node.loraFreq, 868.1);
  assert.equal(node.lastHeard, 1_200);
  assert.equal(node.telemetryTime, 1_180);
  assert.equal(node.latitude, 52.5);
  assert.equal(node.longitude, 13.4);
  assert.deepEqual(node.neighbors, [{
    node_id: '!test',
    neighbor_id: '!peer',
    snr: 9.5,
    rx_time: 1_150,
  }]);
  assert.ok(node.rawSources);
  assert.ok(node.rawSources.node);
  assert.ok(node.rawSources.telemetry);
  assert.ok(node.rawSources.position);

  assert.equal(calls.length, 4);
  calls.forEach(call => {
    assert.deepEqual(call.options, { cache: 'no-store' });
  });
});

test('refreshNodeInformation preserves fallback metrics when telemetry is unavailable', async () => {
  const responses = new Map([
    ['/api/nodes/42?limit=7', createResponse(200, {
      node_id: '!num',
      short_name: 'NUM',
    })],
    ['/api/telemetry/42?limit=7', createResponse(404, { error: 'not found' })],
    ['/api/positions/42?limit=7', createResponse(404, { error: 'not found' })],
    ['/api/neighbors/42?limit=1000', createResponse(404, { error: 'not found' })],
  ]);
  const fetchImpl = async (url, options) => {
    const response = responses.get(url);
    return response ?? createResponse(404, { error: 'not found' });
  };

  const fallback = { nodeNum: 42, battery: 12.5, role: 'CLIENT', modemPreset: 'FallbackPreset', loraFreq: 915 };
  const node = await refreshNodeInformation({ nodeNum: 42, fallback }, { fetchImpl });

  assert.equal(node.nodeId, '!num');
  assert.equal(node.nodeNum, 42);
  assert.equal(node.shortName, 'NUM');
  assert.equal(node.battery, 12.5);
  assert.equal(node.role, 'CLIENT');
  assert.equal(node.modemPreset, 'FallbackPreset');
  assert.equal(node.loraFreq, 915);
  assert.equal(Array.isArray(node.neighbors) && node.neighbors.length, 0);
});

test('refreshNodeInformation requires a node identifier', async () => {
  await assert.rejects(() => refreshNodeInformation(null), /node identifier/i);
});

test('refreshNodeInformation handles missing node records by falling back to telemetry data', async () => {
  const responses = new Map([
    ['/api/nodes/!missing?limit=7', createResponse(404, { error: 'not found' })],
    ['/api/telemetry/!missing?limit=7', createResponse(200, [{
      node_id: '!missing',
      node_num: 77,
      battery_level: 66,
      rx_time: 2_000,
      telemetry_time: 1_950,
    }])],
    ['/api/positions/!missing?limit=7', createResponse(200, [{
      node_id: '!missing',
      latitude: 1.23,
      longitude: 3.21,
      altitude: 42,
      position_time: 1_960,
      rx_time: 1_970,
    }])],
    ['/api/neighbors/!missing?limit=1000', createResponse(200, [null, 'skip', {
      node_id: '!missing',
      neighbor_id: '!ally',
      snr: 8.5,
    }])],
  ]);

  const fetchImpl = async url => responses.get(url) ?? createResponse(404, { error: 'not found' });

  const node = await refreshNodeInformation({ nodeId: '!missing' }, { fetchImpl });

  assert.equal(node.nodeId, '!missing');
  assert.equal(node.nodeNum, 77);
  assert.equal(node.battery, 66);
  assert.equal(node.lastHeard, 2_000);
  assert.equal(node.telemetryTime, 1_950);
  assert.equal(node.positionTime, 1_960);
  assert.equal(node.latitude, 1.23);
  assert.equal(node.longitude, 3.21);
  assert.equal(node.altitude, 42);
  assert.equal(node.role, 'CLIENT');
  assert.deepEqual(node.neighbors, [{
    node_id: '!missing',
    neighbor_id: '!ally',
    snr: 8.5,
  }]);
});

test('refreshNodeInformation enforces a fetch implementation', async () => {
  const originalFetch = globalThis.fetch;
  // eslint-disable-next-line no-global-assign
  globalThis.fetch = undefined;
  try {
    await assert.rejects(() => refreshNodeInformation('!test', { fetchImpl: null }), /fetch implementation/i);
  } finally {
    // eslint-disable-next-line no-global-assign
    globalThis.fetch = originalFetch;
  }
});

test('mergeModemMetadata respects preference flags', () => {
  const target = {};
  mergeModemMetadata(target, { modem_preset: 'Base', lora_freq: '915.5' });
  assert.equal(target.modemPreset, 'Base');
  assert.equal(target.loraFreq, 915.5);

  mergeModemMetadata(target, { modem_preset: 'New', lora_freq: '433' }, { preferExisting: true });
  assert.equal(target.modemPreset, 'Base');
  assert.equal(target.loraFreq, 915.5);

  mergeModemMetadata(target, { modem_preset: 'Updated', lora_freq: '433' }, { preferExisting: false });
  assert.equal(target.modemPreset, 'Updated');
  assert.equal(target.loraFreq, 433);
});

test('helper utilities normalise primitive values', () => {
  assert.equal(toTrimmedString('  hello  '), 'hello');
  assert.equal(toTrimmedString(''), null);
  assert.equal(toTrimmedString(null), null);

  assert.equal(toFiniteNumber('42.5'), 42.5);
  assert.equal(toFiniteNumber('bad'), null);
  assert.equal(toFiniteNumber(Infinity), null);

  assert.equal(extractString({ name: '  Alice ' }, ['missing', 'name']), 'Alice');
  assert.equal(extractString(null, ['name']), null);

  assert.equal(extractNumber({ value: '  13 ' }, ['missing', 'value']), 13);
  assert.equal(extractNumber({}, ['value']), null);
});

test('assign helpers respect preferExisting semantics', () => {
  const target = {};
  assignString(target, 'name', '  primary  ');
  assignString(target, 'name', 'secondary', { preferExisting: true });
  assignString(target, 'description', '');
  assignNumber(target, 'count', '25');
  assignNumber(target, 'count', 13, { preferExisting: true });
  assignNumber(target, 'ignored', 'oops');

  assert.deepEqual(target, { name: 'primary', count: 25 });
});

test('merge helpers combine node, telemetry, and position data', () => {
  const node = {};
  mergeNodeFields(node, {
    node_id: '!node',
    node_num: 55,
    short_name: 'NODE',
    battery_level: null,
    last_heard: 1_000,
    position_time: 900,
  });

  node.battery = 50;

  mergeTelemetry(node, {
    node_id: '!node',
    battery_level: 75,
    voltage: 3.8,
    rx_time: 1_200,
    rx_iso: '2025-01-01T00:00:00Z',
    telemetry_time: 1_150,
  });

  mergePosition(node, {
    node_id: '!node',
    latitude: 52.5,
    longitude: 13.4,
    altitude: 80,
    position_time: 1_180,
    position_time_iso: '2025-01-01T00:19:40Z',
    rx_time: 1_100,
    rx_iso: '2025-01-01T00:18:20Z',
  });

  assert.equal(node.nodeId, '!node');
  assert.equal(node.nodeNum, 55);
  assert.equal(node.shortName, 'NODE');
  assert.equal(node.battery, 50);
  assert.equal(node.voltage, 3.8);
  assert.equal(node.lastHeard, 1_200);
  assert.equal(node.lastSeenIso, '2025-01-01T00:00:00Z');
  assert.equal(node.telemetryTime, 1_150);
  assert.equal(node.positionTime, 1_180);
  assert.equal(node.positionTimeIso, '2025-01-01T00:19:40Z');
  assert.equal(node.latitude, 52.5);
  assert.equal(node.longitude, 13.4);
  assert.equal(node.altitude, 80);
  assert.ok(node.telemetry);
  assert.ok(node.position);
});

test('normalizeReference extracts identifiers and tolerates malformed fallback payloads', () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);

  try {
    const parsed = normalizeReference({
      nodeId: '  ',
      fallback: '{"node_id":"!parsed","nodeNum":99}',
    });
    assert.equal(parsed.nodeId, '!parsed');
    assert.equal(parsed.nodeNum, 99);
    assert.ok(parsed.fallback);

    const invalid = normalizeReference({ fallback: '{not json}' });
    assert.equal(invalid.nodeId, null);
    assert.equal(invalid.nodeNum, null);
    assert.equal(invalid.fallback, null);

    const strRef = normalizeReference('!direct');
    assert.equal(strRef.nodeId, '!direct');
    assert.equal(strRef.nodeNum, null);

    const numRef = normalizeReference(57);
    assert.equal(numRef.nodeId, null);
    assert.equal(numRef.nodeNum, 57);

    const emptyRef = normalizeReference(undefined);
    assert.equal(emptyRef.nodeId, null);
    assert.equal(emptyRef.nodeNum, null);
    assert.equal(emptyRef.fallback, null);
  } finally {
    console.warn = originalWarn;
  }

  assert.ok(warnings.length >= 1);
});

test('parseFallback duplicates object references and rejects primitives', () => {
  const fallbackObject = { nodeId: '!object' };
  const parsedObject = parseFallback(fallbackObject);
  assert.notEqual(parsedObject, fallbackObject);
  assert.deepEqual(parsedObject, fallbackObject);

  const parsedString = parseFallback('{"nodeId":"!string"}');
  assert.ok(parsedString);
  assert.equal(parsedString.nodeId, '!string');
  assert.equal(parseFallback('not json'), null);
  assert.equal(parseFallback(42), null);
});
