# GitHub Actions Workflows

## Workflows

- **`docker.yml`** - Build and push Docker images to GHCR
- **`test-raspberry-pi-hardware.yml`** - Test Raspberry Pi deployment
- **`codeql.yml`** - Security scanning
- **`python.yml`** - Python testing
- **`ruby.yml`** - Ruby testing

## Usage

```bash
# Build locally
docker-compose build

# Deploy
docker-compose up -d
```