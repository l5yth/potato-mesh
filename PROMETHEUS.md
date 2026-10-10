<!-- Copyright © 2025-26 l5yth & contributors -->
<!-- Licensed under the Apache License, Version 2.0 (see LICENSE) -->

# Prometheus Monitoring for PotatoMesh

PotatoMesh exposes runtime telemetry at `/metrics` for Prometheus scraping.

## Runtime integration

No configuration required. `/metrics` is served automatically on the same
port as the dashboard as soon as the web app runs. Each scrape reads the
per-node gauges from the stored node rows. `meshtastic_nodes` is set at startup
and on each `POST /api/nodes`.

## Selecting which nodes are exported

Per-node metrics are opt-in via `PROM_REPORT_IDS` (avoids unbounded per-node
time series):

- Unset or blank: only aggregate gauges (e.g. total node count) are exported.
- `PROM_REPORT_IDS=*`: export metrics for every node.
- `PROM_REPORT_IDS='!abcd1234,!0a2f0001'`: export metrics for the listed node ids only. Ids are `!` plus 8 lowercase hex digits, as `/api/nodes` shows them. Quote the value; shells and YAML treat `!` specially.

Opted-out nodes are never exported, and with `PRIVATE=1` neither are hidden clients.

## Available metrics

| Metric name | Type | Labels | Description |
| --- | --- | --- | --- |
| `meshtastic_messages_total` | Counter | _none_ | Increments each time the ingest pipeline accepts a new message payload. |
| `meshtastic_nodes` | Gauge | _none_ | Number of nodes heard in the last 7 days, without opted-out nodes and, with `PRIVATE=1`, hidden clients: the nodes `/api/nodes` lists, with no 1000-node cap. |
| `meshtastic_node` | Gauge | `node`, `short_name`, `long_name`, `hw_model`, `role` | Reports a node as present (value `1`) with its current names, hardware model and role. One series per node. |
| `meshtastic_node_battery_level` | Gauge | `node` | Most recent battery percentage reported by the node. |
| `meshtastic_node_voltage` | Gauge | `node` | Most recent battery voltage reading. |
| `meshtastic_node_uptime_seconds` | Gauge | `node` | Uptime reported by the device in seconds. |
| `meshtastic_node_channel_utilization` | Gauge | `node` | Latest channel utilisation ratio supplied by the node. |
| `meshtastic_node_transmit_air_utilization` | Gauge | `node` | Proportion of on-air time spent transmitting. |
| `meshtastic_node_latitude` | Gauge | `node` | Latitude component of the last known position. |
| `meshtastic_node_longitude` | Gauge | `node` | Longitude component of the last known position. |
| `meshtastic_node_altitude` | Gauge | `node` | Altitude (in metres) of the last known position. |
| `http_server_requests_total` | Counter | `code`, `method`, `path` | Requests answered. `path` is the route that answered, for example `GET /api/nodes/:id` or `GET /map`, also when it answers 404; `static` for a static file; `metrics` for `/metrics`; `unmatched` for any other request, such as an unknown path. |
| `http_server_request_duration_seconds` | Histogram | `method`, `path` | Response time, with the same `path` values. |
| `http_server_exceptions_total` | Counter | `exception` | Exceptions raised while answering, by class. |

Per-node gauges are emitted only for ids in `PROM_REPORT_IDS`, and never for
an opted-out node. A gauge does not appear until the device has sent the
corresponding telemetry or position update at least once. The latitude,
longitude and altitude gauges do not appear for a position off the globe or at
`(0, 0)`.

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
