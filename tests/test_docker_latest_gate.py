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

"""Move a release's ``:latest`` images only after ``test-images`` passes.

``docker-compose.yml`` pulls ``:latest`` unless the operator pins a version, so
a ``:latest`` image reaches every default install. ``build-and-push`` pushed it
with the version tags, before ``test-images`` booted the release: the withdrawn
v1.0.0 run (39017486662) moved the web amd64 ``:latest`` to an image that
exited at boot, and its ``test-images`` never ran. ``build-and-push`` now
pushes the version tags only, for a release version only, and
``promote-latest`` retags every image's version as ``:latest`` after
``test-images`` passes, on stable tag pushes only (SPEC LT).

The guards read the release workflow as written, with the line scanner in
``docker_workflow_scanner`` and no YAML library. They catch an ordinary edit,
written in the file's own style (block YAML, plain ``key: value`` settings,
bash ``run:`` steps), that names ``:latest`` in a job that runs before or
without a passed ``test-images``, or outside the jobs; every line counts
whole, comments included. ``build-and-push``'s ``tags:`` inputs are pinned to
the version step's outputs. Any other form is out of scope (SPEC LT6). For
example, they do not detect: anchors, aliases, merge keys or escapes in
double-quoted YAML strings; an obfuscated spelling of the tag or a redirected
``GITHUB_STEP_SUMMARY``; a step-summary line that a quote, a here-document or
an ``eval`` opened on an earlier line, a folded or plain multi-line ``run:``
value, or a shell other than bash or sh turns into a command (the exemption
judges each line alone, as bash); a publisher that never names the tag, such
as an action, a reusable or another workflow, a repository script,
``docker compose push``, an untagged image reference, an action input other
than ``tags:``, or a tag that a step's script takes from an input, a context
value, ``vars`` or ``secrets``; a promote step that retags other images than
its two loop lines list; a context value that carries shell syntax into a
step-summary line; or a smoke test weakened inside ``test-images`` (a
step-level ``continue-on-error``, ``|| true``, a step-level ``if:`` or a
removed step; RB-G2).
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest
from docker_workflow_scanner import (  # pytest puts tests/ on sys.path
    MATRIX_ARCHITECTURES,
    MATRIX_SERVICES,
    PROMOTE_ARCHITECTURES,
    PROMOTE_SERVICES,
    build_tags,
    clauses,
    job_needs,
    job_setting,
    latest_lines,
    latest_outside_jobs,
    listed,
    listed_lines,
    matrix_unread,
    smoke_gate_gap,
    step_lines,
    step_script,
    strip_comment,
    workflow_jobs,
)
from test_ci_runtime_sync import _read  # pytest puts tests/ on sys.path

#: Repository-relative path of the release workflow.
RELEASE_WORKFLOW = ".github/workflows/docker.yml"

#: The job that builds and pushes every image.
BUILD_JOB = "build-and-push"

#: The job that boots the release's images.
SMOKE_TEST_JOB = "test-images"

#: The job that retags each image's version as ``:latest``.
PROMOTE_JOB = "promote-latest"

#: ``build-and-push``'s step that reads the version from the tag or the
#: dispatch input; its outputs are what the job's ``tags:`` inputs push.
VERSION_STEP = "Extract version from tag or input"

#: Lines the version step must hold: ``id: version``, which the ``tags:``
#: inputs read; bash, which its ``[[ =~ ]]`` check needs; the event and the
#: dispatch input through ``env``; and the C locale, in which the check's
#: character ranges match ASCII only.
VERSION_STEP_SETTINGS = (
    "      id: version",
    "      shell: bash",
    "        EVENT_NAME: ${{ github.event_name }}",
    "        INPUT_VERSION: ${{ github.event.inputs.version }}",
    "        LC_ALL: C",
)

#: The clauses ``promote-latest``'s ``if:`` joins with ``&&``: a ``v*`` tag
#: push that is not a pre-release (SPEC LT).
PROMOTE_CLAUSES = (
    "startsWith(github.ref, 'refs/tags/v')",
    "github.event_name == 'push'",
    "!contains(github.ref_name, '-rc')",
    "!contains(github.ref_name, '-beta')",
    "!contains(github.ref_name, '-alpha')",
    "!contains(github.ref_name, '-dev')",
)

#: How ``build-and-push`` names an image it tags.
BUILT_IMAGE = (
    "${{ env.REGISTRY }}/${{ env.IMAGE_PREFIX }}-${{ matrix.service }}"
    "-${{ matrix.architecture.name }}:"
)

#: How ``promote-latest`` names the same image in its retag loop.
PROMOTED_IMAGE = "$REGISTRY/$IMAGE_PREFIX-$service-$arch"

#: The entries of all of ``build-and-push``'s ``tags:`` inputs: each image's
#: version and ``v``-version, both from the version step's outputs, which never
#: read ``latest`` (LT4). A tag that a step's script pushes is not among them.
BUILD_TAGS = [
    BUILT_IMAGE + "${{ steps.version.outputs.version }}",
    BUILT_IMAGE + "${{ steps.version.outputs.version_with_v }}",
]

#: A workflow for the helper tests. Jobs: build -> test-images -> promote ->
#: summary, with the forms the scanner reads (comment lines, flow and block
#: ``needs``, a folded ``if:``) and the words that are not the tag (a runner
#: label, an output name, a step-summary line). The trailing top-level key
#: ends the jobs.
SYNTHETIC_WORKFLOW = """\
on:
  push:
    tags: [ 'v*' ]

