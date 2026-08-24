<!-- Copyright © 2025-26 l5yth & contributors -->
<!-- Licensed under the Apache License, Version 2.0 (see LICENSE) -->

# Issue #884 — "Option to not ingest mqtt users"

Working notes: what the code actually does today, what was verified against the
pinned Meshtastic library, and what was decided. Written to be pasteable into
the issue and picked up later once probe data exists.

**Status:** blocked on empirical data. The diagnostic probe is on branch
`l5y-ingestor-mqtt-probe`; the feature itself is not started.

---

## 1. Why the reporter's config doesn't already do this

`PRIMARY_CHANNEL_ONLY=1` gates **messages only** — `handlers/generic.py:509`,
inside `store_packet_dict`. Node records are never channel-filtered. Nodes enter
through two paths, neither channel- nor MQTT-aware:

1. `store_nodeinfo_packet` — `handlers/nodeinfo.py:42`, NODEINFO heard over the air.
2. The node-database snapshot — `daemon.py:409` → `MeshtasticProvider.node_snapshot_items`
   (`protocols/meshtastic.py:74`) → `handlers.upsert_node`. This dumps `iface.nodes`
   wholesale: every node the radio knows, regardless of the channel it was learned on.

Path 2 explains the reporter's follow-up ("not relayed on LongFast, yet they still
appear"). Those nodes aren't arriving as LongFast packets — they're already in the
radio's nodeDB from the private channels, and the snapshot publishes the whole DB.

**Correction to an early reading:** the snapshot is *not* periodic. It runs **once
per connection**, gated by `initial_snapshot_sent` (`daemon.py:639`) and reset on
every reconnect (`daemon.py:314, 393, 530`). With
`DEFAULT_INACTIVITY_RECONNECT_SECS = 3600` (`config.py:40`), a quiet mesh reconnects
about hourly, so it re-fires roughly that often in practice.

## 2. The provenance flag is captured today, then discarded

`handlers/nodeinfo.py:180` sets `node_payload["viaMqtt"]`, and the snapshot path
passes meshtastic's raw node dict through `upsert_payload` (`serialization.py:270`),
so the key rides along there too. But the `nodes` table has no such column
(`data/nodes.sql:17-53`) and `node_writes.rb:352` never maps it. The flag dies at the
web boundary. **An ingestor-side filter therefore needs no schema migration.**

## 3. Verified against the pinned library

Checked against `meshtastic 2.7.11` (`data/requirements.txt`), protobuf 7.35.1:

| Source | Proto field | JSON key | Reaches ingestor as |
| --- | --- | --- | --- |
| `NodeInfo` | `via_mqtt` (f8) | `viaMqtt` | `iface.nodes[id]["viaMqtt"]` |
| `MeshPacket` | `via_mqtt` (f14) | `viaMqtt` | `packet["viaMqtt"]` (top level) |

- Node dicts are built by `node.update(MessageToDict(fromRadio)["nodeInfo"])`
  (`mesh_interface.py:1348`), so snapshot entries carry the flag.
- Packets published to `meshtastic.receive` are `MessageToDict(meshPacket)`
  (`mesh_interface.py:1566`), so the flag is top-level there.
- **Presence means true.** It is a proto3 no-presence scalar, so `MessageToDict`
  omits it when false. Verified for unset / `False` / `True`. `bool(x.get("viaMqtt"))`
  is the correct test; absent ⇒ keep. No tri-state needed.
- `iface.nodes` only ever holds NodeInfo-derived entries (written solely at
  `mesh_interface.py:1358`); `_getOrCreateByNum` placeholders stay in `nodesByNum`.
- **The nodeDB flag is sticky.** `dict.update` cannot clear a key that
  `MessageToDict` omitted, so a node first heard via MQTT and later heard directly
  over RF keeps `viaMqtt: True` until the radio reboots. Verified:
  `update(via_mqtt=True)` then `update(via_mqtt=False)` still reads `True`.
  The per-packet flag has no such problem — it is per-transmission truth.

## 4. The open question that gates everything

Does the firmware still set `via_mqtt` on a packet that a **neighbour's** gateway
downlinked from MQTT onto LoRa, once our radio demodulates it?

Believed yes — it is a LoRa header flag bit (`PACKET_FLAGS_VIA_MQTT_MASK`), not only
a protobuf field, so it should survive the RF hop. **This could not be confirmed from
this repository:** the UDP path decodes full `MeshPacket` protobufs
(`protocols/meshtastic_udp_decode.py`) and never parses raw LoRa header flags, and the
Python library only reports what the device already decoded.

If the bit is not set on relayed packets, a packet-level filter catches nothing and
the whole approach needs rethinking. **Hence the probe — run it before building.**

## 5. MeshCore — out of scope, deliberately

1. **No MQTT at all.** Zero matches for `mqtt|broker` across `protocols/meshcore/`.
   The filter is a Meshtastic-only concern by nature.
2. **The packet gate is a safe no-op there.** MeshCore does reach `store_packet_dict`
   for chat (`protocols/meshcore/handlers.py:321,363`), but its packet dicts are
   synthesized and never carry `viaMqtt`. Absent ⇒ keep, so they pass straight through.
