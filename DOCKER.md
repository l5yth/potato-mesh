<!-- Copyright © 2025-26 l5yth & contributors -->
<!-- Licensed under the Apache License, Version 2.0 (see LICENSE) -->

# PotatoMesh Docker Guide

PotatoMesh publishes ready-to-run container images to the GitHub Packages container
registry (GHCR). You do not need to clone the repository to deploy them—Compose
will pull the latest release images for you.

## Prerequisites

- Docker Engine 24+ or Docker Desktop with the Compose plugin
- Access to `/dev/ttyACM*` (or equivalent) if you plan to attach a Meshtastic
  device to the ingestor container
- An API token that authorises the ingestor to post to your PotatoMesh instance

## Images on GHCR

| Service  | Image                                                                                                          |
|----------|----------------------------------------------------------------------------------------------------------------|
| Web UI   | `ghcr.io/l5yth/potato-mesh-web-linux-amd64:<tag>` (e.g. `latest`, `0.6.0`, `v0.6.0`, or `0.7.0-rc1`)         |
| Ingestor | `ghcr.io/l5yth/potato-mesh-ingestor-linux-amd64:<tag>` (e.g. `latest`, `0.6.0`, `v0.6.0`, or `0.7.0-rc1`)    |

Images are published for every tagged release. Stable builds receive both
semantic version tags (for example `0.6.0`) and a matching `v`-prefixed tag (for
example `v0.6.0`), plus a `latest` tag that tracks the newest stable release.
Pre-release tags (for example `-rc`, `-beta`, `-alpha`, or `-dev` suffixes) are
published only with their explicit version strings (`0.7.0-rc1` and `v0.7.0-rc1`
in this example) and do **not** advance `latest`. Pin the versioned tags when
you need a specific build.

## Configure environment

Create a `.env` file alongside your Compose file and populate the variables you
need. At a minimum you must set `API_TOKEN` so the ingestor can authenticate
against the web API.

```env
API_TOKEN=replace-with-a-strong-token
SITE_NAME=PotatoMesh Demo
CONNECTION=/dev/ttyACM0
INSTANCE_DOMAIN=mesh.example.org
```

Additional environment variables are optional:

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_TOKEN` | _required_ | Shared secret used by the ingestor and API clients for authenticated `POST` requests. |
| `INSTANCE_DOMAIN` | _auto-detected_ | Public hostname (optionally with port) advertised by the web UI, metadata, and API responses. |
| `SITE_NAME` | `"PotatoMesh Demo"` | Title and branding surfaced in the web UI. |
| `CHANNEL` | `"#LongFast"` | Default LoRa channel label displayed on the dashboard. |
| `FREQUENCY` | `"915MHz"` | Default LoRa frequency description shown in the UI. |
| `CONTACT_LINK` | `"#potatomesh:dod.ngo"` | Chat link or Matrix room alias rendered in UI footers and overlays. |
| `MAP_CENTER` | `38.761944,-27.090833` | Latitude and longitude that centre the map view. |
| `MAP_ZOOM` | _unset_ | Fixed Leaflet zoom (disables the auto-fit checkbox when set). |
| `MAX_DISTANCE` | `42` | Maximum relationship distance (km) before edges are hidden. |
| `DEBUG` | `0` | Enables verbose logging across services when set to `1`. |
| `ALLOWED_CHANNELS` | _unset_ | Comma-separated channel names the ingestor accepts; other channels are skipped before hidden filters. |
| `HIDDEN_CHANNELS` | _unset_ | Comma-separated channel names the ingestor skips when forwarding packets. |
| `FEDERATION` | `1` | Controls whether the instance announces itself and crawls peers (`1`) or stays isolated (`0`). |
| `PRIVATE` | `0` | Restricts public visibility and disables chat/message endpoints when set to `1`. |
| `CONNECTION` | `/dev/ttyACM0` | Serial device, TCP endpoint, or Bluetooth target used by the ingestor to reach the radio. |
| `MIN_THREADS` | `16` | Minimum Puma worker threads kept warm on the web service. |
| `MAX_THREADS` | `96` | Maximum Puma worker threads on the web service. Each active `/api/events` (SSE) stream pins one thread, so keep this above your peak concurrent SSE clients plus API/ingest headroom. |

The ingestor posts to the URL configured via `INSTANCE_DOMAIN` (defaulting to
`http://web:41447` in the provided compose file). Use `CHANNEL_INDEX` to select
a LoRa channel on serial or Bluetooth connections.

## Docker Compose file

