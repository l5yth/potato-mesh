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

/// Function type used to fetch messages from a specific endpoint.
typedef MessageFetcher = Future<List<MeshMessage>> Function({
  http.Client? client,
  String domain,
});

/// Meshtastic Reader root widget that configures theming and the home screen.
class PotatoMeshReaderApp extends StatefulWidget {
  const PotatoMeshReaderApp({
    super.key,
    this.fetcher = fetchMessages,
    this.instanceFetcher = fetchInstances,
    this.initialDomain = 'potatomesh.net',
  });

  /// Fetch function injected to simplify testing and offline previews.
  final MessageFetcher fetcher;

  /// Loader for federation instance metadata, overridable in tests.
  final Future<List<MeshInstance>> Function({http.Client? client})
      instanceFetcher;

  /// Initial endpoint domain used when the app boots.
  final String initialDomain;

  @override
  State<PotatoMeshReaderApp> createState() => _PotatoMeshReaderAppState();
}

class _PotatoMeshReaderAppState extends State<PotatoMeshReaderApp> {
  late String _endpointDomain;
  int _endpointVersion = 0;

  @override
  void initState() {
    super.initState();
    _endpointDomain = widget.initialDomain;
  }

  void _handleEndpointChanged(String newDomain) {
    if (newDomain.isEmpty || newDomain == _endpointDomain) {
      return;
    }

    setState(() {
      _endpointDomain = newDomain;
      _endpointVersion += 1;
    });
  }

  Future<List<MeshMessage>> _fetchMessagesForCurrentDomain() {
    return widget.fetcher(domain: _endpointDomain);
  }

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
      home: MessagesScreen(
        key: ValueKey<String>(_endpointDomain),
        fetcher: _fetchMessagesForCurrentDomain,
        resetToken: _endpointVersion,
        onOpenSettings: (context) {
          Navigator.of(context).push(
            MaterialPageRoute(
              builder: (_) => SettingsScreen(
                currentDomain: _endpointDomain,
                onDomainChanged: _handleEndpointChanged,
                loadInstances: () => widget.instanceFetcher(),
              ),
            ),
          );
        },
      ),
    );
  }
}

/// Displays the fetched mesh messages and supports pull-to-refresh.
class MessagesScreen extends StatefulWidget {
  const MessagesScreen({
    super.key,
    this.fetcher = fetchMessages,
    this.onOpenSettings,
    this.resetToken = 0,
  });

  /// Fetch function used to load messages from the PotatoMesh API.
  final Future<List<MeshMessage>> Function() fetcher;

  /// Handler invoked when the settings icon is tapped.
  final void Function(BuildContext context)? onOpenSettings;

  /// Bumps when the endpoint changes to force a refresh of cached data.
  final int resetToken;

  @override
  State<MessagesScreen> createState() => _MessagesScreenState();
}

class _MessagesScreenState extends State<MessagesScreen> {
  late Future<List<MeshMessage>> _future;

  @override
  void initState() {
    super.initState();
    _future = widget.fetcher();
  }

