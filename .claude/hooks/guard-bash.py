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
"""PreToolUse guard for Bash: deny destructive actions, confirm risky ones.

Enforces the risky-action policy from the Phase 2 environment audit so that
destructive git, recursive deletion, publishing, secret reads, and external
network egress cannot run by accident.
"""

import json
import re
import sys


def decision(kind, reason):
    """Emit a PreToolUse permission decision (``deny`` or ``ask``) and exit."""
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": kind,
                    "permissionDecisionReason": reason,
                }
            }
        )
    )
    sys.exit(0)


DENY = [
    (
        re.compile(r"\bgit\s+push\b[^\n]*(--force\b|--force-with-lease\b|(?<!\w)-f\b)"),
        "Force-push denied (history rewrite). Push without --force, or run it manually.",
    ),
    (
        re.compile(
            r"\b(gem\s+push|npm\s+publish|cargo\s+publish|twine\s+upload"
            r"|docker\s+push|flutter\s+pub\s+publish|gh\s+release\s+create)\b"
        ),
        "Publishing/release denied — must be performed by a human.",
    ),
]
ASK = [
    (
        re.compile(
            r"\bgit\s+(reset\s+--hard|clean\s+-[A-Za-z]*f|checkout\s+--\s"
            r"|rebase\b|branch\s+-D\b|push\s+[^\n]*--delete\b)"
        ),
        "Confirm: this git command discards or rewrites work.",
    ),
    (re.compile(r"\bgit\s+push\b"), "Confirm before pushing to a remote."),
    (
        re.compile(r"(?:^|[\s=:'\"/])\.env\b(?!\.example)"),
        "Confirm: reading/using a secrets file (.env).",
    ),
    (
        re.compile(r"\bkeyfile\b|web/\.config\b|\.sqlite\b|\bmesh\.db\b"),
        "Confirm: accessing credentials or a database dump.",
    ),
]
NET = re.compile(r"\b(curl|wget|nc|ncat|telnet|scp|sftp|rsync)\b")
LOCAL = re.compile(r"127\.0\.0\.1|localhost|0\.0\.0\.0|::1")
RM, RM_R, RM_F = (
    re.compile(r"\brm\b"),
    re.compile(r"(?:^|\s)-[A-Za-z]*r|--recursive\b"),
    re.compile(r"(?:^|\s)-[A-Za-z]*f|--force\b"),
)


def main():
    """Read the PreToolUse payload and gate the Bash command."""
    try:
        cmd = (json.load(sys.stdin).get("tool_input", {}) or {}).get(
            "command", ""
        ) or ""
    except Exception:
        sys.exit(0)
    if RM.search(cmd) and RM_R.search(cmd) and RM_F.search(cmd):
        decision(
            "deny",
            "Recursive force-delete (rm -r -f) denied. Remove specific paths explicitly.",
        )
    for rx, why in DENY:
        if rx.search(cmd):
            decision("deny", why)
    for rx, why in ASK:
        if rx.search(cmd):
            decision("ask", why)
    if NET.search(cmd) and not LOCAL.search(cmd):
        decision("ask", "Confirm: network egress to a non-local host.")
    sys.exit(0)


if __name__ == "__main__":
    main()
