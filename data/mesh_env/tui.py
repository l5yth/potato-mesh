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

"""Rich framing + questionary prompts (TTY); plain fallback when not a terminal.

Set ``MESH_ENV_FORCE_RICH=1`` if the banner/panels do not appear but your terminal
supports ANSI (some IDEs mis-report ``isatty`` on stdout).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

import questionary
from questionary import Choice, Style

from .branding import TAGLINE, render_wordmark

# Prompt theme aligned with Rich panels (cyan / gold / neutral grays).
_Q_STYLE = Style(
    [
        ("qmark", "fg:#5ee7b8 bold"),
        ("question", "bold fg:#e8eaed"),
        ("answer", "fg:#5ee7b8 bold"),
        ("pointer", "fg:#5ee7b8 bold"),
        ("highlighted", "fg:#ffd88a bold"),
        ("selected", "fg:#7dd3fc"),
        ("instruction", "fg:#9ca3af"),
        ("text", "fg:#d1d5db"),
    ]
)

_Q_KW: dict[str, Any] = {"style": _Q_STYLE}

_rich_console: Any | None = None
_rich_err: Any | None = None


def _env_truthy(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes")


def _rich_frames() -> bool:
    """Use Rich panels/rules when stdout can render (not tied to stdin)."""

    if _env_truthy("MESH_ENV_FORCE_RICH"):
        return True
    return sys.stdout.isatty()


def _stderr_styled() -> bool:
    if _env_truthy("MESH_ENV_FORCE_RICH"):
        return True
    return sys.stderr.isatty()


def _c() -> Any:
    global _rich_console
    if _rich_console is None:
        from rich.console import Console

        _rich_console = Console(
            highlight=False,
            soft_wrap=True,
            force_terminal=_env_truthy("MESH_ENV_FORCE_RICH"),
        )
    return _rich_console


def _cerr() -> Any:
    global _rich_err
    if _rich_err is None:
        from rich.console import Console

        _rich_err = Console(
            highlight=False,
            stderr=True,
            soft_wrap=True,
            force_terminal=_env_truthy("MESH_ENV_FORCE_RICH"),
        )
    return _rich_err


def is_interactive() -> bool:
    """True when questionary can use the full-screen prompt toolkit UI."""

    return sys.stdin.isatty() and sys.stdout.isatty()


def show_welcome(env_path: Path) -> None:
    if not _rich_frames():
        print(f"PotatoMesh env wizard → {env_path}")
        return

    from rich.align import Align
    from rich import box
    from rich.panel import Panel
    from rich.text import Text

    art = Text(render_wordmark(), style="bold #ffd88a")
    inner = Align.center(art)
    panel = Panel.fit(
        inner,
        title="[bold bright_cyan]potato-mesh[/] [dim]│[/] [white]" + TAGLINE + "[/]",
        subtitle=f"[dim]{env_path}[/]",
        subtitle_align="center",
        border_style="bright_cyan",
        box=box.ROUNDED,
        padding=(1, 3),
    )
    _c().print()
    _c().print(Align.center(panel))
    _c().print()


def step_header(step: int, total: int, title: str) -> None:
    if not _rich_frames():
        print(f"\n--- {step}/{total} {title} ---")
        return

    from rich.rule import Rule

    _c().print()
    _c().print(
        Rule(
            f"[dim]Step {step} of {total}[/]  [bold white]{title}[/]",
            style="bright_cyan",
            align="left",
        )
    )


def print_info(msg: str) -> None:
    if not _rich_frames():
        print(msg)
        return
    _c().print(msg)


def print_dim(msg: str) -> None:
    if not _rich_frames():
        print(msg)
        return
    _c().print(f"[dim]{msg}[/]")


def prompt_hint(text: str | None) -> None:
    """Short dim explanation shown before a prompt (informational, not a question)."""

    t = (text or "").strip()
    if not t:
        return
    print_dim(t)


def print_warning(msg: str) -> None:
    if not _rich_frames():
        print(msg)
        return

    from rich import box
    from rich.panel import Panel

    _c().print(
        Panel(
            msg,
            title="[bold yellow]Note[/]",
            border_style="yellow",
            box=box.ROUNDED,
            padding=(0, 1),
        )
    )


def print_error(msg: str) -> None:
    if not _stderr_styled():
        print(msg, file=sys.stderr)
        return
    _cerr().print(f"[bold red]{msg}[/]")


def print_aborted() -> None:
    if not _rich_frames():
        print("Aborted.")
        return
    _c().print("\n[dim]Aborted — no file was written.[/]")


def print_cancelled() -> None:
    if not _stderr_styled():
        print("\nCancelled.", file=sys.stderr)
        return
    _cerr().print("\n[yellow]Cancelled.[/yellow]")


def print_saved(path: Path, connection_kind_label: str) -> None:
    if not _rich_frames():
        print(f"Wrote {path}")
        print(f"Connection kind: {connection_kind_label}")
        return

    from rich import box
    from rich.panel import Panel

    from rich.align import Align

    body = (
        f"[bold green]Configuration saved.[/bold green]\n\n"
        f"[dim]Env file[/dim]     [bold white]{path}[/bold white]\n"
        f"[dim]Connection[/dim]  [white]{connection_kind_label}[/white]"
    )
    panel = Panel.fit(
        body,
        title="[bold green]Done[/]",
        border_style="green",
        box=box.ROUNDED,
        padding=(1, 2),
    )
    _c().print()
    _c().print(Align.center(panel))
    _c().print()


def _fallback_text(message: str, default: str = "") -> str:
    dhint = f" [{default}]" if default else ""
    raw = input(f"{message}{dhint}: ").strip()
    return raw if raw else default


def _fallback_confirm(message: str, default: bool = True) -> bool:
    d = "Y/n" if default else "y/N"
    raw = input(f"{message} ({d}): ").strip().lower()
    if not raw:
        return default
    return raw in ("y", "yes", "1", "true")


def text(message: str, default: str = "", *, hint: str | None = None) -> str:
    """Prompt for a single line of text.

    *hint* is printed in dim style before the prompt when non-empty.
    """

    prompt_hint(hint)
    if not is_interactive():
        return _fallback_text(message, default)
    r = questionary.text(message, default=default or "", **_Q_KW).unsafe_ask()
    return r.strip() if isinstance(r, str) else default


def confirm(message: str, default: bool = True, *, hint: str | None = None) -> bool:
    """Yes/no prompt; *hint* is dim informational text before the question."""

    prompt_hint(hint)
    if not is_interactive():
        return _fallback_confirm(message, default)
    r = questionary.confirm(message, default=default, **_Q_KW).unsafe_ask()
    return bool(r)


def select(
    message: str,
    choices: list[tuple[str, Any]],
    default_value: Any | None = None,
    *,
    hint: str | None = None,
) -> Any | None:
    """Return the *value* of the selected choice (second element of each tuple).

    *hint* is dim informational text before the list.
    """

    prompt_hint(hint)
    if not choices:
        return None
    default_idx = 0
    if default_value is not None:
        for i, (_, val) in enumerate(choices):
            if val == default_value:
                default_idx = i
                break

    if not is_interactive():
        for i, (title, val) in enumerate(choices):
            mark = " *" if i == default_idx else ""
            print(f"  [{i}] {title}{mark}")
        raw = _fallback_text(f"{message} (number)", str(default_idx))
        try:
            idx = int(raw)
            return choices[idx][1]
        except (ValueError, IndexError):
            return choices[default_idx][1]

    qc: list[Choice] = [Choice(title, value=val) for title, val in choices]
    return questionary.select(
        message,
        choices=qc,
        default=qc[default_idx],
        **_Q_KW,
    ).unsafe_ask()


def checkbox(
    message: str,
    choices: list[tuple[str, Any]],
    *,
    prechecked_values: frozenset[str] | None = None,
    hint: str | None = None,
) -> list[Any]:
    """Return list of selected values (may be empty).

    *prechecked_values* are matched case-insensitively against each choice *value*.
    *hint* is dim informational text before the checklist.
    """

    prompt_hint(hint)
    if not choices:
        return []
    pred_cf = prechecked_values or frozenset()

    def _checked(val: Any) -> bool:
        return str(val).casefold() in pred_cf

    if not is_interactive():
        for i, (title, val) in enumerate(choices):
            mark = " [x]" if _checked(val) else ""
            print(f"  [{i}] {title}{mark}")
        default_nums = ",".join(
            str(i) for i, (_, val) in enumerate(choices) if _checked(val)
        )
        raw = _fallback_text(
            f"{message} (comma-separated numbers, empty=none)", default_nums
        ).replace(" ", "")
        if not raw:
            return []
        out: list[Any] = []
        for part in raw.split(","):
            if not part:
                continue
            try:
                out.append(choices[int(part)][1])
            except (ValueError, IndexError):
                pass
        return out

    qc = [Choice(title, value=val, checked=_checked(val)) for title, val in choices]
    r = questionary.checkbox(message, choices=qc, **_Q_KW).unsafe_ask()
    return list(r)
