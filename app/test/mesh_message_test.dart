// Copyright © 2025-26 l5yth & contributors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import 'package:flutter_test/flutter_test.dart';
import 'package:potato_mesh_reader/main.dart';

/// Unit tests for [MeshMessage] parsing and the sorting helper.
void main() {
  group('MeshMessage.fromJson', () {
    test('parses fields and strips leading bang from sender', () {
      final msg = MeshMessage.fromJson({
        'id': '7',
        'rx_iso': '2024-01-02T03:04:00Z',
        'from_id': '!NICK',
        'to_id': '^',
        'channel': '1',
        'channel_name': 'BerlinMesh',
        'portnum': 'TEXT',
        'text': 'Hello world',
        'rssi': '-90',
        'snr': '5.25',
        'hop_limit': '3',
      });

      expect(msg.id, 7);
      expect(msg.rxIso, '2024-01-02T03:04:00Z');
      expect(msg.rxTime!.toUtc().hour, 3);
      expect(msg.fromShort, 'NICK');
      expect(msg.channelName, 'BerlinMesh');
      expect(msg.text, 'Hello world');
      expect(msg.rssi, -90);
      expect(msg.snr, closeTo(5.25, 0.0001));
      expect(msg.hopLimit, 3);
    });
  });

  group('sortMessagesByRxTime', () {
    test('orders messages oldest to newest even with null timestamps', () {
      final older = MeshMessage(
        id: 1,
        rxTime: DateTime.utc(2023, 12, 31, 23, 59),
        rxIso: '2023-12-31T23:59:00Z',
        fromId: 'A',
        toId: 'B',
        channel: 1,
        channelName: 'Main',
        portnum: 'TEXT',
        text: 'Old',
        rssi: -50,
        snr: 1.0,
        hopLimit: 1,
      );
      final unknownTime = MeshMessage(
        id: 2,
        rxTime: null,
        rxIso: '',
        fromId: 'B',
        toId: 'A',
        channel: 1,
        channelName: 'Main',
        portnum: 'TEXT',
        text: 'Unknown',
        rssi: -55,
        snr: 1.5,
        hopLimit: 1,
      );
      final newer = MeshMessage(
        id: 3,
        rxTime: DateTime.utc(2024, 01, 01, 0, 10),
        rxIso: '2024-01-01T00:10:00Z',
        fromId: 'C',
        toId: 'D',
        channel: 1,
        channelName: 'Main',
        portnum: 'TEXT',
        text: 'New',
        rssi: -60,
        snr: 2.0,
        hopLimit: 1,
      );

      final sorted = sortMessagesByRxTime([newer, unknownTime, older]);

      expect(sorted.first.id, older.id);
      expect(sorted.last.id, newer.id);
      expect(sorted[1].id, unknownTime.id);
    });
  });
}
