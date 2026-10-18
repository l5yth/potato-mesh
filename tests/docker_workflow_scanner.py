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

"""Read a GitHub Actions workflow as written, one line at a time.

The release-workflow guards in ``test_docker_latest_gate.py`` read
``.github/workflows/docker.yml`` through these helpers, which need no YAML
library. They expect block-style YAML with two-space indents (job ids at two
spaces, job settings at four) and raise on a job layout outside that. They read
plain YAML only: anchors, aliases, merge keys below the job level and escapes
in double-quoted strings are read as written, not resolved. SPEC LT6 states
the scope of the guards built on them: ordinary edits in the file's own style.
"""

from __future__ import annotations

import re

# The top-level ``jobs:`` key, and a job id under it (two-space indent).
_JOBS_KEY = re.compile(r"^jobs:$")
_JOB_ID = re.compile(r"^  (?P<job>[A-Za-z_][\w-]*):$")
# A job-level ``key: value`` line (four-space indent).
_JOB_SETTING = re.compile(r"^    (?P<key>[\w-]+):\s*(?P<value>.*)$")
# A line at the job level, and the two forms the scanner reads there: a plain
# ``key: value`` whose value is no YAML anchor or alias, and a ``- `` item of
# the compact block-sequence form. A quoted key, a space before the colon, an
# anchor, an alias or a merge key is some other layout.
_AT_JOB_LEVEL = re.compile(r"^    \S")
_JOB_LEVEL_LINE = re.compile(r"^    (?:[\w-]+:(?:\s+[^\s&*].*)?\s*|- .*)$")
# The tag ``latest`` as a word of its own, after any character but a word
# character, ``.`` or ``-``. A ``-`` counts when it is a shell default's
# operator: after ``:``, after ``]`` or ``}`` (``${A[ $i ]-latest}``), or
# after a parameter name (``${TAG-latest}``). ``ubuntu-latest``,
# ``promote-latest``, ``include_latest`` and ``outputs.latest`` do not count.
_LATEST = re.compile(r"(?:^|[^\w.-]|:-|[\]}]-|\$\{[^{}\s]*[-=?+])latest(?![\w-])")
# ``docker/metadata-action``, whose default flavor adds ``latest`` by itself;
# GitHub reads the owner and repository names ignoring case.
_METADATA_ACTION = re.compile(r"\bdocker/metadata-action@", re.IGNORECASE)
# An ``echo`` or ``printf`` of one quoted string appended to the run's step
# summary, read as bash or sh reads it: no second command, no command
# substitution, no ``\$`` inside double quotes, quotes that balance, and no
# ``${{ }}`` but a plain context path, which GitHub substitutes first. It is
# judged one line at a time and as bash, so a quote, a here-document or an
# ``eval`` opened on an earlier line, a folded ``run: >`` block or a plain
# multi-line ``run:`` value, or a step that runs under another shell
# (``pwsh``, also a Windows runner's default, ``python``, ``ruby``, ``perl``),
# can still make it run a command (SPEC LT6).
_SUMMARY_LINE = re.compile(
    r"""^\s*(?:echo|printf)\s+"""
    r"""(?:"(?:[^"\\`$]|\\[^$]|\$\{\{\s*[\w.-]+\s*\}\}|\$(?![({]))*\""""
    r"""|'(?:[^'$]|\$\{\{\s*[\w.-]+\s*\}\}|\$(?!\{\{))*')"""
    r"""\s*>>\s*(?:"\$\{?GITHUB_STEP_SUMMARY\}?"|\$\{?GITHUB_STEP_SUMMARY\}?)\s*$"""
)
# A status function. With one in its ``if:``, a job loses the implicit
# ``success()`` and can run after a job it needs failed or was cancelled.
# GitHub reads the names ignoring case.
_STATUS_FUNCTION = re.compile(
    r"\b(?:always|failure|cancelled|success)\s*\(", re.IGNORECASE
)
# The build matrix (``service: [a, b]`` and ``- { name: linux-x, ... }``
# items) and the promote loops (``for service in a b; do``). The matrix
# lines LT-A2 reads, each alone on its line: the one-line ``service`` list,
# the ``architecture:`` key and a flow-mapping item whose first key is an
# unquoted ``name``. Any other matrix line, an ``include:`` or ``exclude:``
# among them, may add or drop legs these lists do not show.
_MATRIX_READ = re.compile(
    r"^        (?:service:\s*\[[^\]]*\]|architecture:|  - \{\s*name:\s*[\w-]+\s*,.*\})$"
)

