# PotatoMesh Docker Setup

## Quick Start

```bash
./configure.sh
docker-compose up -d
docker-compose logs -f
```

Access at `http://localhost:41447`

## Configuration

Edit `.env` file or run `./configure.sh` to set:

- `API_TOKEN` - Required for ingestor authentication
- `MESH_SERIAL` - Your Meshtastic device path (e.g., `/dev/ttyACM0`)
- `MESH_TCP_ADDRESS` - Optional Meshtastic node IP (set to use TCP instead of serial)
- `MESH_TCP_PORT` - Optional TCP port override (default: 4403)
- `SITE_NAME` - Your mesh network name
- `MAP_CENTER_LAT/LON` - Map center coordinates

## Device Setup

**Find your device:**
```bash
# Linux
ls /dev/ttyACM* /dev/ttyUSB*

# macOS  
ls /dev/cu.usbserial-*

# Windows
ls /dev/ttyS*
```

**Set permissions (Linux/macOS):**
```bash
sudo chmod 666 /dev/ttyACM0
# Or add user to dialout group
sudo usermod -a -G dialout $USER
```

## Common Commands

```bash
# Start services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down

# Stop and remove data
docker-compose down -v

# Update images
docker-compose pull && docker-compose up -d
```

## Troubleshooting

**Device access issues:**
```bash
# Check device exists and permissions
ls -la /dev/ttyACM0

# Fix permissions
sudo chmod 666 /dev/ttyACM0
```

**Port conflicts:**
```bash
# Find what's using port 41447
sudo lsof -i :41447
```

**Container issues:**
```bash
# Check logs
docker-compose logs

# Restart services
docker-compose restart
```

For more Docker help, see [Docker Compose documentation](https://docs.docker.com/compose/).