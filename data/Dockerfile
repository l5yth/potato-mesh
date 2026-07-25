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
# This pin is bounded on both sides (DK-A2 Rust-drift caveat):
#   lower — the resolved Alpine base must ship Rust >= cryptography's MSRV,
#           because armv7 publishes no wheel and compiles the Rust core from
#           source: 3.12.10-alpine -> Alpine 3.22 -> Rust 1.87 >= crypto 49's 1.83.
#   upper — Docker Hub published no `windowsservercore-ltsc2022` base past
#           3.12.10, and production-windows below reuses this same ARG.
# Raise the floor by bumping here; if crypto's MSRV ever outruns the Alpine that
# 3.12.10 resolves to, split this ARG per stage rather than 404 the Windows base.
ARG PYTHON_VERSION=3.12.10

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
    chown -R potatomesh:potatomesh /app

USER potatomesh

ENV CONNECTION=/dev/ttyACM0 \
    CHANNEL_INDEX=0 \
    DEBUG=0 \
    PROTOCOL=meshtastic \
    TRANSPORT=api \
    PRIMARY_CHANNEL_ONLY=0 \
    PRIMARY_CHANNEL_KEY=AQ== \
    PRIMARY_CHANNEL_NAME="" \
    MESH_UDP_GROUP=224.0.0.69 \
    MESH_UDP_PORT=4403 \
    ALLOWED_CHANNELS="" \
    HIDDEN_CHANNELS="" \
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
    TRANSPORT=api \
    PRIMARY_CHANNEL_ONLY=0 \
    PRIMARY_CHANNEL_KEY=AQ== \
    PRIMARY_CHANNEL_NAME="" \
    MESH_UDP_GROUP=224.0.0.69 \
    MESH_UDP_PORT=4403 \
    ALLOWED_CHANNELS="" \
    HIDDEN_CHANNELS="" \
    INSTANCE_DOMAIN="" \
    API_TOKEN=""

CMD ["python", "-m", "data.mesh"]

FROM production-${TARGETOS} AS production
