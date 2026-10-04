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

"""Ensure every environment variable the config files read reaches its surfaces.

Executable form of ACCEPTANCE ``DOC-A1`` (SPEC ``DOC2``).  ``README.md``
documents every variable that ``data/mesh_ingestor/config.py`` or
``web/lib/potato_mesh/config.rb`` reads; every operator-facing variable is also
declared in ``.env.example``, ``docker-compose.yml``, ``flake.nix`` and the
image of each service that reads it.  Internal tuning knobs
(:data:`ADVANCED_NAMES`, :data:`ADVANCED_PREFIXES`) are README-only.  Retired
names (:data:`RETIRED`) are still read but appear on none of those surfaces.

Names are collected from every reading form, not from one regex.  The shell
heredoc this replaces matched ``[A-Z_]+``, which skips names containing digits
(``MESHCORE_TELEMETRY_POLL_24H_EXEMPT``), and saw only ``os.environ.get``, so
names read through a helper such as ``_env_flag`` were never checked.  A read
whose key the scanners cannot resolve fails the suite instead of being skipped.
"""

from __future__ import annotations

import ast
import bisect
import re
from collections.abc import Iterable, Mapping
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]

INGESTOR_CONFIG = "data/mesh_ingestor/config.py"
"""Python module whose environment reads are checked."""

WEB_CONFIG = "web/lib/potato_mesh/config.rb"
"""Ruby module whose environment reads are checked."""

README = "README.md"
"""Documents every variable either config file reads."""

COMMON_SURFACES = (".env.example", "docker-compose.yml", "flake.nix")
"""Surfaces every operator-facing variable reaches, whichever service reads it."""

INGESTOR_IMAGE = "data/Dockerfile"
"""Image that declares every operator-facing variable the ingestor reads."""

WEB_IMAGE = "web/Dockerfile"
"""Image that declares every operator-facing variable the web app reads."""

SURFACES = (README, *COMMON_SURFACES, INGESTOR_IMAGE, WEB_IMAGE)
"""Every file the check reads, and so every place a retired name must not be."""

RUNTIME = frozenset(
    {
        "HOME",
        "PATH",
        "PORT",
        "HOST",
        "RACK_ENV",
        "APP_ENV",
        "APP_VERSION",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "PYTHONPATH",
        "INSTANCES",
    }
)
"""Set by the platform or the runtime, not by the operator; never checked."""

ADVANCED_NAMES = frozenset(
    {
        "MIN_THREADS",
        "MAX_THREADS",
        "PUMA_FORCE_SHUTDOWN",
        "STATS_CACHE_TTL_SECONDS",
        "OG_IMAGE_TTL_SECONDS",
        "LIVE_SAFETY_POLL_SECONDS",
        "SSE_HEARTBEAT_SECONDS",
        "SSE_MAX_LIFETIME_SECONDS",
        "SSE_PUBLISH_COOLDOWN",
        "SSE_THREAD_RESERVE",
        "INITIAL_FEDERATION_DELAY_SECONDS",
        # Not a tuning knob, but README-only by decision (SPEC PX7).
        "MESHTASTIC_PSK_B64",
    }
)
"""README-only names: documented in the README, kept out of the templates."""

ADVANCED_PREFIXES = ("FEDERATION_", "REMOTE_INSTANCE_")
"""Prefixes of the federation internals, README-only like :data:`ADVANCED_NAMES`."""

RETIRED = frozenset({"RX_ONLY"})
"""Still honoured for existing deployments, retired from every surface (SPEC MA7).

The inverse of the operator tier: a retired name must not appear in the README
or any template, so the check also guards ACCEPTANCE ``TX-A6``.
"""

_ENV_NAME = re.compile(r"[A-Z][A-Z0-9_]*\Z")
"""Shape of a variable name; digits included, unlike ``DOC-A1``'s ``[A-Z_]+``."""

_PY_READERS = frozenset({"os.environ.get", "os.getenv"})
"""Python callables that read the variable named by their first argument."""

