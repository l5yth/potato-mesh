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

import 'dart:async';
import 'dart:convert';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:package_info_plus/package_info_plus.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:url_launcher/url_launcher.dart';

const String _gitVersionEnv =
    String.fromEnvironment('GIT_VERSION', defaultValue: '');
const String _gitTagEnv = String.fromEnvironment('GIT_TAG', defaultValue: '');
const String _gitCommitsEnv =
    String.fromEnvironment('GIT_COMMITS', defaultValue: '');
const String _gitShaEnv = String.fromEnvironment('GIT_SHA', defaultValue: '');
const String _gitDirtyEnv =
    String.fromEnvironment('GIT_DIRTY', defaultValue: '');

void main() {
  runApp(const PotatoMeshReaderApp());
}

/// Function type used to fetch messages from a specific endpoint.
typedef MessageFetcher = Future<List<MeshMessage>> Function({
  http.Client? client,
  String domain,
});

/// PotatoMesh Reader root widget that configures theming and the home screen.
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
      title: '🥔 PotatoMesh Reader',
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
        domain: _endpointDomain,
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
    required this.domain,
  });

  /// Fetch function used to load messages from the PotatoMesh API.
  final Future<List<MeshMessage>> Function() fetcher;

  /// Handler invoked when the settings icon is tapped.
  final void Function(BuildContext context)? onOpenSettings;

  /// Bumps when the endpoint changes to force a refresh of cached data.
  final int resetToken;

  /// Active endpoint domain used for auxiliary lookups like node metadata.
  final String domain;

  @override
  State<MessagesScreen> createState() => _MessagesScreenState();
}

class _MessagesScreenState extends State<MessagesScreen>
    with WidgetsBindingObserver {
  late Future<List<MeshMessage>> _future;
  List<MeshMessage> _messages = const [];
  final ScrollController _scrollController = ScrollController();
  Timer? _refreshTimer;
  bool _isForeground = true;

  @override
  void initState() {
    super.initState();
    _future = widget.fetcher();
    _future.then((msgs) => _appendMessages(msgs)).catchError((_) {});
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _refresh();
      _startAutoRefresh();
    });
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
        _messages = const [];
      });
      _restartAutoRefresh();
      _future.then((msgs) => _appendMessages(msgs)).catchError((_) {});
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _refreshTimer?.cancel();
    _scrollController.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final nowForeground = state == AppLifecycleState.resumed ||
        state == AppLifecycleState.inactive;
    if (nowForeground != _isForeground) {
      _isForeground = nowForeground;
      if (_isForeground) {
        _refresh();
        _startAutoRefresh();
      } else {
        _refreshTimer?.cancel();
      }
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
      final newMessages = await _future;
      _appendMessages(newMessages);
    } catch (_) {
      // Let the FutureBuilder display error UI without breaking the gesture.
    }
  }

  void _appendMessages(List<MeshMessage> newMessages) {
    if (newMessages.isEmpty) return;
    final existingKeys = _messages.map(_messageKey).toSet();
    var added = 0;
    final combined = List<MeshMessage>.from(_messages);
    for (final msg in newMessages) {
      final key = _messageKey(msg);
      if (existingKeys.contains(key)) continue;
      combined.add(msg);
      existingKeys.add(key);
      added += 1;
    }
    if (added == 0 && _messages.isNotEmpty) {
      _scheduleScrollToBottom();
      return;
    }
    setState(() {
      _messages = combined;
    });
    _scheduleScrollToBottom();
  }

  String _messageKey(MeshMessage msg) {
    return '${msg.id}-${msg.rxIso}-${msg.text}';
  }

  void _scheduleScrollToBottom({int retries = 5}) {
    if (retries <= 0) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) {
        _scheduleScrollToBottom(retries: retries - 1);
        return;
      }
      _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
    });
  }

  void _startAutoRefresh() {
    _refreshTimer?.cancel();
    if (!_isForeground) return;
    _refreshTimer =
        Timer.periodic(const Duration(seconds: 60), (_) => _refresh());
  }

  void _restartAutoRefresh() {
    if (_isForeground) {
      _startAutoRefresh();
    }
  }

  String _dateLabelFor(MeshMessage message) {
    if (message.rxTime != null) {
      final local = message.rxTime!.toLocal();
      final y = local.year.toString().padLeft(4, '0');
      final m = local.month.toString().padLeft(2, '0');
      final d = local.day.toString().padLeft(2, '0');
      return '$y-$m-$d';
    }
    if (message.rxIso.isNotEmpty && message.rxIso.length >= 10) {
      return message.rxIso.substring(0, 10);
    }
    return 'Unknown';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8),
          child: SvgPicture.asset(
            'assets/potatomesh-logo.svg',
            height: 28,
            semanticsLabel: 'PotatoMesh logo',
          ),
        ),
        title: const Text('🥔 PotatoMesh Reader'),
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
          if (snapshot.connectionState == ConnectionState.waiting &&
              _messages.isEmpty) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError && _messages.isEmpty) {
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
          final messages = _messages;
          if (messages.isEmpty) {
            return const Center(child: Text('No messages yet.'));
          }

          return RefreshIndicator(
            onRefresh: _refresh,
            child: ScrollConfiguration(
              behavior: const ScrollBehavior().copyWith(scrollbars: false),
              child: ListView.builder(
                controller: _scrollController,
                padding: const EdgeInsets.symmetric(vertical: 8),
                itemCount: messages.length,
                itemBuilder: (context, index) {
                  final msg = messages[index];
                  final currentLabel = _dateLabelFor(msg);
                  final prevLabel =
                      index > 0 ? _dateLabelFor(messages[index - 1]) : null;
                  final needsDivider =
                      prevLabel == null || currentLabel != prevLabel;
                  if (!needsDivider) {
                    return ChatLine(
                      message: msg,
                      domain: widget.domain,
                    );
                  }
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      DateDivider(label: currentLabel),
                      ChatLine(
                        message: msg,
                        domain: widget.domain,
                      ),
                    ],
                  );
                },
              ),
            ),
          );
        },
      ),
    );
  }
}

