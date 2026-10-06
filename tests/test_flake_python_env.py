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

"""Keep the flake ingestor's Python environment able to load its protocols.

``flake.nix`` builds the NixOS ingestor from nixpkgs packages, not from
``data/requirements.txt``. Its ``pythonEnv`` lacked ``rns``, so
``PROTOCOL=reticulum`` failed at import (``reticulum.py`` imports RNS when it
loads) and the unit restarted in a loop. nixpkgs marks ``rns`` unfree (the
Reticulum License limits fields of use), so the flake must also allow that one
license, or ``nix flake check`` refuses to evaluate any ingestor output.
``meshcore`` is not required here: nixpkgs packages only 2.3.0, below the
2.3.8 floor (ACCEPTANCE EC-A2).

These are text checks on ``flake.nix``; they do not evaluate Nix. CI's
``flake-check`` does that.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
FLAKE = REPO_ROOT / "flake.nix"

# Libraries the ingestor imports for the protocols the flake can run.
REQUIRED = ("meshtastic", "protobuf", "rns")

# A Nix comment: ``#`` to the end of the line, or ``/* ... */``. One
# left-to-right pass, so a ``/*`` inside a ``#`` comment opens nothing. String
# literals are not parsed: a ``#`` or ``/*`` inside a string counts as a comment.
_COMMENT = re.compile(r"#[^\n]*|/\*.*?\*/", re.DOTALL)

# A binding starts a statement: at a line start, or after ``;``, ``{`` or
# ``let ``. So ``devpythonEnv``, ``letpkgs``, ``unfree.pkgs`` or
# ``unfree . pkgs`` are not a ``pythonEnv`` or ``pkgs`` binding.
_STATEMENT_START = r"(?m:(?:^|(?<=[;{])|(?<=\blet\s))[ \t\n]*)"

# The unfree predicate nixpkgs reads: ``config.allowUnfreePredicate`` in the
# import's own set, allowing rns's license.
_ALLOW_RNS = re.compile(
    _STATEMENT_START
    + r"config\.allowUnfreePredicate\s*=\s*pkg:\s*nixpkgs\.lib\.getName\s+pkg"
    r"\s*==\s*\"rns\"\s*;"
)

# ``allowUnfree``, quoted or not, set to anything but ``false``, which would
# allow every unfree package.
_ALLOW_ALL = re.compile(r"(?<![\w'-])\"?allowUnfree\"?\s*=(?!\s*false\s*;)")

# ``pkgs = import nixpkgs { ... };`` with a flat attribute set.
_NIXPKGS_IMPORT = re.compile(
    _STATEMENT_START + r"pkgs\s*=\s*import\s+nixpkgs\s*\{(?P<body>[^{}]*)\}\s*;"
)

# ``pythonEnv = pkgs.python3.withPackages (ps: with ps; [ ... ]);``
_PYTHON_ENV = re.compile(
    _STATEMENT_START
    + r"pythonEnv\s*=\s*pkgs\.python3\.withPackages\s*\(\s*ps:\s*with\s+ps;\s*"
    r"\[(?P<body>[^\]]*)\]"
)

# The rns-only predicate as flake.nix spells it, for the synthetic flakes below.
_PREDICATE = 'config.allowUnfreePredicate = pkg: nixpkgs.lib.getName pkg == "rns";'

# A legacyPackages binding, the old flake's ``pkgs``, for the decoys below.
_LEGACY = "pkgs = nixpkgs.legacyPackages.${system};\n"


def _strip_comments(text: str) -> str:
    """Return ``text`` with every Nix comment replaced by a space.

    Args:
        text: Nix source.

    Returns:
        The source without its ``#`` and ``/* */`` comments, so a
        commented-out package or setting never counts. String literals are
        not parsed.
    """

    return _COMMENT.sub(" ", text)


def _assert_single_binding(text: str, name: str) -> None:
    """Fail unless comment-stripped ``text`` binds ``name`` exactly once.

    Args:
        text: Nix source with comments stripped.
        name: The binding to count, such as ``pkgs``.

    Raises:
        AssertionError: When ``name`` is bound zero or several times, in any
            scope, so a decoy in a nested set or ``let`` cannot stand in.
    """

    pattern = _STATEMENT_START + re.escape(name) + r"\s*=(?!=)"
    count = len(re.findall(pattern, text))
    assert count == 1, f"flake.nix: {count} {name} bindings, expected one"


def _python_env_packages(text: str) -> set[str]:
    """Return the package names in ``text``'s ``pythonEnv`` list.

    Args:
        text: Contents of a ``flake.nix``.

    Returns:
        The attribute names inside the ``withPackages`` list, with comments
        skipped.
    """

    stripped = _strip_comments(text)
    _assert_single_binding(stripped, "pythonEnv")
    match = _PYTHON_ENV.search(stripped)
    assert match, "flake.nix: no pythonEnv withPackages list"
    return set(match.group("body").split())


def _nixpkgs_import_body(text: str) -> str:
    """Return the attribute set ``text`` passes to ``import nixpkgs``.

    Args:
        text: Contents of a ``flake.nix``.

    Returns:
        The text between the braces of ``pkgs = import nixpkgs { ... };``,
        with comments skipped. The set must be flat: a nested set, or a set
        merged in with ``//``, fails the check, which is the safe direction.
    """

    stripped = _strip_comments(text)
    _assert_single_binding(stripped, "pkgs")
    match = _NIXPKGS_IMPORT.search(stripped)
    assert match, "flake.nix: no `pkgs = import nixpkgs { ... };` binding"
    return match.group("body")


def _allows_every_unfree(text: str) -> bool:
    """Return whether ``text`` sets ``allowUnfree`` to anything but ``false``.

    Args:
        text: Contents of a ``flake.nix``.

    Returns:
        ``True`` when a live ``allowUnfree``, quoted or not, other than
        ``= false;`` appears anywhere outside a comment.
    """

    return bool(_ALLOW_ALL.search(_strip_comments(text)))


def test_flake_python_env_carries_the_protocol_libraries() -> None:
    """``pythonEnv`` lists meshtastic, protobuf and rns (SPEC DP8)."""

    listed = _python_env_packages(FLAKE.read_text(encoding="utf-8"))
    missing = [name for name in REQUIRED if name not in listed]
    assert not missing, f"flake.nix pythonEnv lacks {missing}"


def test_flake_allows_the_rns_license_only() -> None:
    """flake.nix imports nixpkgs with an unfree predicate for rns alone (SPEC DP8)."""

    text = FLAKE.read_text(encoding="utf-8")
    assert not _allows_every_unfree(text), "flake.nix allows every unfree package"
    assert _ALLOW_RNS.search(
        _nixpkgs_import_body(text)
    ), "flake.nix does not allow rns's unfree license, so nix flake check fails"


def test_comment_stripping_reads_nix_comments_left_to_right() -> None:
    """``#`` and ``/* */`` comments go; a ``/*`` inside a ``#`` comment opens nothing."""

    text = "a # b /* c\nd /* e # f\ng */ h"
    assert _strip_comments(text).split() == ["a", "d", "h"]


