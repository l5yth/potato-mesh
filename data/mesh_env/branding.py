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

"""Wordmark and copy for the env wizard (pyfiglet + static fallback)."""

from __future__ import annotations

# Hand-drawn fallback (~62 columns); used when pyfiglet is unavailable.
POTATO_MESH_ASCII = r"""
  ____       _        _     __  __                     _
 |  _ \ ___ | |_ __ _| |   |  \/  | _____   _____  ___| |__
 | |_) / _ \| __/ _` | |   | |\/| |/ _ \ \ / / _ \/ __| '_ \
 |  __/ (_) | || (_| | |   | |  | | (_) \ V /  __/ (__| | | |
 |_|   \___/ \__\__,_|_|   |_|  |_|\___/ \_/ \___|\___|_| |_|
""".strip()

TAGLINE = "ingestor · env wizard"

_DEFAULT_PHRASE = "Potato Mesh"

# Prefer readable fonts that stay mostly ASCII; order is try-first.
_FIGLET_FONT_PREFERENCE = ("slant", "small", "standard", "big")


def render_wordmark(phrase: str | None = None) -> str:
    """Return multi-line ASCII art for *phrase* via pyfiglet, or :data:`POTATO_MESH_ASCII`."""

    label = (phrase or _DEFAULT_PHRASE).strip() or _DEFAULT_PHRASE
    try:
        from pyfiglet import Figlet
    except ImportError:
        return POTATO_MESH_ASCII

    for font in _FIGLET_FONT_PREFERENCE:
        try:
            return Figlet(font=font).renderText(label).rstrip("\n")
        except Exception:
            continue
    return POTATO_MESH_ASCII