3. **Its snapshot is not a stale nodeDB** — it is the companion device's contact book
   (`protocols/meshcore/provider.py:180`), which is how MeshCore learns nodes at all,
   plus the self-node. `_process_contacts` already upserts every contact independently
   (handlers subscribe before `mc.connect()`/`ensure_contacts()`, `runner.py:157-224`),
   so the daemon snapshot is *mostly* redundant there — but removing it re-opens
   issue #788's ordering fix for no benefit.

## 6. Decisions

| # | Decision |
| --- | --- |
| D1 | Filter **ingestor-side**, not web-side. No schema migration; nothing new persisted. |
| D2 | `DROP_VIA_MQTT` env flag, **default `0`** (off). Existing behaviour is unchanged unless the operator opts in. |
| D3 | **Remove the Meshtastic node-table snapshot entirely** — no `SKIP_NODE_SNAPSHOT` flag. The snapshot is a standing source of inconsistency; only fresh, locally-received data should be ingested. |
| D4 | Cold start goes empty and fills slowly (default NodeInfo broadcast interval is 3h) — **accepted**. |
| D5 | Reconnect gaps become permanent holes — **accepted**. |
| D6 | **Position/telemetry-only nodes must still be upserted.** `handlers/position.py` and `handlers/telemetry.py` POST to their own endpoints and never call `upsert_node`, so without the snapshot a node that emits position but not NODEINFO would depend on web-side synthetic-node creation. Needs its own fix alongside D3. |
| D7 | MeshCore untouched — Meshtastic only. Keep `node_snapshot_items` in the `MeshProtocol` interface. |

## 7. Known couplings to handle when implementing D3

- **`_try_send_self_node` is gated on `initial_snapshot_sent`** (`daemon.py:650`), and
  that flag is only set by `_try_send_snapshot` when `processed_any` is true
  (`daemon.py:437`). Remove the snapshot naively and the host self-node report never
  fires **on either protocol**. This gate must be decoupled in the same change.
- `store_packet_dict` (`handlers/generic.py:322`) is the sole router for every
  Meshtastic packet type, so **one** gate at the top of it covers them all.

## 8. Naming trap — ACCEPTANCE A1b

`ACCEPTANCE.md:78-80` greps every `.rb/.py/.rs/.dart/.js` for
`mqtt|mosquitto|paho|amqp|kafka|broker` and whitelists only `via_?mqtt`. Any new
identifier — or prose in a docstring — containing a bare `mqtt` **fails the hard gate**.
`.claude/hooks/guard-edits.py` enforces the same rule at edit time.

- Passes: `DROP_VIA_MQTT`, `VIA_MQTT_PROBE`, `reason="via-mqtt"`
- Fails: `IGNORE_MQTT_NODES`, `MQTT_FILTER`, `reason="mqtt-relayed"`

This was hit once already while writing the probe (a docstring line reading "a
packet-level MQTT filter"), and fixed by rewording to `via_mqtt`.

## 9. The probe — how to run it

Branch `l5y-ingestor-mqtt-probe` adds `data/mesh_ingestor/via_mqtt_probe.py`, wired
into `store_packet_dict` and `_try_send_snapshot`. It is **read-only**: it never drops,
mutates, transmits, or changes what is POSTed. Off unless `VIA_MQTT_PROBE=1`, and
independent of `DEBUG` so it can run on a production ingestor without the debug firehose.

```yaml
environment:
  VIA_MQTT_PROBE: "1"
```

Each packet is classified by whether the radio stamped RF receive metadata
(`rxSnr`/`rxRssi` — only present for a transmission it actually demodulated)
alongside the flag:

| Classification | Meaning |
| --- | --- |
| `mqtt-over-rf` | **The decisive finding.** Flagged *and* heard over the air — a neighbour bridged it and the bit survived. A packet-level filter would work. |
| `mqtt-no-rf` | Flagged with no RF evidence — would mean a host-side MQTT client, which PotatoMesh never runs. |
| `direct-rf` | Ordinary local RF traffic. |
| `no-rf-metadata` | Locally generated (own node). |

A rolling tally follows every 25 packets, and each node snapshot reports how many
roster entries carry the flag.

```
context=via_mqtt_probe.packet classification='mqtt-over-rf' from_id='!a1b2c3d4' \
  hop_limit=2 hop_start=3 portnum='TEXT_MESSAGE_APP' rx_rssi=-104 rx_snr=-12.5 via_mqtt=True
context=via_mqtt_probe.summary probed_packets=25 mqtt_over_rf=3 mqtt_no_rf=0 \
  direct_rf=21 no_rf_metadata=1 flagged_senders=['!a1b2c3d4']
context=via_mqtt_probe.snapshot snapshot_nodes=214 flagged_nodes=37 flagged_node_ids=[...]
```

**What to look for:** any non-zero `mqtt_over_rf` confirms the approach and unblocks
implementation. If it stays at zero while the dashboard keeps showing MQTT users, the
flag does not survive the RF hop and the packet-level filter is the wrong mechanism —
in which case `snapshot_nodes` vs `flagged_nodes` shows how much of the problem D3
alone would solve.

Delete the probe once the question is settled.
