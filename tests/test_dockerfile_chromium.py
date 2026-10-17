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

"""Run the web image's Chromium step for every platform the release builds.

Alpine 3.24 stopped building Chromium for armv7 (aports 7e8aa9ca, 2026-10-15),
and the v1.0.0 release build failed on the ``linux/arm/v7`` web image with
``chromium (no such package)``. No pull request builds an image, so this test
runs the production stage's ``RUN`` instruction from both Dockerfiles in a
shell, with a fake ``apk`` that answers for one Alpine architecture at a time
from the package sets below.
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]

DOCKERFILES = ("web/Dockerfile", "Dockerfile")

RELEASE_WORKFLOW = ".github/workflows/docker.yml"

# Docker platform -> the architecture ``apk --print-arch`` reports for it.
APK_ARCH = {"linux/amd64": "x86_64", "linux/arm64": "aarch64", "linux/arm/v7": "armv7"}

# The Alpine 3.24 packages the production stage installs, per architecture.
# ``chromium`` is built for aarch64 and x86_64 only (its APKBUILD's ``arch``).
_COMMON_PACKAGES = {
    "python3",
    "sqlite",
    "tzdata",
    "curl",
    "nss",
    "freetype",
    "harfbuzz",
    "ttf-freefont",
}
ALPINE_PACKAGES = {
    "x86_64": _COMMON_PACKAGES | {"chromium"},
    "aarch64": _COMMON_PACKAGES | {"chromium"},
    "armv7": set(_COMMON_PACKAGES),
}

# What the step installs every time, then with Open Graph previews (RB3).
BASE_PACKAGES = ["python3", "sqlite", "tzdata", "curl"]
OG_PACKAGES = ["chromium", "nss", "freetype", "harfbuzz", "ttf-freefont"]

# A POSIX ``apk`` stand-in: ``--print-arch`` prints ``$FAKE_APK_ARCH``; ``add``
# records each package in ``$FAKE_APK_LOG`` and fails as apk does for a package
# missing from ``$FAKE_APK_PACKAGES`` (space separated).
FAKE_APK = """#!/bin/sh
if [ "$1" = "--print-arch" ]; then
  echo "$FAKE_APK_ARCH"
  exit 0
fi
if [ "$1" != "add" ]; then
  echo "fake apk: unsupported arguments: $*" >&2
  exit 2
fi
shift
for package in "$@"; do
  case "$package" in -*) continue ;; esac
  case " $FAKE_APK_PACKAGES " in
    *" $package "*) echo "$package" >> "$FAKE_APK_LOG" ;;
    *)
      echo "ERROR: unable to select packages:" >&2
      echo "  $package (no such package):" >&2
      exit 1
      ;;
  esac
