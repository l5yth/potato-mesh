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

"""Ensure the root ``Dockerfile`` stays identical to ``web/Dockerfile``.

``web/Dockerfile`` is the canonical web image build; the root ``Dockerfile`` is
a backward-compatibility copy that nothing in the repository builds, so its
drift goes unnoticed without this guard. Each file keeps its own leading
comment header (the license block, plus the root copy's compatibility note);
the parser directives and every line after the header must match.
"""

from __future__ import annotations

import difflib
import itertools
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

#: Repository-relative path of the canonical web image build file.
CANONICAL_DOCKERFILE = "web/Dockerfile"

#: Repository-relative path of the backward-compatibility copy.
ROOT_DOCKERFILE = "Dockerfile"

#: BuildKit parser directives (``# syntax=``, ``# escape=``, ``# check=``).
#: They are written as comments but change how the file is parsed, so they are
#: compared with the body rather than stripped with the header.
_PARSER_DIRECTIVE = re.compile(r"\s*#\s*(?:syntax|escape|check)\s*=", re.IGNORECASE)


def _is_header_line(line: str) -> bool:
    """Report whether ``line`` can belong to a Dockerfile's leading header.

    Args:
        line: One line of a Dockerfile, without its newline.

    Returns:
        ``True`` for a blank line or a ``#`` comment, ``False`` otherwise.
    """

    stripped = line.strip()
    return not stripped or stripped.startswith("#")


def _dockerfile_body(text: str) -> list[str]:
    """Return a Dockerfile's parser directives and body, without its header.

    The leading header (every comment and blank line before the first
    instruction) is dropped. Parser directives at the top of the file are kept,
    as is every line from the first instruction onward, comments included.

    Args:
        text: Full contents of a Dockerfile.

    Returns:
        The parser directive lines followed by the body lines, without line
        terminators.
    """

    lines = text.splitlines()
    # Docker honours parser directives only as the very first lines of a
    # file, so collection stops at the first line that is not one.
    directives = list(itertools.takewhile(_PARSER_DIRECTIVE.match, lines))
    body = itertools.dropwhile(_is_header_line, lines[len(directives) :])
    return directives + list(body)


def _body_drift(canonical: str, copy: str) -> str:
    """Diff the canonical file's directives and body against the copy's.

    Args:
        canonical: Contents of ``web/Dockerfile``.
        copy: Contents of the root ``Dockerfile``.

    Returns:
        A unified diff labelled with both repository paths (``-`` lines are
        missing from the copy, ``+`` lines exist only in the copy), or an empty
        string when they match. Hunk line numbers count the compared lines,
        not the lines of either file.
    """

    diff = difflib.unified_diff(
        _dockerfile_body(canonical),
        _dockerfile_body(copy),
        fromfile=CANONICAL_DOCKERFILE,
        tofile=ROOT_DOCKERFILE,
        lineterm="",
    )
    return "\n".join(diff)


def test_root_dockerfile_matches_canonical_web_dockerfile() -> None:
    """Guard the root ``Dockerfile`` against drift from ``web/Dockerfile``."""

    drift = _body_drift(
        (REPO_ROOT / CANONICAL_DOCKERFILE).read_text(encoding="utf-8"),
        (REPO_ROOT / ROOT_DOCKERFILE).read_text(encoding="utf-8"),
    )
    assert not drift, (
        f"{ROOT_DOCKERFILE} has drifted from {CANONICAL_DOCKERFILE}, the canonical "
        f"build file. Copy everything below {CANONICAL_DOCKERFILE}'s license "
        f"header into {ROOT_DOCKERFILE}, below {ROOT_DOCKERFILE}'s own header, "
        f"and keep the two files' line-1 parser directives (# syntax=) identical. "
        f"Diff of the compared lines (leading comment headers excluded):\n{drift}"
    )


def test_dockerfile_body_drops_only_the_leading_header() -> None:
    """Parser directives and comments after the first instruction survive."""

    text = (
        "# syntax=docker/dockerfile:1.6\n"
        "# License notice\n"
        "\n"
        "# NOTE: compatibility copy\n"
        "\n"
        "FROM alpine AS base\n"
        "\n"
        "# In-body comment\n"
        "RUN true\n"
    )

    assert _dockerfile_body(text) == [
        "# syntax=docker/dockerfile:1.6",
        "FROM alpine AS base",
        "",
        "# In-body comment",
        "RUN true",
    ]


def test_body_drift_ignores_headers_and_reports_build_changes() -> None:
    """Header-only differences are not drift; directive and body changes are."""

    canonical = "# syntax=docker/dockerfile:1.6\n# License\n\nFROM alpine\nRUN true\n"
    noted = canonical.replace("\n\n", "\n\n# NOTE: compatibility copy\n\n")
    reworded = canonical.replace("RUN true", "RUN false")
    bumped = canonical.replace("dockerfile:1.6", "dockerfile:1.7")

    assert _body_drift(canonical, noted) == ""

    body_drift = _body_drift(canonical, reworded)
    assert body_drift.startswith(f"--- {CANONICAL_DOCKERFILE}\n+++ {ROOT_DOCKERFILE}")
    assert "-RUN true" in body_drift
    assert "+RUN false" in body_drift

    assert "+# syntax=docker/dockerfile:1.7" in _body_drift(canonical, bumped)
