# PotatoMesh Docker Setup

This document provides comprehensive instructions for running PotatoMesh using Docker, addressing the community request for easier deployment and setup.

## Quick Start

### Prerequisites

- Docker Engine 20.10+ and Docker Compose 2.0+
- A Meshtastic device connected to your system
- Basic familiarity with Docker

### 1. Clone and Configure

```bash
# Clone the repository
git clone https://github.com/l5yth/potato-mesh.git
cd potato-mesh

# Copy and configure environment variables
cp .env.example .env
# Edit .env with your specific configuration
```

### 2. Start PotatoMesh

```bash
# Start the full stack
docker-compose up -d

# View logs
docker-compose logs -f

# Check status
docker-compose ps
```

### 3. Access the Dashboard

Open your browser to `http://localhost:41447` to view the PotatoMesh dashboard.

## Configuration

### Environment Variables

The `.env` file contains all configuration options. Key variables:

```bash
# Required: API authentication token
API_TOKEN=your-secure-api-token-here

# Required: Meshtastic device path
MESH_SERIAL=/dev/ttyACM0

# Optional: Site customization
SITE_NAME=Meshtastic Berlin
DEFAULT_CHANNEL=#MediumFast
DEFAULT_FREQUENCY=868MHz
```

### Meshtastic Device Setup

1. **Find your device path**:
   ```bash
   # Linux
   ls /dev/ttyACM* /dev/ttyUSB*
   
   # macOS
   ls /dev/cu.usbserial-*
   
   # Windows (in WSL or Docker Desktop)
   ls /dev/ttyS*
   ```

2. **Set permissions** (Linux/macOS):
   ```bash
   sudo chmod 666 /dev/ttyACM0
   # Or add your user to the dialout group
   sudo usermod -a -G dialout $USER
   ```

3. **Configure in .env**:
   ```bash
   MESH_SERIAL=/dev/ttyACM0
   ```

## Deployment Options

### Development Mode

For active development with live code reloading:

```bash
docker-compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

Features:
- Live code reloading
- Debug logging enabled
- Volume mounts for source code
- Additional development ports

### Production Mode

For production deployment with optimizations:

```bash
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Features:
- Optimized builds
- Resource limits
- Debug logging disabled
- Production-ready configuration

### Custom Configuration

Create your own override file:

```bash
# docker-compose.custom.yml
version: '3.8'
services:
  web:
    environment:
      - SITE_NAME=My Meshtastic Network
      - MAP_CENTER_LAT=40.7128
      - MAP_CENTER_LON=-74.0060
```

Then run:
```bash
docker-compose -f docker-compose.yml -f docker-compose.custom.yml up -d
```

## Architecture

PotatoMesh runs as a multi-container application:

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Web App       │    │   Data Ingestor │    │   SQLite DB     │
│   (Ruby/Sinatra)│    │   (Python)      │    │   (Volume)      │
│   Port: 41447   │◄───┤   Serial Device │    │   Persistent    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

### Services

- **web**: Ruby Sinatra application serving the dashboard and API
- **ingestor**: Python daemon collecting data from Meshtastic devices
- **volumes**: Persistent storage for database and logs
- **networks**: Internal communication between services

## Data Persistence

### Volumes

PotatoMesh uses Docker volumes for data persistence:

- `potatomesh_data`: SQLite database and application data
- `potatomesh_logs`: Application logs

### Backup

To backup your data:

```bash
# Create backup
docker run --rm -v potatomesh_data:/data -v $(pwd):/backup alpine \
  tar czf /backup/potatomesh-backup-$(date +%Y%m%d).tar.gz -C /data .

# Restore backup
docker run --rm -v potatomesh_data:/data -v $(pwd):/backup alpine \
  tar xzf /backup/potatomesh-backup-20240101.tar.gz -C /data
```

## Monitoring and Maintenance

### Health Checks

Both containers include health checks:

```bash
# Check container health
docker-compose ps

# View health check logs
docker inspect potatomesh-web | jq '.[0].State.Health'
```

### Logs