jobs:
  # Builds every image.
  build:
    runs-on: ubuntu-latest
    steps:
    - run: |
        echo "include_latest=true" >> $GITHUB_OUTPUT
        VERSION=${GITHUB_REF#refs/tags/v}
  test-images:
    needs: build
    steps:
    - run: curl -f http://localhost:41447/
  promote:
    needs: [build, "test-images"]
    if: github.event_name == 'push'
    steps:
    - run: docker buildx imagetools create -t "$IMAGE:latest" "$IMAGE:$VERSION"
  summary:
    needs:
    - promote
    if: >-
      always()
      && github.event_name == 'push'
    steps:
    - run: |
        # list the moved tags
        echo "- image:latest" >> $GITHUB_STEP_SUMMARY

permissions:
  contents: read
"""


def test_latest_is_published_only_after_test_images_passes() -> None:
    """Only jobs that run after ``test-images`` passed name ``:latest``, and no line outside the jobs does (RB-G1)."""

    text = _read(RELEASE_WORKFLOW)
    jobs = workflow_jobs(text)
    expected = {BUILD_JOB, SMOKE_TEST_JOB}
    assert expected <= jobs.keys(), f"jobs read from {RELEASE_WORKFLOW}: {list(jobs)}"
    publishers = {
        name: lines for name, body in jobs.items() if (lines := latest_lines(body))
    }
    assert publishers, (
        f"no job in {RELEASE_WORKFLOW} publishes :latest, the tag "
        "docker-compose.yml pulls by default"
    )
    gaps = [
        f"{RELEASE_WORKFLOW}:{number}: names latest outside the jobs"
        for number in latest_outside_jobs(text)
    ] + [
        f"{name} ({RELEASE_WORKFLOW}:{','.join(map(str, lines))}): {gap}"
        for name, lines in publishers.items()
        if (gap := smoke_gate_gap(jobs, name, SMOKE_TEST_JOB))
    ]
    assert not gaps, "a job can publish :latest without a passed test-images:\n" + (
        "\n".join(gaps)
    )


def test_promote_latest_covers_every_built_image() -> None:
    """``promote-latest``'s loops list exactly the images the build matrix pushes (LT-A2).

    The matrix is read as written: its one-line ``service`` list and its
    ``- { name: ..., }`` architecture items. Any other matrix line, an
    ``include:`` or ``exclude:`` among them, fails the test, and so do loops
    other than one ``for service in`` and one ``for arch in`` line. What the
    loop body does with the names is not checked (SPEC LT6).
    """

    jobs = workflow_jobs(_read(RELEASE_WORKFLOW))
    assert PROMOTE_JOB in jobs, f"jobs read from {RELEASE_WORKFLOW}: {list(jobs)}"
    build, promote = jobs[BUILD_JOB], jobs[PROMOTE_JOB]
    unread = matrix_unread(build)
    assert not unread, f"{BUILD_JOB}'s matrix lines LT-A2 does not read: {unread}"
    built = {
        (service, arch)
        for service in listed(build, MATRIX_SERVICES)
        for arch in listed(build, MATRIX_ARCHITECTURES)
    }
    loops = [
        listed_lines(promote, PROMOTE_SERVICES),
        listed_lines(promote, PROMOTE_ARCHITECTURES),
    ]
    assert [len(lines) for lines in loops] == [1, 1], (
        f"{PROMOTE_JOB} needs one `for service in` and one `for arch in` line, "
        f"not {loops}"
    )
    promoted = {(service, arch) for service in loops[0][0] for arch in loops[1][0]}

    assert built, f"no service and architecture matrix read from {BUILD_JOB}"
    assert promoted == built, (
        f"{PROMOTE_JOB} retags {sorted(promoted)} but {BUILD_JOB} pushes "
        f"{sorted(built)}"
    )
    assert any(BUILT_IMAGE in raw for _, raw in build), BUILT_IMAGE
    assert any(PROMOTED_IMAGE in raw for _, raw in promote), PROMOTED_IMAGE


def test_promote_latest_runs_on_stable_tag_pushes_only() -> None:
    """A pre-release tag and a ``workflow_dispatch`` run never move ``:latest`` (LT-A3).

    ``promote-latest`` is the only job that names the tag, it needs exactly
    ``build-and-push`` and ``test-images`` (LT2), and its ``if:`` admits stable
    ``v*`` tag pushes only.
    """

    jobs = workflow_jobs(_read(RELEASE_WORKFLOW))
    assert PROMOTE_JOB in jobs, f"jobs read from {RELEASE_WORKFLOW}: {list(jobs)}"
    publishers = [name for name, body in jobs.items() if latest_lines(body)]
    assert publishers == [PROMOTE_JOB], f"jobs that name latest: {publishers}"
    needs = job_needs(jobs[PROMOTE_JOB])
    assert sorted(needs) == [BUILD_JOB, SMOKE_TEST_JOB], f"{PROMOTE_JOB} needs {needs}"
    condition = job_setting(jobs[PROMOTE_JOB], "if") or ""

    # Exactly these clauses, joined by `&&`: an `||`, a negation or another
    # clause could run the job on a pre-release tag or a dispatch.
    assert sorted(clauses(condition)) == sorted(PROMOTE_CLAUSES), (
        f"{PROMOTE_JOB}'s if: must be {list(PROMOTE_CLAUSES)} joined by &&, "
        f"not {condition!r}"
    )


def test_build_tags_come_from_the_version_step() -> None:
    """``build-and-push``'s ``tags:`` inputs hold the version step's two outputs only (LT-A3).

    A tag that a step's script pushes is not read here (SPEC LT6).
    """

    jobs = workflow_jobs(_read(RELEASE_WORKFLOW))
    tags = build_tags(jobs[BUILD_JOB])

    assert tags == BUILD_TAGS, f"{BUILD_JOB} tags {tags}, not {BUILD_TAGS}"


@pytest.mark.parametrize(
    ("event", "ref", "version", "published"),
    (
        ("push", "refs/tags/v1.0.0", "", "1.0.0"),
        ("push", "refs/tags/v1.1.0-rc1", "", "1.1.0-rc1"),
        ("workflow_dispatch", "refs/heads/main", "1.0.1", "1.0.1"),
        ("workflow_dispatch", "refs/heads/main", "v1.0.1", "1.0.1"),
        ("workflow_dispatch", "refs/heads/main", "latest", None),
        ("workflow_dispatch", "refs/heads/main", "vlatest", None),
        ("push", "refs/tags/vlatest", "", None),
        ("workflow_dispatch", "refs/heads/main", "1.0.1\nlatest", None),
        ("workflow_dispatch", "refs/heads/main", "$(echo 1.0.1)", None),
    ),
    ids=(
        "tag",
        "pre-release-tag",
        "dispatch",
        "dispatch-with-v",
        "dispatch-latest",
        "dispatch-vlatest",
        "tag-vlatest",
        "dispatch-two-lines",
        "dispatch-substitution",
    ),
)
def test_version_step_tags_release_versions_only(
    event: str, ref: str, version: str, published: str | None, tmp_path: Path
) -> None:
    """The version step writes a release version only, so its outputs never read ``latest`` (LT-A3).

    The step's script runs as GitHub runs a ``shell: bash`` step, with the
    environment the step's ``env:`` sets; any other version fails it before a
    push. Its outputs are what ``build-and-push``'s ``tags:`` inputs push (see
    ``test_build_tags_come_from_the_version_step``).
    """

    jobs = workflow_jobs(_read(RELEASE_WORKFLOW))
    step = step_lines(jobs[BUILD_JOB], VERSION_STEP)
    missing = [line.strip() for line in VERSION_STEP_SETTINGS if line not in step]
    assert not missing, f"{VERSION_STEP!r} lacks {missing}"
    script = step_script(jobs[BUILD_JOB], VERSION_STEP)
    assert "${{" not in script, f"{VERSION_STEP!r} must read its inputs from env"
    output = tmp_path / "github_output"
    output.touch()
    environment = {
        "PATH": os.environ["PATH"],
        "EVENT_NAME": event,
        "INPUT_VERSION": version,
        "LC_ALL": "C",
        "GITHUB_REF": ref,
        "GITHUB_OUTPUT": str(output),
    }

    process = subprocess.run(
        ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", script],
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    written = dict(
        line.split("=", 1) for line in output.read_text(encoding="utf-8").splitlines()
    )

    if published is None:
        assert process.returncode != 0 and not written, (process.stdout, written)
    else:
        assert process.returncode == 0, process.stdout + process.stderr
        assert (written["version"], written["version_with_v"]) == (
            published,
            f"v{published}",
        )


def test_workflow_jobs_split_the_jobs_mapping() -> None:
    """Job ids come in file order with their own lines; the next top-level key ends them."""

    jobs = workflow_jobs(SYNTHETIC_WORKFLOW)

    assert list(jobs) == ["build", "test-images", "promote", "summary"]
    assert jobs["test-images"] == [
        (13, "  test-images:"),
        (14, "    needs: build"),
        (15, "    steps:"),
        (16, "    - run: curl -f http://localhost:41447/"),
    ]
    assert jobs["summary"][-1] == (
        31,
        '        echo "- image:latest" >> $GITHUB_STEP_SUMMARY',
    )
    assert workflow_jobs("on:\n  push:\n") == {}


@pytest.mark.parametrize(
    ("jobs", "line"),
    (
        ("  build: {runs-on: ubuntu-latest}\n", 2),
        ("    build:\n      runs-on: x\n", 2),
        ("  t:\n    'if': always()\n", 3),
        ('  t:\n    "continue-on-error": true\n', 3),
        ("  t:\n    if : always()\n", 3),
        ("  t:\n    if: *gate\n", 3),
        ("  t:\n    <<: *base\n", 3),
        ("  t:\n      runs-on: x\n      continue-on-error: true\n", 3),
    ),
    ids=(
        "flow-style-job",
        "four-space-job-id",
        "single-quoted-key",
        "double-quoted-key",
        "space-before-colon",
        "alias",
        "merge-key",
        "six-space-settings",
    ),
)
def test_workflow_jobs_refuse_an_unexpected_layout(jobs: str, line: int) -> None:
    """These job layouts raise rather than yield wrong settings; lines below a job's settings are not checked."""

    with pytest.raises(ValueError, match=f"line {line}: unexpected layout under jobs"):
        workflow_jobs("jobs:\n" + jobs)


