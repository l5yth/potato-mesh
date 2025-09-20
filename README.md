# 🥔 PotatoMesh

[![GitHub Workflow Status](https://img.shields.io/github/actions/workflow/status/l5yth/potato-mesh/ruby.yml?branch=main)](https://github.com/l5yth/potato-mesh/actions)
[![GitHub release (latest by date)](https://img.shields.io/github/v/release/l5yth/potato-mesh)](https://github.com/l5yth/potato-mesh/releases)
[![codecov](https://codecov.io/gh/l5yth/potato-mesh/branch/main/graph/badge.svg?token=FS7252JVZT)](https://codecov.io/gh/l5yth/potato-mesh)
[![Open-Source License](https://img.shields.io/github/license/l5yth/potato-mesh)](LICENSE)
[![Contributions Welcome](https://img.shields.io/badge/contributions-welcome-brightgreen.svg?style=flat)](https://github.com/l5yth/potato-mesh/issues)

A simple Meshtastic-powered node dashboard for your local community. _No MQTT clutter, just local LoRa aether._

* Web app with chat window and map view showing nodes and messages.
* API to POST (authenticated) and to GET nodes and messages.
* Supplemental Python ingestor to feed the POST APIs of the Web app with data remotely.
* Shows new node notifications (first seen) in chat.
* Allows searching and filtering for nodes in map and table view.

- Live demo for Berlin #MediumFast: [potatomesh.net](https://potatomesh.net)

![screenshot of the second version](./scrot-0.2.png)

## 🐳 Quick Start with Docker

```bash
./configure.sh          # Configure your setup
docker-compose up -d     # Start services
docker-compose logs -f   # View logs
```

Access the dashboard at `http://localhost:41447`

For detailed Docker documentation, see [DOCKER.md](DOCKER.md).

## 📦 Available Docker Images

PotatoMesh provides pre-built Docker images for multiple architectures and operating systems. All images are available on GitHub Container Registry (GHCR.io).

### Web Application Images

| Image                                                                                                                             | Architecture | OS      | Description           | Pull Command                                                       |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------- | --------------------- | ------------------------------------------------------------------ |
| [`ghcr.io/l5yth/potato-mesh-web-linux-amd64`](https://github.com/l5yth/potato-mesh/pkgs/container/potato-mesh-web-linux-amd64)     | x86_64       | Linux   | Standard Linux x86_64 | `docker pull ghcr.io/l5yth/potato-mesh-web-linux-amd64:latest`   |
| [`ghcr.io/l5yth/potato-mesh-web-windows-amd64`](https://github.com/l5yth/potato-mesh/pkgs/container/potato-mesh-web-windows-amd64) | x86_64       | Windows | Windows x86_64        | `docker pull ghcr.io/l5yth/potato-mesh-web-windows-amd64:latest` |

### Ingestor Service Images

| Image                                                                                                                                       | Architecture | OS      | Description           | Pull Command                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------- | --------------------- | ----------------------------------------------------------------------- |
| [`ghcr.io/l5yth/potato-mesh-ingestor-linux-amd64`](https://github.com/l5yth/potato-mesh/pkgs/container/potato-mesh-ingestor-linux-amd64)     | x86_64       | Linux   | Standard Linux x86_64 | `docker pull ghcr.io/l5yth/potato-mesh-ingestor-linux-amd64:latest`   |
| [`ghcr.io/l5yth/potato-mesh-ingestor-windows-amd64`](https://github.com/l5yth/potato-mesh/pkgs/container/potato-mesh-ingestor-windows-amd64) | x86_64       | Windows | Windows x86_64        | `docker pull ghcr.io/l5yth/potato-mesh-ingestor-windows-amd64:latest` |

### Quick Platform Examples

**Linux x86_64:**

```bash
docker pull ghcr.io/l5yth/potato-mesh-web-linux-amd64:latest
docker pull ghcr.io/l5yth/potato-mesh-ingestor-linux-amd64:latest
```

**Standard Linux/Windows (x86_64):**

```bash
docker pull ghcr.io/l5yth/potato-mesh-web-linux-amd64:latest
docker pull ghcr.io/l5yth/potato-mesh-ingestor-linux-amd64:latest
```

### Image Tags

All images support the following tag formats:

- `latest` - Latest stable release
- `v1.0.0` - Specific version (replace with actual version)
- `main` - Latest development build

---

## Web App

### 🐳 Docker (Recommended)

The web app runs automatically when you start the full stack with Docker:

```bash
# Start the web app
docker-compose up -d web
```

The web app will be available at `http://localhost:41447`.

### 📦 Manual Installation

Requires Ruby for the Sinatra web app and SQLite3 for the app's database.

```bash
pacman -S ruby sqlite3
gem install sinatra sqlite3 rackup puma rspec rack-test rufo
cd ./web
bundle install
```

### Run

Check out the `app.sh` run script in `./web` directory.

```bash
API_TOKEN="1eb140fd-cab4-40be-b862-41c607762246" ./app.sh
== Sinatra (v4.1.1) has taken the stage on 41447 for development with backup from Puma
Puma starting in single mode...
[...]
*  Environment: development
*          PID: 188487
* Listening on http://127.0.0.1:41447
```

Check [127.0.0.1:41447](http://127.0.0.1:41447/) for the development preview
of the node map. Set `API_TOKEN` required for authorizations on the API's POST endpoints.

The web app can be configured with environment variables (defaults shown):

* `SITE_NAME` - title and header shown in the ui (default: "Meshtastic Berlin")
* `DEFAULT_CHANNEL` - default channel shown in the ui (default: "#MediumFast")
* `DEFAULT_FREQUENCY` - default channel shown in the ui (default: "868MHz")
* `MAP_CENTER_LAT` / `MAP_CENTER_LON` - default map center coordinates (default: `52.502889` / `13.404194`)
* `MAX_NODE_DISTANCE_KM` - hide nodes farther than this distance from the center (default: 137)
* `MATRIX_ROOM` - matrix room id for a footer link (default: **`` `#meshtastic-berlin:matrix.org` ``**)

Example:

```bash
SITE_NAME="Meshtastic Berlin" MAP_CENTER_LAT=52.502889 MAP_CENTER_LON=13.404194 MAX_NODE_DISTANCE_KM=137 MATRIX_ROOM="" ./app.sh
```

### API

The web app contains an API:

* GET `/api/nodes?limit=100` - returns the latest 100 nodes reported to the app
* GET `/api/messages?limit=100` - returns the latest 100 messages
* POST `/api/nodes` - upserts nodes provided as JSON object mapping node ids to node data (requires `Authorization: Bearer <API_TOKEN>`)
* POST `/api/messages` - appends messages provided as a JSON object or array (requires `Authorization: Bearer <API_TOKEN>`)

The `API_TOKEN` environment variable must be set to a non-empty value and match the token supplied in the `Authorization` header for `POST` requests.

## Python Ingestor

The web app is not meant to be run locally connected to a Meshtastic node but rather
on a remote host without access to a physical Meshtastic device. Therefore, it only
accepts data through the API POST endpoints. Benefit is, here multiple nodes across the
community can feed the dashboard with data. The web app handles messages and nodes
by ID and there will be no duplication.

For convenience, the directory `./data` contains a Python ingestor. It connects to a local
Meshtastic node via serial port to gather nodes and messages seen by the node.

* [ ] pacman -S python

It uses the Meshtastic Python library to ingest mesh data and post nodes and messages
to the configured potato-mesh instance.

Check out `mesh.sh` ingestor script in the `./data` directory.

```bash
POTATOMESH_INSTANCE=http://127.0.0.1:41447 API_TOKEN=1eb140fd-cab4-40be-b862-41c607762246 MESH_SERIAL=/dev/ttyACM0 DEBUG=1 ./mesh.sh
Mesh daemon: nodes+messages → http://127.0.0.1 | port=41447 | channel=0
[...]
[debug] upserted node !849b7154 shortName='7154'
[debug] upserted node !ba653ae8 shortName='3ae8'
[debug] upserted node !16ced364 shortName='Pat'
[debug] stored message from '!9ee71c38' to '^all' ch=0 text='Guten Morgen!'
```

Run the script with `POTATOMESH_INSTANCE` and `API_TOKEN` to keep updating
node records and parsing new incoming messages. Enable debug output with `DEBUG=1`,
specify the serial port with `MESH_SERIAL` (default `/dev/ttyACM0`), etc.

## ⚙️ Configuration

### Customizing Defaults

Before running PotatoMesh, you should customize the default settings for your location and preferences:

```bash
# Run the configuration script
./configure.sh

# Or manually edit the .env file
nano .env
```

The configuration script will prompt you for:

- **Site Name**: Your local mesh network name
- **Map Center**: Latitude/longitude for your location
- **Default Channel**: Your preferred Meshtastic channel
- **Default Frequency**: Your region's frequency (868MHz, 915MHz, etc.)
- **Matrix Room**: Optional Matrix chat room for your community
- **Max Node Distance**: Maximum distance to show nodes (km)
- **Stadia Maps API Key**: API key for map tiles (optional, with setup instructions)

### Platform-Specific Device Access

#### macOS Users

**Important**: Docker Desktop on macOS has limitations with serial device access. For the best experience on macOS, we recommend running the ingestor natively while using Docker for the web app.

**Option 1: Hybrid Approach (Recommended for macOS)**

```bash
# Run web app in Docker
docker-compose up -d web

# Run ingestor natively on macOS
python3 -m venv venv
source venv/bin/activate
pip install -r data/requirements.txt
MESH_SERIAL=/dev/cu.usbmodem* POTATOMESH_INSTANCE=http://localhost:41447 API_TOKEN=your-api-token python data/mesh.py
```

**Option 2: Docker with Device Access (Limited Support)**

```bash
# Note: This may not work reliably on macOS Docker Desktop
docker-compose up -d
```

#### Linux/Windows Users

Standard Docker device mapping works on Linux and Windows:

```bash
# Linux/Windows - standard approach
docker run --device=/dev/ttyACM0 \
  -e MESH_SERIAL=/dev/ttyACM0 \
  -e API_TOKEN=your-api-token \
  ghcr.io/l5yth/potato-mesh-ingestor-linux-amd64:latest
```

## License

Apache v2.0, Contact <COM0@l5y.tech>