#: The build matrix's one-line ``service: [a, b]`` list; ``items`` holds the
#: services.
MATRIX_SERVICES = re.compile(r"^\s+service:\s*\[(?P<items>[^\]]*)\]$")

#: A build matrix architecture item, ``- { name: linux-x, ... }``; ``items``
#: holds the name.
MATRIX_ARCHITECTURES = re.compile(r"^\s+-\s*\{\s*name:\s*(?P<items>[\w-]+)\s*,")

#: The promote step's ``for service in a b; do`` line; ``items`` holds the
#: services.
PROMOTE_SERVICES = re.compile(r"^\s+for service in (?P<items>[\w -]+); do$")

#: The promote step's ``for arch in a b; do`` line; ``items`` holds the
#: architectures.
PROMOTE_ARCHITECTURES = re.compile(r"^\s+for arch in (?P<items>[\w -]+); do$")

# A ``tags`` key in any form: plain, quoted or with a space before its colon,
# also inside a flow mapping, and in any case, as GitHub passes an input by
# its upper-cased name. ``fetch-tags`` and a ``tags/`` path do not count.
_TAGS_KEY = re.compile(r"(?<![\w-])[\"']?tags[\"']?\s*:", re.IGNORECASE)


def strip_comment(line: str) -> str:
    """Drop a line's comment: a ``#`` that starts a word outside quotes.

    YAML and the shell both start a comment there, so
    ``${GITHUB_REF#refs/tags/v}``, ``"step #1"`` and ``'a # b'`` keep their
    ``#``. A backslash escapes the next character outside quotes, inside
    double quotes and inside the shell's ``$'...'``, not inside plain single
    quotes. A quote left open keeps the rest of the line. Each line is read on
    its own, and backticks and ``${...}`` are not modelled, so a ``#`` in a
    quoted string continued from the line before, in backticks or in a
    parameter default is taken for a comment, and a quote inside a plain
    YAML value keeps a comment that follows it. Only the structure is read
    through it (job ids, setting keys, ``needs``, the matrix lines and the
    promote ``if:`` that LT-A3 compares), where such a misread drops or keeps
    text and can only make the guards stricter; the search for the tag and
    for status functions reads every line whole.

    Args:
        line: One workflow line, without its newline.

    Returns:
        The line up to its comment, or the whole line when it has none.
    """

    closing = ""  # the character that ends the open quote, if any
    escapes = True  # whether a backslash escapes inside the open quote
    escaped = False
    word_start = True
    for index, char in enumerate(line):
        if escaped:
            escaped = False
            word_start = False
            continue
        if char == "\\" and (escapes or not closing):
            escaped = True
        elif closing:
            if char == closing:
                closing = ""
        elif char in "\"'":
            closing = char
            escapes = char == '"' or line[index - 1 : index] == "$"
        elif char == "#" and word_start:
            return line[:index]
        word_start = not closing and char.isspace()
    return line


def workflow_jobs(text: str) -> dict[str, list[tuple[int, str]]]:
    """Split a workflow's ``jobs:`` mapping into the jobs' lines.

    The workflow is block-style YAML with two-space indents: job ids at two
    spaces, their settings at four. Blank lines are skipped; the job id line
    and every comment line stay in the job, whose text the guards read. The
    next top-level key ends the mapping.

    Args:
        text: The workflow YAML.

    Returns:
        Each job id, in file order, with its lines as ``(line number, line)``
        pairs, its id line first; the line numbers count from 1 in ``text``.
        Empty when the workflow has no ``jobs:`` key.

    Raises:
        ValueError: A line inside ``jobs:`` is neither a job id nor indented
            under one, such as a flow-style job or a four-space job id; a
            job's first setting is not at four spaces; or a job-level line is
            neither a plain ``key: value`` nor a ``- `` item, such as a quoted
            key, ``if : x``, an anchor, an alias or a merge key.
    """

    jobs: dict[str, list[tuple[int, str]]] = {}
    current = None
    first = False
    inside = False
    for number, raw in enumerate(text.splitlines(), start=1):
        line = strip_comment(raw).rstrip()
        if not inside:
            inside = bool(_JOBS_KEY.match(line))
            continue
        if not line:
            if current is not None and raw.strip():
                jobs[current].append((number, raw))
            continue
        if not line[0].isspace():
            break
        job_id = _JOB_ID.match(line)
        if job_id:
            current, first = job_id.group("job"), True
            jobs[current] = [(number, raw)]
            continue
        job_level = bool(_AT_JOB_LEVEL.match(line))
        if (
            current is None
            or not line.startswith("    ")
            or (first and not job_level)
            or (job_level and not _JOB_LEVEL_LINE.match(line))
        ):
            raise ValueError(f"line {number}: unexpected layout under jobs: {raw!r}")
        first = False
        jobs[current].append((number, raw))
    return jobs


