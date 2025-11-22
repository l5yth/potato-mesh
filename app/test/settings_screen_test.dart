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
  testWidgets('SettingsScreen lists instances and updates selection',
      (tester) async {
    final selections = <String>[];
    Future<List<MeshInstance>> loader() async => const [
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
    Future<List<MeshInstance>> loader() => Future.error(StateError('boom'));

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
}
