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

class _StubRepository extends MeshRepository {
  _StubRepository(this.node) : super();

  final MeshNode? node;

  @override
  MeshNode? findNode(String domain, String nodeId) {
    return node;
  }
}

MeshMessage _buildMessage({
  required int id,
  required String nodeId,
  String text = 'hello',
}) {
  final rx = DateTime.utc(2024, 1, 1, 12, id);
  return MeshMessage(
    id: id,
    rxTime: rx,
    rxIso: rx.toIso8601String(),
    fromId: nodeId,
    nodeId: nodeId,
    toId: '^',
    channel: 1,
    channelName: 'Main',
    portnum: 'TEXT',
    text: text,
    rssi: -50,
    snr: 1.0,
    hopLimit: 1,
  );
}

void main() {
  setUp(() {
    NodeShortNameCache.instance.clear();
  });

  test('prefers node long name when resolving sender', () {
    const node = MeshNode(
      nodeId: '!NODE1',
      shortName: 'N1',
      longName: 'Verbose Node',
    );
    final repo = _StubRepository(node);
    final sender = repo.resolveNotificationSender(
      domain: 'potatomesh.net',
      message: _buildMessage(id: 1, nodeId: '!NODE1'),
    );

    expect(sender.longName, 'Verbose Node');
    expect(sender.shortName, 'N1');
    expect(sender.preferredName, 'Verbose Node');
  });

  test('falls back to short identifier when metadata is missing', () {
    final repo = _StubRepository(null);
    final sender = repo.resolveNotificationSender(
      domain: 'potatomesh.net',
      message: _buildMessage(id: 2, nodeId: '!NODE2'),
    );

    expect(sender.longName, isNull);
    expect(sender.shortName, 'ODE2');
    expect(sender.preferredName, 'ODE2');
  });
}
