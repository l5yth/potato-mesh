# Prometheus Monitoring for PotatoMesh

PotatoMesh exposes runtime telemetry through a dedicated Prometheus endpoint so you can
observe message flow, node health, and geospatial metadata alongside the rest of your
infrastructure. This guide explains how the exporter is wired into the web
application, which metrics are available, and how to integrate the endpoint with a
Prometheus server.

## Runtime integration

The Sinatra application automatically loads the `prometheus-client` gem and mounts the
collector and exporter middlewares during boot. No additional configuration is
required to enable the `/metrics` endpoint—running the web application is enough to
serve Prometheus data on the same port as the dashboard. The middleware pair both
collects default Rack statistics and publishes PotatoMesh-specific gauges and
counters that are updated whenever the ingestors process new node records.

A background refresh is triggered during start-up via
`update_all_prometheus_metrics_from_nodes`, which seeds the gauges based on the latest
state in the database. Subsequent POST requests to the ingest APIs update each metric
in near real time.

## Selecting which nodes are exported

To avoid creating high-cardinality time series, PotatoMesh does not export per-node
metrics unless you opt in by providing node identifiers. Control this behaviour with
the `PROM_REPORT_IDS` environment variable:

- Leave the variable unset or blank to only export aggregate gauges such as the total
  node count.
- Set `PROM_REPORT_IDS=*` to export metrics for every node in the database.
- Provide a comma-separated list (for example `PROM_REPORT_IDS=ABCD1234,EFGH5678`) to
  expose metrics for specific nodes.

The selection applies to both the initial refresh and the incremental updates handled
by the ingest pipeline.

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

All per-node gauges are only emitted for identifiers included in `PROM_REPORT_IDS`.
Some values require telemetry packets to be present—for example, devices must provide
metrics or positional updates before the related gauges appear.

## Accessing the `/metrics` endpoint

Once the application is running, query the exporter directly:

```bash
curl http://localhost:41447/metrics
```

Use any HTTP client capable of plain-text requests. Prometheus scrapers should target
the same URL. The endpoint returns data in the standard exposition format produced by
`prometheus-client`.

## Prometheus scrape configuration

Add a job to your Prometheus server configuration that points to the PotatoMesh
instance. This example polls an instance running locally on the default port every 15
seconds:

```yaml
scrape_configs:
  - job_name: potatomesh
    scrape_interval: 15s
    static_configs:
      - targets:
          - localhost:41447
```

If your deployment requires authentication or runs behind a reverse proxy, configure
Prometheus to match your network topology (for example by adding basic authentication
credentials, custom headers, or TLS settings).

## Troubleshooting

- **No per-node metrics appear.** Ensure that `PROM_REPORT_IDS` is set and that the
  specified nodes exist in the database. Set the value to `*` if you want to export
  every node during initial validation.
- **Metrics look stale after a restart.** Confirm that the ingestor is still posting
  telemetry. The exporter only reflects data stored in the PotatoMesh database.
- **Scrapes time out.** Verify that the Prometheus server can reach the PotatoMesh
  HTTP port and that no reverse proxy is blocking the `/metrics` path.

With the endpoint configured, you can build Grafana dashboards or alerting rules to
keep track of community mesh health in real time.
