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
import 'package:shared_preferences/shared_preferences.dart';

MeshMessage _buildMessage({
  required int id,
  required int minute,
  String text = 'msg',
}) {
  final rxTime = DateTime.utc(2024, 1, 1, 12, minute);
  return MeshMessage(
    id: id,
    rxTime: rxTime,
    rxIso: rxTime.toIso8601String(),
    fromId: '!sender$id',
    nodeId: '!sender$id',
    toId: '^',
    channel: 1,
    channelName: 'Main',
    portnum: 'TEXT',
    text: text,
    rssi: -40,
    snr: 1.2,
    hopLimit: 1,
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('marks latest message seen when no prior marker exists', () async {
    final prefs = await SharedPreferences.getInstance();
    final store = MeshLocalStore(prefs);
    final tracker = MessageSeenTracker(store);
    final messages = [
      _buildMessage(id: 1, minute: 1),
      _buildMessage(id: 2, minute: 2),
    ];

    final unseen =
        await tracker.unseenSince(domain: 'potatomesh.net', messages: messages);

    expect(unseen, isEmpty);
    expect(
      store.loadLastSeenMessageKey('potatomesh.net'),
      MessageSeenTracker.messageKey(messages.last),
    );
  });

  test('returns messages that arrive after last seen marker', () async {
    final prefs = await SharedPreferences.getInstance();
    final store = MeshLocalStore(prefs);
    final tracker = MessageSeenTracker(store);
    final first = _buildMessage(id: 1, minute: 1, text: 'old');
    final second = _buildMessage(id: 2, minute: 2, text: 'new');
    final third = _buildMessage(id: 3, minute: 3, text: 'newer');

    await store.saveLastSeenMessageKey(
      'potatomesh.net',
      MessageSeenTracker.messageKey(first),
    );

    final unseen = await tracker.unseenSince(
      domain: 'potatomesh.net',
      messages: [first, second, third],
    );

    expect(unseen.length, 2);
    expect(unseen.first.text, 'new');
    expect(unseen.last.text, 'newer');
    expect(
      store.loadLastSeenMessageKey('potatomesh.net'),
      MessageSeenTracker.messageKey(third),
    );
  });

  test('ignores notifications if last seen marker is missing from payload',
      () async {
    final prefs = await SharedPreferences.getInstance();
    final store = MeshLocalStore(prefs);
    final tracker = MessageSeenTracker(store);
    final messages = [
      _buildMessage(id: 10, minute: 1),
      _buildMessage(id: 11, minute: 2),
    ];

    await store.saveLastSeenMessageKey(
      'potatomesh.net',
      'nonexistent-key',
    );

    final unseen =
        await tracker.unseenSince(domain: 'potatomesh.net', messages: messages);

    expect(unseen, isEmpty);
    expect(
      store.loadLastSeenMessageKey('potatomesh.net'),
      MessageSeenTracker.messageKey(messages.last),
    );
  });
}
