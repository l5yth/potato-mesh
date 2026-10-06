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

"""Guard the dependency manifests that Dependabot, CI, and the images consume.

Four regressions are pinned here:

* ``.github/dependabot.yml`` named ecosystems GitHub does not document
  (``ruby`` and ``python`` instead of ``bundler`` and ``pip``). The file was
  invalid, so Dependabot never ran a version update for any ecosystem.
* ``web/Gemfile.lock`` was git-ignored, so the web image and CI resolved every
  gem afresh at build time instead of installing a reviewed set.
* ``data/requirements.txt`` carried only ``>=`` floors plus the dev tools, so
  the ingestor image installed black and pytest and whatever release was
  newest on build day.
* The ``github-actions`` entry kept Dependabot's default limit of 5 open pull
  requests, so its 2026-10-04 and 2026-10-05 runs computed the
  ``actions/checkout`` major and then dropped it behind the open updates.
"""

from __future__ import annotations

import fnmatch
import importlib.util
import re
import shutil
import subprocess
from collections.abc import Iterable
from pathlib import Path, PurePosixPath

import pytest
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name
from packaging.version import Version

REPO_ROOT = Path(__file__).resolve().parents[1]
DEPENDABOT = REPO_ROOT / ".github" / "dependabot.yml"
GEMFILE_LOCK = REPO_ROOT / "web" / "Gemfile.lock"
WEB_DOCKERFILE = REPO_ROOT / "web" / "Dockerfile"
RUNTIME_REQUIREMENTS = REPO_ROOT / "data" / "requirements.txt"
DEV_REQUIREMENTS = REPO_ROOT / "data" / "requirements-dev.txt"
EDIT_GUARD = REPO_ROOT / ".claude" / "hooks" / "guard-edits.py"

# Every ``package-ecosystem`` YAML value in the table of GitHub's Dependabot
# options reference, as retrieved on 2026-10-04:
# https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#package-ecosystem-
# Any other value invalidates the whole file, so add one here only once it
# appears in that table.
DOCUMENTED_ECOSYSTEMS = frozenset(
    {
        "bazel",
        "bun",
        "bundler",
        "cargo",
        "composer",
        "conda",
        "deno",
        "devcontainers",
        "docker",
        "docker-compose",
        "dotnet-sdk",
        "elm",
        "github-actions",
        "gitsubmodule",
        "gomod",
        "gradle",
        "helm",
        "julia",
        "maven",
        "mix",
        "nix",
        "npm",
        "nuget",
        "opentofu",
        "pip",
        "pre-commit",
        "pub",
        "rust-toolchain",
        "sbt",
        "swift",
        "terraform",
        "uv",
        "vcpkg",
    }
)

# Language dependency manifests (file-name glob, Dependabot ecosystem) that
# need an entry for their directory. Lockfiles sit beside their manifests, so
# the manifests alone decide the directories. Container base images and the
# Flutter platform build files (Gradle, CocoaPods) are deliberately absent:
# the image pins are bounded on purpose (ACCEPTANCE DK-A2) and the platform
# files belong to the Flutter toolchain.
MANIFEST_ECOSYSTEMS = (
    ("Gemfile", "bundler"),
    ("requirements*.txt", "pip"),
    ("pyproject.toml", "pip"),
    ("package.json", "npm"),
    ("Cargo.toml", "cargo"),
    ("pubspec.yaml", "pub"),
)

# Developer tools that belong in requirements-dev.txt, never in the image.
DEV_TOOLS = ("black", "pytest", "pytest-cov")

# meshcore 2.3.7 introduced EventType.CONTACT_DELETED; the RF5 handler needs
# it, so the pin must never drop below the 2.3.8 floor (ACCEPTANCE EC-A2).
MESHCORE_FLOOR = Version("2.3.8")

# rns 1.5.0/1.5.1 carried a security fix; the pin must never drop below 1.5.1
# (ACCEPTANCE DP-A14).
RNS_FLOOR = Version("1.5.1")

