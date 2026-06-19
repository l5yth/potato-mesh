#!/usr/bin/env bash
# Copyright © 2025-26 l5yth & contributors
# Licensed under the Apache License, Version 2.0 (see LICENSE)
#
# Fail if any tracked source or comment-capable config file is missing the
# exact Apache notice mandated by CLAUDE.md and ACCEPTANCE.md (check B4).
set -euo pipefail

NOTICE='Copyright © 2025-26 l5yth & contributors'

missing=$(git ls-files \
    '*.rb' '*.py' '*.js' '*.rs' '*.dart' \
    '*.yml' '*.yaml' '*.toml' '*.sh' '*.nix' 'Dockerfile' '*/Dockerfile' \
  | grep -vE '(^|/)(vendor|node_modules|build|\.dart_tool)/' \
  | xargs grep -L "$NOTICE" || true)

if [ -n "$missing" ]; then
  echo "Files missing the Apache notice ('${NOTICE}'):"
  echo "$missing"
  exit 1
fi
echo "All checked files carry the Apache notice."
