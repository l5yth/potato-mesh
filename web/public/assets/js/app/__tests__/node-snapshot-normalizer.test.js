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

import { normalizeNodeSnapshot, normalizeNodeCollection, __testUtils } from '../node-snapshot-normalizer.js';

const { normalizeNumber, normalizeString } = __testUtils;

test('normalizeNodeSnapshot synchronises telemetry aliases', () => {
  const node = {
    node_id: '!test',
    channel: '56.2',
    airUtil: 13.5,
    battery_level: 45.5,
    relativeHumidity: 24.3,
    lastHeard: '1234',
  };

  const normalised = normalizeNodeSnapshot(node);

  assert.equal(normalised.nodeId, '!test');
  assert.equal(normalised.channel_utilization, 56.2);
  assert.equal(normalised.channelUtilization, 56.2);
  assert.equal(normalised.channel, 56.2);
  assert.equal(normalised.air_util_tx, 13.5);
  assert.equal(normalised.airUtilTx, 13.5);
  assert.equal(normalised.airUtil, 13.5);
  assert.equal(normalised.battery, 45.5);
  assert.equal(normalised.batteryLevel, 45.5);
  assert.equal(normalised.relative_humidity, 24.3);
  assert.equal(normalised.humidity, 24.3);
  assert.equal(normalised.last_heard, 1234);
});

test('normalizeNodeCollection applies canonical forms to all nodes', () => {
  const nodes = [
    { short_name: '  AAA  ', voltage: '3.7' },
    { shortName: 'BBB', uptime_seconds: '3600', airUtilTx: '5.5' },
  ];

  normalizeNodeCollection(nodes);

  assert.equal(nodes[0].shortName, 'AAA');
  assert.equal(nodes[0].short_name, 'AAA');
  assert.equal(nodes[0].voltage, 3.7);
  assert.equal(nodes[1].uptime, 3600);
  assert.equal(nodes[1].air_util_tx, 5.5);
});

test('normalizeNodeSnapshot maps numeric roles to canonical identifiers', () => {
  const roleNode = { role: '12', node_id: '!role' };
  const numberRoleNode = { role: 12, nodeId: '!number-role' };

  normalizeNodeCollection([roleNode, numberRoleNode]);

  assert.equal(roleNode.role, 'CLIENT_BASE');
  assert.equal(numberRoleNode.role, 'CLIENT_BASE');
});

test('normaliser helpers coerce primitive values consistently', () => {
  assert.equal(normalizeNumber('42.1'), 42.1);
  assert.equal(normalizeNumber('not-a-number'), null);
  assert.equal(normalizeNumber(Infinity), null);

  assert.equal(normalizeString('  hello  '), 'hello');
  assert.equal(normalizeString(''), null);
  assert.equal(normalizeString(null), null);
});
