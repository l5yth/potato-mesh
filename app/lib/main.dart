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
import 'dart:collection';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:package_info_plus/package_info_plus.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

const String _gitVersionEnv =
    String.fromEnvironment('GIT_VERSION', defaultValue: '');
const String _gitTagEnv = String.fromEnvironment('GIT_TAG', defaultValue: '');
const String _gitCommitsEnv =
    String.fromEnvironment('GIT_COMMITS', defaultValue: '');
const String _gitShaEnv = String.fromEnvironment('GIT_SHA', defaultValue: '');
const String _gitDirtyEnv =
    String.fromEnvironment('GIT_DIRTY', defaultValue: '');
const Duration _requestTimeout = Duration(seconds: 5);
const String _themePreferenceKey = 'mesh.themeMode';

void _logHttp(String message) {
  debugPrint('D/$message');
}

Future<List<Map<String, dynamic>>> _decodeJsonList(String body) {
  return compute(_decodeJsonListSync, body);
}

List<Map<String, dynamic>> _decodeJsonListSync(String body) {
  final dynamic decoded = jsonDecode(body);
  if (decoded is! List) {
    throw const FormatException('Expected JSON array');
  }
  return decoded.whereType<Map<String, dynamic>>().toList();
}

Future<Map<String, dynamic>> _decodeJsonMap(String body) {
  return compute(_decodeJsonMapSync, body);
}

Map<String, dynamic> _decodeJsonMapSync(String body) {
  final dynamic decoded = jsonDecode(body);
  if (decoded is! Map<String, dynamic>) {
    throw const FormatException('Expected JSON object');
  }
  return decoded;
}

void main() {
  runApp(const PotatoMeshReaderApp());
}

/// Persistent storage for the theme choice so the UI can honor user intent.
class ThemePreferenceStore {
  const ThemePreferenceStore();

  Future<ThemeMode> load() async {
    final prefs = await SharedPreferences.getInstance();
    final stored = prefs.getString(_themePreferenceKey);
    switch (stored) {
      case 'dark':
        return ThemeMode.dark;
      case 'light':
        return ThemeMode.light;
      case 'system':
        return ThemeMode.system;
      default:
        return ThemeMode.system;
    }
  }

  Future<void> save(ThemeMode mode) async {
    final prefs = await SharedPreferences.getInstance();
    final value = mode == ThemeMode.dark
        ? 'dark'
        : mode == ThemeMode.light
            ? 'light'
            : 'system';
    await prefs.setString(_themePreferenceKey, value);
  }
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
    this.repository,
    this.bootstrapper,
    this.enableAutoRefresh = true,
    this.themeStore = const ThemePreferenceStore(),
  });

  /// Fetch function injected to simplify testing and offline previews.
  final MessageFetcher fetcher;

  /// Loader for federation instance metadata, overridable in tests.
  final Future<List<MeshInstance>> Function({http.Client? client})
      instanceFetcher;

  /// Initial endpoint domain used when the app boots.
  final String initialDomain;

  /// Backing repository controlling persistence and caching.
  final MeshRepository? repository;

  /// Optional bootstrapper override for testing or previews.
  final Future<BootstrapResult> Function({ProgressCallback? onProgress})?
      bootstrapper;

  /// Whether the chat view should periodically refresh messages.
  final bool enableAutoRefresh;

  /// Storage used to persist the chosen theme.
  final ThemePreferenceStore themeStore;

  @override
  State<PotatoMeshReaderApp> createState() => _PotatoMeshReaderAppState();
}

class _PotatoMeshReaderAppState extends State<PotatoMeshReaderApp> {
  late String _endpointDomain;
  int _endpointVersion = 0;
  late final MeshRepository _repository;
  final GlobalKey<ScaffoldMessengerState> _messengerKey =
      GlobalKey<ScaffoldMessengerState>();
  BootstrapProgress _progress =
      const BootstrapProgress(stage: 'loading instances');
  Future<BootstrapResult>? _bootstrapFuture;
  BootstrapResult? _bootstrapResult;
  Object? _lastError;
  ThemeMode _themeMode = ThemeMode.system;

  @override
  void initState() {
    super.initState();
    _endpointDomain = widget.initialDomain;
    _repository = widget.repository ?? MeshRepository();
    NodeShortNameCache.instance.registerResolver(_repository);
    _loadThemeMode();
    _startBootstrap();
  }

  Future<void> _loadThemeMode() async {
    final mode = await widget.themeStore.load();
    if (!mounted) return;
    setState(() {
      _themeMode = mode;
    });
  }

  void _startBootstrap() {
    final loader = widget.bootstrapper ??
        (({ProgressCallback? onProgress}) => _repository.bootstrap(
              initialDomain: widget.initialDomain,
              onProgress: onProgress,
            ));

    setState(() {
      _bootstrapFuture = loader(onProgress: _updateProgress);
    });

    _bootstrapFuture!.then((result) {
      if (!mounted) return;
      setState(() {
        _bootstrapResult = result;
        _endpointDomain = result.selectedDomain;
        _endpointVersion += 1;
        _lastError = null;
      });
    }).catchError((error) {
      if (!mounted) return;
      setState(() {
        _lastError = error;
      });
    });
  }

  void _updateProgress(BootstrapProgress progress) {
    if (!mounted) return;
    setState(() {
      _progress = progress;
    });
  }

  String _normalizeDomain(String domain) {
    var cleaned = domain.trim().toLowerCase();
    if (cleaned.startsWith('https://')) cleaned = cleaned.substring(8);
    if (cleaned.startsWith('http://')) cleaned = cleaned.substring(7);
    if (cleaned.endsWith('/')) {
      cleaned = cleaned.substring(0, cleaned.length - 1);
    }
    return cleaned;
  }

  String? _instanceNameFor(String domain) {
    final normalized = _normalizeDomain(domain);
    final candidates = <MeshInstance>[
      ..._repository.instances,
      if (_bootstrapResult != null) ..._bootstrapResult!.instances,
    ];
    for (final instance in candidates) {
      if (_normalizeDomain(instance.domain) == normalized) {
        return instance.displayName;
      }
    }
    return null;
  }

  Future<List<MeshInstance>> _loadInstances({bool refresh = false}) async {
    if (!refresh && _repository.instances.isNotEmpty) {
      return _repository.instances;
    }
    final instances = await widget.instanceFetcher();
    await _repository.updateInstances(instances);
    return instances;
  }

  Future<void> _handleThemeChanged(ThemeMode mode) async {
    setState(() {
      _themeMode = mode;
    });
    await widget.themeStore.save(mode);
  }

  Future<void> _handleEndpointChanged(String newDomain) async {
    if (newDomain.isEmpty || newDomain == _endpointDomain) {
      return;
    }

    final previousDomain = _endpointDomain;
    final previousSelectedDomain = _repository.selectedDomain;
    await _repository.rememberSelectedDomain(newDomain);
    final future = _repository
        .loadDomainData(
          domain: newDomain,
          forceFull: true,
          onProgress: _updateProgress,
        )
        .then(
          (domainResult) => BootstrapResult(
            instances: _repository.instances,
            nodes: domainResult.nodes,
            messages: domainResult.messages,
            selectedDomain: domainResult.domain,
          ),
        );

    setState(() {
      _bootstrapFuture = future;
      _endpointDomain = newDomain;
      _endpointVersion += 1;
      _lastError = null;
    });

    try {
      final result = await future;
      if (!mounted) return;
      setState(() {
        _bootstrapResult = result;
        _endpointDomain = result.selectedDomain;
        _lastError = null;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _lastError = error;
        _endpointDomain = previousDomain;
      });
      await _repository.rememberSelectedDomain(previousSelectedDomain);
      _messengerKey.currentState?.showSnackBar(
        SnackBar(content: Text('Failed to switch instance: $error')),
      );
    }
  }

