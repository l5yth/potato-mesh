// Copyright © 2025-26 l5yth & contributors
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

// This is a basic Flutter widget test.
//
// To perform an interaction with a widget in your test, use the WidgetTester
// utility in the flutter_test package. For example, you can send tap and scroll
// gestures. You can also use WidgetTester to find child widgets in the widget
// tree, read text, and verify that the values of widget properties are correct.

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'package:potato_mesh_reader/main.dart';

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    NodeShortNameCache.instance.clear();
  });

  testWidgets('renders messages from fetcher and refreshes list',
      (WidgetTester tester) async {
    final sampleMessages = <MeshMessage>[
      MeshMessage(
        id: 1,
        rxTime: null,
        rxIso: '2025-01-01T00:00:00Z',
        fromId: '!nodeA',
        toId: '^all',
        channel: 1,
        channelName: 'TEST',
        portnum: 'TEXT_MESSAGE_APP',
        text: 'hello world',
        rssi: -100,
        snr: -5.0,
        hopLimit: 3,
      ),
      MeshMessage(
        id: 2,
        rxTime: null,
        rxIso: '2025-01-01T01:00:00Z',
        fromId: '!nodeB',
        toId: '^all',
        channel: 1,
        channelName: 'TEST',
        portnum: 'TEXT_MESSAGE_APP',
        text: 'second message',
        rssi: -90,
        snr: -4.0,
        hopLimit: 3,
      ),
    ];

    var fetchCount = 0;
    Future<List<MeshMessage>> mockFetcher({
      http.Client? client,
      String domain = 'potatomesh.net',
    }) async {
      final idx = fetchCount >= sampleMessages.length
          ? sampleMessages.length - 1
          : fetchCount;
      fetchCount += 1;
      return [sampleMessages[idx]];
    }

    Future<BootstrapResult> bootstrapper({ProgressCallback? onProgress}) async {
      onProgress?.call(const BootstrapProgress(stage: 'loading instances'));
      return BootstrapResult(
        instances: const [],
        nodes: const [],
        messages: sampleMessages,
        selectedDomain: 'potatomesh.net',
      );
    }

    await tester.pumpWidget(
      PotatoMeshReaderApp(
        fetcher: mockFetcher,
        bootstrapper: bootstrapper,
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('PotatoMesh Reader'), findsOneWidget);
    expect(find.textContaining('[--:--]'), findsWidgets);
    expect(find.byType(ChatLine), findsNWidgets(2));
    expect(find.textContaining('hello world'), findsOneWidget);
    expect(find.textContaining('#TEST'), findsWidgets);
    expect(find.textContaining('<!nodeB>'), findsOneWidget);
    expect(find.textContaining('second message'), findsOneWidget);
  });
}
