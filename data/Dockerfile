# Multi-stage build for PotatoMesh Data Ingestor
FROM python:3.11-alpine AS builder

# Install build dependencies
RUN apk add --no-cache \
    gcc \
    musl-dev \
    linux-headers \
    build-base

# Set working directory
WORKDIR /app

# Copy requirements and install Python dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir --user -r requirements.txt

# Production stage
FROM python:3.11-alpine AS production

# Install runtime dependencies
RUN apk add --no-cache \
    tzdata \
    curl

# Create non-root user
RUN addgroup -g 1000 -S potatomesh && \
    adduser -u 1000 -S potatomesh -G potatomesh

# Set working directory
WORKDIR /app

# Copy installed Python packages from builder stage
COPY --from=builder /root/.local /home/potatomesh/.local

# Copy application code
COPY --chown=potatomesh:potatomesh . .

# Switch to non-root user
USER potatomesh

# Add local Python packages to PATH
ENV PATH=/home/potatomesh/.local/bin:$PATH

# Health check (check if process is running)
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD pgrep -f "python.*mesh.py" || exit 1

# Default environment variables
ENV MESH_SERIAL=/dev/ttyACM0 \
    MESH_SNAPSHOT_SECS=60 \
    MESH_CHANNEL_INDEX=0 \
    DEBUG=0 \
    POTATOMESH_INSTANCE="" \
    API_TOKEN=""

# Start the mesh daemon
CMD ["python", "mesh.py"]
