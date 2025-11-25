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

import 'dart:io';

import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:shared_preferences_android/shared_preferences_android.dart';
import 'package:shared_preferences_foundation/shared_preferences_foundation.dart';

/// Minimal plugin registrant for background isolates.
///
/// The Workmanager-provided background Flutter engine does not automatically
/// invoke the app's plugin registrant, so we register only the plugins needed
/// by our background task (notifications and shared preferences).
class DartPluginRegistrant {
  static bool _initialized = false;

  static void ensureInitialized() {
    if (_initialized) return;
    if (Platform.isAndroid) {
      try {
        AndroidFlutterLocalNotificationsPlugin.registerWith();
      } catch (_) {}
      try {
        SharedPreferencesAndroid.registerWith();
      } catch (_) {}
    } else if (Platform.isIOS) {
      try {
        IOSFlutterLocalNotificationsPlugin.registerWith();
      } catch (_) {}
      try {
        SharedPreferencesFoundation.registerWith();
      } catch (_) {}
    }
    _initialized = true;
  }
}
