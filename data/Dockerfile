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

ARG TARGETOS=linux
# Both stages below use this pin (DK-A2 Rust-drift caveat):
#   linux: armv7 publishes no cryptography wheel and compiles the Rust core
#          from source, so the resolved Alpine must ship Rust >= the pinned
#          cryptography's MSRV: 3.13.16-alpine -> Alpine 3.24 -> Rust 1.96 >= crypto 50's 1.83.
#   windows: production-windows reuses this ARG, so the release must also
#          exist as `windowsservercore-ltsc2022`; 3.13.16 is the last 3.13 that does.
# CI tests this minor (python.yml, SPEC DP5): bump both together. If a release
# lacks either tag, split this ARG per stage rather than 404 one base.
ARG PYTHON_VERSION=3.13.16

# Linux production image
FROM python:${PYTHON_VERSION}-alpine AS production-linux

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY data/requirements.txt ./
RUN set -eux; \
    apk add --no-cache \
        tzdata \
        curl \
        libstdc++ \
        libgcc; \
    apk add --no-cache --virtual .build-deps \
        gcc \
        musl-dev \
        linux-headers \
        build-base \
        # cryptography and cffi publish no 32-bit ARM wheels, so armv7
        # compiles both from source: cffi needs the libffi headers, and
        # cryptography's Rust extension needs rust/cargo plus the OpenSSL
        # headers found via pkgconfig (DK-A2). All of it is removed again
        # by the trailing `apk del`, so the final image size is unchanged.
        libffi-dev \
        openssl-dev \
        pkgconfig \
        rust \
        cargo; \
    python -m pip install --no-cache-dir -r requirements.txt; \
    apk del .build-deps

COPY data /app/data
RUN addgroup -S potatomesh && \
    adduser -S potatomesh -G potatomesh && \
    adduser potatomesh dialout && \
    # Pre-create the Reticulum config dir *before* the chown: a fresh named
    # volume mounted here is seeded from the image, inheriting this ownership.
    # Without it RNS would have to mkdir into a volume root it may not own.
    mkdir -p /app/.config/potato-mesh/reticulum && \
    chown -R potatomesh:potatomesh /app

USER potatomesh

ENV CONNECTION=/dev/ttyACM0 \
    CHANNEL_INDEX=0 \
    DEBUG=0 \
    PROTOCOL=meshtastic \
    XDG_CONFIG_HOME=/app/.config \
    RETICULUM_CONFIG_DIR=/app/.config/potato-mesh/reticulum \
    RETICULUM_INTERFACES="" \
    RETICULUM_FREQ="" \
    RETICULUM_PRESET="" \
    INGESTOR_NODE_ID="" \
    TRANSPORT=api \
    PRIMARY_CHANNEL_ONLY=0 \
    PRIMARY_CHANNEL_KEY=AQ== \
    PRIMARY_CHANNEL_NAME="" \
    MESH_UDP_GROUP=239.0.0.69,224.0.0.69 \
    MESH_UDP_PORT=4403 \
    ALLOWED_CHANNELS="" \
    HIDDEN_CHANNELS="" \
    DROP_VIA_MQTT=0 \
    TX_ENABLED=0 \
    TX_ANNOUNCE=0 \
    ENERGY_SAVING=0 \
    FREQUENCY="" \
    MESHCORE_SELF_TELEMETRY_SECONDS=3600 \
    MESHCORE_TELEMETRY_POLL_SECONDS=300 \
    MESHCORE_TELEMETRY_POLL_24H_EXEMPT="" \
    FEDERATION=1 \
    PRIVATE=0 \
    INSTANCE_DOMAIN="" \
    API_TOKEN=""

CMD ["python", "-m", "data.mesh"]

# Windows production image
FROM python:${PYTHON_VERSION}-windowsservercore-ltsc2022 AS production-windows

SHELL ["cmd", "/S", "/C"]

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY data/requirements.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt

COPY data /app/data

USER ContainerUser

ENV CONNECTION=/dev/ttyACM0 \
    CHANNEL_INDEX=0 \
    DEBUG=0 \
    PROTOCOL=meshtastic \
    XDG_CONFIG_HOME=/app/.config \
    RETICULUM_CONFIG_DIR=/app/.config/potato-mesh/reticulum \
    RETICULUM_INTERFACES="" \
    RETICULUM_FREQ="" \
    RETICULUM_PRESET="" \
    INGESTOR_NODE_ID="" \
    TRANSPORT=api \
    PRIMARY_CHANNEL_ONLY=0 \
    PRIMARY_CHANNEL_KEY=AQ== \
    PRIMARY_CHANNEL_NAME="" \
    MESH_UDP_GROUP=239.0.0.69,224.0.0.69 \
    MESH_UDP_PORT=4403 \
    ALLOWED_CHANNELS="" \
    HIDDEN_CHANNELS="" \
    DROP_VIA_MQTT=0 \
    TX_ENABLED=0 \
    TX_ANNOUNCE=0 \
    ENERGY_SAVING=0 \
    FREQUENCY="" \
    MESHCORE_SELF_TELEMETRY_SECONDS=3600 \
    MESHCORE_TELEMETRY_POLL_SECONDS=300 \
    MESHCORE_TELEMETRY_POLL_24H_EXEMPT="" \
    FEDERATION=1 \
    PRIVATE=0 \
    INSTANCE_DOMAIN="" \
    API_TOKEN=""

CMD ["python", "-m", "data.mesh"]

FROM production-${TARGETOS} AS production