# A trailing ``# comment``. A ``#`` that belongs to a value is never preceded
# by whitespace in these files, so this cannot cut a value short.
_COMMENT = re.compile(r"(^|\s)#.*$")
# A workflow step's ``uses: owner/repo[/sub-path]@ref``, capturing the part
# before ``@``.
_USES = re.compile(
    r"^[ \t]*(?:-[ \t]+)?uses:[ \t]*[\"']?([^@\s\"'.][^@\s\"']*)@", re.MULTILINE
)
# A YAML block-sequence item, capturing its indentation and its body.
_ITEM = re.compile(r"^(?P<indent>\s+)-\s+(?P<body>.*)$")
# A YAML ``key: value`` line; nested keys are matched at any depth.
_PAIR = re.compile(r"^\s*(?P<key>[\w-]+):\s*(?P<value>.*)$")
# Dependabot's github-actions entry for ``/`` covers the workflows here.
_WORKFLOWS = PurePosixPath(".github/workflows")

requires_git = pytest.mark.skipif(
    shutil.which("git") is None or not (REPO_ROOT / ".git").exists(),
    reason="needs a git checkout",
)


def _dependabot_entries(text: str) -> list[dict[str, str]]:
    """Return the ``updates`` entries of a ``dependabot.yml`` as flat dicts.

    The file is block-style YAML, so a line scanner keeps the guard free of a
    YAML dependency. Each ``-`` item at the first item's indentation starts an
    entry, and every ``key: value`` line inside it (``schedule.interval``
    included) is stored under its bare key. Deeper list items (``ignore``,
    ``directories``) are not entries, and the next top-level key ends the
    list. A layout this scanner cannot read yields missing keys, so the
    guards below fail rather than pass on it.

    Args:
        text: The contents of a ``dependabot.yml`` file.

    Returns:
        One ``{key: value}`` dict per entry, with quotes stripped from values.
    """

    entries: list[dict[str, str]] = []
    item_indent = None
    for raw in text.partition("\nupdates:\n")[2].splitlines():
        line = _COMMENT.sub("", raw).rstrip()
        if line and not line[0].isspace():
            break
        item = _ITEM.match(line)
        if item and item_indent in (None, len(item.group("indent"))):
            item_indent = len(item.group("indent"))
            entries.append({})
            line = item.group("body")
        pair = _PAIR.match(line)
        if pair and entries:
            entries[-1][pair.group("key")] = pair.group("value").strip("\"' ")
    return entries


def _required_entries(paths: Iterable[str]) -> set[tuple[str, str]]:
    """Return the ``(ecosystem, directory)`` pairs the given files need.

    Args:
        paths: Repository-relative POSIX paths, e.g. from ``git ls-files``.

    Returns:
        One pair per manifest directory, using Dependabot's leading-slash
        directory form (``/`` for the repository root).
    """

    required: set[tuple[str, str]] = set()
    for path in map(PurePosixPath, paths):
        if path.parent == _WORKFLOWS and path.suffix in (".yml", ".yaml"):
            required.add(("github-actions", "/"))
            continue
        for pattern, ecosystem in MANIFEST_ECOSYSTEMS:
            if fnmatch.fnmatchcase(path.name, pattern):
                parent = path.parent.as_posix()
                required.add((ecosystem, "/" if parent == "." else f"/{parent}"))
    return required


def _tracked_files() -> list[str]:
    """Return every path git tracks, relative to the repository root.

    Returns:
        The ``git ls-files`` listing.
    """

    listing = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "ls-files", "-z"],
        capture_output=True,
        check=True,
        text=True,
    )
    return [path for path in listing.stdout.split("\0") if path]