def test_job_settings_read_scalar_flow_and_block_values() -> None:
    """``needs`` reads in all three forms; a folded ``if:`` joins its lines."""

    jobs = workflow_jobs(SYNTHETIC_WORKFLOW)

    assert {name: job_needs(body) for name, body in jobs.items()} == {
        "build": [],
        "test-images": ["build"],
        "promote": ["build", "test-images"],
        "summary": ["promote"],
    }
    assert job_setting(jobs["promote"], "if") == "github.event_name == 'push'"
    assert (
        job_setting(jobs["summary"], "if")
        == ">- always() && github.event_name == 'push'"
    )
    assert job_setting(jobs["build"], "if") is None
    commented = [(1, "    if: a  # b"), (2, "    # c"), (3, "    steps:")]
    assert job_setting(commented, "if") == "a"
    assert job_setting(commented, "if", whole=True) == "a  # b # c"


def test_latest_lines_count_the_tag_only() -> None:
    """Runner labels, output names and step-summary lines do not name the tag; a comment does."""

    jobs = workflow_jobs(SYNTHETIC_WORKFLOW)

    assert {name: latest_lines(body) for name, body in jobs.items()} == {
        "build": [],
        "test-images": [],
        "promote": [21],
        "summary": [],
    }
    assert latest_lines(
        [
            (1, "          type=raw,value=latest"),
            (2, "        flavor: latest=auto"),
            (3, '        docker push "$I:latest" && echo ok >> $GITHUB_STEP_SUMMARY'),
            (4, "        tags: ${{ steps.meta.outputs.latest }}"),
            (5, '        image: "x:${TAG:-latest}"'),
            (6, "        TAG=${TAG-latest}"),
            (7, '        echo "step #1" && docker push img:latest'),
            (8, "        echo pushed; docker push img:latest >> $GITHUB_STEP_SUMMARY"),
            (9, "        echo $(docker push img:latest) >> $GITHUB_STEP_SUMMARY"),
            (
                10,
                '        echo "- \\`${{ env.R }}/img:latest\\`" >> $GITHUB_STEP_SUMMARY',
            ),
            (11, "    runs-on: ubuntu-latest  # not the tag"),
            (12, "        A=${A[0]-latest}"),
            (13, "      uses: docker/metadata-action@v5"),
            (14, "        eval \\"),
            (15, '        echo "\\$(docker push img:latest)" >> $GITHUB_STEP_SUMMARY'),
            (
                16,
                "        echo \"${{ '$' }}(docker push img:latest)\" >> $GITHUB_STEP_SUMMARY",
            ),
            (17, "        echo 'x:latest' >> $GITHUB_STEP_SUMMARY"),
            (18, "        # tag it latest later"),
            (19, "        echo 'x"),
            (20, "        #y' && docker push img:latest"),
            (21, '        docker tag x "img:${A[ 0 ]-latest}"'),
            (22, '        docker tag x "img:${A[${i}]-latest}"'),
            (23, "      uses: Docker/Metadata-Action@v5"),
            (24, "        docker push img:latest \\"),
        ]
    ) == [1, 2, 3, 5, 6, 7, 8, 9, 12, 13, 14, 16, 18, 20, 21, 22, 23, 24]


