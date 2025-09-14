#!/usr/bin/env bash
set -euo pipefail

bundle install
exec ruby app.rb -p 41447 -o 127.0.0.1
