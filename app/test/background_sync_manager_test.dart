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
import 'package:workmanager/workmanager.dart';

class _FakeWorkmanagerAdapter implements WorkmanagerAdapter {
  bool initialized = false;
  bool registered = false;
  Duration? frequency;
  ExistingPeriodicWorkPolicy? policy;
  Constraints? constraints;
  Duration? initialDelay;
  Function? dispatcher;

  @override
  Future<void> initialize(Function dispatcher) async {
    initialized = true;
    this.dispatcher = dispatcher;
  }

  @override
  Future<void> registerPeriodicTask(
    String taskId,
    String taskName, {
    Duration frequency = const Duration(minutes: 15),
    ExistingPeriodicWorkPolicy existingWorkPolicy =
        ExistingPeriodicWorkPolicy.keep,
    Duration? initialDelay,
    Constraints? constraints,
  }) async {
    registered = true;
    this.frequency = frequency;
    policy = existingWorkPolicy;
    this.constraints = constraints;
    this.initialDelay = initialDelay;
  }

  @override
  Future<void> cancelAll() async {}
}

class _FakeNotificationClient extends NotificationClient {
  _FakeNotificationClient();

  int calls = 0;
  MeshMessage? lastMessage;
  String? lastDomain;
  String? lastShortName;
  String? lastLongName;

  @override
  Future<void> initialize() async {}

  @override
  Future<void> showNewMessage({
    required MeshMessage message,
    required String domain,
    String? senderShortName,
    String? senderLongName,
  }) async {
    calls += 1;
    lastMessage = message;
    lastDomain = domain;
    lastShortName = senderShortName;
    lastLongName = senderLongName;
  }
}

class _FakeRepository extends MeshRepository {
  _FakeRepository({
    required this.domain,
    required this.messages,
    required this.unseen,
    NotificationSender? sender,
  })  : sender = sender ??
            const NotificationSender(shortName: 'MOCK', longName: 'Mocky'),
        super();

  final String domain;
  final List<MeshMessage> messages;
  final List<MeshMessage> unseen;
  final NotificationSender sender;
  int loadMessagesCalls = 0;

  @override
  Future<String> loadSelectedDomainOrDefault(
      {String fallback = 'potatomesh.net'}) async {
    return domain;
  }

  @override
  Future<List<MeshMessage>> loadMessages({required String domain}) async {
    loadMessagesCalls += 1;
    return messages;
  }

  @override
  Future<List<MeshMessage>> detectUnseenMessages({
    required String domain,
    required List<MeshMessage> messages,
  }) async {
    return unseen;
  }

  @override
  NotificationSender resolveNotificationSender({
    required String domain,
    required MeshMessage message,
  }) {
    return sender;
  }
}

MeshMessage _buildMessage(int id, String text) {
  final rx = DateTime.utc(2024, 1, 1, 12, id);
  return MeshMessage(
    id: id,
    rxTime: rx,
    rxIso: rx.toIso8601String(),
    fromId: '!tester$id',
    nodeId: '!tester$id',
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
    BackgroundSyncManager.resetForTest();
  });

  test('registers and schedules background task', () async {
    final fakeWork = _FakeWorkmanagerAdapter();
    final fakeRepo = _FakeRepository(
      domain: 'potatomesh.net',
      messages: [_buildMessage(1, 'hello')],
      unseen: [_buildMessage(2, 'new')],
      sender: const NotificationSender(
        shortName: 'TEST',
        longName: 'Test Sender',
      ),
    );
    final notifier = _FakeNotificationClient();

    final manager = BackgroundSyncManager(
      workmanager: fakeWork,
      dependencies: BackgroundDependencies(
        repositoryBuilder: () async => fakeRepo,
        notificationBuilder: () async => notifier,
      ),
    );

    await manager.initialize();
    await manager.ensurePeriodicTask();

    expect(fakeWork.initialized, isTrue);
    expect(fakeWork.registered, isTrue);
    expect(fakeWork.policy, ExistingPeriodicWorkPolicy.keep);
    expect(fakeWork.frequency, const Duration(minutes: 15));
    expect(fakeWork.constraints?.networkType, NetworkType.connected);
    expect(fakeWork.initialDelay, const Duration(minutes: 1));

    final handled =
        await BackgroundSyncManager.handleBackgroundTask('task', {});

    expect(handled, isTrue);
    expect(fakeRepo.loadMessagesCalls, 1);
    expect(notifier.calls, 1);
    expect(notifier.lastDomain, 'potatomesh.net');
    expect(notifier.lastShortName, 'TEST');
    expect(notifier.lastLongName, 'Test Sender');
  });

  test('returns true and no-ops when dependencies are missing', () async {
    final handled =
        await BackgroundSyncManager.handleBackgroundTask('task', {});
    expect(handled, isTrue);
  });
}