/// Individual chat line styled in IRC-inspired format.
class ChatLine extends StatelessWidget {
  const ChatLine({
    super.key,
    required this.message,
    required this.domain,
  });

  /// Message data to render.
  final MeshMessage message;
  final String domain;

  /// Generates a stable color from the nickname characters by hashing to a hue.
  Color _nickColor(String nick) {
    final h = nick.codeUnits.fold<int>(0, (a, b) => (a + b) % 360);
    return HSLColor.fromAHSL(1, h.toDouble(), 0.5, 0.6).toColor();
  }

  List<TextSpan> _buildLinkedSpans(
    String text,
    TextStyle baseStyle,
    TextStyle linkStyle,
  ) {
    final spans = <TextSpan>[];
    final urlPattern = RegExp(r'(https?:\/\/[^\s]+)');
    int start = 0;

    for (final match in urlPattern.allMatches(text)) {
      if (match.start > start) {
        spans.add(TextSpan(
          text: text.substring(start, match.start),
          style: baseStyle,
        ));
      }

      final urlText = match.group(0) ?? '';
      final uri = Uri.tryParse(urlText);
      spans.add(TextSpan(
        text: urlText,
        style: linkStyle,
        recognizer: TapGestureRecognizer()
          ..onTap = () async {
            if (uri != null) {
              await launchUrl(uri, mode: LaunchMode.externalApplication);
            }
          },
      ));
      start = match.end;
    }

    if (start < text.length) {
      spans.add(TextSpan(
        text: text.substring(start),
        style: baseStyle,
      ));
    }

    if (spans.isEmpty) {
      spans.add(TextSpan(text: text, style: baseStyle));
    }

    return spans;
  }

  String _fallbackShortName(String fromId) {
    return NodeShortNameCache.fallbackShortName(fromId);
  }

  double _computeIndentPixels(TextStyle baseStyle, BuildContext context) {
    final painter = TextPainter(
      text: TextSpan(text: ' ', style: baseStyle),
      textDirection: Directionality.of(context),
    )..layout();
    return painter.size.width * 8;
  }