def _lockfile_section(text: str, name: str) -> list[str]:
    """Return the stripped lines of one top-level ``Gemfile.lock`` section.

    Args:
        text: The lockfile contents.
        name: A section header such as ``PLATFORMS`` or ``BUNDLED WITH``.

    Returns:
        The indented lines under ``name``, up to the next unindented line.
    """

    lines: list[str] = []
    inside = False
    for line in text.splitlines():
        if not line.startswith(" "):
            inside = line == name
        elif inside:
            lines.append(line.strip())
    return lines


def _repository_ignore_rule(verbose_output: str) -> str | None:
    """Return the committed ``.gitignore`` rule that ignores a path, if any.

    Args:
        verbose_output: The output of ``git check-ignore --no-index --verbose``
            for one path: empty when no rule matches, else
            ``<source>:<line>:<pattern>`` and a tab before the path.

    Returns:
        ``<source>:<line>:<pattern>`` when the deciding rule ignores the path
        and lives in a ``.gitignore`` inside the repository, otherwise
        ``None``. A ``!`` pattern re-includes the path. The clone-local
        ``info/exclude`` and a global excludes file are a developer's own
        settings, not the repository's: git reports them by their own file
        name (``exclude``) or by an absolute path, so they never count.
    """

    rule = verbose_output.split("\t", 1)[0].strip()
    source, _, rest = rule.partition(":")
    pattern = rest.partition(":")[2]
    path = PurePosixPath(source)
    if path.name != ".gitignore" or path.is_absolute() or pattern.startswith("!"):
        return None
    return rule


def _copy_sources(dockerfile: str, needle: str) -> list[str]:
    """Return the ``COPY`` sources of a Dockerfile that contain ``needle``.

    Args:
        dockerfile: The Dockerfile contents.
        needle: A substring of the source path, such as ``Gemfile.lock``.

    Returns:
        The matching source operands, without ``--flags`` or the destination.
    """

    sources: list[str] = []
    for line in dockerfile.splitlines():
        words = line.split()
        if words[:1] == ["COPY"]:
            sources += [w for w in words[1:-1] if needle in w and w[:2] != "--"]
    return sources


def _requirements(path: Path) -> tuple[list[Requirement], list[str]]:
    """Parse a pip requirements file into requirements and option lines.

    Args:
        path: The requirements file to read.

    Returns:
        ``(requirements, options)``: the parsed requirement specifiers, and
        the ``-``-prefixed option lines (such as ``-r requirements.txt``)
        with their comments removed.
    """

    requirements: list[Requirement] = []
    options: list[str] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = _COMMENT.sub("", raw).strip()
        if line.startswith("-"):
            options.append(line)
        elif line:
            requirements.append(Requirement(line))
    return requirements, options


def _exact_pin(requirement: Requirement) -> Version | None:
    """Return the version a requirement pins with ``==``, or ``None``.

    Args:
        requirement: A parsed requirement.

    Returns:
        The pinned version when the specifier is a single ``==`` clause
        without a wildcard, otherwise ``None``.
    """

    clauses = list(requirement.specifier)
    if len(clauses) == 1 and clauses[0].operator == "==":
        if "*" not in clauses[0].version:
            return Version(clauses[0].version)
    return None


def _edit_guard_manifests() -> tuple[str, ...]:
    """Return the manifest names the apex edit hook scans.

    Returns:
        ``MANIFESTS`` from ``.claude/hooks/guard-edits.py``, loaded from its
        path because the hyphenated file name is not importable.
    """

    spec = importlib.util.spec_from_file_location("guard_edits", EDIT_GUARD)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.MANIFESTS


def _pins(path: Path) -> dict[str, Version | None]:
    """Map each requirement name in ``path`` to its exact pin, if any.

    Args:
        path: The requirements file to read.

    Returns:
        ``{name: version}`` keyed by the canonical project name (so
        ``Pytest_Cov`` reads as ``pytest-cov``); the version is ``None`` for
        a requirement that is not pinned with ``==``.
    """

    requirements, _ = _requirements(path)
    return {canonicalize_name(req.name): _exact_pin(req) for req in requirements}


