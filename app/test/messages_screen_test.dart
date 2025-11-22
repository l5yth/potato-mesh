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

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:potato_mesh_reader/main.dart';

/// Widget-level tests that exercise UI states and rendering branches.
void main() {
  testWidgets('PotatoMeshReaderApp wires theming and home screen', (tester) async {
    final fetchCalls = <int>[];
    Future<List<MeshMessage>> fakeFetch() async {
      fetchCalls.add(1);
      return [
        MeshMessage(
          id: 1,
          rxTime: DateTime.utc(2024, 1, 1, 12, 0),
          rxIso: '2024-01-01T12:00:00Z',
          fromId: '!tester',
          toId: '^',
          channel: 1,
          channelName: 'Main',
          portnum: 'TEXT',
          text: 'Hello',
          rssi: -50,
          snr: 2.2,
          hopLimit: 1,
        ),
      ];
    }

    await tester.pumpWidget(PotatoMeshReaderApp(fetcher: fakeFetch));
    await tester.pumpAndSettle();

    expect(find.text('Meshtastic Reader'), findsOneWidget);
    expect(find.byType(MessagesScreen), findsOneWidget);
    expect(fetchCalls.length, 1);
  });

  testWidgets('MessagesScreen shows loading, data, refresh, and empty states', (tester) async {
    var fetchCount = 0;
    final completer = Completer<List<MeshMessage>>();
    Future<List<MeshMessage>> fetcher() {
      fetchCount += 1;
      if (fetchCount == 1) {
        return completer.future;
      }
      if (fetchCount == 2) {
        return Future.value([
          MeshMessage(
            id: 2,
            rxTime: DateTime.utc(2024, 1, 1, 10, 0),
            rxIso: '2024-01-01T10:00:00Z',
            fromId: '!a',
            toId: '^',
            channel: 1,
            channelName: null,
            portnum: 'TEXT',
            text: '',
            rssi: -40,
            snr: 1.1,
            hopLimit: 1,
          ),
        ]);
      }
      return Future.error(StateError('no new data'));
    }

    await tester.pumpWidget(MaterialApp(home: MessagesScreen(fetcher: fetcher)));

    expect(find.byType(CircularProgressIndicator), findsOneWidget);

    completer.complete([
      MeshMessage(
        id: 1,
        rxTime: DateTime.utc(2024, 1, 1, 9, 0),
        rxIso: '2024-01-01T09:00:00Z',
        fromId: '!nick',
        toId: '^',
        channel: 1,
        channelName: 'General',
        portnum: 'TEXT',
        text: 'Loaded',
        rssi: -42,
        snr: 1.5,
        hopLimit: 1,
      ),
    ]);

    await tester.pumpAndSettle();

    expect(find.textContaining('Loaded'), findsOneWidget);
    expect(find.textContaining('General'), findsOneWidget);
    expect(fetchCount, 1);

    await tester.tap(find.byIcon(Icons.refresh));
    await tester.pump();
    await tester.pumpAndSettle();

    expect(fetchCount, 2);
    expect(find.text('⟂ (no text)'), findsOneWidget);

    await tester.tap(find.byIcon(Icons.refresh));
    await tester.pumpAndSettle();

    expect(find.textContaining('Failed to load messages'), findsOneWidget);

    await tester.pumpWidget(
      MaterialApp(
        home: MessagesScreen(fetcher: () async => []),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('No messages yet.'), findsOneWidget);
  });

  testWidgets('Settings button navigates to SettingsScreen', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: MessagesScreen(fetcher: () async => []),
      ),
    );

    await tester.tap(find.byIcon(Icons.settings));
    await tester.pumpAndSettle();

    expect(find.text('Settings (MVP)'), findsOneWidget);
    expect(find.textContaining('Meshtastic Reader MVP'), findsOneWidget);
  });

  testWidgets('ChatLine renders placeholders and nick colour', (tester) async {
    final message = MeshMessage(
      id: 1,
      rxTime: null,
      rxIso: '',
      fromId: '!ColorNick',
      toId: '^',
      channel: 1,
      channelName: null,
      portnum: 'TEXT',
      text: '',
      rssi: null,
      snr: null,
      hopLimit: null,
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: ChatLine(message: message)),
      ),
    );

    final nickText = find.textContaining('<ColorNick>');
    final placeholder = find.text('⟂ (no text)');
    expect(nickText, findsOneWidget);
    expect(placeholder, findsOneWidget);
    expect(find.text('[--:--]'), findsOneWidget);
  });
}
