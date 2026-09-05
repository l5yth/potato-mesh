<!-- Copyright © 2025-26 l5yth & contributors -->
<!-- Licensed under the Apache License, Version 2.0 (see LICENSE) -->

# GitHub Actions Workflows

## Workflows

- `docker.yml` - Build and push Docker images to GHCR
- `codeql.yml` - Security scanning
- `license.yml` - Apache license header check
- `nix.yml` - Nix flake build check
- `python.yml` - Python ingestor pipeline
- `ruby.yml` - Ruby Sinatra app testing
- `rust.yml` - Matrix bridge (Rust) build and test
- `javascript.yml` - Frontend test suite
- `mobile.yml` - Flutter mobile tests with coverage reporting
- `release.yml` - Flutter release builds for Android and iOS (disabled:
  manual `workflow_dispatch` only; the tag-push trigger is commented out)