  /// When the fetcher changes, reload the future so the widget reflects the
  /// new data source on rebuilds.
  @override
  void didUpdateWidget(covariant MessagesScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.fetcher != widget.fetcher ||
        oldWidget.resetToken != widget.resetToken) {
      setState(() {
        _future = widget.fetcher();
      });
    }
  }

  /// Reloads the message feed and waits for completion for pull-to-refresh.
  ///
  /// Errors are intentionally swallowed so the [FutureBuilder] can surface them
  /// via its `snapshot.error` state without bubbling an exception to the
  /// gesture handler.
  Future<void> _refresh() async {
    setState(() {
      _future = widget.fetcher();
    });
    try {
      await _future;
    } catch (_) {
      // Let the FutureBuilder display error UI without breaking the gesture.
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Meshtastic Reader'),
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
              if (widget.onOpenSettings != null) {
                widget.onOpenSettings!(context);
              }
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
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            timeStr,
            style: const TextStyle(
              color: Colors.grey,
              fontWeight: FontWeight.w500,
            ),
          ),
          const SizedBox(width: 6),
          Text(
            nick,
            style: TextStyle(
              color: _nickColor(message.fromShort),
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  message.text.isEmpty ? '⟂ (no text)' : message.text,
                  style: DefaultTextStyle.of(context).style,
                ),
                if (message.channelName != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      '#${message.channelName}',
                      style: const TextStyle(color: Colors.tealAccent),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// MVP settings view offering endpoint selection and about info.
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({
    super.key,
    required this.currentDomain,
    required this.onDomainChanged,
    this.loadInstances = fetchInstances,
  });

  /// Currently selected endpoint domain.
  final String currentDomain;

  /// Callback fired when the user changes the endpoint.
  final ValueChanged<String> onDomainChanged;

  /// Loader used to fetch federation instance metadata.
  final Future<List<MeshInstance>> Function() loadInstances;

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  static const String _defaultDomain = 'potatomesh.net';
  static const String _defaultName = 'BerlinMesh';
  List<MeshInstance> _instances = const [];
  bool _loading = false;
  String _selectedDomain = '';
  String? _error;

  @override
  void initState() {
    super.initState();
    _selectedDomain = widget.currentDomain;
    _fetchInstances();
  }

  @override
  void didUpdateWidget(covariant SettingsScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.currentDomain != widget.currentDomain) {
      _selectedDomain = widget.currentDomain;
    }
  }

  Future<void> _fetchInstances() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final fetched = await widget.loadInstances();
      if (!mounted) return;
      setState(() {
        _instances = fetched;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _instances = const [];
        _error = error.toString();
      });
    } finally {
      if (mounted) {
        setState(() {
          _loading = false;
        });
      }
    }
  }

  void _onEndpointChanged(String? domain) {
    if (domain == null || domain.isEmpty) {
      return;
    }

    setState(() {
      _selectedDomain = domain;
    });
    widget.onDomainChanged(domain);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Endpoint set to $domain')),
    );
  }

  List<DropdownMenuItem<String>> _buildEndpointOptions() {
    final seen = <String>{};
    final items = <DropdownMenuItem<String>>[];

    // Always surface the default BerlinMesh endpoint.
    seen.add(_defaultDomain);
    items.add(
      const DropdownMenuItem(
        value: _defaultDomain,
        child: Text(_defaultName),
      ),
    );

    for (final instance in _instances) {
      if (instance.domain.isEmpty || seen.contains(instance.domain)) {
        continue;
      }
      seen.add(instance.domain);
      items.add(
        DropdownMenuItem(
          value: instance.domain,
          child: Text(instance.displayName),
        ),
      );
    }

    if (_selectedDomain.isNotEmpty && !seen.contains(_selectedDomain)) {
      items.insert(
        0,
        DropdownMenuItem(
          value: _selectedDomain,
          child: Text('Custom ($_selectedDomain)'),
        ),
      );
    }

    return items;
  }

  @override
  Widget build(BuildContext context) {
    final endpointItems = _buildEndpointOptions();
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        children: [
          ListTile(
            leading: const Icon(Icons.cloud),
            title: const Text('Endpoint'),
            subtitle: Text('$_selectedDomain/api/messages'),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                DropdownButtonFormField<String>(
                  key: ValueKey<String>(_selectedDomain),
                  initialValue: _selectedDomain.isNotEmpty
                      ? _selectedDomain
                      : _defaultDomain,
                  isExpanded: true,
                  decoration: const InputDecoration(
                    labelText: 'Select endpoint',
                    border: OutlineInputBorder(),
                  ),
                  items: endpointItems,
                  onChanged: _loading ? null : _onEndpointChanged,
                ),
                const SizedBox(height: 8),
                if (_loading)
                  const LinearProgressIndicator()
                else if (_error != null)
                  Text(
                    'Failed to load instances: $_error',
                    style: const TextStyle(color: Colors.redAccent),
                  )
                else if (_instances.isEmpty)
                  const Text('No federation instances returned.'),
              ],
            ),
          ),
          const Divider(),
          const ListTile(
            leading: Icon(Icons.info_outline),
            title: Text('About'),
            subtitle: Text(
                'Meshtastic Reader — read-only view of PotatoMesh messages.'),
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

/// Mesh federation instance metadata used to configure endpoints.
class MeshInstance {
  const MeshInstance({
    required this.name,
    required this.domain,
  });

  /// Human-friendly instance name.
  final String name;

  /// Instance domain hosting the PotatoMesh API.
  final String domain;

  /// Prefer the provided name, falling back to the domain.
  String get displayName => name.isNotEmpty ? name : domain;

  /// Parse a [MeshInstance] from an API payload entry.
  factory MeshInstance.fromJson(Map<String, dynamic> json) {
    final domain = json['domain']?.toString().trim() ?? '';
    final name = json['name']?.toString().trim() ?? '';
    return MeshInstance(name: name, domain: domain);
  }
}

/// Build a messages API URI for a given domain or absolute URL.
Uri _buildMessagesUri(String domain) {
  final trimmed = domain.trim();
  if (trimmed.isEmpty) {
    return Uri.https('potatomesh.net', '/api/messages', {
      'limit': '100',
      'encrypted': 'false',
    });
  }

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    final parsed = Uri.parse(trimmed);
    return parsed.replace(
      path: '/api/messages',
      queryParameters: {
        'limit': '100',
        'encrypted': 'false',
      },
    );
  }

  return Uri.https(trimmed, '/api/messages', {
    'limit': '100',
    'encrypted': 'false',
  });
}

