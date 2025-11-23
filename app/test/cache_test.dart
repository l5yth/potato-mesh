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
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:potato_mesh_reader/main.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    NodeShortNameCache.instance.clear();
  });

  test('NodeShortNameCache fetches and memoizes short names', () async {
    var calls = 0;
    final client = MockClient((request) async {
      calls += 1;
      expect(request.url.path, '/api/nodes/!cache-test');
      return http.Response('{"short_name":"NODE"}', 200);
    });

    final first = await NodeShortNameCache.instance.shortNameFor(
      domain: 'cache.test',
      nodeId: '!cache-test',
      client: client,
    );
    final second = await NodeShortNameCache.instance.shortNameFor(
      domain: 'cache.test',
      nodeId: '!cache-test',
      client: client,
    );

    expect(first, 'NODE');
    expect(second, 'NODE');
    expect(calls, 1, reason: 'memoises results per domain/id');
  });

  test('NodeShortNameCache falls back to padded suffix', () {
    expect(NodeShortNameCache.fallbackShortName('!ab'), '  ab');
    expect(NodeShortNameCache.fallbackShortName('!abcdef'), 'cdef');
    expect(NodeShortNameCache.fallbackShortName(''), '????');
  });

  test('InstanceVersionCache fetches and caches version payloads', () async {
    var calls = 0;
    final client = MockClient((request) async {
      calls += 1;
      expect(request.url.path, '/version');
      return http.Response(
        '{"name":"BerlinMesh","config":{"channel":"#MediumFast","frequency":"868MHz","instanceDomain":"potatomesh.net"}}',
        200,
      );
    });

    final first = await InstanceVersionCache.instance
        .fetch(domain: 'version.test', client: client);
    final second = await InstanceVersionCache.instance
        .fetch(domain: 'version.test', client: client);

    expect(first?.summary, contains('BerlinMesh'));
    expect(first?.summary, contains('#MediumFast'));
    expect(calls, 1, reason: 'cache should avoid duplicate network calls');
    expect(second?.summary, first?.summary);
  });
}
