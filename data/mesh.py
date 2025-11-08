#!/usr/bin/env python3
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

"""Backward-compatible entry point for the mesh ingestor daemon."""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

try:
    from . import mesh_ingestor as _mesh_ingestor
except ImportError:
    if __package__ in {None, ""}:
        package_dir = Path(__file__).resolve().parent
        project_root = str(package_dir.parent)
        if project_root not in sys.path:
            sys.path.insert(0, project_root)
        _mesh_ingestor = importlib.import_module("data.mesh_ingestor")
    else:
        raise

# Expose the refactored mesh ingestor module under the legacy name so existing
# imports (``import data.mesh as mesh``) continue to work. Attribute access and
# monkeypatching operate directly on the shared module instance.
sys.modules[__name__] = _mesh_ingestor


if __name__ == "__main__":
    _mesh_ingestor.main()
