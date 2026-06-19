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
"""PreToolUse guard protecting the apex invariant (SPEC.md §1, ACCEPTANCE.md A1).

Blocks Edit/Write/MultiEdit calls that would add an MQTT or other message-broker
dependency to a package manifest. The Meshtastic ``via_mqtt`` provenance flag is
explicitly allowed and scrubbed before scanning.
"""

import json
import os
import re
import sys

# Dependency-declaration manifests that must never gain a broker client.
MANIFESTS = (
    "Gemfile",
    "requirements.txt",
    "Cargo.toml",
    "pubspec.yaml",
    "package.json",
)
# "mqtt" et al. match as substrings so embedded crate/package names (e.g.
# ``rumqttc``, ``paho-mqtt``) are caught; generic ``broker`` stays word-bounded.
BROKER = re.compile(r"(?i)(mqtt|mosquitto|paho|amqp|kafka|rabbitmq|\bbroker\b)")
ALLOWED = re.compile(r"(?i)via_?mqtt")


def added_text(tool, ti):
    """Return the text a tool call would introduce into the file."""
    if tool == "Write":
        return ti.get("content", "")
    if tool == "Edit":
        return ti.get("new_string", "")
    if tool == "MultiEdit":
        return "\n".join(e.get("new_string", "") for e in ti.get("edits", []))
    return ""


def main():
    """Read the PreToolUse payload and deny apex-violating manifest edits."""
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # never break a tool call on a parse error
    ti = payload.get("tool_input", {}) or {}
    if os.path.basename(ti.get("file_path", "") or "") not in MANIFESTS:
        sys.exit(0)
    scrubbed = ALLOWED.sub("", added_text(payload.get("tool_name", ""), ti))
    if BROKER.search(scrubbed):
        print(
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "deny",
                        "permissionDecisionReason": (
                            "Blocked by the PotatoMesh apex invariant (SPEC.md §1): refusing to add "
                            "an MQTT/cloud-broker dependency. PotatoMesh is local-LoRa only."
                        ),
                    }
                }
            )
        )
    sys.exit(0)


if __name__ == "__main__":
    main()
