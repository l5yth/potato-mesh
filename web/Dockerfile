# Multi-stage build for PotatoMesh Web Application
FROM ruby:3.2-alpine AS builder

# Install build dependencies
RUN apk add --no-cache \
    build-base \
    sqlite-dev \
    linux-headers

# Set working directory
WORKDIR /app

# Copy Gemfile and install dependencies
COPY Gemfile Gemfile.lock* ./
RUN bundle config set --local deployment 'true' && \
    bundle config set --local without 'development test' && \
    bundle install --jobs=4 --retry=3

# Production stage
FROM ruby:3.2-alpine AS production

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

# Copy application code
COPY --chown=potatomesh:potatomesh . .

# Create data directory for SQLite database
RUN mkdir -p /app/data && \
    chown -R potatomesh:potatomesh /app/data

# Switch to non-root user
USER potatomesh

# Expose port
EXPOSE 41447

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:41447/ || exit 1

# Default environment variables
ENV MESH_DB=/app/data/mesh.db \
    DB_BUSY_TIMEOUT_MS=5000 \
    DB_BUSY_MAX_RETRIES=5 \
    DB_BUSY_RETRY_DELAY=0.05 \
    MAX_JSON_BODY_BYTES=1048576 \
    SITE_NAME="Meshtastic Berlin" \
    DEFAULT_CHANNEL="#MediumFast" \
    DEFAULT_FREQUENCY="868MHz" \
    MAP_CENTER_LAT=52.502889 \
    MAP_CENTER_LON=13.404194 \
    MAX_NODE_DISTANCE_KM=137 \
    MATRIX_ROOM="#meshtastic-berlin:matrix.org" \
    DEBUG=0

# Start the application
CMD ["ruby", "app.rb", "-p", "41447", "-o", "0.0.0.0"]
