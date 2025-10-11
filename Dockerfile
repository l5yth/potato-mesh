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
RUN mkdir -p /app/data && \
    chown -R potatomesh:potatomesh /app/data

# Switch to non-root user
USER potatomesh

# Expose port
EXPOSE 41447

# Default environment variables (can be overridden by host)
ENV APP_ENV=production \
    MESH_DB=/app/data/mesh.db \
    DB_BUSY_TIMEOUT_MS=5000 \
    DB_BUSY_MAX_RETRIES=5 \
    DB_BUSY_RETRY_DELAY=0.05 \
    MAX_JSON_BODY_BYTES=1048576 \
    SITE_NAME="PotatoMesh Demo" \
    DEFAULT_CHANNEL="#LongFast" \
    DEFAULT_FREQUENCY="915MHz" \
    MAP_CENTER_LAT=38.761944 \
    MAP_CENTER_LON=-27.090833 \
    MAX_NODE_DISTANCE_KM=42 \
    MATRIX_ROOM="#potatomesh:dod.ngo" \
    DEBUG=0

# Start the application
CMD ["ruby", "app.rb", "-p", "41447", "-o", "0.0.0.0"]
