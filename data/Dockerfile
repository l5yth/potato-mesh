# Multi-stage build for PotatoMesh Data Ingestor
FROM python:3.13-alpine AS builder

# Install build dependencies
RUN apk add --no-cache \
    gcc \
    musl-dev \
    linux-headers \
    build-base

# Set working directory
WORKDIR /app

# Copy requirements and install Python dependencies
COPY data/requirements.txt ./
RUN pip install --no-cache-dir --user -r requirements.txt

# Production stage
FROM python:3.13-alpine AS production

# Install runtime dependencies
RUN apk add --no-cache \
    tzdata \
    curl

# Create non-root user and add to dialout group for serial access
RUN addgroup -g 1000 -S potatomesh && \
    adduser -u 1000 -S potatomesh -G potatomesh && \
    adduser potatomesh dialout

# Set working directory
WORKDIR /app

# Copy installed Python packages from builder stage
COPY --from=builder /root/.local /home/potatomesh/.local

# Copy application code
COPY --chown=potatomesh:potatomesh data/ .

# Switch to non-root user
USER potatomesh

# Add local Python packages to PATH
ENV PATH=/home/potatomesh/.local/bin:$PATH

# Default environment variables (can be overridden by host)
ENV MESH_SERIAL=/dev/ttyACM0 \
    MESH_SNAPSHOT_SECS=60 \
    MESH_CHANNEL_INDEX=0 \
    DEBUG=0 \
    POTATOMESH_INSTANCE="" \
    API_TOKEN=""

# Start the mesh daemon
CMD ["python", "mesh.py"]
