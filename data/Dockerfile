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
ARG PYTHON_VERSION=3.12.6

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
        build-base; \
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
    ALLOWED_CHANNELS="" \
    HIDDEN_CHANNELS="" \
    INSTANCE_DOMAIN="" \
    API_TOKEN=""

CMD ["python", "-m", "data.mesh"]

FROM production-${TARGETOS} AS production