  Future<List<MeshMessage>> _fetchMessagesForCurrentDomain({
    http.Client? client,
    String domain = '',
  }) {
    final activeDomain = domain.isNotEmpty ? domain : _endpointDomain;
    final hasCustomFetcher = !identical(widget.fetcher, fetchMessages);
    if (hasCustomFetcher) {
      return widget.fetcher(domain: activeDomain, client: client);
    }
    return _repository.loadMessages(domain: activeDomain);
  }

  @override
  Widget build(BuildContext context) {
    final seed = Colors.teal;
    final lightTheme = ThemeData(
      brightness: Brightness.light,
      colorScheme: ColorScheme.fromSeed(
        seedColor: seed,
        brightness: Brightness.light,
      ),
      useMaterial3: true,
      textTheme: const TextTheme(
        bodyMedium: TextStyle(
          fontFamily: 'monospace',
          fontSize: 13,
          height: 1.15,
        ),
      ),
    );
    final darkTheme = ThemeData(
      brightness: Brightness.dark,
      colorScheme: ColorScheme.fromSeed(
        seedColor: seed,
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
    );

    return MaterialApp(
      title: '🥔 PotatoMesh Reader',
      debugShowCheckedModeBanner: false,
      scaffoldMessengerKey: _messengerKey,
      theme: lightTheme,
      darkTheme: darkTheme,
      themeMode: _themeMode,
      home: FutureBuilder<BootstrapResult>(
        future: _bootstrapFuture,
        builder: (context, snapshot) {
          final effectiveResult = snapshot.data ?? _bootstrapResult;
          if (effectiveResult == null) {
            return LoadingScreen(
              progress: _progress,
              error: _lastError ?? snapshot.error,
            );
          }

          final domain = _repository.selectedDomain.isNotEmpty
              ? _repository.selectedDomain
              : effectiveResult.selectedDomain;
          final instanceName = _instanceNameFor(domain);
          final initialMessages = (effectiveResult.selectedDomain == domain)
              ? effectiveResult.messages
              : const <MeshMessage>[];
          return MessagesScreen(
            key: ValueKey<String>(domain),
            fetcher: _fetchMessagesForCurrentDomain,
            resetToken: _endpointVersion,
            domain: domain,
            repository: _repository,
            instanceName: instanceName,
            enableAutoRefresh: widget.enableAutoRefresh,
            initialMessages: initialMessages,
            onOpenSettings: (context) {
              Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => SettingsScreen(
                    currentDomain: _repository.selectedDomain.isNotEmpty
                        ? _repository.selectedDomain
                        : domain,
                    onDomainChanged: _handleEndpointChanged,
                    loadInstances: ({bool refresh = false}) =>
                        _loadInstances(refresh: refresh),
                    themeMode: _themeMode,
                    onThemeChanged: _handleThemeChanged,
                  ),
                ),
              );
            },
          );
        },
      ),
    );
  }
}

/// Splash-style loading view shown while federation data is hydrated.
class LoadingScreen extends StatelessWidget {
  const LoadingScreen({
    super.key,
    required this.progress,
    this.error,
  });

  final BootstrapProgress progress;
  final Object? error;