_RB_DEF = re.compile(
    r"^[ \t]*def[ \t]+(?:self\.)?(?P<name>\w+[?!]?)"
    r"(?:[ \t]*\((?P<params>[^)]*)\))?",
    re.MULTILINE,
)
"""Header of a Ruby method definition, with or without a parameter list."""

_RB_PARAM = re.compile(r"(?:^|,)\s*[*&]*(\w+)")
"""One parameter name in a Ruby parameter list (defaults and splats allowed)."""

_RB_COMMENT = re.compile(r"^[ \t]*#.*$", re.MULTILINE)
"""A whole-line Ruby comment: a mention of ``ENV`` there is prose, not a read."""

_RB_OTHER_ENV = re.compile(r"\bENV\b(?!\[|\.fetch\()")
"""Any use of ``ENV`` other than the two read forms the Ruby scanner resolves."""


def _read(path: str) -> str:
    """Return the text of a repository file.

    Parameters:
        path: File path relative to the repository root.

    Returns:
        The file's contents.
    """

    return (REPO_ROOT / path).read_text(encoding="utf-8")


def _dotted_name(node: ast.AST) -> str | None:
    """Render a ``Name``/``Attribute`` chain such as ``os.environ.get``.

    Parameters:
        node: Expression to render.

    Returns:
        The dotted path, or ``None`` when ``node`` is not a plain name chain.
    """

    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = _dotted_name(node.value)
        return None if base is None else f"{base}.{node.attr}"
    return None


