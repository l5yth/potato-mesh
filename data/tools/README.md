<!-- Copyright © 2025-26 l5yth & contributors -->
<!-- Licensed under the Apache License, Version 2.0 (see LICENSE) -->

# `data/tools/` — passive UDP operator & dev tools

Helpers for the passive UDP transport (`TRANSPORT=udp`, see the
[Passive UDP transport](../../README.md#passive-udp-transport) section of the
README). Neither file is part of the ingestor runtime.

## `capture_udp_fixtures.py` — capture real datagrams for testing

A **receive-only** diagnostic that joins the node's "Mesh via UDP" multicast
group and writes each raw datagram to a JSONL file (base64 in `raw_b64`). Used to
produce the real-traffic fixtures under
[`../../tests/fixtures/mesh_udp/`](../../tests/fixtures/mesh_udp/).

```bash
# Prereq: "Mesh via UDP" enabled on the node
#   meshtastic --set network.enabled_protocols 1
# Run on a host on the node's LAN (host networking; multicast can't cross a NAT):
python data/tools/capture_udp_fixtures.py --out capture.jsonl --count 40
# Optional live decode summary of primary-channel packets:
python data/tools/capture_udp_fixtures.py --out capture.jsonl --primary-only
```

It never transmits and never connects to the radio API, so it is safe to run
alongside a live ingestor or the phone app.

**Coverage note:** this is an operator-run diagnostic that needs a live LAN
socket, so it is intentionally exempt from the ingestor package's 100%-unit-test
gate. The runtime decode/crypto it exercises *is* fully covered by
`tests/test_meshtastic_udp_decode_unit.py` against the captured fixtures.

## `compose.udp.pi.yml` — Raspberry Pi (arm64) deployment

A Docker Compose file for running the ingestor in passive UDP mode on a Pi 5. It
requires `network_mode: host` (multicast `224.0.0.69` cannot reach a bridged
container) and reads the same `.env` as the standard deployment.

### `.env` keys the UDP deployment reads

```dotenv
TRANSPORT=udp
PRIMARY_CHANNEL_ONLY=1
PRIMARY_CHANNEL_KEY=AQ==          # base64 primary PSK (Meshtastic default)
PRIMARY_CHANNEL_NAME=MediumFast   # REQUIRED: name of channel 0 (or the preset
                                  # name if blank on the radio); resolves the
                                  # channel hash. If unset, primary-only mode
                                  # drops ALL traffic (fail closed).
INGESTOR_NODE_ID=!xxxxxxxx        # host node id for the ingestor heartbeat
MESH_UDP_GROUP=224.0.0.69
MESH_UDP_PORT=4403
# plus the standard API_TOKEN / INSTANCE_DOMAIN
```

### Build → ship → verify

The image is built **natively on an arm64 Pi** (no QEMU) and copied to the
target:

```bash
# 1. On a build Pi, from the source tree:
docker build -f data/Dockerfile -t potato-mesh-ingestor:udp .
docker save potato-mesh-ingestor:udp | gzip > potato-mesh-ingestor-udp.tar.gz

# 2. Copy the image tarball to the target Pi, then:
docker load < potato-mesh-ingestor-udp.tar.gz
cp data/tools/compose.udp.pi.yml compose.yml   # first time only; add .env keys above
docker compose up -d

# 3. Verify: the startup log pins the channel, and no secondary names appear.
docker compose logs ingestor | grep "UDP primary-channel filter"   # primary_channel_hash=<n>, severity=info
docker compose logs ingestor | grep "POST request failed"          # (expect nothing)
```

A `primary_channel_hash` of `null` / `severity=warn` means `PRIMARY_CHANNEL_NAME`
is unset and the ingestor is dropping everything (fail closed).
