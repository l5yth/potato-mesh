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

| Service  | Image                                                                                                         | Architecture |
|----------|---------------------------------------------------------------------------------------------------------------|--------------|
| Web UI   | `ghcr.io/l5yth/potato-mesh-web-linux-amd64:<tag>` (e.g. `latest`, `3.0`, or `v3.0`)                           | Linux x86_64 |
| Web UI   | `ghcr.io/l5yth/potato-mesh-web-linux-arm64:<tag>` (e.g. `latest`, `3.0`, or `v3.0`)                           | Linux ARM64  |
| Web UI   | `ghcr.io/l5yth/potato-mesh-web-linux-armv7:<tag>` (e.g. `latest`, `3.0`, or `v3.0`)                           | Linux ARMv7  |
| Web UI   | `ghcr.io/l5yth/potato-mesh-web-linux-armv6:<tag>` (e.g. `latest`, `3.0`, or `v3.0`)                           | Linux ARMv6  |
| Web UI   | `ghcr.io/l5yth/potato-mesh-web-linux-riscv64:<tag>` (e.g. `latest`, `3.0`, or `v3.0`)                         | Linux RISC-V |
| Ingestor | `ghcr.io/l5yth/potato-mesh-ingestor-linux-amd64:<tag>` (e.g. `latest`, `3.0`, or `v3.0`)                      | Linux x86_64 |
| Ingestor | `ghcr.io/l5yth/potato-mesh-ingestor-linux-arm64:<tag>` (e.g. `latest`, `3.0`, or `v3.0`)                      | Linux ARM64  |
| Ingestor | `ghcr.io/l5yth/potato-mesh-ingestor-linux-armv7:<tag>` (e.g. `latest`, `3.0`, or `v3.0`)                      | Linux ARMv7  |
| Ingestor | `ghcr.io/l5yth/potato-mesh-ingestor-linux-armv6:<tag>` (e.g. `latest`, `3.0`, or `v3.0`)                      | Linux ARMv6  |
| Ingestor | `ghcr.io/l5yth/potato-mesh-ingestor-linux-riscv64:<tag>` (e.g. `latest`, `3.0`, or `v3.0`)                    | Linux RISC-V |

Images are published for every tagged release. Each build receives both semantic
version tags (for example `3.0`) and a matching `v`-prefixed tag (for example
`v3.0`). `latest` always points to the newest release, so pin one of the version
tags when you need a specific build. Set `POTATOMESH_IMAGE_ARCH` in your Compose
environment to switch between the published architectures (for example,
`linux-armv6` for ARMv6 or `linux-riscv64` for RISC-V).

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
| `FEDERATION` | `1` | Controls whether the instance announces itself and crawls peers (`1`) or stays isolated (`0`). |
| `PRIVATE` | `0` | Restricts public visibility and disables chat/message endpoints when set to `1`. |
| `CONNECTION` | `/dev/ttyACM0` | Serial device, TCP endpoint, or Bluetooth target used by the ingestor to reach the radio. |

The ingestor also respects supporting variables such as `POTATOMESH_INSTANCE`
(defaults to `http://web:41447`) for remote posting and `CHANNEL_INDEX` when
selecting a LoRa channel on serial or Bluetooth connections.

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

## Troubleshooting

- **Serial device permissions (Linux/macOS):** grant access with `sudo chmod 666
  /dev/ttyACM0` or add your user to the `dialout` group.
- **Port already in use:** identify the conflicting service with `sudo lsof -i
  :41447`.
- **Viewing logs:** `docker compose logs -f` tails output from both services.

For general Docker support, consult the [Docker Compose documentation](https://docs.docker.com/compose/).