  @override
  Widget build(BuildContext context) {
    final label = error != null
        ? 'Failed to load: $error'
        : (progress.label.isNotEmpty ? progress.label : 'Loading…');
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Padding(
              padding: const EdgeInsets.only(bottom: 24),
              child: Image.asset(
                'assets/icon-splash.png',
                height: 120,
                semanticLabel: 'PotatoMesh',
              ),
            ),
            const CircularProgressIndicator(),
            const SizedBox(height: 28),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 24),
              child: Text(
                label,
                textAlign: TextAlign.center,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Progress payload used to render bootstrap and domain load status.
class BootstrapProgress {
  const BootstrapProgress({
    required this.stage,
    this.current,
    this.total,
    this.detail,
  });

  final String stage;
  final int? current;
  final int? total;
  final String? detail;

  /// Human-friendly label summarising the current progress state.
  String get label {
    final buffer = StringBuffer(stage);
    if (current != null && total != null && total! > 0) {
      buffer.write(' ${current!}/${total!}');
    }
    if (detail != null && detail!.isNotEmpty) {
      buffer.write(' • ${detail!}');
    }
    return buffer.toString();
  }
}

/// Result container returned once federation, nodes, and messages are loaded.
class BootstrapResult {
  const BootstrapResult({
    required this.instances,
    required this.nodes,
    required this.messages,
    required this.selectedDomain,
  });

  final List<MeshInstance> instances;
  final List<MeshNode> nodes;
  final List<MeshMessage> messages;
  final String selectedDomain;
}

/// Domain-level fetch outcome used when switching between instances.
class DomainLoadResult {
  const DomainLoadResult({
    required this.domain,
    required this.nodes,
    required this.messages,
  });

  final String domain;
  final List<MeshNode> nodes;
  final List<MeshMessage> messages;
}

typedef ProgressCallback = void Function(BootstrapProgress progress);

/// Thin wrapper around [SharedPreferences] used to persist federation data.
class MeshLocalStore {
  MeshLocalStore(this._prefs);

  final SharedPreferences _prefs;

  static const String _instancesKey = 'mesh.instances';
  static const String _selectedDomainKey = 'mesh.selectedDomain';

  String _safeKey(String domain) {
    final base = domain.trim().isEmpty ? 'potatomesh.net' : domain.trim();
    return base.replaceAll(RegExp(r'[^a-zA-Z0-9._-]'), '_');
  }

  Future<void> saveInstances(List<MeshInstance> instances) async {
    final encoded = jsonEncode(instances.map((i) => i.toJson()).toList());
    await _prefs.setString(_instancesKey, encoded);
  }

  List<MeshInstance> loadInstances() {
    final raw = _prefs.getString(_instancesKey);
    if (raw == null || raw.isEmpty) return const [];
    try {
      final dynamic decoded = jsonDecode(raw);
      if (decoded is! List) return const [];
      return decoded
          .whereType<Map<String, dynamic>>()
          .map(MeshInstance.fromJson)
          .where((instance) => instance.domain.isNotEmpty)
          .toList();
    } catch (_) {
      return const [];
    }
  }

  Future<void> saveSelectedDomain(String domain) async {
    await _prefs.setString(_selectedDomainKey, domain.trim());
  }

  String? loadSelectedDomain() {
    return _prefs.getString(_selectedDomainKey);
  }

  Future<void> saveNodes(String domain, List<MeshNode> nodes) async {
    final encoded = jsonEncode(nodes.map((n) => n.toJson()).toList());
    await _prefs.setString('mesh.nodes.${_safeKey(domain)}', encoded);
  }

  List<MeshNode> loadNodes(String domain) {
    final raw = _prefs.getString('mesh.nodes.${_safeKey(domain)}');
    if (raw == null || raw.isEmpty) return const [];
    try {
      final dynamic decoded = jsonDecode(raw);
      if (decoded is! List) return const [];
      return decoded
          .whereType<Map<String, dynamic>>()
          .map(MeshNode.fromJson)
          .where((node) => node.nodeId.isNotEmpty)
          .toList();
    } catch (_) {
      return const [];
    }
  }

  Future<void> saveMessages(String domain, List<MeshMessage> messages) async {
    final trimmed = messages.length > 1200
        ? messages.sublist(messages.length - 1200)
        : messages;
    final encoded = jsonEncode(trimmed.map((m) => m.toJson()).toList());
    await _prefs.setString('mesh.messages.${_safeKey(domain)}', encoded);
  }

  List<MeshMessage> loadMessages(String domain) {
    final raw = _prefs.getString('mesh.messages.${_safeKey(domain)}');
    if (raw == null || raw.isEmpty) return const [];
    try {
      final dynamic decoded = jsonDecode(raw);
      if (decoded is! List) return const [];
      return decoded
          .whereType<Map<String, dynamic>>()
          .map(MeshMessage.fromJson)
          .toList();
    } catch (_) {
      return const [];
    }
  }
}

/// Provider used by [NodeShortNameCache] to resolve cached node metadata.
abstract class MeshNodeResolver {
  MeshNode? findNode(String domain, String nodeId);
}

/// Repository responsible for federation discovery, caching, and persistence.
class MeshRepository implements MeshNodeResolver {
  MeshRepository({
    SharedPreferences? prefs,
    http.Client? client,
    Random? random,
  })  : _prefs = prefs,
        _client = client,
        _random = random ?? Random();

  SharedPreferences? _prefs;
  MeshLocalStore? _store;
  final http.Client? _client;
  final Random _random;

  final Map<String, List<MeshNode>> _nodesByDomain = {};
  final Map<String, List<MeshMessage>> _messagesByDomain = {};
  final Map<String, bool> _messagesLoaded = {};
  final Map<String, Set<String>> _nodeFetchInFlight = {};
  List<MeshInstance> _instances = const [];
  String _selectedDomain = 'potatomesh.net';

  List<MeshInstance> get instances => _instances;
  String get selectedDomain => _selectedDomain;

  Future<MeshLocalStore> _ensureStore() async {
    if (_store != null) return _store!;
    _prefs ??= await SharedPreferences.getInstance();
    _store = MeshLocalStore(_prefs!);
    return _store!;
  }

  /// Persist the selected domain choice without performing network calls.
  Future<void> rememberSelectedDomain(String domain) async {
    _selectedDomain = _domainKey(domain);
    final store = await _ensureStore();
    await store.saveSelectedDomain(_selectedDomain);
  }

  String _domainKey(String domain) {
    var cleaned = domain.trim();
    if (cleaned.isEmpty) return 'potatomesh.net';
    cleaned = cleaned.toLowerCase();
    if (cleaned.startsWith('https://')) cleaned = cleaned.substring(8);
    if (cleaned.startsWith('http://')) cleaned = cleaned.substring(7);
    if (cleaned.endsWith('/')) {
      cleaned = cleaned.substring(0, cleaned.length - 1);
    }
    if (cleaned.isEmpty) return 'potatomesh.net';
    return cleaned;
  }

  /// Kicks off the full bootstrap flow including federation discovery, node
  /// validation, and initial message downloads.
  Future<BootstrapResult> bootstrap({
    String initialDomain = 'potatomesh.net',
    ProgressCallback? onProgress,
  }) async {
    final store = await _ensureStore();
    final cachedInstances = store.loadInstances();
    final hasCachedInstances = cachedInstances.isNotEmpty;
    if (hasCachedInstances) {
      _instances = cachedInstances;
    }

    final cachedDomain = store.loadSelectedDomain();
    _selectedDomain = (cachedDomain != null && cachedDomain.isNotEmpty)
        ? cachedDomain
        : initialDomain;

    final httpClient = _client ?? http.Client();
    final shouldCloseClient = _client == null;

    if (!hasCachedInstances) {
      final discovered = await _discoverInstances(
        client: httpClient,
        onProgress: onProgress,
      );
      final validated = await _validateInstances(
        discovered,
        httpClient,
        onProgress,
      );
      if (validated.isNotEmpty) {
        _instances = validated;
        await store.saveInstances(validated);
      }
    }

    _selectedDomain = _resolveSelectedDomain(_instances, _selectedDomain);
    await store.saveSelectedDomain(_selectedDomain);

    // Hydrate caches from storage before hitting the network so the UI has
    // something to render if connectivity is constrained.
    final cachedNodes = store.loadNodes(_selectedDomain);
    if (cachedNodes.isNotEmpty) {
      final key = _domainKey(_selectedDomain);
      _nodesByDomain[key] = cachedNodes;
      NodeShortNameCache.instance
          .prime(domain: _selectedDomain, nodes: cachedNodes);
    }
    final cachedMessages = store.loadMessages(_selectedDomain);
    if (cachedMessages.isNotEmpty) {
      _messagesByDomain[_domainKey(_selectedDomain)] = cachedMessages;
      _messagesLoaded[_domainKey(_selectedDomain)] = true;
    }

    final domainResult = await _loadFirstResponsiveInstance(
      preferredDomain: _selectedDomain,
      candidates: _instances,
      httpClient: httpClient,
      onProgress: onProgress,
    );

    if (shouldCloseClient) {
      httpClient.close();
    }

    return BootstrapResult(
      instances: _instances,
      nodes: domainResult.nodes,
      messages: domainResult.messages,
      selectedDomain: _selectedDomain,
    );
  }

  /// Loads nodes and messages for a domain, persisting the selection.
  Future<DomainLoadResult> loadDomainData({
    required String domain,
    ProgressCallback? onProgress,
    http.Client? httpClient,
    bool forceFull = false,
  }) async {
    final store = await _ensureStore();
    final targetDomain =
        domain.trim().isEmpty ? 'potatomesh.net' : domain.trim();

    final client = httpClient ?? _client ?? http.Client();
    final shouldClose = httpClient == null && _client == null;

    try {
      final nodes = await _fetchNodesList(
        domain: targetDomain,
        client: client,
        persist: true,
        useCacheWhenAvailable: !forceFull,
        onProgress: onProgress,
      );

      final messages = await _loadMessagesInternal(
        domain: targetDomain,
        client: client,
        forceFull: forceFull,
        onProgress: onProgress,
      );

      _selectedDomain = targetDomain;
      await store.saveSelectedDomain(_selectedDomain);

      return DomainLoadResult(
        domain: targetDomain,
        nodes: nodes,
        messages: messages,
      );
    } finally {
      if (shouldClose) {
        client.close();
      }
    }
  }

  /// Fetches a complete messages list on first load, falling back to a smaller
  /// refresh window on subsequent calls.
  Future<List<MeshMessage>> loadMessages({required String domain}) async {
    await _ensureStore();
    final key = _domainKey(domain);
    final loaded = _messagesLoaded[key] ?? false;
    final client = _client ?? http.Client();
    final shouldClose = _client == null;
    try {
      // Ensure cached data is available for immediate rendering.
      if (!loaded && !_messagesByDomain.containsKey(key)) {
        final cached = _store?.loadMessages(domain) ?? const [];
        if (cached.isNotEmpty) {
          _messagesByDomain[key] = cached;
        }
      }
      return _loadMessagesInternal(
        domain: domain,
        client: client,
        forceFull: !loaded,
      );
    } finally {
      if (shouldClose) {
        client.close();
      }
    }
  }

  /// Stores a nodes snapshot for quick lookup without refetching mid-session.
  Future<List<MeshNode>> loadNodes({required String domain}) async {
    await _ensureStore();
    final key = _domainKey(domain);
    if (_nodesByDomain.containsKey(key)) {
      return _nodesByDomain[key]!;
    }

    final cached = _store?.loadNodes(domain) ?? const [];
    if (cached.isNotEmpty) {
      _nodesByDomain[key] = cached;
      NodeShortNameCache.instance.prime(domain: domain, nodes: cached);
      return cached;
    }

    final client = _client ?? http.Client();
    final shouldClose = _client == null;
    try {
      return _fetchNodesList(
        domain: domain,
        client: client,
        persist: true,
        useCacheWhenAvailable: true,
      );
    } finally {
      if (shouldClose) {
        client.close();
      }
    }
  }

  /// Public entry point for fetching and caching federation instances.
  Future<List<MeshInstance>> discoverInstances({
    http.Client? client,
    ProgressCallback? onProgress,
  }) async {
    final store = await _ensureStore();
    final cached = store.loadInstances();
    final httpClient = client ?? _client ?? http.Client();
    final shouldClose = client == null && _client == null;
    try {
      final discovered = await _discoverInstances(
        client: httpClient,
        onProgress: onProgress,
      );
      final validated = await _validateInstances(
        discovered,
        httpClient,
        onProgress,
      );
      if (validated.isNotEmpty) {
        _instances = validated;
        await store.saveInstances(validated);
        return validated;
      }
      if (cached.isNotEmpty) return cached;
      return discovered;
    } finally {
      if (shouldClose) {
        httpClient.close();
      }
    }
  }

  /// Overwrites the cached instances and persists them to local storage.
  Future<void> updateInstances(List<MeshInstance> instances) async {
    _instances = instances;
    final store = await _ensureStore();
    await store.saveInstances(instances);
  }

  @override
  MeshNode? findNode(String domain, String nodeId) {
    final key = _domainKey(domain);
    final nodes = _nodesByDomain[key];
    if (nodes == null) return null;
    final trimmed = nodeId.trim();
    for (final node in nodes) {
      if (_matchesNodeId(node.nodeId, trimmed)) {
        return node;
      }
    }
    return null;
  }

  Future<List<MeshInstance>> _discoverInstances({
    required http.Client client,
    ProgressCallback? onProgress,
  }) async {
    final seen = <String>{};
    final queue = Queue<String>();
    final results = <MeshInstance>[];

    Future<void> enqueueFromDomain(String domain) async {
      try {
        final uri = _buildInstancesUri(domain);
        _logHttp('GET $uri');
        final resp = await client.get(uri).timeout(_requestTimeout);
        _logHttp('HTTP ${resp.statusCode} $uri');
        if (resp.statusCode != 200) return;
        final decoded = await _decodeJsonList(resp.body);
        final parsed = decoded
            .map(MeshInstance.fromJson)
            .where((instance) => instance.domain.isNotEmpty)
            .toList();
        for (final instance in parsed) {
          final key = _domainKey(instance.domain);
          if (seen.contains(key)) continue;
          seen.add(key);
          results.add(instance);
          queue.add(instance.domain);
        }
      } catch (_) {
        // Skip unreachable domains during discovery.
      }
    }

    onProgress?.call(const BootstrapProgress(stage: 'loading instances'));
    await enqueueFromDomain('potatomesh.net');

    while (queue.isNotEmpty) {
      final domain = queue.removeFirst();
      onProgress?.call(
        BootstrapProgress(
          stage: 'discovering instances',
          current: results.length,
          total: null,
          detail: domain,
        ),
      );
      await enqueueFromDomain(domain);
    }

    final deduped = <String, MeshInstance>{};
    for (final instance in results) {
      final key = _domainKey(instance.domain);
      if (instance.isPrivate) continue;
      deduped[key] = instance;
    }

    final list = deduped.values.toList()
      ..sort((a, b) =>
          a.displayName.toLowerCase().compareTo(b.displayName.toLowerCase()));
    return list;
  }

  Future<List<MeshInstance>> _validateInstances(
    List<MeshInstance> candidates,
    http.Client client,
    ProgressCallback? onProgress,
  ) async {
    if (candidates.isEmpty) return const [];
    final now = DateTime.now().toUtc();
    final valid = <MeshInstance>[];
    final total = candidates.length;
    for (var i = 0; i < candidates.length; i++) {
      final candidate = candidates[i];
      onProgress?.call(
        BootstrapProgress(
          stage: 'verifying instances',
          current: i + 1,
          total: total,
          detail: candidate.domain,
        ),
      );
      try {
        final nodes = await _fetchNodesList(
          domain: candidate.domain,
          client: client,
          limit: 200,
          persist: false,
          useCacheWhenAvailable: false,
        );
        final active = nodes
            .where((node) => node.isActive(const Duration(hours: 24), now))
            .toList();
        if (active.length >= 10) {
          valid.add(candidate);
        }
      } catch (_) {
        // Invalid instance; skip.
      }
    }
    return valid.isNotEmpty ? valid : candidates;
  }

  Future<DomainLoadResult> _loadFirstResponsiveInstance({
    required String preferredDomain,
    required List<MeshInstance> candidates,
    required http.Client httpClient,
    ProgressCallback? onProgress,
  }) async {
    final store = await _ensureStore();
    final ordered = <String>{
      preferredDomain,
      ...candidates.map((c) => c.domain)
    };
    DomainLoadResult? result;
    Object? lastError;
    for (final domain in ordered) {
      try {
        result = await loadDomainData(
          domain: domain,
          onProgress: onProgress,
          httpClient: httpClient,
          forceFull: true,
        );
        break;
      } catch (error) {
        lastError = error;
        continue;
      }
    }

    if (result != null) {
      return result;
    }

    final cachedNodes = store.loadNodes(preferredDomain);
    final cachedMessages = store.loadMessages(preferredDomain);
    if (cachedNodes.isNotEmpty || cachedMessages.isNotEmpty) {
      _selectedDomain = preferredDomain;
      await store.saveSelectedDomain(_selectedDomain);
      return DomainLoadResult(
        domain: preferredDomain,
        nodes: cachedNodes,
        messages: cachedMessages,
      );
    }

    throw lastError ?? Exception('No responsive instances');
  }

  String _resolveSelectedDomain(
    List<MeshInstance> available,
    String desired,
  ) {
    if (available.isEmpty) {
      return desired.trim().isNotEmpty ? desired.trim() : 'potatomesh.net';
    }
    final desiredKey = _domainKey(desired);
    for (final instance in available) {
      if (_domainKey(instance.domain) == desiredKey) {
        return instance.domain;
      }
    }
    return available[_random.nextInt(available.length)].domain;
  }

  Future<List<MeshNode>> _fetchNodesList({
    required String domain,
    required http.Client client,
    int limit = 1000,
    bool persist = true,
    bool useCacheWhenAvailable = true,
    ProgressCallback? onProgress,
  }) async {
    final key = _domainKey(domain);
    if (useCacheWhenAvailable && _nodesByDomain.containsKey(key)) {
      return _nodesByDomain[key]!;
    }
    final uri = _buildNodesUri(domain, limit: limit);
    _logHttp('GET $uri');
    final resp = await client.get(uri).timeout(_requestTimeout);
    _logHttp('HTTP ${resp.statusCode} $uri');
    if (resp.statusCode != 200) {
      throw Exception('HTTP ${resp.statusCode}: ${resp.body}');
    }
    final decoded = await _decodeJsonList(resp.body);
    final nodes = <MeshNode>[];
    var index = 0;
    for (final entry in decoded) {
      index += 1;
      final node = MeshNode.fromJson(entry);
      if (node.nodeId.isEmpty) continue;
      nodes.add(node);
      onProgress?.call(
        BootstrapProgress(
          stage: 'loading nodes',
          current: index,
          total: decoded.length,
          detail: domain,
        ),
      );
    }

    if (persist) {
      _nodesByDomain[key] = nodes;
      NodeShortNameCache.instance.prime(domain: domain, nodes: nodes);
      await _store?.saveNodes(domain, nodes);
    }

    return nodes;
  }

  Future<List<MeshMessage>> _loadMessagesInternal({
    required String domain,
    required http.Client client,
    bool forceFull = false,
    ProgressCallback? onProgress,
  }) async {
    final key = _domainKey(domain);
    final alreadyLoaded = _messagesLoaded[key] ?? false;
    final initialFetch = forceFull || !alreadyLoaded;
    final limit = initialFetch ? 1000 : 100;

    final uri = _buildMessagesUri(domain, limit: limit);
    _logHttp('GET $uri');
    final resp = await client.get(uri).timeout(_requestTimeout);
    _logHttp('HTTP ${resp.statusCode} $uri');
    if (resp.statusCode != 200) {
      throw Exception('HTTP ${resp.statusCode}: ${resp.body}');
    }
    final decoded = await _decodeJsonList(resp.body);

    final messages = <MeshMessage>[];
    var index = 0;
    for (final entry in decoded) {
      index += 1;
      final message = MeshMessage.fromJson(entry);
      messages.add(message);
      onProgress?.call(
        BootstrapProgress(
          stage: 'loading messages',
          current: index,
          total: decoded.length,
          detail: domain,
        ),
      );
    }

    final merged = _mergeMessages(domain, messages);
    _messagesLoaded[key] = true;
    await _store?.saveMessages(domain, merged);

    // Ensure new senders are cached locally for name lookups.
    await _hydrateMissingNodes(
        domain: domain, messages: messages, client: client);

    return merged;
  }

  List<MeshMessage> _mergeMessages(String domain, List<MeshMessage> incoming) {
    final key = _domainKey(domain);
    final existing = List<MeshMessage>.from(_messagesByDomain[key] ?? const []);
    final seen = existing.map(_messageKey).toSet();
    for (final msg in incoming) {
      final key = _messageKey(msg);
      if (seen.contains(key)) continue;
      existing.add(msg);
      seen.add(key);
    }
    final sorted = sortMessagesByRxTime(existing);
    if (sorted.length > 1200) {
      sorted.removeRange(0, sorted.length - 1200);
    }
    _messagesByDomain[key] = sorted;
    return sorted;
  }

  String _messageKey(MeshMessage msg) {
    return '${msg.id}-${msg.rxIso}-${msg.fromId}-${msg.text}';
  }

  Future<void> _hydrateMissingNodes({
    required String domain,
    required List<MeshMessage> messages,
    required http.Client client,
  }) async {
    final store = await _ensureStore();
    final key = _domainKey(domain);
    var nodes = List<MeshNode>.from(_nodesByDomain[key] ?? const []);
    if (nodes.isEmpty) {
      final cached = store.loadNodes(domain);
      if (cached.isNotEmpty) {
        nodes = List<MeshNode>.from(cached);
        _nodesByDomain[key] = nodes;
        NodeShortNameCache.instance.prime(domain: domain, nodes: cached);
      }
    }
    final knownIds = nodes.map((n) => _normalizeNodeId(n.nodeId)).toSet();
    final inFlight = _nodeFetchInFlight.putIfAbsent(key, () => {});
    for (final message in messages) {
      final rawNodeId = message.lookupNodeId.trim();
      final nodeId = _normalizeNodeId(rawNodeId);
      if (nodeId.isEmpty || knownIds.contains(nodeId)) continue;
      if (inFlight.contains(nodeId)) continue;
      inFlight.add(nodeId);
      try {
        final uri = _buildNodeUri(domain, rawNodeId);
        _logHttp('GET $uri');
        final resp = await client.get(uri).timeout(_requestTimeout);
        _logHttp('HTTP ${resp.statusCode} $uri');
        if (resp.statusCode != 200) {
          knownIds.add(nodeId);
          continue;
        }
        final decoded = await _decodeJsonMap(resp.body);
        final node = MeshNode.fromJson(decoded);
        if (node.nodeId.isEmpty) continue;
        nodes = List<MeshNode>.from(nodes)..add(node);
        _nodesByDomain[key] = nodes;
        NodeShortNameCache.instance.prime(domain: domain, nodes: [node]);
        await _store?.saveNodes(domain, nodes);
        knownIds.add(_normalizeNodeId(node.nodeId));
      } catch (_) {
        // Swallow node lookup errors during refresh.
      } finally {
        inFlight.remove(nodeId);
      }
    }
  }

  bool _matchesNodeId(String existing, String candidate) {
    final cleanExisting = _normalizeNodeId(existing);
    final cleanCandidate = _normalizeNodeId(candidate);
    return cleanExisting.trim() == cleanCandidate.trim();
  }

  String _normalizeNodeId(String id) {
    return id.startsWith('!') ? id.substring(1) : id;
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
    this.repository,
    this.initialMessages = const [],
    this.instanceName,
    this.enableAutoRefresh = true,
  });

  /// Fetch function used to load messages from the PotatoMesh API.
  final Future<List<MeshMessage>> Function() fetcher;

  /// Handler invoked when the settings icon is tapped.
  final void Function(BuildContext context)? onOpenSettings;

  /// Bumps when the endpoint changes to force a refresh of cached data.
  final int resetToken;

  /// Active endpoint domain used for auxiliary lookups like node metadata.
  final String domain;

  /// Optional repository backing persistence for this screen.
  final MeshRepository? repository;

  /// Messages obtained during the bootstrap phase to avoid re-fetching.
  final List<MeshMessage> initialMessages;

  /// Human-friendly name of the selected instance if the user picked one.
  final String? instanceName;

  /// Whether periodic background refresh is enabled.
  final bool enableAutoRefresh;

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
  int _fetchVersion = 0;

  @override
  void initState() {
    super.initState();
    _messages = List<MeshMessage>.from(widget.initialMessages);
    _future = Future.value(_messages);
    _startFetch(clear: _messages.isEmpty);
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
        oldWidget.resetToken != widget.resetToken ||
        oldWidget.enableAutoRefresh != widget.enableAutoRefresh) {
      _restartAutoRefresh();
      setState(() {
        _messages = List<MeshMessage>.from(widget.initialMessages);
        _future = Future.value(_messages);
      });
      _startFetch(clear: _messages.isEmpty);
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
  Future<void> _refresh({bool appendOnly = false}) async {
    await _startFetch(appendOnly: appendOnly);
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
    return '${msg.id}-${msg.rxIso}-${msg.fromId}-${msg.text}';
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
    if (!widget.enableAutoRefresh) return;
    _refreshTimer?.cancel();
    if (!_isForeground) return;
    _refreshTimer = Timer.periodic(
      const Duration(seconds: 60),
      (_) => _refresh(appendOnly: true),
    );
  }

  void _restartAutoRefresh() {
    if (_isForeground) {
      _startAutoRefresh();
    }
  }

  Future<void> _startFetch(
      {bool clear = false, bool appendOnly = false}) async {
    final version = ++_fetchVersion;
    final future = widget.fetcher();
    if (!appendOnly) {
      setState(() {
        if (clear) {
          _messages = const [];
        }
        _future = future;
      });
    }
    try {
      final msgs = await future;
      if (version != _fetchVersion) return;
      _appendMessages(msgs);
    } catch (error) {
      if (appendOnly) {
        debugPrint('D/Failed to append messages: $error');
        return;
      }
      rethrow;
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

  Color _zebraColor(BuildContext context, int index) {
    final isEven = index.isEven;
    final brightness = Theme.of(context).brightness;
    if (brightness == Brightness.dark) {
      return isEven
          ? Colors.black
          : Color.lerp(Colors.black, Colors.white, 0.05)!;
    }
    return isEven
        ? Colors.white
        : Color.lerp(Colors.white, Colors.black, 0.05)!;
  }

  @override
  Widget build(BuildContext context) {
    final titleText =
        (widget.instanceName != null && widget.instanceName!.trim().isNotEmpty)
            ? '🥔 ${widget.instanceName!.trim()}'
            : '🥔 PotatoMesh Reader';
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
        title: Text(titleText),
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
                padding: EdgeInsets.zero,
                itemCount: messages.length,
                itemBuilder: (context, index) {
                  final msg = messages[index];
                  final currentLabel = _dateLabelFor(msg);
                  final prevLabel =
                      index > 0 ? _dateLabelFor(messages[index - 1]) : null;
                  final needsDivider =
                      prevLabel == null || currentLabel != prevLabel;
                  final zebraColor = _zebraColor(context, index);
                  final content = needsDivider
                      ? Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            DateDivider(label: currentLabel),
                            ChatLine(
                              message: msg,
                              domain: widget.domain,
                            ),
                          ],
                        )
                      : ChatLine(
                          message: msg,
                          domain: widget.domain,
                        );
                  return Container(color: zebraColor, child: content);
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

  static final Map<String, double> _indentCache = {};

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
    final key =
        '${baseStyle.fontFamily}-${baseStyle.fontSize}-${baseStyle.fontWeight}-${baseStyle.fontStyle}';
    final cached = _indentCache[key];
    if (cached != null) return cached;
    final painter = TextPainter(
      text: TextSpan(text: ' ', style: baseStyle),
      textDirection: Directionality.of(context),
    )..layout();
    final width = painter.size.width * 8;
    _indentCache[key] = width;
    return width;
  }

  @override
  Widget build(BuildContext context) {
    final timeStr = '[${message.timeFormatted}]';
    final rawId = message.fromId.isNotEmpty ? message.fromId : '?';
    final lookupId =
        message.lookupNodeId.isNotEmpty ? message.lookupNodeId : rawId;
    final nick = rawId.startsWith('!') ? rawId : '!$rawId';
    final channel = '#${message.channelName ?? ''}'.trim();
    final bodyText = message.text.isEmpty ? '⟂ (no text)' : message.text;
    final colorScheme = Theme.of(context).colorScheme;
    final baseStyle = DefaultTextStyle.of(context)
        .style
        .copyWith(color: colorScheme.onSurface);
    final linkStyle = baseStyle.copyWith(
      color: colorScheme.tertiary,
      decoration: TextDecoration.underline,
    );
    final indentPx = _computeIndentPixels(baseStyle, context);

    return FutureBuilder<String>(
        future: NodeShortNameCache.instance.shortNameFor(
          domain: domain,
          nodeId: lookupId,
        ),
        builder: (context, snapshot) {
          final shortName = snapshot.data?.isNotEmpty == true
              ? snapshot.data!
              : _fallbackShortName(lookupId);
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
                        style: TextStyle(
                            color: Theme.of(context).colorScheme.tertiary),
                      ),
                    ],
                    style: baseStyle,
                  ),
                ),
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
        });
  }
}