def job_setting(
    body: list[tuple[int, str]], key: str, whole: bool = False
) -> str | None:
    """Return the text of one job-level setting, such as ``needs`` or ``if``.

    A setting is a ``key:`` line at four spaces. Its value continues on the
    deeper lines below it, comment lines among them, and on ``-`` items at its
    own indent (the compact block-sequence form); the next job-level key ends
    it. Step settings sit deeper, so a step's ``if:`` is not the job's.

    Args:
        body: A job's lines, as :func:`workflow_jobs` returns them.
        key: The setting's key.
        whole: Keep each line whole, comments included, instead of
            dropping what :func:`strip_comment` takes for a comment.

    Returns:
        The value's lines, stripped and joined by single spaces; ``None``
        when the job has no such setting.
    """

    parts: list[str] = []
    found = False
    for _, raw in body:
        line = raw.rstrip() if whole else strip_comment(raw).rstrip()
        setting = _JOB_SETTING.match(line)
        if setting:
            if found:
                break
            found = setting.group("key") == key
            if found:
                parts.append(setting.group("value").strip())
        elif found:
            parts.append(line.strip())
    return " ".join(part for part in parts if part) if found else None


def job_needs(body: list[tuple[int, str]]) -> list[str]:
    """Return the jobs a job lists in ``needs``.

    Args:
        body: A job's lines, as :func:`workflow_jobs` returns them.

    Returns:
        The job ids in order, from a scalar, a flow list or a block list,
        with quotes dropped; empty when the job needs none.
    """

    return re.findall(r"[A-Za-z_][\w-]*", job_setting(body, "needs") or "")


def latest_lines(body: list[tuple[int, str]]) -> list[int]:
    """Return the lines on which a job names the ``latest`` tag.

    Every line is read whole, comments included. Lines that a trailing
    backslash continues are judged together; each keeps its indentation, so a
    word split across lines is not rejoined. A line that by itself only
    appends one quoted string to ``$GITHUB_STEP_SUMMARY`` (``_SUMMARY_LINE``)
    does not count; it is judged alone and as bash, so a quote, a
    here-document or an ``eval`` opened on an earlier line, a folded
    ``run: >`` block or a plain multi-line ``run:`` value, or another shell
    than bash or sh, can make it run a command, which is not detected (SPEC
    LT6).
    Every other mention of the word counts (see ``_LATEST``): a comment, a
    pulled ``:latest`` image, ``latest`` in a step name, a shell default
    (``${TAG:-latest}``, ``${TAG-latest}``, ``${A[ $i ]-latest}``), and
    ``docker/metadata-action``, whose default flavor adds the tag.

    Args:
        body: A job's lines, as :func:`workflow_jobs` returns them.

    Returns:
        The file line number where each such command starts, in order.
    """

    lines: list[int] = []
    command, start = "", 0
    for number, raw in body:
        command, start = command + raw.rstrip(), start or number
        if command.endswith("\\"):
            command = command[:-1]
            continue
        if _METADATA_ACTION.search(command) or (
            _LATEST.search(command) and not _SUMMARY_LINE.match(command)
        ):
            lines.append(start)
        command, start = "", 0
    # A body that ends inside a continued command still counts it.
    if _LATEST.search(command) or _METADATA_ACTION.search(command):
        lines.append(start)
    return lines


