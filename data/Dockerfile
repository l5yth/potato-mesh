# syntax=docker/dockerfile:1.6

ARG TARGETOS=linux
ARG PYTHON_VERSION=3.12.6

# Linux production image
FROM python:${PYTHON_VERSION}-alpine AS production-linux

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN apk add --no-cache \
    tzdata \
    curl

COPY data/requirements.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt

COPY data/ .
RUN addgroup -S potatomesh && \
    adduser -S potatomesh -G potatomesh && \
    adduser potatomesh dialout && \
    chown -R potatomesh:potatomesh /app

USER potatomesh

ENV MESH_SERIAL=/dev/ttyACM0 \
    MESH_SNAPSHOT_SECS=60 \
    MESH_CHANNEL_INDEX=0 \
    DEBUG=0 \
    POTATOMESH_INSTANCE="" \
    API_TOKEN=""

CMD ["python", "mesh.py"]

# Windows production image
FROM python:${PYTHON_VERSION}-windowsservercore-ltsc2022 AS production-windows

SHELL ["cmd", "/S", "/C"]

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY data/requirements.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt

COPY data/ .

USER ContainerUser

ENV MESH_SERIAL=/dev/ttyACM0 \
    MESH_SNAPSHOT_SECS=60 \
    MESH_CHANNEL_INDEX=0 \
    DEBUG=0 \
    POTATOMESH_INSTANCE="" \
    API_TOKEN=""

CMD ["python", "mesh.py"]

FROM production-${TARGETOS} AS production
