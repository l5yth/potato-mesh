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

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:potato_mesh_reader/main.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('BootstrapProgress renders stage, counts, and detail', () {
    const progress = BootstrapProgress(
      stage: 'Downloading',
      current: 2,
      total: 5,
      detail: 'instances',
    );

    expect(progress.label, 'Downloading 2/5 • instances');

    const fallback = BootstrapProgress(stage: 'Starting');
    expect(fallback.label, 'Starting');
  });

  test('InstanceVersion summary prefers populated fields', () {
    const populated = InstanceVersion(
      name: 'BerlinMesh',
      channel: '#MediumFast',
      frequency: '868MHz',
      instanceDomain: 'potatomesh.net',
    );
    expect(populated.summary, 'BerlinMesh · #MediumFast · 868MHz');

    const minimal = InstanceVersion(
      name: '',
      channel: null,
      frequency: null,
      instanceDomain: null,
    );
    expect(minimal.summary, 'Unknown');
  });

  test('sortMessagesByRxTime keeps unknown timestamps in place', () {
    final withTime = MeshMessage(
      id: 2,
      rxTime: DateTime.utc(2024, 1, 1, 12, 1),
      rxIso: '2024-01-01T12:01:00Z',
      fromId: '!a',
      nodeId: '!a',
      toId: '^',
      channelName: '#general',
      channel: 1,
      portnum: 'TEXT',
      text: 'timed',
      rssi: -50,
      snr: 1.0,
      hopLimit: 1,
    );
    final withoutTime = MeshMessage(
      id: 1,
      rxTime: null,
      rxIso: '',
      fromId: '!b',
      nodeId: '!b',
      toId: '^',
      channelName: '#general',
      channel: 1,
      portnum: 'TEXT',
      text: 'unknown',
      rssi: -50,
      snr: 1.0,
      hopLimit: 1,
    );
    final laterTime = MeshMessage(
      id: 3,
      rxTime: DateTime.utc(2024, 1, 1, 12, 5),
      rxIso: '2024-01-01T12:05:00Z',
      fromId: '!c',
      nodeId: '!c',
      toId: '^',
      channelName: '#general',
      channel: 1,
      portnum: 'TEXT',
      text: 'later',
      rssi: -50,
      snr: 1.0,
      hopLimit: 1,
    );

    final sorted = sortMessagesByRxTime([withoutTime, laterTime, withTime]);

    expect(sorted.first.id, withoutTime.id,
        reason: 'messages without rxTime should retain position');
    expect(sorted[1].id, withTime.id,
        reason: 'messages with timestamps should be ordered chronologically');
    expect(sorted.last.id, laterTime.id);
  });

  testWidgets('LoadingScreen displays progress label and icon',
      (tester) async {
    const screen = LoadingScreen(
      progress: BootstrapProgress(stage: 'Fetching'),
    );

    await tester.pumpWidget(const MaterialApp(home: screen));

    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.text('Fetching'), findsOneWidget);
    expect(find.bySemanticsLabel('PotatoMesh'), findsOneWidget);
  });

  testWidgets('LoadingScreen surfaces errors', (tester) async {
    const screen = LoadingScreen(
      progress: BootstrapProgress(stage: 'Loading'),
      error: 'boom',
    );

    await tester.pumpWidget(const MaterialApp(home: screen));

    expect(find.textContaining('Failed to load: boom'), findsOneWidget);
  });
}