Use the `docker-compose.yml` file provided in the repository (or download the
[raw file from GitHub](https://raw.githubusercontent.com/l5yth/potato-mesh/main/docker-compose.yml)).
It already references the published GHCR images, defines persistent volumes for
data, configuration, and logs, and includes optional bridge-profile services for
environments that require classic port mapping. Place this file in the same
directory as your `.env` file so Compose can pick up both.

The dedicated configuration volume binds to `/app/.config/potato-mesh` inside
the container. This path stores the instance private key and staged
`/.well-known/potato-mesh` documents. Because the volume persists independently
of container lifecycle events, generated credentials are not replaced on reboot
or re-deploy.

The `potatomesh_pages` volume mounts to `/app/pages` and holds operator-managed
Markdown files that are rendered as static content pages in the web UI. On first
start the default `1-about.md` page is copied from the image into the volume.
You can add, edit, or remove `.md` files in this volume to customise your
instance's navigation. To use a host directory instead of a named volume, replace
the volume entry with a bind mount:

```yaml
volumes:
  - ./my-pages:/app/pages
```

## Start the stack

From the directory containing the Compose file:

```bash
docker compose up -d
```

Docker automatically pulls the GHCR images when they are not present locally.
The dashboard becomes available at `http://127.0.0.1:41447`. Use the bridge
profile when you need to map the port explicitly:

```bash
COMPOSE_PROFILES=bridge docker compose up -d
```

## Updating

```bash
docker compose pull
docker compose up -d
```

## Running behind a reverse proxy (TLS + static assets)

The web container serves plain HTTP on port `41447`. For any public deployment,
terminate TLS in a reverse proxy in front of it. A ready-to-adapt nginx example
lives at [`deploy/nginx.example.conf`](deploy/nginx.example.conf); the notes
below explain the parts that matter.

**Forwarded headers (required).** The app derives its public scheme and host —
used for `INSTANCE_DOMAIN`, page metadata, the sitemap, and federation links —
from `X-Forwarded-Proto` and the `Host` header. Forward both, or generated URLs
resolve to the wrong scheme/host:

```nginx
proxy_set_header Host              $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
```

**Static-asset caching.** Every JS module and `base.css` is served with a
`?v=<APP_VERSION>` query, and the layout emits one `<script type="importmap">`
that rewrites the whole module graph to those versioned URLs (SPEC `AV2`–`AV4`).
Versioned JS/CSS are therefore safe to cache **immutably** for a year; images,
icons, and fonts are *not* versioned and keep a short TTL with revalidation (a
stale logo is cosmetic — `AV4`). Two ways to realize this:

1. **Any deployment (portable):** have the app emit the headers itself. The
   container bakes assets into the image at `/app/public` with no volume, so a
   host proxy cannot read them from disk — this is the only option for the
   Compose/GHCR stack. Tracked in
   [#870](https://github.com/l5yth/potato-mesh/issues/870).
2. **Bare-metal (repo checkout):** serve `/assets/` straight from nginx off disk
   (the `location /assets/` block in the example). This also keeps the ~50
   per-page ES-module requests off the single Ruby process. For containers, only
   do this if you bind-mount `web/public` into an nginx sidecar.

Three things that bite in practice — all handled in the example file:

- **Filesystem permissions:** the proxy worker user (`http`, `www-data`, …) must
  be able to traverse to and read `web/public`. Check with
  `namei -l <path>/web/public/assets/styles/base.css` — every parent directory
  needs `o+x`, or disk-served assets return `403`.
- **Upstream keepalive** needs both `proxy_http_version 1.1` and
  `proxy_set_header Connection ""`.
- **TLS session resumption:** Certbot's `options-ssl-nginx.conf` sets
  `ssl_session_tickets off` (forward secrecy) and ships its own
  `ssl_session_cache`. Adding `ssl_session_tickets on;` in the same server block
  is a fatal *duplicate-directive* error; even placed correctly it trades away
  forward secrecy unless you rotate ticket keys. Leaving it off costs ~1 RTT on
  cold TLS 1.3 connections — usually the right call.

Verify after `nginx -t && systemctl reload nginx`:

```bash
curl -sD- -H 'Accept-Encoding: gzip' https://<host>/assets/js/app/main.js?v=<ver> -o /dev/null \
  | grep -i 'cache-control\|content-encoding'
# expect: cache-control: public, max-age=31536000, immutable   and   content-encoding: gzip
```

## Performance & scaling

The web app runs as a **single Puma process** with a bounded thread pool
(`MIN_THREADS:MAX_THREADS`, default `16:96`). CRuby serialises Ruby execution on
one global lock, so a single expensive request can delay others — keep hot read
paths cheap and let the reverse proxy absorb static traffic.

- **Thread pool.** Each live-update SSE stream (`GET /api/events`) pins one
  thread for its lifetime, so size `MAX_THREADS` above your expected concurrent
  SSE clients plus API/ingest headroom (that is why the floor is 16, not Puma's
  MRI default of 5). Override with `MIN_THREADS` / `MAX_THREADS`.
- **Static assets.** Serve `/assets/` from the reverse proxy (or via app-level
  immutable headers) so the module fan-out and revalidations never touch Ruby —
  see the section above.
- **Cluster (multi-process) mode is not supported out of the box.** Live updates
  use an in-process pub/sub, so events would not fan out across workers; the
  per-process response cache and the background retention/federation threads
  would also need per-worker handling. To scale on one host today: front it with
  the reverse proxy, serve assets from disk, and keep queries cheap.

## Troubleshooting

- **Serial device permissions (Linux/macOS):** grant access with `sudo chmod 666
  /dev/ttyACM0` or add your user to the `dialout` group.
- **Port already in use:** identify the conflicting service with `sudo lsof -i
  :41447`.
- **Viewing logs:** `docker compose logs -f` tails output from both services.

For general Docker support, consult the [Docker Compose documentation](https://docs.docker.com/compose/).
