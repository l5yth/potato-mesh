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

# NOTE: This Dockerfile is kept for backward compatibility. The canonical build
# instructions live in `web/Dockerfile`; keep the two files in sync.

# Main application builder stage
FROM ruby:3.3-alpine AS builder

# Ensure native extensions are built against musl libc rather than
# using glibc precompiled binaries (which fail on Alpine).
ENV BUNDLE_FORCE_RUBY_PLATFORM=true

# Install build dependencies and SQLite3
RUN apk add --no-cache \
    build-base \
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

# Production stage
FROM ruby:3.3-alpine AS production

# Install runtime dependencies
RUN apk add --no-cache \
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

# Copy application code (exclude Dockerfile from web directory)
COPY --chown=potatomesh:potatomesh web/app.rb web/app.sh web/Gemfile web/Gemfile.lock* web/spec/ ./
COPY --chown=potatomesh:potatomesh web/public ./public
COPY --chown=potatomesh:potatomesh web/views/ ./views/

# Copy SQL schema files from data directory
COPY --chown=potatomesh:potatomesh data/*.sql /data/

# Create data directory for SQLite database
RUN mkdir -p /app/data /app/.local/share/potato-mesh && \
    chown -R potatomesh:potatomesh /app/data /app/.local

# Switch to non-root user
USER potatomesh

# Expose port
EXPOSE 41447

# Default environment variables (can be overridden by host)
ENV APP_ENV=production \
    RACK_ENV=production \
    SITE_NAME="PotatoMesh Demo" \
    INSTANCE_DOMAIN="potato.example.com" \
    CHANNEL="#LongFast" \
    FREQUENCY="915MHz" \
    MAP_CENTER="38.761944,-27.090833" \
    MAX_DISTANCE=42 \
    CONTACT_LINK="#potatomesh:dod.ngo" \
    DEBUG=0

# Start the application
CMD ["ruby", "app.rb", "-p", "41447", "-o", "0.0.0.0"]