def test_latest_outside_jobs_reads_every_other_line() -> None:
    """An input default, a comment before the first job or a top-level ``env`` value names the tag; job lines are left to the gate."""

    workflow = (
        "on:\n  workflow_dispatch:\n    inputs:\n      tag:\n        default: latest\n"
        "jobs:\n  # publishes latest\n  a:\n    runs-on: ubuntu-latest\n    steps:\n"
        "    - run: docker push img:latest\n"
        "env:\n  TAG: latest  # the default tag\n"
    )

    assert latest_outside_jobs(workflow) == [5, 7, 13]
    assert latest_outside_jobs(SYNTHETIC_WORKFLOW) == []


def test_clauses_split_an_if_on_and() -> None:
    """The block marker and ``${{ }}`` go; a negated group stays visible in its clauses."""

    assert clauses(">- a && b") == ["a", "b"]
    assert clauses("${{ a && b }}") == ["a", "b"]
    assert clauses("!(a && b)") == ["!(a", "b)"]


def test_step_script_reads_the_run_block() -> None:
    """The script is the dedented ``run: |`` block; a step without one, or no such step, raises."""

    body = [
        (1, "    - name: A"),
        (2, "      env:"),
        (3, "        X: 1"),
        (4, "      run: |"),
        (5, "        echo a"),
        (6, "          echo b"),
        (7, "      shell: bash"),
        (8, "    - name: B"),
        (9, "      uses: x/y@v1"),
    ]

    assert step_script(body, "A") == "echo a\n  echo b"
    assert build_tags(body) == []
    with pytest.raises(ValueError, match="has no run"):
        step_script(body, "B")
    with pytest.raises(ValueError, match="no step named 'C'"):
        step_script(body, "C")


