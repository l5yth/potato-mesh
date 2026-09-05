<!-- Copyright © 2025-26 l5yth & contributors -->
<!-- Licensed under the Apache License, Version 2.0 (see LICENSE) -->

# Prometheus Monitoring for PotatoMesh

PotatoMesh exposes runtime telemetry at `/metrics` for Prometheus scraping.

## Runtime integration

No configuration required. `/metrics` is served automatically on the same
port as the dashboard as soon as the web app runs. Gauges are seeded from the
database at startup and updated in near real time as `POST` ingest requests
arrive.

## Selecting which nodes are exported

Per-node metrics are opt-in via `PROM_REPORT_IDS` (avoids unbounded per-node
time series):

- Unset or blank: only aggregate gauges (e.g. total node count) are exported.
- `PROM_REPORT_IDS=*`: export metrics for every node.
- `PROM_REPORT_IDS=ABCD1234,EFGH5678`: export metrics for the listed node ids only.

Applies to both the initial refresh and incremental updates.

## Available metrics

| Metric name | Type | Labels | Description |
| --- | --- | --- | --- |
| `meshtastic_messages_total` | Counter | _none_ | Increments each time the ingest pipeline accepts a new message payload. |
| `meshtastic_nodes` | Gauge | _none_ | Tracks the number of nodes currently stored in the database. |
| `meshtastic_node` | Gauge | `node`, `short_name`, `long_name`, `hw_model`, `role` | Reports a node as present (value `1`) along with identity metadata. |
| `meshtastic_node_battery_level` | Gauge | `node` | Most recent battery percentage reported by the node. |
| `meshtastic_node_voltage` | Gauge | `node` | Most recent battery voltage reading. |
| `meshtastic_node_uptime_seconds` | Gauge | `node` | Uptime reported by the device in seconds. |
| `meshtastic_node_channel_utilization` | Gauge | `node` | Latest channel utilisation ratio supplied by the node. |
| `meshtastic_node_transmit_air_utilization` | Gauge | `node` | Proportion of on-air time spent transmitting. |
| `meshtastic_node_latitude` | Gauge | `node` | Latitude component of the last known position. |
| `meshtastic_node_longitude` | Gauge | `node` | Longitude component of the last known position. |
| `meshtastic_node_altitude` | Gauge | `node` | Altitude (in metres) of the last known position. |

Per-node gauges are emitted only for ids in `PROM_REPORT_IDS`. A gauge does
not appear until the device has sent the corresponding telemetry or position
update at least once.

## Accessing the `/metrics` endpoint

```bash
curl http://localhost:41447/metrics
```

Returns the standard Prometheus exposition format.

## Prometheus scrape configuration

Example (instance on the default port, 15 s interval):

```yaml
scrape_configs:
  - job_name: potatomesh
    scrape_interval: 15s
    static_configs:
      - targets:
          - localhost:41447
```

Behind a reverse proxy or auth, configure Prometheus's `basic_auth`, custom
headers, or TLS settings to match.

## Troubleshooting

- No per-node metrics appear. Set `PROM_REPORT_IDS` to the node ids you want, or `*` to export all.
- Metrics look stale after a restart. Confirm the ingestor is still posting - the exporter only reflects what is stored in the database.
- Scrapes time out. Verify Prometheus can reach the PotatoMesh HTTP port and that no reverse proxy blocks `/metrics`.
