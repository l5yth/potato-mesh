# GitHub Actions Workflows

## Workflows

- **`docker.yml`** - Build and push Docker images to GHCR
- **`codeql.yml`** - Security scanning
- **`python.yml`** - Python ingestor pipeline
- **`ruby.yml`** - Ruby Sinatra app testing
- **`javascript.yml`** - Frontend test suite
- **`mobile.yml`** - Flutter mobile tests with coverage reporting
- **`release.yml`** - Tag-triggered Flutter release builds for Android and iOS

## Usage

```bash
# Build locally
docker-compose build

# Deploy
docker-compose up -d
```