  @override
  Widget build(BuildContext context) {
    final timeStr = '[${message.timeFormatted}]';
    final rawId = message.fromId.isNotEmpty ? message.fromId : '?';
    final nick = rawId.startsWith('!') ? rawId : '!$rawId';
    final channel = '#${message.channelName ?? ''}'.trim();
    final bodyText = message.text.isEmpty ? '⟂ (no text)' : message.text;
    final baseStyle = DefaultTextStyle.of(context).style;
    final linkStyle = baseStyle.copyWith(
      color: Colors.tealAccent,
      decoration: TextDecoration.underline,
    );
    final indentPx = _computeIndentPixels(baseStyle, context);

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
      child: FutureBuilder<String>(
          future: NodeShortNameCache.instance.shortNameFor(
            domain: domain,
            nodeId: rawId,
          ),
          builder: (context, snapshot) {
            final shortName = snapshot.data?.isNotEmpty == true
                ? snapshot.data!
                : _fallbackShortName(rawId);
            final paddedShortName = NodeShortNameCache.padToWidth(shortName);
            return SelectionArea(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text.rich(
                    TextSpan(
                      children: [
                        TextSpan(
                          text: timeStr,
                          style: const TextStyle(
                            color: Colors.grey,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                        const TextSpan(text: ' '),
                        TextSpan(
                          text: '<$nick>',
                          style: TextStyle(
                            color: _nickColor(message.fromShort),
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const TextSpan(text: ' '),
                        TextSpan(
                          text: '($paddedShortName)',
                          style: baseStyle.copyWith(
                            color: _nickColor(message.fromShort),
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const TextSpan(text: ' '),
                        TextSpan(
                          text: channel,
                          style: const TextStyle(color: Colors.tealAccent),
                        ),
                      ],
                      style: baseStyle,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Padding(
                    padding: EdgeInsets.only(left: indentPx),
                    child: SelectableText.rich(
                      TextSpan(
                        children: _buildLinkedSpans(
                          bodyText,
                          baseStyle,
                          linkStyle,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            );
          }),
    );
  }
}

/// Bold, grey date divider between chat messages.
class DateDivider extends StatelessWidget {
  const DateDivider({super.key, required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
      child: Text(
        '-- $label --',
        style: const TextStyle(
          fontWeight: FontWeight.w700,
          color: Colors.grey,
        ),
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
  String _versionLabel = '';
  Future<InstanceVersion?>? _instanceVersionFuture;

  @override
  void initState() {
    super.initState();
    _selectedDomain = widget.currentDomain;
    _fetchInstances();
    _loadVersion();
    _instanceVersionFuture =
        InstanceVersionCache.instance.fetch(domain: _selectedDomain);
  }

  @override
  void didUpdateWidget(covariant SettingsScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.currentDomain != widget.currentDomain) {
      _selectedDomain = widget.currentDomain;
      _instanceVersionFuture =
          InstanceVersionCache.instance.fetch(domain: _selectedDomain);
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

  Future<void> _loadVersion() async {
    try {
      final info = await PackageInfo.fromPlatform();
      final label = _composeGitAwareVersion(info);
      if (!mounted) return;
      setState(() {
        _versionLabel = label;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _versionLabel = 'v0.0.0';
      });
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
    setState(() {
      _instanceVersionFuture =
          InstanceVersionCache.instance.fetch(domain: _selectedDomain);
    });
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
          FutureBuilder<InstanceVersion?>(
            key: ValueKey<String>(_selectedDomain),
            future: _instanceVersionFuture,
            builder: (context, snapshot) {
              final info = snapshot.data;
              final domainDisplay = _selectedDomain.trim().isEmpty
                  ? 'potatomesh.net'
                  : _selectedDomain.trim();
              final domainUri = _buildDomainUrl(domainDisplay);
              Widget subtitle;
              if (snapshot.connectionState == ConnectionState.waiting) {
                subtitle = const Text('Loading version info…');
              } else if (info != null) {
                subtitle = Text(info.summary);
              } else {
                subtitle = const Text('Version info unavailable');
              }
              return ListTile(
                leading: const Icon(Icons.storage),
                title: const Text('PotatoMesh Info'),
                subtitle: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    subtitle,
                    const SizedBox(height: 4),
                    RichText(
                      text: TextSpan(
                        text: domainDisplay,
                        style: const TextStyle(
                          color: Colors.tealAccent,
                          decoration: TextDecoration.underline,
                        ),
                        recognizer: TapGestureRecognizer()
                          ..onTap = () async {
                            if (domainUri != null) {
                              await launchUrl(
                                domainUri,
                                mode: LaunchMode.externalApplication,
                              );
                            }
                          },
                      ),
                    ),
                  ],
                ),
              );
            },
          ),
          const Divider(),
          const ListTile(
            leading: Icon(Icons.info_outline),
            title: Text('About'),
            subtitle: Text(
                '🥔 PotatoMesh Reader - a read-only view of a selected Meshtastic region.'),
          ),
          ListTile(
            leading: const Icon(Icons.tag),
            title: const Text('Version'),
            subtitle:
                Text(_versionLabel.isNotEmpty ? _versionLabel : 'Loading…'),
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
      'limit': '1000',
      'encrypted': 'false',
    });
  }

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    final parsed = Uri.parse(trimmed);
    return parsed.replace(
      path: '/api/messages',
      queryParameters: {
        'limit': '1000',
        'encrypted': 'false',
      },
    );
  }

  return Uri.https(trimmed, '/api/messages', {
    'limit': '1000',
    'encrypted': 'false',
  });
}

/// Build a node metadata API URI for a given domain.
Uri _buildNodeUri(String domain, String nodeId) {
  final trimmedDomain = domain.trim();
  final encodedId = Uri.encodeComponent(nodeId);

  if (trimmedDomain.isEmpty) {
    return Uri.https('potatomesh.net', '/api/nodes/$encodedId');
  }

  if (trimmedDomain.startsWith('http://') ||
      trimmedDomain.startsWith('https://')) {
    final parsed = Uri.parse(trimmedDomain);
    return parsed.replace(path: '/api/nodes/$encodedId');
  }

  return Uri.https(trimmedDomain, '/api/nodes/$encodedId');
}

/// Build a /version endpoint URI for a given domain.
Uri _buildVersionUri(String domain) {
  final trimmed = domain.trim();
  if (trimmed.isEmpty) {
    return Uri.https('potatomesh.net', '/version');
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    final parsed = Uri.parse(trimmed);
    return parsed.replace(path: '/version');
  }
  return Uri.https(trimmed, '/version');
}

String _composeGitAwareVersion(PackageInfo info) {
  const versionDefine = _gitVersionEnv;
  if (versionDefine.isNotEmpty) {
    return versionDefine.startsWith('v') ? versionDefine : 'v$versionDefine';
  }

  const tagDefine = _gitTagEnv;
  if (tagDefine.isNotEmpty) {
    final tag = tagDefine.startsWith('v') ? tagDefine : 'v$tagDefine';
    final suffixParts = <String>[];
    const commitsDefine = _gitCommitsEnv;
    const shaDefine = _gitShaEnv;
    const dirtyDefine = _gitDirtyEnv;
    final commits = commitsDefine.trim();
    final sha = shaDefine.trim();
    final dirtyFlag = dirtyDefine.toLowerCase().trim();
    final dirty = dirtyFlag == 'true' || dirtyFlag == '1' || dirtyFlag == 'yes';

    if (commits.isNotEmpty && commits != '0') {
      suffixParts.add(commits);
      if (sha.isNotEmpty) {
        suffixParts.add(sha);
      }
    } else if (sha.isNotEmpty) {
      suffixParts.add(sha);
    }

    if (dirty) {
      if (suffixParts.isEmpty) {
        suffixParts.add('dirty');
      } else {
        suffixParts[suffixParts.length - 1] = '${suffixParts.last}-dirty';
      }
    }

    return suffixParts.isEmpty ? tag : '$tag+${suffixParts.join('-')}';
  }

  final base = 'v${info.version}';
  return info.buildNumber.isNotEmpty ? '$base+${info.buildNumber}' : base;
}

Uri? _buildDomainUrl(String domain) {
  final trimmed = domain.trim();
  if (trimmed.isEmpty) return null;
  final hasScheme =
      trimmed.startsWith('http://') || trimmed.startsWith('https://');
  final candidate = hasScheme ? trimmed : 'https://$trimmed';
  return Uri.tryParse(candidate);
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

/// Memoised loader for node short names sourced from the API.
class NodeShortNameCache {
  NodeShortNameCache._();

  /// Singleton instance used by chat line rendering.
  static final NodeShortNameCache instance = NodeShortNameCache._();

  final Map<String, Future<String>> _cache = {};

  /// Resolve the short name for a node, defaulting to the fallback suffix.
  Future<String> shortNameFor({
    required String domain,
    required String nodeId,
    http.Client? client,
  }) {
    final trimmedId = nodeId.trim();
    final fallback = fallbackShortName(trimmedId);
    if (trimmedId.isEmpty) return Future.value(fallback);

    final key = '${domain.trim()}|$trimmedId';
    if (_cache.containsKey(key)) {
      return _cache[key]!;
    }

    final future = _loadShortName(
      domain: domain,
      nodeId: trimmedId,
      fallback: fallback,
      client: client,
    );
    _cache[key] = future;
    return future;
  }

  Future<String> _loadShortName({
    required String domain,
    required String nodeId,
    required String fallback,
    http.Client? client,
  }) async {
    final uri = _buildNodeUri(domain, nodeId);
    final httpClient = client ?? http.Client();
    final shouldClose = client == null;

    try {
      final resp = await httpClient.get(uri);
      if (resp.statusCode != 200) return fallback;

      final dynamic decoded = jsonDecode(resp.body);
      if (decoded is Map<String, dynamic>) {
        final raw = decoded['short_name'] ?? decoded['shortName'];
        if (raw != null) {
          final name = raw.toString().trim();
          if (name.isNotEmpty) return name;
        }
      }

      return fallback;
    } catch (_) {
      return fallback;
    } finally {
      if (shouldClose) {
        httpClient.close();
      }
    }
  }

  /// Fallback that uses the trailing four characters of the node id.
  static String fallbackShortName(String fromId) {
    final trimmed = fromId.startsWith('!') ? fromId.substring(1) : fromId;
    if (trimmed.isEmpty) return '????';
    final suffix =
        trimmed.length <= 4 ? trimmed : trimmed.substring(trimmed.length - 4);
    return padToWidth(suffix);
  }

  /// Ensures the provided short name is at least [width] characters wide.
  static String padToWidth(String value, {int width = 4}) {
    if (value.length >= width) return value;
    return value.padLeft(width);
  }
}

/// Cached metadata describing an instance's public version payload.
class InstanceVersion {
  const InstanceVersion({
    required this.name,
    required this.channel,
    required this.frequency,
    required this.instanceDomain,
  });

  final String name;
  final String? channel;
  final String? frequency;
  final String? instanceDomain;

  String get summary {
    final parts = <String>[];
    if (name.isNotEmpty) parts.add(name);
    if (channel != null && channel!.isNotEmpty) parts.add(channel!);
    if (frequency != null && frequency!.isNotEmpty) parts.add(frequency!);
    return parts.isNotEmpty ? parts.join(' · ') : 'Unknown';
  }

  factory InstanceVersion.fromJson(Map<String, dynamic> json) {
    final config = json['config'] is Map<String, dynamic>
        ? json['config'] as Map<String, dynamic>
        : <String, dynamic>{};
    final siteName = config['siteName']?.toString().trim() ?? '';
    final name = (json['name']?.toString().trim() ?? '').isNotEmpty
        ? json['name'].toString().trim()
        : siteName;
    return InstanceVersion(
      name: name,
      channel: config['channel']?.toString().trim(),
      frequency: config['frequency']?.toString().trim(),
      instanceDomain: config['instanceDomain']?.toString().trim(),
    );
  }
}

/// Memoised loader for instance version payloads.
class InstanceVersionCache {
  InstanceVersionCache._();

  static final InstanceVersionCache instance = InstanceVersionCache._();

  final Map<String, Future<InstanceVersion?>> _cache = {};

  Future<InstanceVersion?> fetch({
    required String domain,
    http.Client? client,
  }) {
    final key = domain.trim().isEmpty ? 'potatomesh.net' : domain.trim();
    if (_cache.containsKey(key)) {
      return _cache[key]!;
    }
    final future = _load(key, client: client);
    _cache[key] = future;
    return future;
  }

  Future<InstanceVersion?> _load(
    String domain, {
    http.Client? client,
  }) async {
    final uri = _buildVersionUri(domain);
    final httpClient = client ?? http.Client();
    final shouldClose = client == null;
    try {
      final resp = await httpClient.get(uri);
      if (resp.statusCode != 200) return null;
      final dynamic decoded = jsonDecode(resp.body);
      if (decoded is Map<String, dynamic>) {
        return InstanceVersion.fromJson(decoded);
      }
      return null;
    } catch (_) {
      return null;
    } finally {
      if (shouldClose) {
        httpClient.close();
      }
    }
  }
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