View application logs:

```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f web
docker-compose logs -f ingestor

# Last 100 lines
docker-compose logs --tail=100 web
```

### Updates

To update PotatoMesh:

```bash
# Pull latest images
docker-compose pull

# Recreate containers with new images
docker-compose up -d

# Or rebuild from source
docker-compose build --no-cache
docker-compose up -d
```

## Troubleshooting

### Common Issues

#### 1. Serial Device Access

**Problem**: Ingestor can't access Meshtastic device

**Solutions**:
```bash
# Check device exists
ls -la /dev/ttyACM0

# Check permissions
ls -la /dev/ttyACM0

# Fix permissions
sudo chmod 666 /dev/ttyACM0

# Or add user to dialout group
sudo usermod -a -G dialout $USER
# Then logout and login again
```

#### 2. Port Already in Use

**Problem**: Port 41447 is already in use

**Solutions**:
```bash
# Find what's using the port
sudo lsof -i :41447

# Kill the process
sudo kill -9 <PID>

# Or use a different port
# Edit docker-compose.yml:
# ports:
#   - "8080:41447"
```

#### 3. Database Issues

**Problem**: Database corruption or permission issues

**Solutions**:
```bash
# Check database volume
docker volume inspect potatomesh_data

# Reset database (WARNING: loses all data)
docker-compose down
docker volume rm potatomesh_data
docker-compose up -d
```

#### 4. Container Won't Start

**Problem**: Container fails to start

**Solutions**:
```bash
# Check logs
docker-compose logs web
docker-compose logs ingestor

# Check container status
docker-compose ps

# Restart services
docker-compose restart

# Rebuild containers
docker-compose build --no-cache
docker-compose up -d
```

### Debug Mode

Enable debug logging:

```bash
# Edit .env
DEBUG=1

# Restart services
docker-compose restart
```

### Container Shell Access

Access container shells for debugging:

```bash
# Web container
docker-compose exec web sh

# Ingestor container
docker-compose exec ingestor sh

# Run commands
docker-compose exec web bundle exec ruby -v
docker-compose exec ingestor python --version
```

## Security Considerations

### API Token

- Use a strong, random API token
- Keep the token secret
- Rotate the token regularly

### Network Security

- The web application binds to all interfaces (0.0.0.0)
- Consider using a reverse proxy (nginx) for production
- Use HTTPS in production environments

### Container Security

- Containers run as non-root users
- Images are regularly scanned for vulnerabilities
- Use specific image tags, not `latest`

## Performance Tuning

### Resource Limits

For production deployments, consider resource limits:

```yaml
# docker-compose.prod.yml
services:
  web:
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: '0.5'
```

### Database Optimization

- SQLite is configured with WAL mode for better concurrency
- Consider using an external database for high-traffic deployments

## Advanced Usage

### Custom Images

Build custom images with additional tools:

```dockerfile
# Dockerfile.custom
FROM potatomesh/web:latest
RUN apk add --no-cache curl jq
```

### Multi-Host Deployment

For multi-host deployments, consider:

- Docker Swarm mode
- Kubernetes
- External database (PostgreSQL, MySQL)
- Shared storage (NFS, Ceph)

### Integration with Reverse Proxy

Example nginx configuration:

```nginx
server {
    listen 80;
    server_name potatomesh.example.com;
    
    location / {
        proxy_pass http://localhost:41447;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## Support

### Getting Help

1. Check the logs: `docker-compose logs -f`
2. Review this documentation
3. Check GitHub issues: https://github.com/l5yth/potato-mesh/issues
4. Join the Matrix room: #meshtastic-berlin:matrix.org

### Contributing

To contribute to the Docker setup:

1. Fork the repository
2. Make your changes
3. Test with `docker-compose up -d`
4. Submit a pull request

### Reporting Issues

When reporting Docker-related issues, include:

- Docker version: `docker --version`
- Docker Compose version: `docker-compose --version`
- Operating system and version
- Complete error logs: `docker-compose logs`
- Your `.env` file (remove sensitive information)
