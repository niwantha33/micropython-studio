"""Debugger bridge JSON integrity under concurrent CDC and command traffic."""
import importlib.util
import io
import json
from pathlib import Path
import sys
import threading
import types
import unittest
from unittest.mock import patch

SRC = Path(__file__).resolve().parents[1] / "src" / "dbg_bridge.py"


class DebugBridgeOutputTests(unittest.TestCase):
    def test_reader_and_command_events_remain_atomic_json_lines(self):
        serial_stub = types.ModuleType("serial")
        old = sys.modules.get("serial")
        sys.modules["serial"] = serial_stub
        try:
            spec = importlib.util.spec_from_file_location("_mps_debug_bridge_test", SRC)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        finally:
            if old is None:
                sys.modules.pop("serial", None)
            else:
                sys.modules["serial"] = old

        capture = io.StringIO()
        with patch.object(sys, "stdout", capture):
            a = threading.Thread(target=lambda: [
                module.say(evt="reply", text="frame=" + str(i)) for i in range(100)
            ])
            b = threading.Thread(target=lambda: [
                module.say(evt="bp_hit", ip=i, fun=23) for i in range(100)
            ])
            a.start()
            b.start()
            a.join(3)
            b.join(3)
            self.assertFalse(a.is_alive())
            self.assertFalse(b.is_alive())

        rows = [json.loads(line) for line in capture.getvalue().splitlines()]
        self.assertEqual(len(rows), 200)
        self.assertEqual(sum(r["evt"] == "bp_hit" for r in rows), 100)
        self.assertEqual(sum(r["evt"] == "reply" for r in rows), 100)


if __name__ == "__main__":
    unittest.main()
