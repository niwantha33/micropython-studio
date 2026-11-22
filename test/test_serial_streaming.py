"""Regression tests for the proven 2.6.1 MicroPython serial REPL protocol."""
import base64
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / "src" / "mpy_daemon.py"


def load_daemon():
    stub = types.ModuleType("serial")
    previous = sys.modules.get("serial")
    sys.modules["serial"] = stub
    try:
        spec = importlib.util.spec_from_file_location("_v261_repl_test", SOURCE)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    finally:
        if previous is None:
            sys.modules.pop("serial", None)
        else:
            sys.modules["serial"] = previous


class FakeSerial:
    is_open = True
    in_waiting = 0

    def __init__(self, daemon):
        self.daemon = daemon
        self.writes = []

    def write(self, data):
        self.writes.append(data)
        reply = None
        if data == b'\r\x01':
            reply = b'raw REPL; CTRL-B to exit\r\n>'
        elif data == b'\x05A\x01':
            reply = b'R\x01\x00\x04'
        elif data == b'\x04':
            reply = b'\x04ready \xc3\xa9\r\n\x04\x04>'
        elif data == b'\r\x02':
            reply = b'>>>'
        if reply:
            with self.daemon._rx_lock:
                self.daemon._rx_queue.extend(reply)
        return len(data)


class KnownGoodReplProtocolTests(unittest.TestCase):
    def setUp(self):
        self.mod = load_daemon()
        self.daemon = self.mod.MpyDaemon("COM5")
        self.daemon.running = True
        self.port = FakeSerial(self.daemon)
        self.daemon.serial = self.port
        self.events = []
        self.daemon.send_event = lambda name, data: self.events.append((name, data))

    def test_interactive_enter_and_control_c_are_written_directly(self):
        for raw in (b'\r', b'print(1 + 1)\r', b'\x03'):
            self.daemon.process_command({
                "action": "terminal_input",
                "data": base64.b64encode(raw).decode("ascii")
            })
        self.assertIn(b'\r', self.port.writes)
        self.assertIn(b'print(1 + 1)\r', self.port.writes)
        self.assertIn(b'\x03', self.port.writes)

    def test_input_buffered_while_raw_repl_and_released_when_idle(self):
        self.daemon.in_raw_repl = True
        self.daemon.process_command({
            "action": "terminal_input",
            "data": base64.b64encode(b'help()\r').decode("ascii")
        })
        self.assertNotIn(b'help()\r', self.port.writes)
        self.daemon.in_raw_repl = False
        self.daemon._flush_terminal_input()
        self.assertIn(b'help()\r', self.port.writes)

    def test_finite_run_uses_original_device_protocol(self):
        with patch.object(self.mod.time, "sleep", lambda _: None):
            self.daemon.process_command({
                "action": "run_in_terminal", "code": "print('ready')"
            })
        output = b"".join(base64.b64decode(data["data"])
                          for event, data in self.events
                          if event == "terminal_data")
        self.assertIn(b"ready \xc3\xa9", output)
        self.assertFalse(self.daemon.in_raw_repl)
        self.assertFalse(any(event == "error" for event, _ in self.events))


if __name__ == "__main__":
    unittest.main()
