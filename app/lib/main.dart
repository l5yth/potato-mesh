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

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

void main() {
  runApp(const PotatoMeshReaderApp());
}

/// Meshtastic Reader root widget that configures theming and the home screen.
class PotatoMeshReaderApp extends StatelessWidget {
  const PotatoMeshReaderApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Meshtastic Reader',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        colorScheme: ColorScheme.fromSeed(
          seedColor: Colors.teal,
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
        textTheme: const TextTheme(
          bodyMedium: TextStyle(
            fontFamily: 'monospace',
            fontSize: 13,
            height: 1.15,
          ),
        ),
      ),
      home: const MessagesScreen(),
    );
  }
}

/// Displays the fetched mesh messages and supports pull-to-refresh.
class MessagesScreen extends StatefulWidget {
  const MessagesScreen({super.key});

  @override
  State<MessagesScreen> createState() => _MessagesScreenState();
}

class _MessagesScreenState extends State<MessagesScreen> {
  late Future<List<MeshMessage>> _future;

  @override
  void initState() {
    super.initState();
    _future = fetchMessages();
  }

  /// Reloads the message feed and waits for completion for pull-to-refresh.
  Future<void> _refresh() async {
    setState(() {
      _future = fetchMessages();
    });
    await _future;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('#BerlinMesh'),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh),
            onPressed: _refresh,
          ),
          IconButton(
            tooltip: 'Settings',
            icon: const Icon(Icons.settings),
            onPressed: () {
              Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => const SettingsScreen(),
                ),
              );
            },
          ),
        ],
      ),
      body: FutureBuilder<List<MeshMessage>>(
        future: _future,
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Text(
                  'Failed to load messages:\n${snapshot.error}',
                  textAlign: TextAlign.center,
                ),
              ),
            );
          }
          final messages = snapshot.data ?? [];
          if (messages.isEmpty) {
            return const Center(child: Text('No messages yet.'));
          }

          return RefreshIndicator(
            onRefresh: _refresh,
            child: ListView.builder(
              padding: const EdgeInsets.symmetric(vertical: 8),
              itemCount: messages.length,
              itemBuilder: (context, index) {
                final msg = messages[index];
                return ChatLine(message: msg);
              },
            ),
          );
        },
      ),
    );
  }
}

/// Individual chat line styled in IRC-inspired format.
class ChatLine extends StatelessWidget {
  const ChatLine({super.key, required this.message});

  /// Message data to render.
  final MeshMessage message;

  /// Generates a stable color from the nickname characters by hashing to a hue.
  Color _nickColor(String nick) {
    final h = nick.codeUnits.fold<int>(0, (a, b) => (a + b) % 360);
    return HSLColor.fromAHSL(1, h.toDouble(), 0.5, 0.6).toColor();
  }