class _PythonEnvReads(ast.NodeVisitor):
    """Collect the environment reads in one parsed Python module.

    A read is a call to :data:`_PY_READERS` or to a known helper, or an
    ``os.environ[...]`` subscript.  Its key resolves one of three ways: a
    string literal names a variable; a parameter of the enclosing function
    makes that function a helper, whose own call sites then name the
    variables; any other key, and any other use of ``os.environ``, is
    unresolved.

    Attributes:
        helpers: Functions already known to forward a parameter to a read.
        names: Variable names read with a literal key.
        forwarders: Functions seen forwarding a parameter to a read.
        unresolved: Line and source of every read that could not be resolved.
    """

    def __init__(self, helpers: frozenset[str]) -> None:
        """Start a scan that also treats calls to ``helpers`` as reads.

        Parameters:
            helpers: Bare names of the known helper functions.
        """

        self.helpers = helpers
        self.names: set[str] = set()
        self.forwarders: set[str] = set()
        self.unresolved: list[str] = []
        # Innermost enclosing function last: (name, parameter names).
        self._scopes: list[tuple[str, frozenset[str]]] = []
        # ``os.environ`` nodes already accounted for by a recognised read.
        self._consumed: set[int] = set()

    def visit_FunctionDef(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        """Visit a function body with the function's parameters in scope.

        Parameters:
            node: Function definition being entered.
        """

        args = node.args
        params = {arg.arg for arg in (*args.posonlyargs, *args.args, *args.kwonlyargs)}
        self._scopes.append((node.name, frozenset(params)))
        self.generic_visit(node)
        self._scopes.pop()

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_Call(self, node: ast.Call) -> None:
        """Record the key of a call to a reader or to a known helper.

        Parameters:
            node: Call expression being visited.
        """

        dotted = _dotted_name(node.func) or ""
        # Helpers match on the final component, so ``config._env_flag(...)``
        # cannot hide a read from the scan.
        if dotted in _PY_READERS or dotted.rpartition(".")[2] in self.helpers:
            if dotted == "os.environ.get":
                self._consumed.add(id(node.func.value))
            self._record(node.args[0] if node.args else None, node)
        self.generic_visit(node)

    def visit_Subscript(self, node: ast.Subscript) -> None:
        """Record the key of an ``os.environ[...]`` lookup.

        Parameters:
            node: Subscript expression being visited.
        """

        if _dotted_name(node.value) == "os.environ":
            self._consumed.add(id(node.value))
            self._record(node.slice, node)
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        """Flag a use of ``os.environ`` that is not a recognised read.

        Parameters:
            node: Attribute expression being visited.
        """

        if _dotted_name(node) == "os.environ" and id(node) not in self._consumed:
            self.unresolved.append(f"line {node.lineno}: {ast.unparse(node)}")
        self.generic_visit(node)

    def _record(self, key: ast.expr | None, read: ast.expr) -> None:
        """Resolve one read's key to a name, a forwarded parameter, or neither.

        Parameters:
            key: First argument or subscript of the read; ``None`` when absent.
            read: The whole read expression, quoted when unresolved.
        """

        if (
            isinstance(key, ast.Constant)
            and isinstance(key.value, str)
            and _ENV_NAME.match(key.value)
        ):
            self.names.add(key.value)
        elif (
            isinstance(key, ast.Name) and self._scopes and key.id in self._scopes[-1][1]
        ):
            self.forwarders.add(self._scopes[-1][0])
        else:
            self.unresolved.append(f"line {read.lineno}: {ast.unparse(read)}")


def _python_env_names(source: str) -> set[str]:
    """Return every environment variable name Python ``source`` reads.

    Rescans until no new helper appears, so a helper that forwards its
    parameter to another helper is followed too.

    Parameters:
        source: Python module source.

    Returns:
        The names read with a literal key, directly or through a helper.

    Raises:
        AssertionError: When a read cannot be resolved to a name.
    """

    tree = ast.parse(source)
    helpers: frozenset[str] = frozenset()
    while True:
        scan = _PythonEnvReads(helpers)
        scan.visit(tree)
        if scan.forwarders <= helpers:
            break
        helpers |= scan.forwarders
    assert not scan.unresolved, f"unresolved environment reads: {scan.unresolved}"
    return scan.names


def _ruby_read_pattern(helpers: Iterable[str]) -> re.Pattern[str]:
    """Compile the pattern matching every Ruby ``ENV`` read and helper call.

    Parameters:
        helpers: Names of the methods known to forward a parameter to a read.

    Returns:
        A pattern whose ``key`` group is the read's first argument: a quoted
        string, a lower-case identifier, or the single character found instead.
    """

    # Helper calls may omit the parentheses (``resolve "X"``); \s* after the
    # opener spans newlines, so multi-line argument lists are followed.
    calls = "".join(rf"|\b{re.escape(name)}(?:\(|[ \t]+)" for name in sorted(helpers))
    return re.compile(
        rf"(?:\bENV(?:\[|\.fetch\(){calls})\s*"
        r"""(?P<key>"[^"]*"|'[^']*'|[a-z_]\w*|\S)"""
    )


def _ruby_env_names(source: str) -> set[str]:
    """Return every environment variable name Ruby ``source`` reads.

    ``ENV[...]`` and ``ENV.fetch(...)`` are reads.  A read whose key is a
    parameter of the enclosing method makes that method a helper (as
    ``fetch_string`` and ``resolve_xdg_home`` are), and calls to a helper are
    reads in turn, rescanned until no new helper appears.  Whole-line comments
    are ignored; any other use of ``ENV`` or an unresolvable key fails.

    Parameters:
        source: Ruby source text.

    Returns:
        The names read with a literal key, directly or through a helper.

    Raises:
        AssertionError: When a read cannot be resolved to a name.
    """

    code = _RB_COMMENT.sub("", source)
    defs = list(_RB_DEF.finditer(code))
    starts = [header.start() for header in defs]
    helpers: frozenset[str] = frozenset()
    while True:
        names: set[str] = set()
        forwarders: set[str] = set()
        unresolved = [use.group(0) for use in _RB_OTHER_ENV.finditer(code)]
        for read in _ruby_read_pattern(helpers).finditer(code):
            # The enclosing method is the last ``def`` header before the read.
            index = bisect.bisect_right(starts, read.start()) - 1
            method = defs[index] if index >= 0 else None
            if method is not None and read.start() < method.end():
                continue  # the helper's own ``def`` line, not a call to it
            params = set(_RB_PARAM.findall(method["params"] or "")) if method else set()
            key = read["key"]
            if key[0] in "\"'" and _ENV_NAME.match(key[1:-1]):
                names.add(key[1:-1])
            elif key in params:
                forwarders.add(method["name"])
            else:
                unresolved.append(read.group(0))
        if forwarders <= helpers:
            break
        helpers |= forwarders
    assert not unresolved, f"unresolved environment reads: {unresolved}"
    return names


def _has(text: str, name: str) -> bool:
    """Report whether ``name`` appears in ``text`` as a whole word.

    Parameters:
        text: Contents of one surface.
        name: Environment variable name.

    Returns:
        ``True`` when the surface mentions the variable.
    """

    return re.search(rf"\b{name}\b", text) is not None


def _is_advanced(name: str) -> bool:
    """Report whether ``name`` is README-only, kept out of the templates.

    Parameters:
        name: Environment variable name.

    Returns:
        ``True`` for :data:`ADVANCED_NAMES` and :data:`ADVANCED_PREFIXES` names.
    """

    return name in ADVANCED_NAMES or name.startswith(ADVANCED_PREFIXES)


def _surface_findings(
    ingestor: set[str], web: set[str], texts: Mapping[str, str]
) -> list[str]:
    """List every surface a variable fails to reach, in ``DOC-A1``'s wording.

    Parameters:
        ingestor: Names the ingestor config reads.
        web: Names the web config reads.
        texts: Contents of every :data:`SURFACES` file, keyed by repository path.

    Returns:
        One line per gap, ordered by variable; empty when nothing is missing.
    """

    findings = []
    for name in sorted((ingestor | web) - RUNTIME):
        if name in RETIRED:
            present = [path for path in SURFACES if _has(texts[path], name)]
            if present:
                findings.append(f"{name}: retired but present in {', '.join(present)}")
            continue
        if not _has(texts[README], name):
            findings.append(f"{name}: absent from {README}")
        if _is_advanced(name):
            continue
        need = list(COMMON_SURFACES)
        # A variable both services read is declared in both images.
        if name in ingestor:
            need.append(INGESTOR_IMAGE)
        if name in web:
            need.append(WEB_IMAGE)
        missing = [path for path in need if not _has(texts[path], name)]
        if missing:
            findings.append(f"{name}: missing from {', '.join(missing)}")
    return findings


def test_every_env_var_reaches_its_surfaces() -> None:
    """Each name is in the README, operator names in each template, retired nowhere."""

    ingestor = _python_env_names(_read(INGESTOR_CONFIG))
    web = _ruby_env_names(_read(WEB_CONFIG))
    findings = _surface_findings(
        ingestor, web, {path: _read(path) for path in SURFACES}
    )
    assert not findings, "\n".join(findings)


@pytest.mark.parametrize(
    "name",
    # os.environ.get, the _env_flag helper, and a name containing digits.
    ["CONNECTION", "TX_ENABLED", "MESHCORE_TELEMETRY_POLL_24H_EXEMPT"],
)
def test_ingestor_scan_sees_every_reading_form(name: str) -> None:
    """Each reading form ``config.py`` uses is seen, so no pass is vacuous."""

    assert name in _python_env_names(_read(INGESTOR_CONFIG))


@pytest.mark.parametrize(
    "name",
    # ENV[...], ENV.fetch, fetch_string, a multi-line fetch_positive_integer
    # call, a helper call nested in another, and resolve_xdg_home, a helper
    # that forwards to a helper.
    [
        "DEBUG",
        "PRIVATE",
        "MESHTASTIC_PSK_B64",
        "REMOTE_INSTANCE_CONNECT_TIMEOUT",
        "CHANNEL",
        "XDG_DATA_HOME",
    ],
)
def test_web_scan_sees_every_reading_form(name: str) -> None:
    """Each reading form ``config.rb`` uses is seen, so no pass is vacuous."""

    assert name in _ruby_env_names(_read(WEB_CONFIG))


def test_python_scanner_follows_every_form() -> None:
    """Literal reads, helpers, helpers of helpers and dotted calls all count."""

    source = """
import os

def _flag(name, *, default):
    return os.environ.get(name) or default

def _wrap(key):
    return _flag(key, default=1)

async def _later(key):
    return os.getenv(key)

A_1 = os.environ.get("A_1")
B = os.getenv("B")
C = os.environ["C"]
D = _wrap("D")
E = config._flag("E", default=0)
G = _later("G")
F = make().get("NOT_A_READ")
"""
    assert _python_env_names(source) == {"A_1", "B", "C", "D", "E", "G"}


@pytest.mark.parametrize(
    "source",
    [
        'import os\nX = os.environ.get(PREFIX + "X")',
        'import os\nX = os.environ.get("lower_case")',
        "import os\nX = os.environ.get()",
        "import os\nX = dict(os.environ)",
        "import os\ndef f(a):\n    return os.environ.get(b)",
        "import os\nX = os.environ[key]",
    ],
    ids=["expression", "not-a-name", "no-key", "bare", "not-a-param", "module-key"],
)
def test_python_scanner_rejects_unresolvable_reads(source: str) -> None:
    """A read whose variable cannot be named fails instead of being skipped."""

    with pytest.raises(AssertionError, match="unresolved environment reads"):
        _python_env_names(source)


def test_ruby_scanner_follows_every_form() -> None:
    """Literal reads, helpers, nesting, multi-line and paren-less calls count."""

    source = """
# ENV in a comment is prose, not a read.
TOP = ENV["TOP"]
module M
  def flag?
    ENV.fetch("FLAG_2", "0") == "1"
  end

  def fetch_string(key, default = nil)
    value = ENV[key]
    value.nil? ? default : value
  end

  def resolve(env_key, *rest)
    fetch_string(env_key, nil)
  end

  def site
    fetch_string("SITE", fetch_string('CHANNEL', nil))
  end

  def timeout
    fetch_string(
      "TIMEOUT",
      nil,
    )
  end

  def home
    resolve "HOME_DIR"
  end
end
"""
    assert _ruby_env_names(source) == {
        "TOP",
        "FLAG_2",
        "SITE",
        "CHANNEL",
        "TIMEOUT",
        "HOME_DIR",
    }


@pytest.mark.parametrize(
    "source",
    [
        'X = ENV.key?("X")',
        "X = ENV[KEY]",
        'X = ENV["lower_case"]',
        "def f(a)\n  ENV[b]\nend",
        "X = ENV[key]",
    ],
    ids=["other-use", "constant-key", "not-a-name", "not-a-param", "outside-def"],
)
def test_ruby_scanner_rejects_unresolvable_reads(source: str) -> None:
    """A read whose variable cannot be named fails instead of being skipped."""

    with pytest.raises(AssertionError, match="unresolved environment reads"):
        _ruby_env_names(source)


def test_surface_findings_name_every_gap() -> None:
    """Each tier, image and whole-word rule of ``DOC-A1`` yields its own line."""

    texts = {
        README: "ING SHARED RX_ONLY",
        ".env.example": "ING SHARED",
        "docker-compose.yml": "ING_EXTRA SHARED RX_ONLY",
        "flake.nix": "ING SHARED",
        INGESTOR_IMAGE: "ING SHARED",
        WEB_IMAGE: "",
    }
    ingestor = {"ING", "SHARED", "MIN_THREADS", "HOME", "RX_ONLY"}
    web = {"SHARED", "WEB", "FEDERATION_X"}
    assert _surface_findings(ingestor, web, texts) == [
        "FEDERATION_X: absent from README.md",
        "ING: missing from docker-compose.yml",
        "MIN_THREADS: absent from README.md",
        "RX_ONLY: retired but present in README.md, docker-compose.yml",
        "SHARED: missing from web/Dockerfile",
        "WEB: absent from README.md",
        "WEB: missing from .env.example, docker-compose.yml, flake.nix, web/Dockerfile",
    ]