def _assert_pinned_at_least(name: str, floor: Version) -> None:
    """Assert that ``data/requirements.txt`` pins ``name`` with ``==`` at ``floor`` or above.

    Args:
        name: Project name; matched by its canonical form, as ``_pins`` keys.
        floor: Lowest acceptable pinned version.
    """

    pinned = _pins(RUNTIME_REQUIREMENTS).get(canonicalize_name(name))
    assert pinned is not None, f"{name} is not pinned with == in data/requirements.txt"
    assert pinned >= floor, f"{name}=={pinned} is below {floor}"


def test_dependabot_ecosystems_are_documented() -> None:
    """Every ``package-ecosystem`` value is one GitHub documents."""

    entries = _dependabot_entries(DEPENDABOT.read_text(encoding="utf-8"))
    ecosystems = {entry.get("package-ecosystem", "") for entry in entries}
    undocumented = sorted(ecosystems - DOCUMENTED_ECOSYSTEMS)
    assert entries, "no updates entries parsed from .github/dependabot.yml"
    assert not undocumented, (
        f"undocumented package-ecosystem values in .github/dependabot.yml: "
        f"{undocumented} (Ruby is `bundler`, Python is `pip`)"
    )


@requires_git
def test_dependabot_covers_every_manifest_directory() -> None:
    """Each tracked manifest's directory has a weekly entry for its ecosystem."""

    entries = _dependabot_entries(DEPENDABOT.read_text(encoding="utf-8"))
    configured = {(e.get("package-ecosystem"), e.get("directory")) for e in entries}
    missing = sorted(_required_entries(_tracked_files()) - configured)
    not_weekly = sorted(
        f"{e.get('package-ecosystem')} {e.get('directory')}"
        for e in entries
        if e.get("interval") != "weekly"
    )
    assert not missing, f"no Dependabot entry for (ecosystem, directory): {missing}"
    assert not not_weekly, f"Dependabot entries not on a weekly schedule: {not_weekly}"


def _action_repositories(text: str) -> set[str]:
    """Return the ``owner/repo`` of every remote action a workflow file uses.

    Dependabot updates a repository once for all its sub-path actions
    (``github/codeql-action/init`` and ``/analyze``), so a sub-path folds into
    its repository. Local actions (``./``) and ``docker://`` images are not
    GitHub Actions updates and are left out.

    Args:
        text: The contents of a workflow file.

    Returns:
        The ``owner/repo`` names, without duplicates.
    """

    return {
        "/".join(name.split("/")[:2]) for name in _USES.findall(text) if ":" not in name
    }


def test_actions_pr_limit_covers_every_action() -> None:
    """The ``github-actions`` limit fits one open pull request per action repository.

    Dependabot drops an update it has computed once the entry already has
    ``open-pull-requests-limit`` pull requests open (5 by default). A limit at
    or above the number of action repositories the workflows use keeps every
    update from waiting behind the others.
    """

    entries = _dependabot_entries(DEPENDABOT.read_text(encoding="utf-8"))
    actions = [e for e in entries if e.get("package-ecosystem") == "github-actions"]
    workflows = REPO_ROOT / _WORKFLOWS
    files = sorted([*workflows.glob("*.yml"), *workflows.glob("*.yaml")])
    used = set().union(
        *(_action_repositories(f.read_text(encoding="utf-8")) for f in files)
    )
    assert len(actions) == 1, "expected one github-actions entry in dependabot.yml"
    assert used, "no `uses: owner/action@ref` lines parsed from .github/workflows"
    limit = int(actions[0].get("open-pull-requests-limit", "5"))
    assert limit >= len(used), (
        f"github-actions open-pull-requests-limit is {limit}, "
        f"below the {len(used)} distinct actions in use"
    )