def test_build_tags_read_every_tags_input() -> None:
    """Every ``tags: |`` block counts; a ``tags`` key in any other form is kept whole."""

    body = [
        (1, "        tags: |"),
        (2, "          a:1"),
        (3, "        labels: |"),
        (4, "          x"),
        (5, "        tags: |"),
        (6, "          b:2"),
        (7, "        tags: c:3"),
        (8, '        "tags": |'),
        (9, "        tags : |"),
        (10, "        with: { push: true, tags: d:4 }"),
        (11, "        fetch-tags: true"),
        (12, "        RAW=${GITHUB_REF#refs/tags/}"),
        (13, "        TAGS: e:5"),
    ]

    assert build_tags(body) == [
        "a:1",
        "b:2",
        "tags: c:3",
        '"tags": |',
        "tags : |",
        "with: { push: true, tags: d:4 }",
        "TAGS: e:5",
    ]


def test_listed_lines_keep_each_loop_line() -> None:
    """Two ``for service in`` lines stay two lists, which LT-A2 refuses; ``listed`` joins them."""

    body = [
        (1, "        for service in web ingestor; do"),
        (2, "        for service in matrix-bridge; do  # the rest"),
    ]

    assert listed_lines(body, PROMOTE_SERVICES) == [
        ["web", "ingestor"],
        ["matrix-bridge"],
    ]
    assert listed(body, PROMOTE_SERVICES) == ["web", "ingestor", "matrix-bridge"]