def job_ancestors(needs: dict[str, list[str]], job: str) -> set[str]:
    """Return every job that ``job`` needs, directly or through other jobs.

    Args:
        needs: Each job id with the job ids it lists in ``needs``.
        job: The job whose ancestors to collect.

    Returns:
        The ancestor ids, including ids no job defines.
    """

    found: set[str] = set()
    pending = list(needs.get(job, []))
    while pending:
        name = pending.pop()
        if name not in found:
            found.add(name)
            pending.extend(needs.get(name, []))
    return found


def smoke_gate_gap(
    jobs: dict[str, list[tuple[int, str]]], job: str, smoke: str
) -> str | None:
    """Say how ``job`` can run without a passed smoke-test job, if it can.

    The job must need the smoke-test job ``smoke``, directly or through other
    jobs, and ``smoke`` must not set a job-level ``continue-on-error`` other
    than ``false``. That job and each job between it and ``smoke`` must keep
    the implicit ``success()``: a status function in an ``if:``
    (``always()``, ``failure()``, ``cancelled()`` or ``success()``, in any
    case) replaces it, so the job can run after ``smoke`` failed. Both
    settings are read whole, comment lines and trailing comments included,
    so a ``#`` cannot hide part of them. It also flags an ``if:`` such as
    ``success() && x``, which changes nothing, one that pairs a status
    function with ``needs.<smoke>.result == 'success'``, and a status
    function named only in a comment.

    Args:
        jobs: The workflow's jobs, as :func:`workflow_jobs` returns them.
        job: The job to check.
        smoke: The id of the smoke-test job, such as ``test-images``.

    Returns:
        The reason, or ``None`` when the job runs only after ``smoke``
        passed.
    """

    needs = {name: job_needs(body) for name, body in jobs.items()}
    ancestors = job_ancestors(needs, job)
    unknown = sorted(ancestors - jobs.keys())
    if unknown:
        return f"needs {unknown}, which the workflow does not define"
    if smoke not in ancestors:
        return f"{smoke} is not among its needs"
    allowed = job_setting(jobs[smoke], "continue-on-error", whole=True)
    if allowed not in (None, "false"):
        return (
            f"{smoke} has `continue-on-error: {allowed}`, "
            "so its failure need not stop the jobs after it"
        )
    between = sorted(name for name in ancestors if smoke in job_ancestors(needs, name))
    for name in [job, *between]:
        condition = job_setting(jobs[name], "if", whole=True) or ""
        if _STATUS_FUNCTION.search(condition):
            return (
                f"{name} has `if: {condition}`, " f"so it can run after {smoke} failed"
            )
    return None


def listed_lines(
    body: list[tuple[int, str]], pattern: re.Pattern[str]
) -> list[list[str]]:
    """Return the names on each of a job's lines that ``pattern`` matches.

    Args:
        body: A job's lines, as :func:`workflow_jobs` returns them.
        pattern: A line pattern whose ``items`` group lists names, separated
            by commas or spaces.

    Returns:
        One list of names per matching line, in file order; empty when no line
        matches.
    """

    lines: list[list[str]] = []
    for _, raw in body:
        match = pattern.match(strip_comment(raw).rstrip())
        if match:
            lines.append(re.findall(r"[\w-]+", match.group("items")))
    return lines


def listed(body: list[tuple[int, str]], pattern: re.Pattern[str]) -> list[str]:
    """Return the names on all of a job's lines that ``pattern`` matches.

    Args:
        body: A job's lines, as :func:`workflow_jobs` returns them.
        pattern: A line pattern whose ``items`` group lists names, separated
            by commas or spaces.

    Returns:
        The names in file order; empty when no line matches.
    """

    return [name for names in listed_lines(body, pattern) for name in names]


def latest_outside_jobs(text: str) -> list[int]:
    """Return the lines outside every job that name the ``latest`` tag.

    That is every line that belongs to no job: the top-level keys and their
    values, the lines between ``jobs:`` and its first job id, and the lines
    after the jobs. A top-level ``env`` value or a dispatch input reaches every
    job's expressions, so no such line may name the tag. Each line is read
    whole, comments included.

    Args:
        text: The workflow YAML.

    Returns:
        The file line numbers, in order.
    """

    numbers: list[int] = []
    in_jobs = inside = False
    for number, raw in enumerate(text.splitlines(), start=1):
        line = strip_comment(raw).rstrip()
        if line and not line[0].isspace():
            in_jobs, inside = bool(_JOBS_KEY.match(line)), False
        elif in_jobs and _JOB_ID.match(line):
            inside = True
        if not inside and _LATEST.search(raw):
            numbers.append(number)
    return numbers


