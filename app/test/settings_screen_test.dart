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
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('SettingsScreen lists instances and updates selection',
      (tester) async {
    final selections = <String>[];
    Future<List<MeshInstance>> loader({bool refresh = false}) async => const [
          MeshInstance(name: 'Mesh Dresden', domain: 'map.meshdresden.eu'),
          MeshInstance(name: 'Mesh Berlin', domain: 'berlin.mesh'),
        ];

    await tester.pumpWidget(
      MaterialApp(
        home: SettingsScreen(
          currentDomain: 'potatomesh.net',
          onDomainChanged: selections.add,
          loadInstances: loader,
        ),
      ),
    );

    await tester.pumpAndSettle();

    await tester.tap(find.byType(DropdownButtonFormField<String>));
    await tester.pumpAndSettle();
    expect(find.text('Mesh Dresden'), findsOneWidget);
    await tester.tap(find.text('Mesh Berlin').last);
    await tester.pumpAndSettle();

    expect(selections.single, 'berlin.mesh');
    expect(find.textContaining('berlin.mesh'), findsWidgets);
  });

  testWidgets('SettingsScreen surfaces load errors', (tester) async {
    Future<List<MeshInstance>> loader({bool refresh = false}) =>
        Future.error(StateError('boom'));

    await tester.pumpWidget(
      MaterialApp(
        home: SettingsScreen(
          currentDomain: 'potatomesh.net',
          onDomainChanged: (_) {},
          loadInstances: loader,
        ),
      ),
    );

    await tester.pumpAndSettle();

    expect(find.textContaining('Failed to load instances'), findsOneWidget);
  });

  testWidgets('SettingsScreen refresh button refetches instances',
      (tester) async {
    final refreshCalls = <bool>[];
    Future<List<MeshInstance>> loader({bool refresh = false}) async {
      refreshCalls.add(refresh);
      return const [
        MeshInstance(name: 'Mesh Berlin', domain: 'berlin.mesh'),
      ];
    }

    await tester.pumpWidget(
      MaterialApp(
        home: SettingsScreen(
          currentDomain: 'potatomesh.net',
          onDomainChanged: (_) {},
          loadInstances: loader,
        ),
      ),
    );

    await tester.pumpAndSettle();
    expect(refreshCalls, [false]);

    await tester.tap(find.byIcon(Icons.refresh));
    await tester.pumpAndSettle();

    expect(refreshCalls, contains(true));
    expect(refreshCalls.length, greaterThanOrEqualTo(2));
  });

  testWidgets('SettingsScreen toggles theme mode', (tester) async {
    final selected = <ThemeMode>[];

    await tester.pumpWidget(
      MaterialApp(
        home: SettingsScreen(
          currentDomain: 'potatomesh.net',
          onDomainChanged: (_) {},
          loadInstances: ({bool refresh = false}) async => const [],
          themeMode: ThemeMode.light,
          onThemeChanged: selected.add,
        ),
      ),
    );

    await tester.pumpAndSettle();

    expect(find.text('Appearance'), findsOneWidget);
    await tester.tap(find.byType(DropdownButtonFormField<ThemeMode>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Dark').last);
    await tester.pumpAndSettle();

    expect(selected.single, ThemeMode.dark);
  });
}