def test_matrix_unread_lists_what_lt_a2_does_not_read() -> None:
    """The matrix forms LT-A2 reads pass; any other matrix line is listed, without its comment."""

    body = [
        (1, "      fail-fast: false"),
        (2, "      matrix:"),
        (3, "        service: [web, ingestor]"),
        (4, "        architecture:"),
        (5, "          - { name: linux-amd64, platform: linux/amd64 }"),
        (6, "          - { platform: linux/arm64, name: linux-arm64 }"),
        (7, '          - { name: "linux-riscv64", platform: linux/riscv64 }'),
        (8, "          - name: linux-s390x"),
        (9, "        'include':  # one more leg"),
        (10, ""),
        (11, "    steps:"),
        (12, "        exclude: [x]"),
    ]

    assert matrix_unread(body) == [
        "- { platform: linux/arm64, name: linux-arm64 }",
        '- { name: "linux-riscv64", platform: linux/riscv64 }',
        "- name: linux-s390x",
        "'include':",
    ]


@pytest.mark.parametrize(
    ("line", "kept"),
    (
        ("# a comment", ""),
        ("    needs: [a, b]  # why", "    needs: [a, b]  "),
        ('echo "step #1" && push', 'echo "step #1" && push'),
        ("echo 'a # b' # c", "echo 'a # b' "),
        ('echo "a \\" # b" # c', 'echo "a \\" # b" '),
        ("echo 'a\\' # c", "echo 'a\\' "),
        ("VERSION=${GITHUB_REF#refs/tags/v}", "VERSION=${GITHUB_REF#refs/tags/v}"),
        ("echo a\\ #b", "echo a\\ #b"),
        (
            "eval $'true \\' # \\'; docker push img:latest'",
            "eval $'true \\' # \\'; docker push img:latest'",
        ),
        ("echo $'a' # c", "echo $'a' "),
    ),
    ids=(
        "whole-line",
        "trailing",
        "double-quoted",
        "single-quoted",
        "escaped-double-quote",
        "backslash-in-single-quotes",
        "parameter-expansion",
        "escaped-space",
        "ansi-c-escaped-quote",
        "ansi-c-closed",
    ),
)
def test_strip_comment_cuts_only_a_comment(line: str, kept: str) -> None:
    """A ``#`` inside quotes or a word stays; one that starts a word cuts the line."""

    assert strip_comment(line) == kept


