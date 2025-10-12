# GitHub Actions Workflows

## Workflows

- **`docker.yml`** - Build and push Docker images to GHCR
- **`codeql.yml`** - Security scanning
- **`python.yml`** - Python ingestor pipeline
- **`ruby.yml`** - Ruby Sinatra app testing
- **`javascript.yml`** - Frontend test suite

## Usage

```bash
# Build locally
docker-compose build

# Deploy
docker-compose up -d
```
