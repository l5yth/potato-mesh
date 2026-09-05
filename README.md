<!-- Copyright © 2025-26 l5yth & contributors -->
<!-- Licensed under the Apache License, Version 2.0 (see LICENSE) -->

# 🥔 PotatoMesh

[![GitHub Workflow Status](https://img.shields.io/github/actions/workflow/status/l5yth/potato-mesh/ruby.yml?branch=main)](https://github.com/l5yth/potato-mesh/actions)
[![GitHub release](https://img.shields.io/github/v/release/l5yth/potato-mesh)](https://github.com/l5yth/potato-mesh/releases)
[![codecov](https://codecov.io/gh/l5yth/potato-mesh/branch/main/graph/badge.svg?token=FS7252JVZT)](https://codecov.io/gh/l5yth/potato-mesh)
[![Open-Source License](https://img.shields.io/github/license/l5yth/potato-mesh)](LICENSE)
[![Contributions Welcome](https://img.shields.io/badge/contributions-welcome-brightgreen.svg?style=flat)](https://github.com/l5yth/potato-mesh/issues)
[![Matrix Chat](https://img.shields.io/badge/matrix-%23potatomesh:dod.ngo-blue)](https://matrix.to/#/#potatomesh:dod.ngo)

[![Meshtastic](https://img.shields.io/badge/Meshtastic-supported-67ea94)](https://meshtastic.org)
[![Meshcore](https://img.shields.io/badge/Meshcore-supported-1f2937)](https://meshcore.io)
[![Reticulum](https://img.shields.io/badge/Reticulum-supported-7b61ff)](https://reticulum.network)

A federated Meshtastic, Meshcore, and Reticulum node dashboard for your local community.
_No MQTT clutter, just local LoRa aether._

* Web dashboard: map + chat, nodes, positions, neighbors, trace routes, telemetry, messages.
  * API to `POST` (authenticated) and `GET` nodes, messages, and telemetry.
  * New-node and telemetry notifications in chat.
  * Search and filter nodes in map and table view.
  * Federates automatically with other communities running PotatoMesh.
  * Supports Meshtastic, Meshcore, and Reticulum.
* Python ingestor feeds the web app's `POST` APIs remotely.
  * Supports multiple ingestors per instance.
  * Supports Meshtastic, Meshcore, and Reticulum.
* Matrix bridge posts Meshtastic messages to a Matrix channel (no radio required).
* Mobile app to _read_ messages on your local aether (no radio required).

Live demo for Berlin: [potatomesh.net](https://potatomesh.net)

![screenshot of the sixth version](./scrot-0.7.png)

Jump to Contents:
- [Web App](#web-app) - configuration, running, deploying, monitoring, etc.
- [Ingestor](#ingestor) - configuration, running, transmitting, etc.
- [Nix](#nix) - nix deployment
- [Docker](#docker) - docker deployment
- [Matrix Bridge](#matrix-bridge) - configuration and deployment
- [Mobile App](#mobile-app) - reader app

## Web App

Requires Ruby and SQLite3.

```bash
pacman -S ruby sqlite3
gem install sinatra sqlite3 rackup puma rspec rack-test rufo prometheus-client
cd ./web
bundle install
```

### Run

```bash
API_TOKEN="1eb140fd-cab4-40be-b862-41c607762246" ./app.sh
== Sinatra (v4.1.1) has taken the stage on 41447 for development with backup from Puma
Puma starting in single mode...
[...]
*  Environment: development
*          PID: 188487
* Listening on http://127.0.0.1:41447
```

Open [127.0.0.1:41447](http://127.0.0.1:41447/) for the dashboard. `API_TOKEN` is required to authorize the API's `POST` endpoints.

### Production

```bash
RACK_ENV="production" \
APP_ENV="production" \
API_TOKEN="SuperSecureTokenReally" \
INSTANCE_DOMAIN="https://potatomesh.net" \
MAP_CENTER="53.55,13.42" \
exec ruby app.rb -p 41447 -o 0.0.0.0
```

* Set `RACK_ENV=production` and `APP_ENV=production`.
* Bind to a production port and all interfaces: `-p 41447 -o 0.0.0.0`.
* Set a strong `API_TOKEN` to authorize `POST` requests.
* Set `INSTANCE_DOMAIN` to your deployment's public URL.
* Set `MAP_CENTER` to your region's coordinates.

The web app can be configured with environment variables (defaults shown):

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_TOKEN` | _required_ | Shared secret that authorizes ingestors and API clients making `POST` requests. |
| `INSTANCE_DOMAIN` | _auto-detected_ | Public hostname (optionally with port) used for metadata, federation, and generated API links. |
| `SITE_NAME` | `"PotatoMesh Demo"` | Title and header displayed in the UI. |
| `MESHTASTIC_PRESET` | `"#LongFast"` | Meshtastic radio preset shown in the join strip, meta description, and federation directory (e.g. `MediumFast`). |
| `MESHTASTIC_FREQ` | `"915MHz"` | Meshtastic frequency shown alongside the preset. |
| `MESHCORE_PRESET` | _unset_ | Meshcore radio preset for the join strip; the Meshcore line is hidden until both `MESHCORE_*` values are set. |
| `MESHCORE_FREQ` | _unset_ | Meshcore frequency for the join strip. |
| `CONTACT_LINK` | `"#potatomesh:dod.ngo"` | Chat link or Matrix alias rendered in the footer and overlays. |
| `ANNOUNCEMENT` | _unset_ | Optional announcement banner text rendered above the header on every page. |
| `MAP_CENTER` | `38.761944,-27.090833` | Latitude and longitude that centre the map on load. |
| `MAP_ZOOM` | _unset_ | Fixed Leaflet zoom applied on first load; disables auto-fit when provided. |
| `MAX_DISTANCE` | `42` | Maximum distance (km) before node relationships are hidden on the map. |
| `DEBUG` | `0` | Set to `1` for verbose logging in the web services. |
| `FEDERATION` | `1` | Set to `1` to announce your instance and crawl peers, or `0` to disable federation. Private mode overrides this. |
| `PRIVATE` | `0` | Set to `1` to hide the chat UI, disable message APIs, and exclude hidden clients from public listings. |
| `EVENTS` | `1` | Set to `0` to disable the live-update SSE stream (`GET /api/events`); clients then fall back to polling at the refresh interval. |
| `MIN_THREADS` | `16` | Minimum Puma worker threads kept warm. |
| `MAX_THREADS` | `96` | Maximum Puma worker threads. Each active `/api/events` SSE stream pins one thread, so keep this above your peak concurrent SSE clients plus API/ingest headroom. |
| `OG_IMAGE_URL` | _unset_ | Absolute `http(s)://` URL for the social preview image; other schemes are ignored. Replaces the generated `/og-image.png`. Use HTTPS - most platforms won't render an HTTP preview. |
| `PAGES_DIR` | `./pages` | The directory for static, custom-content pages. |
| `PROM_REPORT_IDS` | _unset_ | Comma-separated node ids to expose as per-node Prometheus gauges. Empty exports none. |

`/robots.txt` and `/sitemap.xml` are generated automatically and respect
`PRIVATE`/`FEDERATION`. Markdown files in `pages/` may set YAML frontmatter
(`title`, `description`, `image`, `noindex`); `image` must be an absolute
`http(s)://` URL - other schemes are dropped.

If `INSTANCE_DOMAIN` is unset in production, the app warns once at startup and
falls back to the inbound `Host` header for canonical URLs - vulnerable to
cache poisoning behind a misconfigured proxy. Set `INSTANCE_DOMAIN` to avoid
this.

Example:

```bash
SITE_NAME="PotatoMesh Demo" INSTANCE_DOMAIN="https://potatomesh.net" MAP_CENTER=38.761944,-27.090833 MAP_ZOOM=11 MAX_DISTANCE=42 CONTACT_LINK="#potatomesh:dod.ngo" ./app.sh
```

### Configuration & Storage

Runtime assets follow the XDG base directory spec, falling back to the
repository root when unset:

- Key: `$XDG_CONFIG_HOME/potato-mesh/keyfile`
- Well-known document: `$XDG_CONFIG_HOME/potato-mesh/well-known/potato-mesh`
- Database: `$XDG_DATA_HOME/potato-mesh`

Outbound requests. The map loads basemap tiles from two third-party CDNs on
every viewport: OpenStreetMap HOT (`tile.openstreetmap.fr`) and CARTO
(`basemaps.cartocdn.com`). Only `z/x/y` tile coordinates are sent - no key,
cookie, or analytics parameter. Tiles are the only third-party request the
dashboard makes.

### Custom Pages

Add Markdown files to `web/pages/` to publish static content pages (contact
info, rules, legal notices). Each `.md` file becomes a nav entry and a route
at `/pages/<slug>`.

Filename format: `<sort-prefix>-<slug>.md`. The prefix sets nav order; the
slug sets the URL and nav label:

| Filename               | Nav Label      | URL                     |
| ---------------------- | -------------- | ----------------------- |
| `1-about.md`           | About          | `/pages/about`          |
| `5-rules.md`           | Rules          | `/pages/rules`          |
| `9-contact.md`         | Contact        | `/pages/contact`        |
| `20-impressum.md`      | Impressum      | `/pages/impressum`      |

- Ships with a default `1-about.md`.
- Docker: the directory is the `potatomesh_pages` volume (`/app/pages`) - edit pages without rebuilding.
- Override the directory with `PAGES_DIR`.

### Federation

- `FEDERATION=1` (default): announce this instance, respond to crawlers, and crawl peers every 8 hours.
- `FEDERATION=0`: fully isolated, no federation.
- `PRIVATE=1` disables federation regardless of `FEDERATION`.

### API

All `GET` routes accept `?limit=` and `?since=`; bulk collections also accept
`?before=` and `?protocol=`. All `POST` routes require
`Authorization: Bearer <API_TOKEN>`.

Collections - `GET` list, `GET /:id` for one node's rows, `POST` to ingest:

| Path | Notes |
| --- | --- |
| `/api/nodes` | `GET`, `GET /:id`, `POST` |
| `/api/positions` | `GET`, `GET /:id`, `POST` |
| `/api/telemetry` | `GET`, `GET /:id`, `POST`; `/api/telemetry/aggregated` for rollups |
| `/api/messages` | `GET`, `GET /:id`, `POST`; all 404 when `PRIVATE=1` |
| `/api/neighbors` | `GET`, `GET /:id`, `POST` |
| `/api/traces` | `GET`, `GET /:id`, `POST` |
| `/api/waypoints` | `GET`, `GET /:id`, `POST`; all 404 when `PRIVATE=1` |
| `/api/destinations` | `GET`; `?node_id=` filters. Reticulum destinations per node |
| `/api/ingestors` | `GET`, `POST`. Active ingestors feeding this instance |
| `/api/instances` | `GET`, `POST`. Known federated instances |

Other

| Path | Returns |
| --- | --- |
| `GET /api/stats` | Node/message/telemetry counts per protocol and window |
| `GET /api/stats/activity` | Packets/hour time series per protocol |
| `GET /api/events` | SSE stream of collection-change events |
| `GET /version` | Instance name, version, and public config |
| `GET /metrics` | Prometheus exporter - see [`PROMETHEUS.md`](./PROMETHEUS.md) |
| `GET /.well-known/potato-mesh` | Signed federation record for this instance |
| `GET /og-image.png` | Open Graph preview image |
| `GET /robots.txt`, `GET /sitemap.xml` | Crawler directives |

Pages - `GET /` dashboard, `GET /nodes/:id` node detail, `GET /pages/:slug`
custom pages. Static assets: `GET /favicon.ico`, `GET /potatomesh-logo.svg`.

There is no health endpoint; use `GET /version`.

### Advanced tuning

Internal tuning knobs, all optional; set only to change the defaults shown.
Not pre-declared in `.env.example`, Compose, or the NixOS module - set them
directly in the web process's environment.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MIN_THREADS` | `16` | Puma minimum thread count. |
| `MAX_THREADS` | `96` | Puma maximum thread count. |
| `PUMA_FORCE_SHUTDOWN` | `3` | Seconds Puma waits before forcing shutdown. |
| `STATS_CACHE_TTL_SECONDS` | `60` | Cache lifetime for `/api/stats` responses. |
| `OG_IMAGE_TTL_SECONDS` | `3600` | Cache lifetime for the generated `/og-image.png`. |
| `LIVE_SAFETY_POLL_SECONDS` | `300` | Interval of the fallback poll that backstops the SSE stream. |
| `SSE_HEARTBEAT_SECONDS` | `15` | Comment-frame keepalive interval on `/api/events`. |
| `SSE_MAX_LIFETIME_SECONDS` | `600` | Maximum lifetime of one SSE connection before the client reconnects. |
| `SSE_PUBLISH_COOLDOWN` | `1.0` | Minimum seconds between SSE publishes, coalescing bursts. |
| `SSE_THREAD_RESERVE` | `32` | Threads held back from SSE so ordinary requests keep being served. |
| `FEDERATION_WORKERS` | `4` | Federation crawl worker-pool size. |
| `FEDERATION_WORK_QUEUE` | `128` | Queued federation tasks before new ones are dropped. |
| `FEDERATION_TASK_TIMEOUT` | `120` | Seconds before one federation task is abandoned. |
| `FEDERATION_SHUTDOWN_TIMEOUT` | `3` | Seconds to drain federation workers on shutdown. |
| `FEDERATION_CRAWL_COOLDOWN` | `300` | Minimum seconds between crawls of the same domain. |
| `FEDERATION_MAX_DOMAINS_PER_CRAWL` | `256` | Domain ceiling for one crawl pass. |
| `FEDERATION_MAX_INSTANCES_PER_RESPONSE` | `64` | Instances accepted from one peer's response. |
| `INITIAL_FEDERATION_DELAY_SECONDS` | `2` | Delay before the first crawl after boot. |
| `REMOTE_INSTANCE_CONNECT_TIMEOUT` | `15` | Connect timeout when fetching a peer. |
| `REMOTE_INSTANCE_READ_TIMEOUT` | `60` | Read timeout when fetching a peer. |
| `REMOTE_INSTANCE_REQUEST_TIMEOUT` | `30` | Overall request timeout when fetching a peer. |
| `REMOTE_INSTANCE_MAX_RESPONSE_BYTES` | `8388608` | Response ceiling (8 MiB) when fetching a peer. |

### Monitoring

PotatoMesh ships with a Prometheus exporter mounted at `/metrics`. Consult
[`PROMETHEUS.md`](./PROMETHEUS.md) for deployment guidance, metric details, and
scrape configuration examples.

## Ingestor

The web app never connects to a radio; it only ingests via authenticated
`POST`. Run one or more Python ingestors from `./data` to feed it - each
connects to a LoRa node over serial, TCP, or Bluetooth (BLE), and multiple
ingestors can feed one instance without duplicating data.

```bash
pacman -S python
cd ./data
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Check out `mesh.sh` ingestor script in the `./data` directory.

```bash
INSTANCE_DOMAIN=http://127.0.0.1:41447 API_TOKEN=1eb140fd-cab4-40be-b862-41c607762246 CONNECTION=/dev/ttyACM0 DEBUG=1 ./mesh.sh
[2025-02-20T12:34:56.789012Z] [potato-mesh] [info] channel=0 context=daemon.main port='41447' target='http://127.0.0.1' Mesh daemon starting
[...]
[2025-02-20T12:34:57.012345Z] [potato-mesh] [debug] context=handlers.upsert_node node_id=!849b7154 short_name='7154' long_name='7154' Queued node upsert payload
[2025-02-20T12:34:57.456789Z] [potato-mesh] [debug] context=handlers.upsert_node node_id=!ba653ae8 short_name='3ae8' long_name='3ae8' Queued node upsert payload
[2025-02-20T12:34:58.001122Z] [potato-mesh] [debug] context=handlers.store_packet_dict channel=0 from_id='!9ee71c38' payload='Guten Morgen!' to_id='^all' Queued message payload
```

Configure with the environment variables below.

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_TOKEN` | _required_ | Shared secret that authorizes ingestors and API clients making `POST` requests. |
| `INSTANCE_DOMAIN` | _required_ | Public hostname (optionally with port) used for feeding the API with data. |
| `PROTOCOL` | `meshtastic` | Which protocol are we ingesting? One of `meshtastic`, `meshcore`, or `reticulum`. |
| `CONNECTION` | `/dev/ttyACM0` | Where do we talk to the node? Accepts serial ports, TCP host:port (e.g. `192.168.1.20:4403`), and Bluetooth addresses: MAC format (e.g. `ED:4D:9E:95:CF:60`) or, on macOS, UUID format (e.g. `C0AEA92F-045E-9B82-C9A6-A1FD822B3A9E`). Ignored under `PROTOCOL=reticulum`, which has no single endpoint - see [Reticulum](#reticulum). |
| `DEBUG` | `0` | Set to `1` for verbose logging in the ingestor services. |
| `CHANNEL_INDEX` | `0` | Which channel index to ingest from. |
| `ENERGY_SAVING` | `0` | Set to `1` to duty-cycle the radio connection instead of holding it open. |
| `FREQUENCY` | _unset_ | Deprecated alias for `MESHTASTIC_FREQ`; overrides the auto-detected LoRa frequency. |
| `CHANNEL` | _unset_ | Deprecated alias for `MESHTASTIC_PRESET`. |
| `ALLOWED_CHANNELS` | _unset_ | Comma-separated channel names the ingestor accepts (e.g. `Chat,Ops`); when set, all other channels are skipped before hidden filters. |
| `HIDDEN_CHANNELS` | _unset_ | Comma-separated channel names the ingestor will ignore when forwarding packets. |
| `TRANSPORT` | `api` | Ingestor transport: `api` (Meshtastic library over serial/TCP/BLE) or `udp` (passive LAN multicast; see [Passive UDP transport](#passive-udp-transport)). |
| `PRIMARY_CHANNEL_ONLY` | `0` | Set to `1` to ingest only the primary channel (index 0) and drop all other channels. In UDP transport this requires `PRIMARY_CHANNEL_NAME`; without it, every packet is dropped (fail closed). |
| `PRIMARY_CHANNEL_KEY` | `AQ==` | Base64 PSK used to decrypt the primary channel in UDP transport (default = Meshtastic default key). |
| `PRIMARY_CHANNEL_NAME` | _unset_ | Name of channel 0 (e.g. `MediumFast`); find it with `meshtastic --info` if blank on the radio. Required by UDP `PRIMARY_CHANNEL_ONLY=1`. |
| `MESH_UDP_GROUP` | `224.0.0.69` | Multicast group joined in UDP transport. |
| `MESH_UDP_PORT` | `4403` | Multicast port joined in UDP transport. |
| `INGESTOR_NODE_ID` | _unset_ | `!xxxxxxxx` id used for the ingestor heartbeat. Required for the UDP transport, which cannot auto-detect "self". Optional for `PROTOCOL=reticulum`, which derives one from your primary announced identity; set it there only to override that. |
| `RETICULUM_CONFIG_DIR` | `~/.reticulum` | Which RNS config the ingestor uses, and so which interfaces it can see. Point it at the directory your `rnsd` uses. See [Reticulum](#reticulum). |
| `RETICULUM_FREQ` | _from RNS config_ | Frequency shown for Reticulum nodes. Overrides the value read from your `RNodeInterface` section. |
| `RETICULUM_PRESET` | _from RNS config_ | Radio preset shown for Reticulum nodes. Overrides the value derived from your bandwidth/spreading-factor/coding-rate. |
| `RETICULUM_INTERFACES` | _unset_ | Which RNS interfaces to ingest from, e.g. `RNode`. Comma-separated, case-insensitive substring match against the names in `rnstatus`. Your own nodes are always ingested; empty ingests everything. See [Reticulum](#reticulum). |
| `MESHCORE_TELEMETRY_POLL_SECONDS` | `300` | Requires `TX_ENABLED=1` (polling other nodes is a transmission). Seconds between Meshcore contact telemetry polls (one on-air request per interval, round-robin over the roster; each contact is additionally polled at most once per 24 h: when every contact is fresh the tick sends nothing). Set `0` to disable on-air polling. |
| `MESHCORE_SELF_TELEMETRY_SECONDS` | `3600` | Seconds between Meshcore host self-telemetry reads (battery/sensors over the companion link, no airtime). Set `0` to disable. |
| `TX_ENABLED` | `0` | Master switch for all ingestor transmissions. `0` = listen only. `1` = allow transmit - enables Meshcore on-air telemetry polling; does not by itself enable announcements. See [Transmitting on the mesh](#transmitting-on-the-mesh). |
| `TX_ANNOUNCE` | `0` | Requires `TX_ENABLED=1`. Broadcasts a one-line activity summary at most once per 24 h, never in the first 24 h after start. See [Transmitting on the mesh](#transmitting-on-the-mesh). |

### Transmitting on the mesh

By default a PotatoMesh ingestor never transmits. It listens, and forwards
what it hears to your dashboard. Nothing below happens unless you turn it on.

| Variable | Default | What turning it on means |
| --- | --- | --- |
| `TX_ENABLED` | `0` | The ingestor may transmit. On its own this enables Meshcore on-air telemetry polling: round-robin requests to other nodes for their battery/sensor readings, at most one request per `MESHCORE_TELEMETRY_POLL_SECONDS` (default 300 s) and at most once per 24 h per node. This is how other nodes' telemetry reaches your dashboard. Meshtastic ingestion needs no transmission at all. |
| `TX_ANNOUNCE` | `0` | Requires `TX_ENABLED=1`. Broadcasts one line on your default channel, at most once every 24 h, and never in the first 24 h after the ingestor starts. |

The announcement looks like this:

```
Meshtastic activity in the last 24h: 42 active nodes, 118 packets/hour. https://mesh.example.org
```

Numbers come from the instance's public API. Suppressed when the instance is
`PRIVATE=1`; fails closed (no transmit) if the check can't reach the instance.

Both flags must be on for an announcement to go out:

| `TX_ENABLED` | `TX_ANNOUNCE` | Result |
| --- | --- | --- |
| `0` | `0` | Receive only. The default. |
| `0` | `1` | Receive only: `TX_ENABLED=0` wins. |
| `1` | `0` | Telemetry polling on, no announcements. |
| `1` | `1` | Telemetry polling on, one announcement per 24 h. |

The ingestor logs the resolved policy at startup, without `DEBUG=1`:

```
[2026-08-24T09:12:44.117Z] [potato-mesh] [info] context=tx.policy announcements_permitted=False rx_only=False transmit_permitted=False tx_announce=False tx_enabled=False Transmit policy resolved
```

If a flag seems to have no effect, that line shows what the ingestor actually
resolved - including a flag that never reached the container.

### Meshcore

Set `PROTOCOL=meshcore` to ingest from a Meshcore companion-firmware node
(serial, TCP, or BLE via the same `CONNECTION` formats). Captures RF metrics
alongside contacts and messages: per-message SNR/hop counts, per-channel-message
RSSI and repeater path, and per-advert SNR/RSSI/hops for every node heard -
including nodes with no room in the radio's contact roster.

The ingestor writes one radio setting at startup: enables the firmware's
overwrite-oldest-contact flag (`autoadd_config` bit `0x01`, firmware ≥ 1.16)
when not already set.

- Never evicts favourites; other auto-add settings are preserved.
- Older firmware (no command support) is left untouched.
- Evicted contacts stay in the dashboard's database - only the radio's local roster rotates.

### Reticulum

Set `PROTOCOL=reticulum` to ingest from a Reticulum (RNS) network. The ingestor
listens for announces and files each one as a node. It never transmits, so
`TX_ENABLED=0` (the default) is fine.

`CONNECTION` does not apply; if set, the ingestor ignores it and logs that it did.

It reads your existing `~/.reticulum`, so if `rnsd` already works, so does this:

```bash
API_TOKEN=... INSTANCE_DOMAIN=https://your.instance PROTOCOL=reticulum ./data/mesh.sh
```

To ingest only from your radio, set `RETICULUM_INTERFACES` to part of the
interface name from `rnstatus` - matching is case-insensitive substring:

```bash
RETICULUM_INTERFACES="RNode Reticulum Berlin"
```

Your own nodes are always ingested regardless of this setting. Everything
further away is filtered by it.

To use a different RNS config, set `RETICULUM_CONFIG_DIR`, pointing at the
same directory your `rnsd` uses - interface filtering fails across mismatched
directories.

In Docker, the config dir is the `potatomesh_reticulum` volume
(`/app/.config/potato-mesh/reticulum`). RNS seeds a stock config there with
only a link-local `AutoInterface`, which reaches no radio on the default
bridge network:

- Add your interfaces to the volume's `config` file, then restart:
  `docker compose exec ingestor sh -c 'cat >> /app/.config/potato-mesh/reticulum/config'`
- Or point `RETICULUM_CONFIG_DIR` at a bind mount of the host's `~/.reticulum`
  and run with host networking.

The ingestor derives its node id from your primary identity - the one
announcing the most destinations on this machine. `INGESTOR_NODE_ID` overrides
it. It reports the id it resolved at startup:

```
context=reticulum.connect ... node_id='!27716218' Reticulum announce listener registered
```

`node_id='pending'` means nothing local has been heard yet; the ingestor
retries each loop and logs again once it resolves. Not the transport identity
 -  not the hash `rnstatus` prints as "Transport Instance".

Changing the id strands the old row. Setting, changing, or removing
`INGESTOR_NODE_ID` moves the ingestor's node id; the previous row stays in
`/api/ingestors` without heartbeats until it ages out. Leaving the variable
as-is across upgrades is inert.

Frequency and preset are read from the first `RNodeInterface` in your RNS
config; `RETICULUM_FREQ` and `RETICULUM_PRESET` override them. A matching
preset name describes radio settings only, not interoperability with a
Meshtastic mesh; otherwise it shows `SF8/BW125/CR5`. Values are read once at
startup - change them in the RNS config and restart the ingestor, or the
dashboard keeps showing the old ones.

A node is one row per identity - a peer running both LXMF and a nomadnet node
is still one entry. Its destinations (addresses) are listed via
`GET /api/destinations` and shown as sub-rows grouped under the identity in
the dashboard table.

Announces carry no SNR, battery, or position, so those columns show dashes and
Reticulum nodes stay off the map.

### Passive UDP transport

Meshtastic's node API accepts only one client at a time. Set `TRANSPORT=udp`
to run the ingestor as a passive listener on the node's LAN multicast group
(`224.0.0.69:4403`) instead of connecting to the API - leaving the API slot
free for the phone app or CLI.

Enable "Mesh via UDP" on the node first: `meshtastic --set network.enabled_protocols 1`.

- Decrypts the primary channel with `PRIMARY_CHANNEL_KEY` (default `AQ==`). Channels with other keys are dropped undecrypted.
- Set `PRIMARY_CHANNEL_ONLY=1` and `PRIMARY_CHANNEL_NAME` to ingest only channel 0. Without `PRIMARY_CHANNEL_NAME` set, `PRIMARY_CHANNEL_ONLY=1` drops every packet (fail closed).
- The node list rebuilds from observed packets - the node's own database is not read. Decoded payloads (position, telemetry, traceroute, …) match the API/serial transport shape.

`TRANSPORT=udp` requires host networking (`network_mode: host`). A
ready-to-use Raspberry Pi (arm64) deployment is provided in
[`data/tools/compose.udp.pi.yml`](data/tools/compose.udp.pi.yml). Capture live
packets for testing with
[`data/tools/capture_udp_fixtures.py`](data/tools/capture_udp_fixtures.py).

## Nix

For the dev shell, run:

```bash
nix develop
```

The shell provides Ruby plus the Python ingestor dependencies (including `meshtastic`
and `protobuf`). To sanity-check that the ingestor starts, run `python -m data.mesh`
with the usual environment variables (`INSTANCE_DOMAIN`, `API_TOKEN`, `CONNECTION`).

To run the packaged apps directly:

```bash
nix run .#web
nix run .#ingestor
```

Minimal NixOS module snippet:

```nix
services.potato-mesh = {
  enable = true;
  apiTokenFile = config.sops.secrets.potato-mesh-api-token.path;
  dataDir = "/var/lib/potato-mesh";
  port = 41447;
  instanceDomain = "https://mesh.me";
  siteName = "Nix Mesh";
  contactLink = "homeserver.mx";
  mapCenter = "28.96,-13.56";
  frequency = "868MHz";
  ingestor = {
    enable = true;
    connection = "192.168.X.Y:4403";
  };
};
```

Every variable in the tables above has a module option, named in camelCase
(`SITE_NAME` → `siteName`, `OG_IMAGE_URL` → `ogImageUrl`):

- Web options sit at the top level; ingestor options sit under `ingestor`.
- `PROTOCOL`, `TRANSPORT`, `INGESTOR_NODE_ID` → `ingestor.protocol`,
  `ingestor.transport`, `ingestor.nodeId`.
- `RETICULUM_CONFIG_DIR`, `RETICULUM_INTERFACES` → `ingestor.reticulumConfigDir`,
  `ingestor.reticulumInterfaces`.
- Options typed `nullOr` emit no variable when left `null`, so the app keeps its
  own default.

## Docker

Docker images are published on GitHub Container Registry for each release.
Image names and tags follow the workflow format:
`${IMAGE_PREFIX}-${service}-${architecture}:${tag}` (see `.github/workflows/docker.yml`).

```bash
docker pull ghcr.io/l5yth/potato-mesh-web-linux-amd64:latest
docker pull ghcr.io/l5yth/potato-mesh-web-linux-arm64:latest
docker pull ghcr.io/l5yth/potato-mesh-web-linux-armv7:latest

docker pull ghcr.io/l5yth/potato-mesh-ingestor-linux-amd64:latest
docker pull ghcr.io/l5yth/potato-mesh-ingestor-linux-arm64:latest
docker pull ghcr.io/l5yth/potato-mesh-ingestor-linux-armv7:latest

docker pull ghcr.io/l5yth/potato-mesh-matrix-bridge-linux-amd64:latest
docker pull ghcr.io/l5yth/potato-mesh-matrix-bridge-linux-arm64:latest
docker pull ghcr.io/l5yth/potato-mesh-matrix-bridge-linux-armv7:latest

# version-pinned examples
docker pull ghcr.io/l5yth/potato-mesh-web-linux-amd64:v0.7.5
docker pull ghcr.io/l5yth/potato-mesh-ingestor-linux-amd64:v0.7.5
docker pull ghcr.io/l5yth/potato-mesh-matrix-bridge-linux-amd64:v0.7.5
```

Note: `latest` is only published for non-prerelease versions. Pre-release tags
such as `-rc`, `-beta`, `-alpha`, or `-dev` are version-tagged only.

When using Compose, set `POTATOMESH_IMAGE_ARCH` in `docker-compose.yml` (or via
environment) so service images resolve to the correct architecture variant and
you avoid manual tag mistakes.

Feel free to run the [configure.sh](./configure.sh) script to set up your
environment. See the [Docker guide](DOCKER.md) for more details and custom
deployment instructions.

## Matrix Bridge

Work in progress. Forwards messages from a PotatoMesh instance to a Matrix
channel (no radio required). See [matrix/README.md](./matrix/README.md).

![matrix bridge](./scrot-0.6.png)

## Mobile App

Work in progress. A read-only reader app for Android and iOS. See
[app/README.md](./app/README.md).

## Demos

Post your nodes and screenshots here:

* <https://github.com/l5yth/potato-mesh/discussions/258>

## License

Apache v2.0, Contact <COM0@l5y.tech>

Join our community chat to discuss the dashboard or ask for technical support:
[#potatomesh:dod.ngo](https://matrix.to/#/#potatomesh:dod.ngo)
