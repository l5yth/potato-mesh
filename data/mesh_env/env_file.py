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

"""Read and write ``.env`` files while preserving unmanaged lines."""

from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path

_MANAGED_KEYS: frozenset[str] = frozenset(
    {
        "PROVIDER",
        "CONNECTION",
        "ALLOWED_CHANNELS",
        "HIDDEN_CHANNELS",
        "INSTANCE_DOMAIN",
        "API_TOKEN",
        "DEBUG",
        "ENERGY_SAVING",
    }
)

_KEY_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")

# Dropped from preserved text so re-running the wizard does not stack duplicate headers.
_MANAGED_BLOCK_HEADER = "# --- potato-mesh ingestor (mesh_env wizard) ---"


def managed_keys() -> frozenset[str]:
    return _MANAGED_KEYS


def parse_env_lines(text: str) -> dict[str, str]:
    """Parse ``KEY=value`` assignments; ignores export prefix and strips quotes."""

    result: dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        m = _KEY_RE.match(line)
        if not m:
            continue
        key, val = m.group(1), m.group(2).strip()
        if val.startswith('"') and val.endswith('"') and len(val) >= 2:
            val = val[1:-1].replace('\\"', '"')
        elif val.startswith("'") and val.endswith("'") and len(val) >= 2:
            val = val[1:-1]
        result[key] = val
    return result


def load_managed_from_file(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    return {
        k: v
        for k, v in parse_env_lines(
            path.read_text(encoding="utf-8", errors="replace")
        ).items()
        if k in _MANAGED_KEYS
    }


def merge_write_env(path: Path, values: dict[str, str]) -> None:
    """Drop prior managed-key lines from *path* and append a block with *values*.

    The wizard banner comment is not preserved from the old file so repeat runs do
    not accumulate duplicate headers.
    """

    path.parent.mkdir(parents=True, exist_ok=True)
    existing = ""
    if path.is_file():
        existing = path.read_text(encoding="utf-8", errors="replace")

    kept_lines: list[str] = []
    for raw_line in existing.splitlines():
        stripped = raw_line.strip()
        if stripped.startswith("#") or not stripped:
            if stripped == _MANAGED_BLOCK_HEADER:
                continue
            kept_lines.append(raw_line)
            continue
        line = stripped
        if line.startswith("export "):
            line = line[7:].lstrip()
        m = _KEY_RE.match(line)
        if m and m.group(1) in _MANAGED_KEYS:
            continue
        kept_lines.append(raw_line)

    while kept_lines and kept_lines[-1].strip() == "":
        kept_lines.pop()

    block_lines = [
        "",
        _MANAGED_BLOCK_HEADER,
    ]
    order = (
        "PROVIDER",
        "CONNECTION",
        "ALLOWED_CHANNELS",
        "HIDDEN_CHANNELS",
        "INSTANCE_DOMAIN",
        "API_TOKEN",
        "DEBUG",
        "ENERGY_SAVING",
    )
    for key in order:
        if key not in _MANAGED_KEYS or key not in values:
            continue
        val = values[key]
        if val is None:
            continue
        sval = str(val)
        if re.search(r"[\s#\"']", sval) or sval == "":
            esc = sval.replace("\\", "\\\\").replace('"', '\\"')
            block_lines.append(f'{key}="{esc}"')
        else:
            block_lines.append(f"{key}={sval}")

    out_text = "\n".join(kept_lines)
    if kept_lines:
        out_text += "\n"
    out_text += "\n".join(block_lines) + "\n"

    fd, tmp = tempfile.mkstemp(prefix=".env.", dir=str(path.parent), text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(out_text)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass
