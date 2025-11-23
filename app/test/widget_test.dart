// This is a basic Flutter widget test.
//
// To perform an interaction with a widget in your test, use the WidgetTester
// utility in the flutter_test package. For example, you can send tap and scroll
// gestures. You can also use WidgetTester to find child widgets in the widget
// tree, read text, and verify that the values of widget properties are correct.

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'package:potato_mesh_reader/main.dart';

void main() {
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

    await tester.pumpWidget(PotatoMeshReaderApp(fetcher: mockFetcher));
    await tester.pumpAndSettle();

    expect(find.textContaining('PotatoMesh Reader'), findsOneWidget);
    expect(find.text('[--:--]'), findsOneWidget);
    expect(find.text('<!nodeA>'), findsOneWidget);
    expect(find.text('hello world'), findsOneWidget);
    expect(find.text('#TEST'), findsOneWidget);

    await tester.tap(find.byTooltip('Refresh'));
    await tester.pumpAndSettle();

    expect(find.text('<!nodeB>'), findsOneWidget);
    expect(find.text('second message'), findsOneWidget);
    expect(find.text('<!nodeA>'), findsNothing);
  });
}
