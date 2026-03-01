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

"""Ensure version identifiers stay synchronised across all packages."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import data


def _ruby_fallback_version() -> str:
    config_path = REPO_ROOT / "web" / "lib" / "potato_mesh" / "config.rb"
    contents = config_path.read_text(encoding="utf-8")
    inside = False
    for line in contents.splitlines():
        stripped = line.strip()
        if stripped.startswith("def version_fallback"):
            inside = True
            continue
        if inside and stripped == "end":
            break
        if inside:
            literal = re.search(r"['\"](?P<version>[^'\"]+)['\"]", stripped)
            if literal:
                return literal.group("version")
    raise AssertionError("Unable to locate version_fallback definition in config.rb")


def _javascript_package_version() -> str:
    package_path = REPO_ROOT / "web" / "package.json"
    data = json.loads(package_path.read_text(encoding="utf-8"))
    version = data.get("version")
    if isinstance(version, str):
        return version
    raise AssertionError("package.json does not expose a string version")


def _flutter_package_version() -> str:
    pubspec_path = REPO_ROOT / "app" / "pubspec.yaml"
    for line in pubspec_path.read_text(encoding="utf-8").splitlines():
        if line.startswith("version:"):
            version = line.split(":", 1)[1].strip()
            if version:
                return version
            break
    raise AssertionError("pubspec.yaml does not expose a version")


def _rust_package_version() -> str:
    cargo_path = REPO_ROOT / "matrix" / "Cargo.toml"
    inside_package = False
    for line in cargo_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped == "[package]":
            inside_package = True
            continue
        if inside_package and stripped.startswith("[") and stripped.endswith("]"):
            break
        if inside_package:
            literal = re.match(
                r'version\s*=\s*["\'](?P<version>[^"\']+)["\']', stripped
            )
            if literal:
                return literal.group("version")
    raise AssertionError("Cargo.toml does not expose a package version")


def test_version_identifiers_match_across_languages() -> None:
    """Guard against version drift between Python, Ruby, JavaScript, Flutter, and Rust."""

    python_version = getattr(data, "__version__", None)
    assert (
        isinstance(python_version, str) and python_version
    ), "data.__version__ missing"

    ruby_version = _ruby_fallback_version()
    javascript_version = _javascript_package_version()
    flutter_version = _flutter_package_version()
    rust_version = _rust_package_version()

    assert (
        python_version
        == ruby_version
        == javascript_version
        == flutter_version
        == rust_version
    )
