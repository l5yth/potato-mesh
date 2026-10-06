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

"""Keep CI testing the language runtimes the published images ship.

The web image ran ``ruby:3.3-alpine`` and the ingestor image Python 3.12
while CI tested only Ruby 3.4/4.0 and Python 3.13, so a change that broke the
shipped runtimes passed every check.
"""

from __future__ import annotations

import fnmatch
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
PYTHON_WORKFLOW = ".github/workflows/python.yml"

# (image Dockerfile, regex capturing each ``major.minor`` runtime it ships,
# workflow whose test matrix must list that version, matrix key).
RUNTIME_PINS = (
    (
        "web/Dockerfile",
        r"^FROM\s+ruby:(\d+\.\d+)\b",
        ".github/workflows/ruby.yml",
        "ruby-version",
    ),
    (
        "data/Dockerfile",
        r"^ARG\s+PYTHON_VERSION=(\d+\.\d+)\b",
        PYTHON_WORKFLOW,
        "python-version",
    ),
)

# Files the guards in this module, in test_dependency_manifests.py and in
# test_configure_script.py read. A pull request touching any of them must run
# the Python workflow. Pushes to main run it unfiltered, which still covers what
# these guards read beyond this list (.gitignore, a manifest in a new
# directory).
GUARDED_INPUTS = (
    ".github/dependabot.yml",
    ".github/workflows/python.yml",
    ".github/workflows/ruby.yml",
    "configure.sh",
    "data/Dockerfile",
    "data/requirements-dev.txt",
    "data/requirements.txt",
    "tests/test_ci_runtime_sync.py",
    "tests/test_dependency_manifests.py",
    "web/Dockerfile",
    "web/Gemfile",
    "web/Gemfile.lock",
)


def _read(relative: str) -> str:
    """Return a repository file's text.

    Args:
        relative: Path relative to the repository root.

    Returns:
        The file contents.
    """

    return (REPO_ROOT / relative).read_text(encoding="utf-8")


def _matrix_values(workflow: str, key: str) -> set[str]:
    """Return the values of a flow-style ``key: [...]`` matrix list.

    Args:
        workflow: The workflow YAML.
        key: The matrix key, such as ``ruby-version``.

    Returns:
        The listed values with quotes stripped; empty when ``key`` holds no
        flow list (a scalar ``python-version: "3.13"`` is not a matrix).
    """

    listing = re.search(
        rf"^\s+{re.escape(key)}:\s*\[(?P<items>[^\]]*)\]", workflow, re.MULTILINE
    )
    if listing is None:
        return set()
    items = listing.group("items").split(",")
    return {item.strip().strip("\"'") for item in items if item.strip()}


def _pull_request_paths(workflow: str) -> list[str]:
    """Return the path filters listed under ``on.pull_request.paths``.

    Comment lines and blank lines inside the list are skipped, and so is a
    trailing ``# comment`` on an item, so annotating the filters cannot hide
    the ones below the annotation.

    Args:
        workflow: The workflow YAML (block style, two-space indents).

    Returns:
        The globs in order, with quotes stripped; empty when the workflow
        has no such filter.
    """

    section = re.search(r"^  pull_request:\n((?:(?:   .*)?\n)*)", workflow, re.M)
    body = section.group(1) if section else ""
    listing = re.search(r"^    paths:\n((?:(?:      [-#].*)?\n)*)", body, re.M)
    lines = listing.group(1).splitlines() if listing else []
    items = [re.sub(r"(^|\s)#.*$", "", line).strip() for line in lines]
    return [item[2:].strip().strip("\"'") for item in items if item.startswith("- ")]


@pytest.mark.parametrize(
    ("dockerfile", "pattern", "workflow", "key"),
    RUNTIME_PINS,
    ids=("web-ruby", "ingestor-python"),
)
def test_ci_matrix_tests_the_shipped_runtime(
    dockerfile: str, pattern: str, workflow: str, key: str
) -> None:
    """The workflow matrix lists every runtime minor the image ships."""

    shipped = set(re.findall(pattern, _read(dockerfile), re.MULTILINE))
    text = _read(workflow)
    tested = _matrix_values(text, key)
    assert shipped, f"no runtime version found in {dockerfile}"
    assert shipped <= tested, (
        f"{dockerfile} ships {sorted(shipped)} but the {key} matrix in "
        f"{workflow} tests {sorted(tested)}"
    )
    # A matrix the setup step ignores tests one runtime N times.
    assert "${{ matrix.%s }}" % key in text, f"{workflow} does not use matrix.{key}"


@pytest.mark.parametrize("workflow", sorted({pin[2] for pin in RUNTIME_PINS}))
def test_runtime_matrix_does_not_fail_fast(workflow: str) -> None:
    """One runtime's failure must not cancel, and so hide, the other legs."""

    assert re.search(
        r"^\s+fail-fast:\s*false\s*$", _read(workflow), re.MULTILINE
    ), f"{workflow}: set fail-fast: false on the runtime matrix"


def test_python_workflow_runs_the_guards_for_their_inputs() -> None:
    """A pull request touching a guarded input runs the Python workflow.

    ``fnmatch``'s ``*`` also crosses ``/``, which is looser than GitHub's
    filter syntax; the filters here are exact names, ``name*`` suffix globs
    and ``dir/**`` globs, on which both agree.
    """

    filters = _pull_request_paths(_read(PYTHON_WORKFLOW))
    unfiltered = [
        path
        for path in GUARDED_INPUTS
        if not any(fnmatch.fnmatchcase(path, glob) for glob in filters)
    ]
    assert filters, f"no pull_request.paths parsed from {PYTHON_WORKFLOW}"
    assert not unfiltered, f"{PYTHON_WORKFLOW} pull_request.paths misses {unfiltered}"


def test_pull_request_paths_skip_comments_and_blank_lines() -> None:
    """Annotated filter lists parse whole; a workflow without a filter has none."""

    workflow = (
        "on:\n"
        "  push:\n"
        '    branches: [ "main" ]\n'
        "  pull_request:\n"
        "    paths:\n"
        "      - '.github/**'\n"
        "      # Read by a guard below.\n"
        "\n"
        '      - "web/Gemfile*"  # lockfile too\n'
        "    types: [opened]\n"
        "\n"
        "permissions:\n"
        "  contents: read\n"
    )
    assert _pull_request_paths(workflow) == [".github/**", "web/Gemfile*"]
    assert _pull_request_paths("on:\n  push:\n    branches: [main]\n") == []


def test_matrix_values_ignore_a_scalar_setting() -> None:
    """A scalar version is no matrix; a flow list is read with quotes stripped."""

    assert _matrix_values('        python-version: "3.13"\n', "python-version") == set()
    flow = "        ruby-version: ['3.3', \"4.0\"]\n"
    assert _matrix_values(flow, "ruby-version") == {"3.3", "4.0"}
