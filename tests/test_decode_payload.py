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

from __future__ import annotations

import base64
import io
import json
import sys

from meshtastic.protobuf import mesh_pb2
from meshtastic.protobuf import telemetry_pb2

from data.mesh_ingestor import decode_payload


def run_main_with_input(payload: dict) -> tuple[int, dict]:
    stdin = io.StringIO(json.dumps(payload))
    stdout = io.StringIO()
    original_stdin = sys.stdin
    original_stdout = sys.stdout
    try:
        sys.stdin = stdin
        sys.stdout = stdout
        status = decode_payload.main()
    finally:
        sys.stdin = original_stdin
        sys.stdout = original_stdout

    output = json.loads(stdout.getvalue() or "{}")
    return status, output


def test_decode_payload_position_success():
    position = mesh_pb2.Position()
    position.latitude_i = 525598720
    position.longitude_i = 136577024
    position.altitude = 11
    position.precision_bits = 13
    payload_b64 = base64.b64encode(position.SerializeToString()).decode("ascii")

    result = decode_payload._decode_payload(3, payload_b64)

    assert result["type"] == "POSITION_APP"
    assert result["payload"]["latitude_i"] == 525598720
    assert result["payload"]["longitude_i"] == 136577024
    assert result["payload"]["altitude"] == 11


def test_decode_payload_rejects_invalid_payload():
    result = decode_payload._decode_payload(3, "not-base64")

    assert result["error"].startswith("invalid-payload")
    assert "invalid-payload" in result["error"]


def test_decode_payload_rejects_unsupported_port():
    result = decode_payload._decode_payload(
        999, base64.b64encode(b"ok").decode("ascii")
    )

    assert result["error"] == "unsupported-port"
    assert result["portnum"] == 999


def test_main_handles_invalid_json():
    stdin = io.StringIO("nope")
    stdout = io.StringIO()
    original_stdin = sys.stdin
    original_stdout = sys.stdout
    try:
        sys.stdin = stdin
        sys.stdout = stdout
        status = decode_payload.main()
    finally:
        sys.stdin = original_stdin
        sys.stdout = original_stdout

    result = json.loads(stdout.getvalue())
    assert status == 1
    assert result["error"].startswith("invalid-json")


def test_main_requires_portnum():
    status, result = run_main_with_input(
        {"payload_b64": base64.b64encode(b"ok").decode("ascii")}
    )

    assert status == 1
    assert result["error"] == "missing-portnum"


def test_main_requires_integer_portnum():
    status, result = run_main_with_input(
        {"portnum": "3", "payload_b64": base64.b64encode(b"ok").decode("ascii")}
    )

    assert status == 1
    assert result["error"] == "missing-portnum"


def test_main_requires_payload():
    status, result = run_main_with_input({"portnum": 3})

    assert status == 1
    assert result["error"] == "missing-payload"


def test_main_requires_string_payload():
    status, result = run_main_with_input({"portnum": 3, "payload_b64": 123})

    assert status == 1
    assert result["error"] == "missing-payload"


def test_main_success_position_payload():
    position = mesh_pb2.Position()
    position.latitude_i = 525598720
    position.longitude_i = 136577024
    payload_b64 = base64.b64encode(position.SerializeToString()).decode("ascii")

    status, result = run_main_with_input({"portnum": 3, "payload_b64": payload_b64})

    assert status == 0
    assert result["type"] == "POSITION_APP"
    assert result["payload"]["latitude_i"] == 525598720


def test_decode_payload_handles_parse_failure():
    class BrokenMessage:
        def ParseFromString(self, _payload):
            raise ValueError("boom")

    decode_payload.PORTNUM_MAP[99] = ("BROKEN", BrokenMessage)
    payload_b64 = base64.b64encode(b"\x00").decode("ascii")

    result = decode_payload._decode_payload(99, payload_b64)

    assert result["error"].startswith("decode-failed")
    assert result["type"] == "BROKEN"
    decode_payload.PORTNUM_MAP.pop(99, None)


def test_main_entrypoint_executes():
    import runpy

    payload = {"portnum": 3, "payload_b64": base64.b64encode(b"").decode("ascii")}
    stdin = io.StringIO(json.dumps(payload))
    stdout = io.StringIO()
    original_stdin = sys.stdin
    original_stdout = sys.stdout
    try:
        sys.stdin = stdin
        sys.stdout = stdout
        try:
            runpy.run_module("data.mesh_ingestor.decode_payload", run_name="__main__")
        except SystemExit as exc:
            assert exc.code == 0
    finally:
        sys.stdin = original_stdin
        sys.stdout = original_stdout


def test_decode_payload_telemetry_success():
    telemetry = telemetry_pb2.Telemetry()
    telemetry.time = 123
    payload_b64 = base64.b64encode(telemetry.SerializeToString()).decode("ascii")

    result = decode_payload._decode_payload(67, payload_b64)

    assert result["type"] == "TELEMETRY_APP"
    assert result["payload"]["time"] == 123
