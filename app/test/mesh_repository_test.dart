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

import 'dart:convert';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:potato_mesh_reader/main.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    NodeShortNameCache.instance.clear();
  });

  test('bootstrap filters private and inactive instances', () async {
    final nowSeconds = DateTime.now().toUtc().millisecondsSinceEpoch ~/ 1000;
    final client = MockClient((request) async {
      if (request.url.path == '/api/instances' &&
          request.url.host == 'potatomesh.net') {
        return http.Response(
          jsonEncode([
            {'name': 'Public Mesh', 'domain': 'public.mesh'},
            {
              'name': 'Hidden Mesh',
              'domain': 'private.mesh',
              'isPrivate': true
            },
            {'name': 'Stale Mesh', 'domain': 'stale.mesh'},
          ]),
          200,
        );
      }
      if (request.url.path == '/api/instances' &&
          request.url.host == 'public.mesh') {
        return http.Response('[]', 200);
      }
      if (request.url.path == '/api/instances' &&
          request.url.host == 'stale.mesh') {
        return http.Response('[]', 200);
      }
      if (request.url.path == '/api/nodes' &&
          request.url.host == 'public.mesh') {
        final nodes = List.generate(12, (i) {
          return {
            'node_id': '!pub$i',
            'short_name': 'P$i',
            'last_heard': nowSeconds,
          };
        });
        return http.Response(jsonEncode(nodes), 200);
      }
      if (request.url.path == '/api/nodes' &&
          request.url.host == 'stale.mesh') {
        final stale = nowSeconds - (60 * 60 * 48);
        return http.Response(
          jsonEncode([
            {'node_id': '!old', 'short_name': 'OLD', 'last_heard': stale},
            {'node_id': '!older', 'short_name': 'OLD2', 'last_heard': stale},
          ]),
          200,
        );
      }
      if (request.url.path == '/api/messages') {
        return http.Response(
          jsonEncode([
            {
              'id': 1,
              'rx_iso': '2024-01-01T00:00:00Z',
              'from_id': '!pub1',
              'to_id': '^',
              'channel': 1,
              'portnum': 'TEXT',
              'text': 'hello'
            },
            {
              'id': 2,
              'rx_iso': '2024-01-01T00:10:00Z',
              'from_id': '!pub2',
              'to_id': '^',
              'channel': 1,
              'portnum': 'TEXT',
              'text': 'world'
            },
          ]),
          200,
        );
      }
      if (request.url.path.startsWith('/api/nodes/')) {
        return http.Response(
          jsonEncode({
            'node_id': '!fallback',
            'short_name': 'FLBK',
            'last_heard': nowSeconds
          }),
          200,
        );
      }
      return http.Response('[]', 200);
    });

    final repository = MeshRepository(client: client, random: Random(1));
    final result = await repository.bootstrap(initialDomain: 'public.mesh');

    expect(result.instances.map((i) => i.domain), ['public.mesh']);
    expect(result.selectedDomain, 'public.mesh');
    expect(result.nodes.length, 12);
    expect(result.messages.length, 2);
  });

  test('loadMessages performs incremental refresh after initial sync',
      () async {
    final nowSeconds = DateTime.now().toUtc().millisecondsSinceEpoch ~/ 1000;
    final sinces = <String>[];
    final client = MockClient((request) async {
      if (request.url.path == '/api/nodes') {
        return http.Response(
          jsonEncode([
            {'node_id': '!a', 'short_name': 'A', 'last_heard': nowSeconds},
          ]),
          200,
        );
      }
      if (request.url.path.startsWith('/api/nodes/')) {
        return http.Response(
          jsonEncode(
              {'node_id': '!a', 'short_name': 'A', 'last_heard': nowSeconds}),
          200,
        );
      }
      if (request.url.path == '/api/messages') {
        sinces.add(request.url.queryParameters['since'] ?? '');
        expect(request.url.queryParameters['limit'], '1000');
        if (sinces.length == 1) {
          return http.Response(
            jsonEncode([
              {
                'id': 1,
                'rx_iso': '2024-01-01T00:00:00Z',
                'from_id': '!a',
                'to_id': '^',
                'channel': 1,
                'portnum': 'TEXT',
                'text': 'first'
              }
            ]),
            200,
          );
        }
        return http.Response(
          jsonEncode([
            {
              'id': 2,
              'rx_iso': '2024-01-01T00:10:00Z',
              'from_id': '!a',
              'to_id': '^',
              'channel': 1,
              'portnum': 'TEXT',
              'text': 'new'
            }
          ]),
          200,
        );
      }
      return http.Response('[]', 200);
    });

    final repository = MeshRepository(client: client);
    final domainResult = await repository.loadDomainData(
      domain: 'potatomesh.net',
      forceFull: true,
    );
    expect(domainResult.messages.length, 1);

    final refreshed = await repository.loadMessages(domain: 'potatomesh.net');

    final expectedSince =
        DateTime.parse('2024-01-01T00:00:00Z').toUtc().millisecondsSinceEpoch ~/
            1000;
    expect(sinces.first, '0');
    expect(sinces.last, expectedSince.toString());
    expect(refreshed.length, 2);
    expect(refreshed.last.text, 'new');
  });

  test('bootstrap falls back to next responsive instance when first fails',
      () async {
    final nowSeconds = DateTime.now().toUtc().millisecondsSinceEpoch ~/ 1000;
    final client = MockClient((request) async {
      if (request.url.host == 'potatomesh.net' &&
          request.url.path == '/api/instances') {
        return http.Response(
          jsonEncode([
            {'name': 'Broken', 'domain': 'broken.mesh'},
            {'name': 'Healthy', 'domain': 'healthy.mesh'},
          ]),
          200,
        );
      }
      if (request.url.host == 'broken.mesh' &&
          request.url.path == '/api/nodes') {
        return http.Response('Not found', 404);
      }
      if (request.url.host == 'healthy.mesh' &&
          request.url.path == '/api/nodes') {
        final nodes = List.generate(10, (i) {
          return {
            'node_id': '!ok$i',
            'short_name': 'OK$i',
            'last_heard': nowSeconds,
          };
        });
        return http.Response(jsonEncode(nodes), 200);
      }
      if (request.url.host == 'healthy.mesh' &&
          request.url.path == '/api/messages') {
        return http.Response(
          jsonEncode([
            {
              'id': 10,
              'rx_iso': '2024-01-01T00:00:00Z',
              'from_id': '!ok1',
              'to_id': '^',
              'channel': 1,
              'portnum': 'TEXT',
              'text': 'hi'
            }
          ]),
          200,
        );
      }
      if (request.url.path.startsWith('/api/nodes/')) {
        return http.Response(
          jsonEncode({
            'node_id': '!ok1',
            'short_name': 'OK1',
            'last_heard': nowSeconds
          }),
          200,
        );
      }
      return http.Response('[]', 200);
    });

    final repository = MeshRepository(client: client);
    final result = await repository.bootstrap(initialDomain: 'broken.mesh');

    expect(result.selectedDomain, 'healthy.mesh');
    expect(result.messages.single.text, 'hi');
  });

  test('bootstrap skips instance discovery when cache is populated', () async {
    final nowSeconds = DateTime.now().toUtc().millisecondsSinceEpoch ~/ 1000;
    final cachedInstances = jsonEncode([
      {
        'id': '1',
        'name': 'Cached Mesh',
        'domain': 'cached.mesh',
        'isPrivate': false,
        'lastUpdateTime': nowSeconds,
      }
    ]);
    SharedPreferences.setMockInitialValues({
      'mesh.instances': cachedInstances,
      'mesh.selectedDomain': 'cached.mesh',
    });

    var instancesCalls = 0;
    final client = MockClient((request) async {
      if (request.url.path == '/api/instances') {
        instancesCalls += 1;
        return http.Response('[]', 200);
      }
      if (request.url.path == '/api/nodes') {
        final nodes = List.generate(10, (i) {
          return {
            'node_id': '!cached$i',
            'short_name': 'C$i',
            'last_heard': nowSeconds,
          };
        });
        return http.Response(jsonEncode(nodes), 200);
      }
      if (request.url.path == '/api/messages') {
        return http.Response(
          jsonEncode([
            {
              'id': 20,
              'rx_iso': '2024-01-01T00:00:00Z',
              'from_id': '!cached1',
              'to_id': '^',
              'channel': 1,
              'portnum': 'TEXT',
              'text': 'cached'
            }
          ]),
          200,
        );
      }
      if (request.url.path.startsWith('/api/nodes/')) {
        return http.Response(
          jsonEncode({
            'node_id': '!cached1',
            'short_name': 'C1',
            'last_heard': nowSeconds
          }),
          200,
        );
      }
      return http.Response('[]', 200);
    });

    final repository = MeshRepository(client: client);
    final result = await repository.bootstrap(initialDomain: 'cached.mesh');

    expect(instancesCalls, 0, reason: 'should not refetch instance list');
    expect(result.selectedDomain, 'cached.mesh');
    expect(result.messages.single.text, 'cached');
  });

  test('loadMessages prefers cached nodes over remote lookups', () async {
    final savedNodes = jsonEncode([
      {'node_id': '!a', 'short_name': 'A', 'last_heard': 0}
    ]);
    SharedPreferences.setMockInitialValues({
      'mesh.nodes.potatomesh.net': savedNodes,
    });

    var nodeDetailHits = 0;
    final client = MockClient((request) async {
      if (request.url.path == '/api/messages') {
        return http.Response(
          jsonEncode([
            {
              'id': 1,
              'rx_iso': '2024-01-01T00:00:00Z',
              'from_id': '!a',
              'to_id': '^',
              'channel': 1,
              'portnum': 'TEXT',
              'text': 'cached node'
            }
          ]),
          200,
        );
      }
      if (request.url.path.startsWith('/api/nodes/')) {
        nodeDetailHits += 1;
        return http.Response(
          jsonEncode({'node_id': '!a', 'short_name': 'A', 'last_heard': 0}),
          200,
        );
      }
      return http.Response('[]', 200);
    });

    final repository = MeshRepository(client: client);
    final messages = await repository.loadMessages(domain: 'potatomesh.net');

    expect(messages.single.text, 'cached node');
    expect(nodeDetailHits, 0);
  });

  test('rememberSelectedDomain persists normalized choice', () async {
    final repo = MeshRepository();
    await repo.rememberSelectedDomain('HTTP://Example.Mesh/');
    expect(repo.selectedDomain, 'example.mesh');

    final prefs = await SharedPreferences.getInstance();
    final store = MeshLocalStore(prefs);
    expect(store.loadSelectedDomain(), 'example.mesh');
  });
}