def clauses(condition: str) -> list[str]:
    """Split a job's ``if:`` into the clauses it joins with ``&&``.

    Args:
        condition: The ``if:`` text, as :func:`job_setting` returns it, with
            or without a block-scalar marker (``>-``) and ``${{ }}``.

    Returns:
        The clauses, stripped, in order.
    """

    text = re.sub(r"^[>|][+-]?\s*", "", condition.strip())
    text = re.sub(r"^\$\{\{(.*)\}\}$", r"\1", text.strip())
    return [clause.strip() for clause in text.split("&&")]


def step_lines(body: list[tuple[int, str]], name: str) -> list[str]:
    """Return the lines of the job's step called ``name``.

    A step is a ``- name:`` item at four spaces with its keys at six; it ends
    at the next ``- `` item at four spaces.

    Args:
        body: A job's lines, as :func:`workflow_jobs` returns them.
        name: The step's ``name``.

    Returns:
        The step's lines after its ``- name:`` line, right-stripped.

    Raises:
        ValueError: The job has no step of that name.
    """

    lines = [raw.rstrip() for _, raw in body]
    try:
        start = lines.index(f"    - name: {name}")
    except ValueError:
        raise ValueError(f"no step named {name!r}") from None
    step: list[str] = []
    for line in lines[start + 1 :]:
        if line.startswith("    - "):
            break
        step.append(line)
    return step


def step_script(body: list[tuple[int, str]], name: str) -> str:
    """Return the ``run: |`` script of the job's step called ``name``.

    The script is the block below the step's ``run: |``, eight spaces in,
    dedented; the body holds no blank lines, which the shell does not need.

    Args:
        body: A job's lines, as :func:`workflow_jobs` returns them.
        name: The step's ``name``.

    Returns:
        The script, its lines joined by newlines.

    Raises:
        ValueError: The job has no step of that name, or the step has no
            ``run: |`` block.
    """

    script: list[str] | None = None
    for line in step_lines(body, name):
        if script is not None:
            if not line.startswith("        "):
                break
            script.append(line[8:])
        elif line == "      run: |":
            script = []
    if not script:
        raise ValueError(f"step {name!r} has no run: | block")
    return "\n".join(script)


def build_tags(body: list[tuple[int, str]]) -> list[str]:
    """Return the entries of every ``tags:`` input in a job.

    An input is a ``tags: |`` line eight spaces in, with its entries ten
    spaces in below it; the first shallower line ends them. Any other line
    that holds a ``tags`` key (plain, quoted, with a space before its colon,
    inside a flow mapping, or in another case) is returned whole, so it never
    equals a pinned entry.

    Args:
        body: A job's lines, as :func:`workflow_jobs` returns them.

    Returns:
        The entries of all the job's ``tags:`` inputs, stripped, in order.
    """

    entries: list[str] = []
    inside = False
    for _, raw in body:
        line = raw.rstrip()
        if inside and line.startswith("          "):
            entries.append(line.strip())
            continue
        inside = line == "        tags: |"
        if not inside and _TAGS_KEY.search(line):
            entries.append(line.strip())
    return entries


def matrix_unread(body: list[tuple[int, str]]) -> list[str]:
    """Return the lines of a job's ``matrix:`` block that LT-A2 does not read.

    The block is the lines eight or more spaces in below a ``matrix:`` line
    six spaces in. LT-A2 reads only the forms ``_MATRIX_READ`` matches; any
    other line there may add or drop legs.

    Args:
        body: A job's lines, as :func:`workflow_jobs` returns them.

    Returns:
        The other lines, comments removed and stripped, in order; empty when
        LT-A2 reads the whole matrix.
    """

    unread: list[str] = []
    inside = False
    for _, raw in body:
        line = strip_comment(raw).rstrip()
        if not line:
            continue
        if inside and line.startswith("        "):
            if not _MATRIX_READ.match(line):
                unread.append(line.strip())
            continue
        inside = line == "      matrix:"
    return unread
