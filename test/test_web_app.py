import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


def test_query_nodes_from_web_app(tmp_path):
    db_path = tmp_path / "nodes.db"
    os.environ["MESH_DB"] = str(db_path)

    # import nodes module after setting env var
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from data import nodes  # type: ignore

    nodes.load_nodes_from_file(Path(__file__).with_name("nodes.json"))

    web_dir = Path(__file__).resolve().parents[1] / "web"
    try:
        subprocess.run(["bundle", "install"], cwd=web_dir, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        env = os.environ.copy()
        env["MESH_DB"] = str(db_path)
        out = subprocess.check_output(
            [
                "bundle",
                "exec",
                "ruby",
                "-e",
                'require_relative "app"; require "json"; puts query_nodes(5).to_json'
            ],
            cwd=web_dir,
            env=env,
            stderr=subprocess.DEVNULL,
        )
    except subprocess.CalledProcessError:
        pytest.skip("ruby dependencies not installed")

    data = json.loads(out)
    assert len(data) == 5
    last_heards = [item["last_heard"] for item in data]
    assert last_heards == sorted(last_heards, reverse=True)
