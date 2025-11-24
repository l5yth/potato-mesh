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
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:potato_mesh_reader/main.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Widget-level tests that exercise UI states and rendering branches.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    NodeShortNameCache.instance.allowRemoteLookups = false;
    NodeShortNameCache.instance.clear();
  });

  testWidgets('PotatoMeshReaderApp wires theming and home screen',
      (tester) async {
    final fetchCalls = <int>[];
    Future<List<MeshMessage>> fakeFetch({
      http.Client? client,
      String domain = 'potatomesh.net',
    }) async {
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

    Future<BootstrapResult> bootstrapper({ProgressCallback? onProgress}) async {
      onProgress?.call(const BootstrapProgress(stage: 'loading instances'));
      return BootstrapResult(
        instances: const [],
        nodes: const [],
        messages: await fakeFetch(domain: 'potatomesh.net'),
        selectedDomain: 'potatomesh.net',
      );
    }

    await tester.pumpWidget(PotatoMeshReaderApp(
      fetcher: fakeFetch,
      bootstrapper: bootstrapper,
      enableAutoRefresh: false,
    ));
    await tester.pumpAndSettle();

    expect(find.textContaining('PotatoMesh Reader'), findsOneWidget);
    expect(find.byType(MessagesScreen), findsOneWidget);
    expect(fetchCalls.length, greaterThanOrEqualTo(1));
  });

  testWidgets('MessagesScreen shows loading, data, refresh, and empty states',
      (tester) async {
    var fetchCount = 0;
    final completer = Completer<List<MeshMessage>>();
    Future<List<MeshMessage>> fetcher() {
      fetchCount += 1;
      if (fetchCount == 1) {
        return completer.future;
      }
      return Future.value([
        MeshMessage(
          id: fetchCount,
          rxTime: DateTime.utc(2024, 1, 1, 10, fetchCount),
          rxIso: '2024-01-01T10:00:00Z',
          fromId: '!a',
          toId: '^',
          channel: 1,
          channelName: 'General',
          portnum: 'TEXT',
          text: 'Message $fetchCount',
          rssi: -40,
          snr: 1.1,
          hopLimit: 1,
        ),
      ]);
    }

    await tester.pumpWidget(
      MaterialApp(
        home: MessagesScreen(
          fetcher: fetcher,
          domain: 'potatomesh.net',
          enableAutoRefresh: false,
        ),
      ),
    );

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

    expect(fetchCount, greaterThanOrEqualTo(2));

    await tester.tap(find.byIcon(Icons.refresh));
    await tester.pump();
    await tester.pumpAndSettle();

    expect(fetchCount, greaterThanOrEqualTo(3));
    expect(find.textContaining('Message'), findsWidgets);

    await tester.pumpWidget(
      MaterialApp(
        home: MessagesScreen(
          fetcher: () async => [],
          domain: 'potatomesh.net',
          enableAutoRefresh: false,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('No messages yet.'), findsOneWidget);
  });

  testWidgets('Settings button navigates to SettingsScreen', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: MessagesScreen(
          fetcher: () async => [],
          domain: 'potatomesh.net',
          enableAutoRefresh: false,
          onOpenSettings: (context) {
            Navigator.of(context).push(
              MaterialPageRoute(
                builder: (_) => SettingsScreen(
                  currentDomain: 'potatomesh.net',
                  onDomainChanged: (_) {},
                  loadInstances: ({bool refresh = false}) async => const [],
                ),
              ),
            );
          },
          resetToken: 0,
        ),
      ),
    );

    await tester.tap(find.byIcon(Icons.settings));
    await tester.pumpAndSettle();

    expect(find.text('Settings'), findsOneWidget);
    expect(find.textContaining('PotatoMesh Reader'), findsOneWidget);
  });

  // Stale fetch completions are ignored by versioned fetch guard; covered
  // indirectly by other tests that rely on append ordering.

  testWidgets('changing endpoint triggers a refresh with new domain',
      (tester) async {
    final calls = <String>[];
    Future<List<MeshMessage>> fetcher({
      http.Client? client,
      String domain = 'potatomesh.net',
    }) async {
      calls.add(domain);
      return [
        MeshMessage(
          id: 1,
          rxTime: null,
          rxIso: '2024-01-01T00:00:00Z',
          fromId: '!a',
          toId: '^',
          channel: 1,
          channelName: 'Main',
          portnum: 'TEXT',
          text: domain,
          rssi: null,
          snr: null,
          hopLimit: null,
        )
      ];
    }

    Future<List<MeshInstance>> loader({bool refresh = false}) async => const [
          MeshInstance(name: 'Mesh Berlin', domain: 'berlin.mesh'),
        ];

    final mockClient = MockClient((request) async {
      if (request.url.path.contains('/api/nodes')) {
        return http.Response('[]', 200);
      }
      if (request.url.path.contains('/api/messages')) {
        return http.Response('[]', 200);
      }
      if (request.url.path.contains('/api/instances')) {
        return http.Response(
            '[{"name":"Mesh Berlin","domain":"berlin.mesh"}]', 200);
      }
      return http.Response('[]', 200);
    });

    final repository = MeshRepository(client: mockClient);

    Future<BootstrapResult> bootstrapper({ProgressCallback? onProgress}) async {
      onProgress?.call(const BootstrapProgress(stage: 'loading instances'));
      final initialMessages = await fetcher(domain: 'potatomesh.net');
      final instances = await loader();
      await repository.updateInstances(instances);
      return BootstrapResult(
        instances: instances,
        nodes: const [],
        messages: initialMessages,
        selectedDomain: 'potatomesh.net',
      );
    }

    await tester.pumpWidget(
      PotatoMeshReaderApp(
        fetcher: fetcher,
        instanceFetcher: ({http.Client? client}) => loader(),
        bootstrapper: bootstrapper,
        repository: repository,
        enableAutoRefresh: false,
      ),
    );
    await tester.pumpAndSettle();

    expect(calls.first, 'potatomesh.net');
    expect(find.text('potatomesh.net'), findsOneWidget);

    await tester.tap(find.byIcon(Icons.settings));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(DropdownButtonFormField<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Mesh Berlin').last);
    await tester.pumpAndSettle();
    await tester.pageBack();
    final messagesFinder = find.byType(MessagesScreen);
    for (var i = 0; i < 10 && messagesFinder.evaluate().isEmpty; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }

    expect(messagesFinder, findsOneWidget);
    expect(repository.selectedDomain, 'berlin.mesh');
    expect(calls.contains('berlin.mesh'), isTrue);
    expect(find.text('berlin.mesh'), findsOneWidget);
    expect(find.text('🥔 Mesh Berlin'), findsOneWidget);
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
        home: Scaffold(
          body: ChatLine(
            message: message,
            domain: 'potatomesh.net',
          ),
        ),
      ),
    );

    final nickText = find.textContaining('<!ColorNick>');
    final placeholder = find.text('⟂ (no text)');
    expect(nickText, findsOneWidget);
    expect(placeholder, findsOneWidget);
    expect(find.textContaining('[--:--]'), findsOneWidget);
  });
}
