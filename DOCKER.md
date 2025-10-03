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

| Service  | Image                                                             |
|----------|-------------------------------------------------------------------|
| Web UI   | `ghcr.io/l5yth/potato-mesh-web-linux-amd64:latest`                |
| Ingestor | `ghcr.io/l5yth/potato-mesh-ingestor-linux-amd64:latest`           |

Images are published for every tagged release. Replace `latest` with a
specific version tag if you prefer pinned deployments.

## Configure environment

Create a `.env` file alongside your Compose file and populate the variables you
need. At a minimum you must set `API_TOKEN` so the ingestor can authenticate
against the web API.

```env
API_TOKEN=replace-with-a-strong-token
SITE_NAME=My Meshtastic Network
MESH_SERIAL=/dev/ttyACM0
```

Additional environment variables are optional:

- `DEFAULT_CHANNEL`, `DEFAULT_FREQUENCY`, `MAP_CENTER_LAT`, `MAP_CENTER_LON`,
  `MAX_NODE_DISTANCE_KM`, and `MATRIX_ROOM` customise the UI.
- `POTATOMESH_INSTANCE` (defaults to `http://web:41447`) lets the ingestor post
  to a remote PotatoMesh instance if you do not run both services together.
- `MESH_CHANNEL_INDEX`, `MESH_SNAPSHOT_SECS`, and `DEBUG` adjust ingestor
  behaviour.

## Docker Compose file

Use the `docker-compose.yml` file provided in the repository (or download the
[raw file from GitHub](https://raw.githubusercontent.com/l5yth/potato-mesh/main/docker-compose.yml)).
It already references the published GHCR images, defines persistent volumes for
data and logs, and includes optional bridge-profile services for environments
that require classic port mapping. Place this file in the same directory as
your `.env` file so Compose can pick up both.

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