def test_python_env_parser_skips_comments() -> None:
    """The parser reads names across lines and skips ``#`` and ``/* */`` comments."""

    text = (
        "pythonEnv = pkgs.python3.withPackages (ps: with ps; [\n"
        "  a # b\n  c /* d */\n  /* e\n  f */ g\n]);"
    )
    assert _python_env_packages(text) == {"a", "c", "g"}


@pytest.mark.parametrize("decoy", ["devpythonEnv", "dev.pythonEnv", "letpythonEnv"])
def test_python_env_parser_ignores_a_longer_name(decoy: str) -> None:
    """A longer name or an attribute path above the real list does not stand in for it."""

    text = (
        f"{decoy} = pkgs.python3.withPackages (ps: with ps; [ rns black ]);\n"
        "pythonEnv = pkgs.python3.withPackages (ps: with ps; [ meshtastic ]);"
    )
    assert _python_env_packages(text) == {"meshtastic"}


@pytest.mark.parametrize(
    "decoy",
    [
        "dev = { pythonEnv = pkgs.python3.withPackages (ps: with ps; [ rns ]); };",
        "devEnv = let pythonEnv = pkgs.python3.withPackages"
        " (ps: with ps; [ rns ]); in pythonEnv;",
    ],
    ids=["nested-set", "inner-let"],
)
def test_python_env_parser_refuses_a_second_binding(decoy: str) -> None:
    """A second ``pythonEnv`` in a nested set or ``let`` fails instead of standing in."""

    text = (
        f"{decoy}\npythonEnv = pkgs.python3.withPackages (ps: with ps; [ meshtastic ]);"
    )
    with pytest.raises(AssertionError, match="2 pythonEnv bindings, expected one"):
        _python_env_packages(text)


