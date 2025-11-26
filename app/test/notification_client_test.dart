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

import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:potato_mesh_reader/main.dart';

void main() {
  test('uses drawable name for Android init and notifications', () {
    final client = LocalNotificationClient();

    final androidInit = client.buildAndroidInitializationSettings();
    expect(androidInit.defaultIcon, 'ic_mesh_notification');

    final details = client.notificationDetailsForTest();
    final androidDetails = details.android as AndroidNotificationDetails;
    expect(androidDetails.icon, 'ic_mesh_notification');
    expect(androidDetails.category, AndroidNotificationCategory.message);
  });
}
