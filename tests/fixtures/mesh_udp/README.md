<!-- Copyright © 2025-26 l5yth & contributors -->
<!-- Licensed under the Apache License, Version 2.0 (see LICENSE) -->

# Mesh-via-UDP capture fixtures

`primary_and_private_capture.jsonl` — 32 real Meshtastic multicast datagrams
captured from a live Station G2 with `data/tools/capture_udp_fixtures.py`
(no filter — all channels). Each line: `{"raw_b64", "len", "src"}` where
`raw_b64` is the raw `MeshPacket` protobuf datagram.

Composition (validated): 21 primary-channel packets (channel hash 31) that
decrypt with the default key `AQ==`; 11 packets on 5 private channels that do
NOT decrypt with the default key (used to prove the drop path). Portnums on
primary: POSITION, TELEMETRY, TEXT_MESSAGE, TRACEROUTE, NODEINFO, ROUTING.