@pytest.mark.parametrize(
    "comment", [f"# {_PREDICATE}", f"/* {_PREDICATE} */"], ids=["hash", "block"]
)
def test_license_check_skips_a_commented_out_predicate(comment: str) -> None:
    """A predicate inside a ``#`` or ``/* */`` comment does not count."""

    text = f"pkgs = import nixpkgs {{\n  inherit system;\n  {comment}\n}};"
    assert not _ALLOW_RNS.search(_nixpkgs_import_body(text))


@pytest.mark.parametrize(
    "setting",
    [
        _PREDICATE.removeprefix("config."),
        "nixpkgs." + _PREDICATE,
    ],
    ids=["without-config", "nixos-option"],
)
def test_license_check_needs_the_config_attribute(setting: str) -> None:
    """A predicate nixpkgs does not read as ``config`` does not count."""

    text = f"pkgs = import nixpkgs {{\n  inherit system;\n  {setting}\n}};"
    assert not _ALLOW_RNS.search(_nixpkgs_import_body(text))


@pytest.mark.parametrize(
    "text",
    [
        f"# {_PREDICATE}\n{_LEGACY}",
        f"{_LEGACY}unfreepkgs = import nixpkgs {{ {_PREDICATE} }};",
        f"{_LEGACY}letpkgs = import nixpkgs {{ {_PREDICATE} }};",
        f"{_LEGACY}unfree.pkgs = import nixpkgs {{ {_PREDICATE} }};",
        f"{_LEGACY}unfree . pkgs = import nixpkgs {{ {_PREDICATE} }};",
        f"pkgs = import nixpkgs {{ inherit system; }} // {{ {_PREDICATE} }};",
        "pkgs = import nixpkgs {\n  inherit system;\n"
        f"  overlays = [ (final: prev: {{ {_PREDICATE} }}) ];\n}};",
    ],
    ids=[
        "legacy",
        "longer-name",
        "let-prefix",
        "attribute-path",
        "spaced-path",
        "merged-set",
        "overlay",
    ],
)
def test_license_check_needs_its_own_flat_pkgs_import(text: str) -> None:
    """Without a flat ``pkgs = import nixpkgs { ... };`` binding the check fails."""

    with pytest.raises(AssertionError, match="no `pkgs = import nixpkgs"):
        _nixpkgs_import_body(text)


@pytest.mark.parametrize(
    "text",
    [
        f"{_LEGACY}unfree = {{ pkgs = import nixpkgs {{ {_PREDICATE} }}; }};",
        f"{_LEGACY}hello = let pkgs = import nixpkgs {{ {_PREDICATE} }}; in pkgs.hello;",
    ],
    ids=["nested-set", "inner-let"],
)
def test_license_check_refuses_a_second_pkgs_binding(text: str) -> None:
    """A second ``pkgs`` in a nested set or ``let`` fails instead of standing in."""

    with pytest.raises(AssertionError, match="2 pkgs bindings, expected one"):
        _nixpkgs_import_body(text)


@pytest.mark.parametrize(
    "text",
    [
        f"pkgs = import nixpkgs {{ {_PREDICATE} config.allowUnfree = true; }};",
        f"pkgs = import nixpkgs {{\n  {_PREDICATE}\n"
        "  overlays = [ (final: prev: { b = prev.b.override { r = 1; }; }) ];\n"
        "  config.allowUnfree = true;\n};",
        f"pkgs = import nixpkgs {{\n  {_PREDICATE} # not nixpkgs/*\n"
        "  config.allowUnfree = true; # */\n};",
        f"pkgs = import nixpkgs {{ {_PREDICATE} config.allowUnfree = !false; }};",
        f'pkgs = import nixpkgs {{ {_PREDICATE} config."allowUnfree" = true; }};',
    ],
    ids=[
        "beside",
        "after-nested-set",
        "after-hash-comment",
        "negated-false",
        "quoted-name",
    ],
)
def test_license_check_spots_a_blanket_allow(text: str) -> None:
    """``allowUnfree`` set to anything but ``false`` allows every unfree package."""

    assert _allows_every_unfree(text)


def test_license_check_skips_a_commented_out_or_false_blanket_allow() -> None:
    """A commented-out ``allowUnfree = true``, or ``allowUnfree = false;``, does not count."""

    text = (
        "# config.allowUnfree = true;\n/* config.allowUnfree = true; */\n"
        "config.allowUnfree = false;"
    )
    assert not _allows_every_unfree(text)
