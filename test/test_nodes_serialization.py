import os
import sqlite3
import sys
import types
from dataclasses import dataclass
from pathlib import Path


def test_upsert_node_handles_position(tmp_path):
    data_dir = Path(__file__).resolve().parent.parent / "data"
    cwd = os.getcwd()
    os.chdir(data_dir)
    try:
        # Provide minimal stubs for the meshtastic modules imported by nodes.py
        meshtastic = types.ModuleType("meshtastic")
        serial_module = types.ModuleType("serial_interface")
        serial_module.SerialInterface = object
        mesh_module = types.ModuleType("mesh_interface")
        mesh_module.MeshInterface = object
        meshtastic.serial_interface = serial_module
        meshtastic.mesh_interface = mesh_module
        sys.modules.setdefault("meshtastic", meshtastic)
        sys.modules.setdefault("meshtastic.serial_interface", serial_module)
        sys.modules.setdefault("meshtastic.mesh_interface", mesh_module)

        sys.path.insert(0, str(data_dir))
        import nodes
        # Close original on-disk connection and use in-memory DB for testing
        nodes.conn.close()
        dbfile = Path("nodes.db")
        if dbfile.exists():
            dbfile.unlink()
        nodes.conn = sqlite3.connect(":memory:", check_same_thread=False)
        nodes.conn.executescript(nodes.schema)
        nodes.conn.commit()

        @dataclass
        class Position:
            time: int = 123
            locationSource: str = "GPS"
            latitude: float = 52.5
            longitude: float = 13.4
            altitude: float = 34.0

        n = {"num": 7, "position": Position(), "lastHeard": 100}
        nodes.upsert_node("node1", n)
        nodes.conn.commit()
        row = nodes.conn.execute(
            "SELECT latitude, first_heard, last_heard FROM nodes WHERE node_id=?",
            ("node1",),
        ).fetchone()
        assert row is not None
        assert row[0] == 52.5
        assert row[1] == 100
        initial_last_heard = row[2]
        assert initial_last_heard is not None and initial_last_heard >= row[1]

        # Changing the reported lastHeard should not affect stored last_heard
        # which is always updated to the current time
        n["lastHeard"] = 0
        nodes.upsert_node("node1", n)
        nodes.conn.commit()
        row2 = nodes.conn.execute(
            "SELECT first_heard, last_heard FROM nodes WHERE node_id=?", ("node1",)
        ).fetchone()
        assert row2[0] == 100
        assert row2[1] >= initial_last_heard
    finally:
        os.chdir(cwd)
