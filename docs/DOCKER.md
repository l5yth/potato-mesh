# PotatoMesh Docker Setup

## Quick Start

### Prerequisites
- Docker Engine 20.10+ and Docker Compose 2.0+
- A Meshtastic device connected to your system

### Option 1: Use Published Images (Recommended)

```bash
# Pull the latest images
docker pull ghcr.io/l5yth/potato-mesh-web-linux-amd64:latest
docker pull ghcr.io/l5yth/potato-mesh-ingestor-linux-amd64:latest

# Start with published images
docker-compose up -d
```

### Option 2: Build from Source

```bash
# Clone and configure
git clone https://github.com/l5yth/potato-mesh.git
cd potato-mesh
./configure.sh

# Build and run
docker-compose up --build -d
```

## Platform-Specific Configurations

### Linux/Windows (Default)
```bash
docker-compose up -d
```

### Raspberry Pi
```bash
docker-compose -f docker-compose.raspberry-pi.yml up -d
```

### Development
```bash
docker-compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

## Environment Configuration

Run `./configure.sh` to set up your environment variables:
- Site name and location settings
- Meshtastic channel configuration
- Stadia Maps API key (optional)
- Security API token

## Architecture-Specific Images

Available images for different platforms:
- `ghcr.io/l5yth/potato-mesh-web-linux-amd64:latest` - Linux x86_64
- `ghcr.io/l5yth/potato-mesh-web-linux-arm64:latest` - Linux ARM64
- `ghcr.io/l5yth/potato-mesh-web-linux-armv7:latest` - Raspberry Pi
- `ghcr.io/l5yth/potato-mesh-web-windows-amd64:latest` - Windows x86_64

Same pattern for ingestor service.

## macOS Users

Docker Desktop on macOS has limitations with serial device access. Use the hybrid approach:

```bash
# Run web app in Docker
docker-compose up -d web

# Run ingestor natively
python3 -m venv venv && source venv/bin/activate
pip install -r data/requirements.txt
MESH_SERIAL=/dev/cu.usbmodem* POTATOMESH_INSTANCE=http://localhost:41447 API_TOKEN=your-token python data/mesh.py
```

## Troubleshooting

### Device Access Issues
- Ensure your user is in the `dialout` group (Linux)
- Check device permissions: `ls -la /dev/tty*`
- Verify device path in environment variables

### Resource Constraints
- Raspberry Pi: Use `docker-compose.raspberry-pi.yml`
- Adjust memory limits in compose files if needed

### Network Issues
- Ensure port 41447 is available
- Check firewall settings
- Verify API_TOKEN matches between services