@requires_git
def test_gemfile_lock_is_not_git_ignored() -> None:
    """No committed ``.gitignore`` rule ignores ``web/Gemfile.lock``.

    ``--no-index`` applies the rules even to a tracked file. The global
    excludes file is replaced by ``/dev/null``, and a match from the clone's
    ``info/exclude`` does not count, so a developer's own ``Gemfile.lock``
    pattern cannot fail this guard.
    """

    command = ["git", "-C", str(REPO_ROOT), "-c", "core.excludesFile=/dev/null"]
    check = subprocess.run(
        command + ["check-ignore", "--no-index", "--verbose", "web/Gemfile.lock"],
        capture_output=True,
        text=True,
    )
    # Exit status 0 prints the deciding rule, 1 means no rule matched.
    assert check.returncode in (0, 1), check.stderr
    rule = _repository_ignore_rule(check.stdout)
    assert rule is None, f"web/Gemfile.lock is git-ignored by {rule}"


def test_gemfile_lock_locks_the_build_platforms() -> None:
    """The lockfile covers CI's runners and the Alpine image builds.

    ``ruby/setup-ruby`` installs in deployment mode, which rejects a lockfile
    without the runner's platform (x86_64 glibc Linux), and the web image
    compiles every gem for the generic ``ruby`` platform
    (``BUNDLE_FORCE_RUBY_PLATFORM``). ``BUNDLED WITH`` selects the Bundler
    that both of them install.
    """

    assert GEMFILE_LOCK.is_file(), (
        "web/Gemfile.lock is missing: the web image and CI resolve every gem "
        "afresh at build time"
    )
    text = GEMFILE_LOCK.read_text(encoding="utf-8")
    platforms = set(_lockfile_section(text, "PLATFORMS"))
    assert "ruby" in platforms, f"PLATFORMS lacks ruby: {sorted(platforms)}"
    runners = platforms & {"x86_64-linux", "x86_64-linux-gnu"}
    assert runners, f"PLATFORMS lacks x86_64-linux(-gnu) for CI: {sorted(platforms)}"
    assert _lockfile_section(text, "BUNDLED WITH"), "no BUNDLED WITH version"


def test_web_image_copies_the_committed_lockfile() -> None:
    """Every ``COPY`` of the lockfile into the web image matches a real file."""

    sources = _copy_sources(WEB_DOCKERFILE.read_text(encoding="utf-8"), "Gemfile.lock")
    unmatched = sorted({s for s in sources if not list(REPO_ROOT.glob(s))})
    assert sources, "web/Dockerfile never copies web/Gemfile.lock"
    assert not unmatched, (
        f"web/Dockerfile COPY sources {unmatched} match no file, so the image "
        f"resolves gems at build time"
    )


def test_runtime_requirements_pin_exact_versions() -> None:
    """``data/requirements.txt`` pins every runtime dependency with ``==``."""

    pins = _pins(RUNTIME_REQUIREMENTS)
    unpinned = sorted(name for name, version in pins.items() if version is None)
    assert pins, "no requirements parsed from data/requirements.txt"
    assert not unpinned, f"data/requirements.txt does not pin with ==: {unpinned}"


def test_runtime_requirements_exclude_dev_tools() -> None:
    """The ingestor image installs no formatter or test runner."""

    leaked = sorted(set(_pins(RUNTIME_REQUIREMENTS)) & set(DEV_TOOLS))
    assert not leaked, f"dev tools in data/requirements.txt (the image): {leaked}"


def test_dev_requirements_extend_runtime_with_pinned_tools() -> None:
    """``data/requirements-dev.txt`` adds the pinned dev tools to the runtime set."""

    assert DEV_REQUIREMENTS.is_file(), "data/requirements-dev.txt is missing"
    _, options = _requirements(DEV_REQUIREMENTS)
    pins = _pins(DEV_REQUIREMENTS)
    unpinned = [tool for tool in DEV_TOOLS if pins.get(tool) is None]
    assert "-r requirements.txt" in options, "missing -r requirements.txt"
    assert not unpinned, f"data/requirements-dev.txt does not pin with ==: {unpinned}"