  @override
  Widget build(BuildContext context) {
    final timeStr = '[${message.timeFormatted}]';
    final nick = '<${message.fromShort}>';

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
      child: RichText(
        text: TextSpan(
          style: DefaultTextStyle.of(context).style,
          children: [
            TextSpan(
              text: '$timeStr ',
              style: const TextStyle(
                color: Colors.grey,
                fontWeight: FontWeight.w500,
              ),
            ),
            TextSpan(
              text: '$nick ',
              style: TextStyle(
                color: _nickColor(message.fromShort),
                fontWeight: FontWeight.w600,
              ),
            ),
            TextSpan(
              text: message.text.isEmpty ? '⟂ (no text)' : message.text,
            ),
            if (message.channelName != null) ...[
              const TextSpan(text: '  '),
              TextSpan(
                text: '#${message.channelName}',
                style: const TextStyle(color: Colors.tealAccent),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// MVP settings placeholder offering endpoint and about info.
class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Settings (MVP)')),
      body: ListView(
        children: const [
          ListTile(
            leading: Icon(Icons.cloud),
            title: Text('Endpoint'),
            subtitle: Text('https://potatomesh.net/api/messages'),
          ),
          Divider(),
          ListTile(
            leading: Icon(Icons.info_outline),
            title: Text('About'),
            subtitle: Text('Meshtastic Reader MVP — read-only view of PotatoMesh messages.'),
          ),
        ],
      ),
    );
  }
}

/// --- Data layer ------------------------------------------------------------

/// Representation of a single mesh message returned by the PotatoMesh API.
class MeshMessage {
  final int id;
  final DateTime? rxTime;
  final String rxIso;
  final String fromId;
  final String toId;
  final int? channel;
  final String? channelName;
  final String portnum;
  final String text;
  final int? rssi;
  final double? snr;
  final int? hopLimit;

  /// Creates a [MeshMessage] with all properties parsed from the API response.
  MeshMessage({
    required this.id,
    required this.rxTime,
    required this.rxIso,
    required this.fromId,
    required this.toId,
    required this.channel,
    required this.channelName,
    required this.portnum,
    required this.text,
    required this.rssi,
    required this.snr,
    required this.hopLimit,
  });

  /// Parses a [MeshMessage] from the raw JSON map returned by the API.
  factory MeshMessage.fromJson(Map<String, dynamic> json) {
    DateTime? parsedTime;
    if (json['rx_iso'] is String) {
      try {
        parsedTime = DateTime.parse(json['rx_iso'] as String).toLocal();
      } catch (_) {
        parsedTime = null;
      }
    }

    double? parseDouble(dynamic v) {
      if (v == null) return null;
      if (v is num) return v.toDouble();
      return double.tryParse(v.toString());
    }

    int? parseInt(dynamic v) {
      if (v == null) return null;
      if (v is int) return v;
      return int.tryParse(v.toString());
    }

    return MeshMessage(
      id: parseInt(json['id']) ?? 0,
      rxTime: parsedTime,
      rxIso: json['rx_iso']?.toString() ?? '',
      fromId: json['from_id']?.toString() ?? '',
      toId: json['to_id']?.toString() ?? '',
      channel: parseInt(json['channel']),
      channelName: json['channel_name']?.toString(),
      portnum: json['portnum']?.toString() ?? '',
      text: json['text']?.toString() ?? '',
      rssi: parseInt(json['rssi']),
      snr: parseDouble(json['snr']),
      hopLimit: parseInt(json['hop_limit']),
    );
  }

  /// Formats the message time as HH:MM in local time.
  String get timeFormatted {
    if (rxTime == null) return '--:--';
    final h = rxTime!.hour.toString().padLeft(2, '0');
    final m = rxTime!.minute.toString().padLeft(2, '0');
    return '$h:$m';
  }

  /// Returns sender without a leading `!` prefix for display.
  String get fromShort {
    if (fromId.isEmpty) return '?';
    return fromId.startsWith('!') ? fromId.substring(1) : fromId;
  }
}

/// Fetches the latest PotatoMesh messages and returns them sorted by receive time.
Future<List<MeshMessage>> fetchMessages() async {
  final uri = Uri.https('potatomesh.net', '/api/messages', {
    'limit': '100',
    'encrypted': 'false',
  });

  final resp = await http.get(uri);
  if (resp.statusCode != 200) {
    throw Exception('HTTP ${resp.statusCode}: ${resp.body}');
  }

  final dynamic decoded = jsonDecode(resp.body);
  if (decoded is! List) {
    throw Exception('Unexpected response shape, expected JSON array');
  }

  final msgs = decoded
      .whereType<Map<String, dynamic>>()
      .map((m) => MeshMessage.fromJson(m))
      .toList();

  return sortMessagesByRxTime(msgs);
}

/// Returns a new list sorted by receive time so older messages render first.
List<MeshMessage> sortMessagesByRxTime(List<MeshMessage> messages) {
  messages.sort((a, b) {
    final at = a.rxTime ?? DateTime.fromMillisecondsSinceEpoch(0);
    final bt = b.rxTime ?? DateTime.fromMillisecondsSinceEpoch(0);
    return at.compareTo(bt);
  });

  return messages;
}
