import json
import os
import subprocess
import sys
from pathlib import Path
import time
import sqlite3

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
                'require_relative "app"; require "json"; puts query_nodes(1000).to_json'
            ],
            cwd=web_dir,
            env=env,
            stderr=subprocess.DEVNULL,
        )
    except subprocess.CalledProcessError:
        pytest.skip("ruby dependencies not installed")

    data = json.loads(out)
    conn = sqlite3.connect(db_path)
    threshold = int(time.time()) - 7 * 24 * 60 * 60
    expected = conn.execute("SELECT COUNT(*) FROM nodes WHERE last_heard >= ?", (threshold,)).fetchone()[0]
    old_count = conn.execute("SELECT COUNT(*) FROM nodes WHERE last_heard < ?", (threshold,)).fetchone()[0]
    conn.close()
    assert old_count > 0
    assert len(data) == expected
    last_heards = [item["last_heard"] for item in data]
    assert last_heards == sorted(last_heards, reverse=True)
    assert all(lh is None or lh >= threshold for lh in last_heards)


def test_post_nodes_to_web_app(tmp_path):
    db_path = tmp_path / "nodes.db"
    os.environ["MESH_DB"] = str(db_path)
    os.environ["API_TOKEN"] = "secrettoken"

    web_dir = Path(__file__).resolve().parents[1] / "web"
    nodes_json = Path(__file__).with_name("nodes.json")
    try:
        subprocess.run(["bundle", "install"], cwd=web_dir, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        env = os.environ.copy()
        env["MESH_DB"] = str(db_path)
        env["API_TOKEN"] = "secrettoken"
        ruby = (
            "require_relative 'app'; require 'json'; require 'rack/mock'; require 'sqlite3';"\
            f"nodes = File.read({json.dumps(str(nodes_json))});"\
            "req = Rack::MockRequest.new(Sinatra::Application);"\
            "res = req.post('/api/nodes', 'CONTENT_TYPE' => 'application/json', 'HTTP_AUTHORIZATION' => 'Bearer secrettoken', :input => nodes);"\
            "puts res.status;"\
            "db = SQLite3::Database.new(ENV['MESH_DB']);"\
            "puts db.get_first_value('SELECT COUNT(*) FROM nodes');"
        )
        out = subprocess.check_output(
            ["bundle", "exec", "ruby", "-e", ruby],
            cwd=web_dir,
            env=env,
            stderr=subprocess.DEVNULL,
        )
    except subprocess.CalledProcessError:
        pytest.skip("ruby dependencies not installed")

    lines = out.decode().strip().splitlines()
    assert lines[0] == "200"
    expected = len(json.load(open(nodes_json)))
    assert int(lines[1]) == expected


def test_null_role_defaults_to_client(tmp_path):
    db_path = tmp_path / "nodes.db"
    os.environ["MESH_DB"] = str(db_path)
    os.environ["API_TOKEN"] = "tok"

    web_dir = Path(__file__).resolve().parents[1] / "web"
    node = {
        "nodeA": {
            "num": 1,
            "lastHeard": int(time.time()),
            "user": {"shortName": "Foo"},
        }
    }
    nodes_json = json.dumps(node)
    try:
        subprocess.run(["bundle", "install"], cwd=web_dir, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        env = os.environ.copy()
        env["MESH_DB"] = str(db_path)
        env["API_TOKEN"] = "tok"
        ruby = (
            "require_relative 'app'; require 'json'; require 'rack/mock';"
            f"nodes = {json.dumps(nodes_json)};"
            "req = Rack::MockRequest.new(Sinatra::Application);"
            "req.post('/api/nodes', 'CONTENT_TYPE' => 'application/json', 'HTTP_AUTHORIZATION' => 'Bearer tok', :input => nodes);"
            "puts query_nodes(1000).to_json;"
        )
        out = subprocess.check_output(["bundle", "exec", "ruby", "-e", ruby], cwd=web_dir, env=env, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        pytest.skip("ruby dependencies not installed")

    data = json.loads(out.decode().splitlines()[-1])
    assert any(n["role"] == "CLIENT" for n in data if n["node_id"] == "nodeA")

    conn = sqlite3.connect(db_path)
    role = conn.execute("SELECT role FROM nodes WHERE node_id=?", ("nodeA",)).fetchone()[0]
    conn.close()
    assert role == "CLIENT"