@pytest.mark.parametrize(
    ("workflow", "gap"),
    (
        ("  t:\n    needs: test-images\n", None),
        ("  s:\n    needs: test-images\n  t:\n    needs: s\n", None),
        ("  s:\n    needs: test-images\n  t:\n    needs: [s, test-images]\n", None),
        ("  t:\n    needs: build\n", "test-images is not among its needs"),
        ("  t:\n    needs: [test-image]\n", "needs ['test-image'], which"),
        (
            "  t:\n    needs: test-images\n    if: ${{ !cancelled() }}\n",
            "t has `if: ${{ !cancelled() }}`, so it can run after test-images failed",
        ),
        (
            "  s:\n    needs: test-images\n    if: always()\n  t:\n    needs: s\n",
            "s has `if: always()`, so it can run after test-images failed",
        ),
        ("  s:\n    if: always()\n  t:\n    needs: [s, test-images]\n", None),
        ("  t:\n    needs: test-images\n    if: Always()\n", "t has `if: Always()`"),
        (
            "  t:\n    needs: test-images\n"
            "    if: success() || github.event_name == 'workflow_dispatch'\n",
            "t has `if: success() ||",
        ),
        (
            "    continue-on-error: true\n  t:\n    needs: test-images\n",
            "test-images has `continue-on-error: true`, so its failure need not stop",
        ),
        ("    continue-on-error: false\n  t:\n    needs: test-images\n", None),
        (
            "  t:\n    needs: test-images\n    if: >-\n"
            "      github.ref_name != 'a\n      #' || always()\n",
            "t has `if: >- github.ref_name != 'a #' || always()`",
        ),
        (
            "  t:\n    needs: test-images\n"
            "    if: github.event_name == 'push'  # always() not needed\n",
            "t has `if: github.event_name == 'push'  # always() not needed`",
        ),
    ),
    ids=(
        "direct",
        "through-a-job",
        "through-two-paths",
        "not-needed",
        "unknown-job",
        "status-function",
        "status-function-between",
        "status-function-beside",
        "status-function-any-case",
        "explicit-success",
        "smoke-test-may-fail",
        "smoke-test-must-pass",
        "status-function-after-hash",
        "status-function-in-comment",
    ),
)
def test_smoke_gate_gap_follows_needs_and_status_functions(
    workflow: str, gap: str | None
) -> None:
    """A job needs ``test-images`` through jobs that each keep the implicit ``success()``."""

    jobs = workflow_jobs(
        "jobs:\n  build:\n    runs-on: x\n"
        "  test-images:\n    needs: build\n" + workflow
    )

    reason = smoke_gate_gap(jobs, "t", SMOKE_TEST_JOB)

    if gap is None:
        assert reason is None
    else:
        assert reason is not None and reason.startswith(gap), reason