def test_meshcore_pin_defines_contact_deleted() -> None:
    """The pinned ``meshcore`` is at least 2.3.8 (``EventType.CONTACT_DELETED``)."""

    _assert_pinned_at_least("meshcore", MESHCORE_FLOOR)


def test_rns_pin_keeps_the_security_fix() -> None:
    """The pinned ``rns`` is at least 1.5.1, past the 1.5 security fix."""

    _assert_pinned_at_least("rns", RNS_FLOOR)


def test_edit_guard_watches_every_requirements_file() -> None:
    """The apex edit hook scans both pip requirements files."""

    found = RUNTIME_REQUIREMENTS.parent.glob("requirements*.txt")
    names = {path.name for path in found} | {DEV_REQUIREMENTS.name}
    unwatched = sorted(names - set(_edit_guard_manifests()))
    assert not unwatched, f".claude/hooks/guard-edits.py does not scan {unwatched}"


def test_dependabot_parser_reads_only_top_level_update_items() -> None:
    """Nested list items, comments, and later top-level keys are not entries."""

    text = (
        "version: 2\n"
        "updates:\n"
        '  - package-ecosystem: "npm"  # trailing comment\n'
        "    directory: '/web'\n"
        "    schedule:\n"
        "      interval: weekly\n"
        "    ignore:\n"
        '      - dependency-name: "left-pad"\n'
        "\n"
        "  - package-ecosystem: cargo\n"
        "registries:\n"
        "  - package-ecosystem: not-an-entry\n"
    )
    assert _dependabot_entries(text) == [
        {
            "package-ecosystem": "npm",
            "directory": "/web",
            "schedule": "",
            "interval": "weekly",
            "ignore": "",
        },
        {"package-ecosystem": "cargo"},
    ]


def test_action_repositories_fold_sub_paths_and_skip_local_actions() -> None:
    """Actions count once per repository; local actions and images not at all."""

    text = """jobs:
  build:
    steps:
      - uses: actions/checkout@v7
      - name: Init
        uses: "github/codeql-action/init@v4"
      - uses: 'github/codeql-action/analyze@v4'
      - uses: ./.github/actions/local
      - uses: docker://alpine@sha256:0123abcd
      - uses: dtolnay/rust-toolchain@stable
"""

    assert _action_repositories(text) == {
        "actions/checkout",
        "github/codeql-action",
        "dtolnay/rust-toolchain",
    }


def test_required_entries_map_manifests_to_their_directories() -> None:
    """Manifests map to ecosystem and directory; other files need no entry."""

    paths = [
        "Gemfile",
        "web/package.json",
        "data/requirements-dev.txt",
        ".github/workflows/ruby.yml",
        ".github/workflows/README.md",
        "README.md",
    ]
    assert _required_entries(paths) == {
        ("bundler", "/"),
        ("npm", "/web"),
        ("pip", "/data"),
        ("github-actions", "/"),
    }


def test_repository_ignore_rule_counts_only_committed_gitignores() -> None:
    """Repository rules count; negations and developer-local files do not."""

    rule = ".gitignore:48:Gemfile.lock"
    assert _repository_ignore_rule(f"{rule}\tweb/Gemfile.lock\n") == rule
    for output in (
        "",
        "web/.gitignore:3:!Gemfile.lock\tweb/Gemfile.lock\n",
        ".git/info/exclude:7:Gemfile.lock\tweb/Gemfile.lock\n",
        "/home/dev/.gitignore:1:Gemfile.lock\tweb/Gemfile.lock\n",
    ):
        assert _repository_ignore_rule(output) is None, output


def test_exact_pin_accepts_only_a_single_equality_clause() -> None:
    """``==X`` is a pin; floors, wildcards, ranges, and bare names are not."""

    assert _exact_pin(Requirement("meshcore==2.3.15")) == Version("2.3.15")
    for loose in ("meshcore>=2.3.8", "meshcore==2.3.*", "meshcore>=2,<3", "meshcore"):
        assert _exact_pin(Requirement(loose)) is None, loose