/// Fetches the latest PotatoMesh messages and returns them sorted by receive time.
///
/// A custom [client] can be supplied for testing; otherwise a short-lived
/// [http.Client] is created and closed after the request completes.
Future<List<MeshMessage>> fetchMessages({
  http.Client? client,
  String domain = 'potatomesh.net',
}) async {
  final uri = _buildMessagesUri(domain);

  final httpClient = client ?? http.Client();
  final shouldClose = client == null;

  final resp = await httpClient.get(uri);
  if (shouldClose) {
    httpClient.close();
  }
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

/// Fetches federation instance metadata from potatomesh.net and normalizes it.
///
/// Instances lacking a domain are dropped. A provided [client] is closed
/// automatically when created internally.
Future<List<MeshInstance>> fetchInstances({http.Client? client}) async {
  final uri = Uri.https('potatomesh.net', '/api/instances');
  final httpClient = client ?? http.Client();
  final shouldClose = client == null;

  try {
    final resp = await httpClient.get(uri);
    if (resp.statusCode != 200) {
      throw Exception('HTTP ${resp.statusCode}: ${resp.body}');
    }

    final dynamic decoded = jsonDecode(resp.body);
    if (decoded is! List) {
      throw Exception('Unexpected instances response, expected JSON array');
    }

    final instances = decoded
        .whereType<Map<String, dynamic>>()
        .map((entry) => MeshInstance.fromJson(entry))
        .where((instance) => instance.domain.isNotEmpty)
        .toList()
      ..sort((a, b) =>
          a.displayName.toLowerCase().compareTo(b.displayName.toLowerCase()));

    return instances;
  } finally {
    if (shouldClose) {
      httpClient.close();
    }
  }
}

/// Returns a new list sorted by receive time so older messages render first.
///
/// Messages that lack a receive time keep their original positions to avoid
/// shuffling "unknown" entries to the start or end of the feed. Only messages
/// with a concrete [rxTime] are re-ordered chronologically.
List<MeshMessage> sortMessagesByRxTime(List<MeshMessage> messages) {
  final knownTimes = messages.where((m) => m.rxTime != null).toList()
    ..sort((a, b) => a.rxTime!.compareTo(b.rxTime!));

  var knownIndex = 0;
  return messages.map((message) {
    if (message.rxTime == null) {
      return message;
    }

    final sortedMessage = knownTimes[knownIndex];
    knownIndex += 1;
    return sortedMessage;
  }).toList();
}
