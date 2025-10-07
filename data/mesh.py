#!/usr/bin/env python3
"""Backward-compatible entry point for the mesh ingestor daemon."""

from __future__ import annotations

import importlib
import sys

try:
    from . import mesh_ingestor as _mesh_ingestor
except ImportError:
    if __package__ in {None, ""}:
        _mesh_ingestor = importlib.import_module("data.mesh_ingestor")
    else:
        raise

# Expose the refactored mesh ingestor module under the legacy name so existing
# imports (``import data.mesh as mesh``) continue to work. Attribute access and
# monkeypatching operate directly on the shared module instance.
sys.modules[__name__] = _mesh_ingestor


if __name__ == "__main__":
    _mesh_ingestor.main()