done
"""


def _instructions(text: str) -> list[tuple[str, str]]:
    """Split a Dockerfile into its instructions, each with its build stage.

    Continuation lines (a trailing backslash) are joined the way Docker joins
    them, without the backslash and the newline. Comment and blank lines are
    dropped, inside a continued instruction too, as Docker drops them.

    Args:
        text: Full contents of a Dockerfile.

    Returns:
        ``(stage, instruction)`` pairs in file order, where ``stage`` is the
        ``AS`` name of the enclosing ``FROM`` (empty before the first one) and
        ``instruction`` the joined instruction text.
    """

    pairs: list[tuple[str, str]] = []
    stage = ""
    pending = ""
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line.endswith("\\"):
            pending += line[:-1]
            continue
        instruction = pending + line
        pending = ""
        named = re.match(r"\s*FROM\s+\S+\s+AS\s+(\S+)", instruction, re.IGNORECASE)
        if named:
            stage = named.group(1)
        pairs.append((stage, instruction.strip()))
    return pairs


def _chromium_step(dockerfile: str) -> str:
    """Return the shell command of the production stage's Chromium ``RUN``.

    Args:
        dockerfile: Repository-relative path of the Dockerfile.

    Returns:
        The command after ``RUN``, as Docker passes it to ``/bin/sh -c``.
    """

    text = (REPO_ROOT / dockerfile).read_text(encoding="utf-8")
    steps = [
        instruction[len("RUN") :].strip()
        for stage, instruction in _instructions(text)
        if stage == "production"
        and instruction.startswith("RUN ")
        and "chromium" in instruction
    ]
    assert (
        len(steps) == 1
    ), f"{dockerfile}: expected one production RUN installing chromium, found {len(steps)}"
    return steps[0]


def _release_platforms() -> list[str]:
    """Return the platforms the release workflow builds images for.

    Returns:
        Each ``platform:`` value of the ``build-and-push`` matrix, in order.
    """

    workflow = (REPO_ROOT / RELEASE_WORKFLOW).read_text(encoding="utf-8")
    return re.findall(r"platform:\s*(linux/[\w/]+)", workflow)


def _run_step(
    command: str, arch: str, with_og_image: str, tmp_path: Path
) -> tuple[subprocess.CompletedProcess, list[str]]:
    """Run a ``RUN`` command against the fake ``apk`` for one architecture.

    Args:
        command: Shell command of the ``RUN`` instruction.
        arch: Alpine architecture the fake ``apk`` answers for.
        with_og_image: Value of the ``WITH_OG_IMAGE`` build argument.
        tmp_path: Directory for the fake ``apk`` and its install log.

    Returns:
        The finished shell process and the packages it installed, in order.
    """

    bin_dir = tmp_path / f"bin-{arch}-{with_og_image}"
    bin_dir.mkdir()
    apk = bin_dir / "apk"
    apk.write_text(FAKE_APK, encoding="utf-8")
    apk.chmod(0o755)
    log = tmp_path / f"installed-{arch}-{with_og_image}.txt"
    log.touch()
    env = {
        "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        "FAKE_APK_ARCH": arch,
        "FAKE_APK_LOG": str(log),
        "FAKE_APK_PACKAGES": " ".join(sorted(ALPINE_PACKAGES[arch])),
        "WITH_OG_IMAGE": with_og_image,
    }
    process = subprocess.run(
        ["/bin/sh", "-c", command], env=env, capture_output=True, text=True, check=False
    )
    return process, log.read_text(encoding="utf-8").split()


@pytest.mark.parametrize("dockerfile", DOCKERFILES)
def test_chromium_step_builds_on_every_release_platform(
    dockerfile: str, tmp_path: Path
) -> None:
    """Each release platform builds; the preview packages come where Alpine builds Chromium.

    Elsewhere the step installs none of them and says so (RB3).
    """

    command = _chromium_step(dockerfile)
    platforms = _release_platforms()
    assert platforms == ["linux/amd64", "linux/arm64", "linux/arm/v7"]

    for platform in platforms:
        arch = APK_ARCH[platform]
        process, installed = _run_step(command, arch, "1", tmp_path)

        assert process.returncode == 0, f"{dockerfile} on {platform}: {process.stderr}"
        if "chromium" in ALPINE_PACKAGES[arch]:
            assert installed == BASE_PACKAGES + OG_PACKAGES, (platform, installed)
        else:
            assert installed == BASE_PACKAGES, (platform, installed)
            assert f"Alpine builds no Chromium for {arch};" in process.stdout, (
                platform,
                process.stdout,
            )


@pytest.mark.parametrize("dockerfile", DOCKERFILES)
def test_chromium_step_installs_no_chromium_without_og_images(
    dockerfile: str, tmp_path: Path
) -> None:
    """``WITH_OG_IMAGE=0`` builds every platform without Chromium."""

    command = _chromium_step(dockerfile)

    for arch in ALPINE_PACKAGES:
        process, installed = _run_step(command, arch, "0", tmp_path)

        assert process.returncode == 0, f"{dockerfile} on {arch}: {process.stderr}"
        assert installed == BASE_PACKAGES, (arch, installed)


def test_fake_apk_refuses_a_package_its_architecture_lacks(tmp_path: Path) -> None:
    """The stand-in fails like apk, so a step that asks for Chromium on armv7 fails."""

    process, installed = _run_step(
        "apk add --no-cache curl chromium", "armv7", "1", tmp_path
    )

    assert process.returncode == 1
    assert "chromium (no such package)" in process.stderr
    assert installed == ["curl"]


def test_instructions_join_continuations_and_track_stages() -> None:
    """Continuations join without the backslash or an inner comment; each instruction keeps its stage."""

    text = (
        "# header\nFROM alpine AS builder\nRUN a \\\n    # inner note\n    b\n\n"
        "FROM alpine AS production\n# note\nRUN c\n"
    )

    assert _instructions(text) == [
        ("builder", "FROM alpine AS builder"),
        ("builder", "RUN a     b"),
        ("production", "FROM alpine AS production"),
        ("production", "RUN c"),
    ]