/// Bold, grey date divider between chat messages.
class DateDivider extends StatelessWidget {
  const DateDivider({super.key, required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).colorScheme.onSurfaceVariant;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
      child: Text(
        '-- $label --',
        style: TextStyle(
          fontWeight: FontWeight.w700,
          color: color,
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
    this.loadInstances = _defaultInstanceLoader,
    this.themeMode = ThemeMode.system,
    this.onThemeChanged,
  });

  /// Currently selected endpoint domain.
  final String currentDomain;

  /// Callback fired when the user changes the endpoint.
  final ValueChanged<String> onDomainChanged;

  /// Loader used to fetch federation instance metadata.
  final Future<List<MeshInstance>> Function({bool refresh}) loadInstances;

  /// Current theme mode selection.
  final ThemeMode themeMode;

  /// Callback when the theme selection changes.
  final ValueChanged<ThemeMode>? onThemeChanged;

  static Future<List<MeshInstance>> _defaultInstanceLoader(
      {bool refresh = false}) {
    return fetchInstances();
  }

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
  late ThemeMode _selectedThemeMode;

  @override
  void initState() {
    super.initState();
    _selectedDomain = widget.currentDomain;
    _selectedThemeMode = widget.themeMode;
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
    if (oldWidget.themeMode != widget.themeMode) {
      _selectedThemeMode = widget.themeMode;
    }
  }

  Future<void> _fetchInstances({bool refresh = false}) async {
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final fetched = await widget.loadInstances(refresh: refresh);
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

  void _onThemeModeChanged(ThemeMode? mode) {
    if (mode == null) return;
    setState(() {
      _selectedThemeMode = mode;
    });
    widget.onThemeChanged?.call(mode);
  }

  List<DropdownMenuItem<String>> _buildEndpointOptions() {
    final seen = <String, String>{};
    void addOption(String domain, String name) {
      final key = domain.trim();
      if (key.isEmpty || seen.containsKey(key)) return;
      seen[key] = name;
    }

    addOption(_defaultDomain, _defaultName);
    for (final instance in _instances) {
      addOption(instance.domain, instance.displayName);
    }
    if (_selectedDomain.isNotEmpty && !seen.containsKey(_selectedDomain)) {
      addOption(_selectedDomain, 'Custom (${_selectedDomain.trim()})');
    }

    final sortedKeys = seen.keys.toList()
      ..sort(
          (a, b) => seen[a]!.toLowerCase().compareTo(seen[b]!.toLowerCase()));

    return sortedKeys
        .map(
          (domain) => DropdownMenuItem<String>(
            value: domain,
            child: Text(seen[domain]!),
          ),
        )
        .toList();
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
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: DropdownButtonFormField<String>(
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
                    ),
                    const SizedBox(width: 8),
                    IconButton(
                      tooltip: 'Refresh instances',
                      icon: const Icon(Icons.refresh),
                      onPressed: _loading
                          ? null
                          : () => _fetchInstances(refresh: true),
                    ),
                  ],
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
                title: const Text('Instance'),
                subtitle: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    subtitle,
                    const SizedBox(height: 4),
                    RichText(
                      text: TextSpan(
                        text: domainDisplay,
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.primary,
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
            leading: Icon(Icons.palette_outlined),
            title: Text('Theme'),
            subtitle: Text('Select preferred appearance'),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            child: DropdownButtonFormField<ThemeMode>(
              decoration: const InputDecoration(
                border: OutlineInputBorder(),
                labelText: 'Appearance',
              ),
              initialValue: _selectedThemeMode,
              items: const [
                DropdownMenuItem(
                  value: ThemeMode.system,
                  child: Text('System'),
                ),
                DropdownMenuItem(
                  value: ThemeMode.light,
                  child: Text('Light'),
                ),
                DropdownMenuItem(
                  value: ThemeMode.dark,
                  child: Text('Dark'),
                ),
              ],
              onChanged: _onThemeModeChanged,
            ),
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
            subtitle: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(_versionLabel.isNotEmpty ? _versionLabel : 'Loading…'),
                const SizedBox(height: 4),
                RichText(
                  text: TextSpan(
                    text: 'github.com/l5yth/potato-mesh',
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.primary,
                      decoration: TextDecoration.underline,
                    ),
                    recognizer: TapGestureRecognizer()
                      ..onTap = () async {
                        final uri = Uri.parse(
                          'https://github.com/l5yth/potato-mesh/',
                        );
                        await launchUrl(
                          uri,
                          mode: LaunchMode.externalApplication,
                        );
                      },
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

/// --- Data layer ------------------------------------------------------------

/// Representation of a single mesh message returned by the PotatoMesh API.
class MeshMessage {
  final int id;
  final DateTime? rxTime;
  final String rxIso;
  final String fromId;
  final String nodeId;
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
    this.nodeId = '',
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
      nodeId: json['node_id']?.toString() ?? '',
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

  /// Prefer the explicit node id when present, falling back to the sender id.
  String get lookupNodeId => nodeId.isNotEmpty ? nodeId : fromId;

  /// Serialises the message for persistence in local storage.
  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'rx_iso': rxIso,
      'from_id': fromId,
      'node_id': nodeId,
      'to_id': toId,
      'channel': channel,
      'channel_name': channelName,
      'portnum': portnum,
      'text': text,
      'rssi': rssi,
      'snr': snr,
      'hop_limit': hopLimit,
    };
  }
}

/// Mesh federation instance metadata used to configure endpoints.
class MeshInstance {
  const MeshInstance({
    required this.name,
    required this.domain,
    this.id = '',
    this.isPrivate = false,
    this.lastUpdateTime,
  });

  /// Human-friendly instance name.
  final String name;

  /// Instance domain hosting the PotatoMesh API.
  final String domain;

  /// Unique identifier for the instance when provided by the API.
  final String id;

  /// True when the instance is marked as private and should be hidden.
  final bool isPrivate;

  /// Optional last update timestamp from the federation payload.
  final DateTime? lastUpdateTime;

  /// Prefer the provided name, falling back to the domain.
  String get displayName => name.isNotEmpty ? name : domain;

  /// Parse a [MeshInstance] from an API payload entry.
  factory MeshInstance.fromJson(Map<String, dynamic> json) {
    final domain = json['domain']?.toString().trim() ?? '';
    final name = json['name']?.toString().trim() ?? '';
    final id = json['id']?.toString().trim() ?? '';
    final isPrivateRaw = json['isPrivate'] ?? json['private'];
    final isPrivate = isPrivateRaw is bool
        ? isPrivateRaw
        : isPrivateRaw?.toString().toLowerCase() == 'true';
    DateTime? lastUpdate;
    final lastUpdateRaw = json['lastUpdateTime'];
    if (lastUpdateRaw != null) {
      final seconds = int.tryParse(lastUpdateRaw.toString());
      if (seconds != null) {
        lastUpdate =
            DateTime.fromMillisecondsSinceEpoch(seconds * 1000, isUtc: true);
      }
    }

    return MeshInstance(
      name: name,
      domain: domain,
      id: id,
      isPrivate: isPrivate,
      lastUpdateTime: lastUpdate,
    );
  }

  /// Serialize the instance for persistence.
  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'domain': domain,
      'isPrivate': isPrivate,
      'lastUpdateTime': lastUpdateTime != null
          ? lastUpdateTime!.millisecondsSinceEpoch ~/ 1000
          : null,
    };
  }
}

/// Node metadata persisted locally to avoid repeated network lookups.
class MeshNode {
  const MeshNode({
    required this.nodeId,
    this.shortName = '',
    this.longName = '',
    this.lastHeard,
    this.firstHeard,
    this.hwModel,
    this.latitude,
    this.longitude,
  });

  final String nodeId;
  final String shortName;
  final String longName;
  final DateTime? lastHeard;
  final DateTime? firstHeard;
  final String? hwModel;
  final double? latitude;
  final double? longitude;

  /// Returns a name suitable for chat rendering.
  String get displayShortName => shortName.isNotEmpty
      ? shortName
      : NodeShortNameCache.fallbackShortName(nodeId);

  /// Whether the node was heard within the provided freshness window.
  bool isActive(Duration freshness, DateTime nowUtc) {
    if (lastHeard == null) return false;
    final threshold = nowUtc.subtract(freshness);
    return lastHeard!.isAfter(threshold);
  }

  factory MeshNode.fromJson(Map<String, dynamic> json) {
    DateTime? parseSeconds(dynamic value) {
      if (value == null) return null;
      final seconds = int.tryParse(value.toString());
      if (seconds == null) return null;
      return DateTime.fromMillisecondsSinceEpoch(seconds * 1000, isUtc: true);
    }

    double? parseDouble(dynamic value) {
      if (value == null) return null;
      if (value is num) return value.toDouble();
      return double.tryParse(value.toString());
    }

    return MeshNode(
      nodeId: json['node_id']?.toString() ?? json['id']?.toString() ?? '',
      shortName:
          json['short_name']?.toString() ?? json['shortName']?.toString() ?? '',
      longName:
          json['long_name']?.toString() ?? json['longName']?.toString() ?? '',
      lastHeard:
          parseSeconds(json['last_heard']) ?? parseSeconds(json['lastSeen']),
      firstHeard: parseSeconds(json['first_heard']),
      hwModel: json['hw_model']?.toString(),
      latitude: parseDouble(json['latitude']),
      longitude: parseDouble(json['longitude']),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'node_id': nodeId,
      'short_name': shortName,
      'long_name': longName,
      'last_heard':
          lastHeard != null ? lastHeard!.millisecondsSinceEpoch ~/ 1000 : null,
      'first_heard': firstHeard != null
          ? firstHeard!.millisecondsSinceEpoch ~/ 1000
          : null,
      'hw_model': hwModel,
      'latitude': latitude,
      'longitude': longitude,
    };
  }
}

/// Build a messages API URI for a given domain or absolute URL.
Uri _buildMessagesUri(String domain, {int limit = 1000}) {
  final trimmed = domain.trim();
  final params = {
    'limit': limit.toString(),
    'encrypted': 'false',
  };
  if (trimmed.isEmpty) {
    return Uri.https('potatomesh.net', '/api/messages', params);
  }

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    final parsed = Uri.parse(trimmed);
    return parsed.replace(
      path: '/api/messages',
      queryParameters: params,
    );
  }

  return Uri.https(trimmed, '/api/messages', params);
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

/// Build the bulk nodes API URI for fetching recent nodes.
Uri _buildNodesUri(String domain, {int limit = 1000}) {
  final trimmedDomain = domain.trim();
  final params = {'limit': limit.toString()};

  if (trimmedDomain.isEmpty) {
    return Uri.https('potatomesh.net', '/api/nodes', params);
  }

  if (trimmedDomain.startsWith('http://') ||
      trimmedDomain.startsWith('https://')) {
    final parsed = Uri.parse(trimmedDomain);
    return parsed.replace(path: '/api/nodes', queryParameters: params);
  }

  return Uri.https(trimmedDomain, '/api/nodes', params);
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

/// Build an instances API URI for federation discovery.
Uri _buildInstancesUri(String domain) {
  final trimmed = domain.trim();
  if (trimmed.isEmpty || trimmed == 'potatomesh.net') {
    return Uri.https('potatomesh.net', '/api/instances');
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    final parsed = Uri.parse(trimmed);
    return parsed.replace(path: '/api/instances');
  }
  return Uri.https(trimmed, '/api/instances');
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
  int limit = 1000,
}) async {
  final uri = _buildMessagesUri(domain, limit: limit);
  _logHttp('GET $uri');

  final httpClient = client ?? http.Client();
  final shouldClose = client == null;

  final resp = await httpClient.get(uri).timeout(_requestTimeout);
  _logHttp('HTTP ${resp.statusCode} $uri');
  if (shouldClose) {
    httpClient.close();
  }
  if (resp.statusCode != 200) {
    throw Exception('HTTP ${resp.statusCode}: ${resp.body}');
  }

  final decoded = await _decodeJsonList(resp.body);
  final msgs = decoded.map(MeshMessage.fromJson).toList();

  return sortMessagesByRxTime(msgs);
}

/// Memoised loader for node short names sourced from the API.
class NodeShortNameCache {
  NodeShortNameCache._();

  /// Singleton instance used by chat line rendering.
  static final NodeShortNameCache instance = NodeShortNameCache._();

  MeshNodeResolver? _resolver;
  final Map<String, Future<String>> _cache = {};
  final Map<String, Map<String, String>> _primedShortNames = {};
  bool _allowRemoteLookups = true;

  /// Registers a resolver that can supply locally cached node metadata.
  void registerResolver(MeshNodeResolver resolver) {
    _resolver = resolver;
  }

  /// Clears memoised entries; primarily used in tests.
  void clear() {
    _cache.clear();
    _primedShortNames.clear();
  }

  /// Enables or disables remote lookups for short names.
  set allowRemoteLookups(bool enabled) {
    _allowRemoteLookups = enabled;
  }

  /// Seeds the cache with a batch of node metadata to avoid network calls.
  void prime({required String domain, required Iterable<MeshNode> nodes}) {
    final key = domain.trim();
    final map = _primedShortNames.putIfAbsent(key, () => {});
    for (final node in nodes) {
      final id = node.nodeId.trim();
      final name = node.shortName.trim();
      if (id.isEmpty || name.isEmpty) continue;
      map[id] = name;
    }
  }

  /// Resolve the short name for a node, defaulting to the fallback suffix.
  Future<String> shortNameFor({
    required String domain,
    required String nodeId,
    http.Client? client,
  }) {
    final trimmedId = nodeId.trim();
    final normalizedDomain = _normalizeDomainKey(domain);
    final normalizedId = _normalizeNodeId(trimmedId);
    final fallback = fallbackShortName(trimmedId);
    if (normalizedId.isEmpty) return Future.value(fallback);
    if (!_allowRemoteLookups) return Future.value(fallback);

    final domainKey = normalizedDomain;
    final primed = _primedShortNames[domainKey];
    if (primed != null) {
      final primedName =
          primed[trimmedId] ?? primed['!$trimmedId'] ?? primed[normalizedId];
      if (primedName != null && primedName.isNotEmpty) {
        return Future.value(padToWidth(primedName));
      }
    }

    final resolved = _resolver?.findNode(domainKey, trimmedId);
    if (resolved != null && resolved.displayShortName.isNotEmpty) {
      final name = resolved.displayShortName;
      _storePrimed(domainKey, trimmedId, name);
      return Future.value(padToWidth(name));
    }

    final key = '$domainKey|$normalizedId';
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
    final normalizedDomain = _normalizeDomainKey(domain);
    final normalizedId = _normalizeNodeId(nodeId);
    final cacheKey = '$normalizedDomain|$normalizedId';
    if (_cache.containsKey(cacheKey)) {
      return _cache[cacheKey]!;
    }

    final uri = _buildNodeUri(domain, nodeId);
    final httpClient = client ?? http.Client();
    final shouldClose = client == null;

    try {
      _logHttp('GET $uri');
      final resp = await httpClient.get(uri).timeout(_requestTimeout);
      _logHttp('HTTP ${resp.statusCode} $uri');
      if (resp.statusCode != 200) return fallback;

      final decoded = await _decodeJsonMap(resp.body);
      final raw = decoded['short_name'] ?? decoded['shortName'];
      if (raw != null) {
        final name = raw.toString().trim();
        if (name.isNotEmpty) {
          _storePrimed(domain, nodeId, name);
          return padToWidth(name);
        }
      }

      return fallback;
    } catch (_) {
      return fallback;
    } finally {
      _cache[cacheKey] = Future.value(fallback);
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

  void _storePrimed(String domain, String nodeId, String name) {
    final domainKey = _normalizeDomainKey(domain);
    final map = _primedShortNames.putIfAbsent(domainKey, () => {});
    final trimmedId = nodeId.trim();
    final normalizedId = _normalizeNodeId(trimmedId);
    map[trimmedId] = name;
    map['!$normalizedId'] = name;
    map[normalizedId] = name;
  }

  String _normalizeDomainKey(String domain) {
    var cleaned = domain.trim();
    if (cleaned.startsWith('https://')) cleaned = cleaned.substring(8);
    if (cleaned.startsWith('http://')) cleaned = cleaned.substring(7);
    if (cleaned.endsWith('/')) {
      cleaned = cleaned.substring(0, cleaned.length - 1);
    }
    if (cleaned.isEmpty) return 'potatomesh.net';
    return cleaned.toLowerCase();
  }

  String _normalizeNodeId(String id) {
    final trimmed = id.trim();
    return trimmed.startsWith('!') ? trimmed.substring(1) : trimmed;
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
      _logHttp('GET $uri');
      final resp = await httpClient.get(uri).timeout(_requestTimeout);
      _logHttp('HTTP ${resp.statusCode} $uri');
      if (resp.statusCode != 200) return null;
      final decoded = await _decodeJsonMap(resp.body);
      return InstanceVersion.fromJson(decoded);
    } catch (_) {
      return null;
    } finally {
      if (shouldClose) {
        httpClient.close();
      }
    }
  }
}

/// Fetches and validates federation instances, persisting them locally.
Future<List<MeshInstance>> fetchInstances({http.Client? client}) {
  final repository = MeshRepository(client: client);
  return repository.discoverInstances(client: client);
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
