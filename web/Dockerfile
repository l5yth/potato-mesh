# syntax=docker/dockerfile:1.6
# Copyright © 2025-26 l5yth & contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Main application builder stage
FROM ruby:3.3-alpine AS builder

# Ensure native extensions are built against musl libc rather than
# using glibc precompiled binaries (which fail on Alpine).
ENV BUNDLE_FORCE_RUBY_PLATFORM=true

# Install build dependencies and SQLite3
RUN apk add --no-cache \
    build-base \
    python3 \
    py3-pip \
    py3-virtualenv \
    sqlite-dev \
    linux-headers \
    pkgconfig

# Set working directory
WORKDIR /app

# Copy Gemfile and install dependencies
COPY web/Gemfile web/Gemfile.lock* ./

# Install gems with SQLite3 support
RUN bundle config set --local force_ruby_platform true && \
    bundle config set --local without 'development test' && \
    bundle install --jobs=4 --retry=3

# Install Meshtastic decoder dependencies in a dedicated venv
RUN python3 -m venv /opt/meshtastic-venv && \
    /opt/meshtastic-venv/bin/pip install --no-cache-dir meshtastic protobuf

# Production stage
FROM ruby:3.3-alpine AS production

# Install runtime dependencies
RUN apk add --no-cache \
    python3 \
    sqlite \
    tzdata \
    curl

# Create non-root user
RUN addgroup -g 1000 -S potatomesh && \
    adduser -u 1000 -S potatomesh -G potatomesh

# Set working directory
WORKDIR /app

# Copy installed gems from builder stage
COPY --from=builder /usr/local/bundle /usr/local/bundle
COPY --from=builder /opt/meshtastic-venv /opt/meshtastic-venv

# Copy application code (excluding the Dockerfile which is not required at runtime)
COPY --chown=potatomesh:potatomesh web/app.rb ./
COPY --chown=potatomesh:potatomesh web/app.sh ./
COPY --chown=potatomesh:potatomesh web/Gemfile ./
COPY --chown=potatomesh:potatomesh web/Gemfile.lock* ./
COPY --chown=potatomesh:potatomesh web/lib ./lib
COPY --chown=potatomesh:potatomesh web/spec ./spec
COPY --chown=potatomesh:potatomesh web/public ./public
COPY --chown=potatomesh:potatomesh web/views ./views
COPY --chown=potatomesh:potatomesh web/content ./content
COPY --chown=potatomesh:potatomesh web/scripts ./scripts
RUN chmod -R a-w /app/content

# Copy SQL schema files from data directory
COPY --chown=potatomesh:potatomesh data/*.sql /data/
COPY --chown=potatomesh:potatomesh data/mesh_ingestor/decode_payload.py /app/data/mesh_ingestor/decode_payload.py

# Create data and configuration directories with correct ownership
RUN mkdir -p /app/.local/share/potato-mesh \
    && mkdir -p /app/.config/potato-mesh/well-known \
    && chown -R potatomesh:potatomesh /app/.local/share /app/.config

# Switch to non-root user
USER potatomesh

# Expose port
EXPOSE 41447

# Default environment variables (can be overridden by host)
ENV RACK_ENV=production \
    APP_ENV=production \
    MESHTASTIC_PYTHON=/opt/meshtastic-venv/bin/python \
    XDG_DATA_HOME=/app/.local/share \
    XDG_CONFIG_HOME=/app/.config \
    SITE_NAME="PotatoMesh Demo" \
    CHANNEL="#LongFast" \
    FREQUENCY="915MHz" \
    MAP_CENTER="38.761944,-27.090833" \
    MAP_ZOOM="" \
    MAX_DISTANCE=42 \
    CONTACT_LINK="#potatomesh:dod.ngo" \
    DEBUG=0

# Start the application
CMD ["ruby", "app.rb", "-p", "41447", "-o", "0.0.0.0"]
