"""Exercise production daemon RX, command and raw-paste paths together."""
import base64
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from test_serial_streaming import load_daemon
from virtual_micropython import VirtualMicroPython


class VirtualSerialBaselineTests(unittest.TestCase):
    def setUp(self):
        self.mod = load_daemon()
        self.daemon = self.mod.MpyDaemon("VIRTUAL-BASELINE")
        self.port = VirtualMicroPython()
        self.daemon.serial = self.port
        self.daemon.running = True
        self.events = []
        self.guard = threading.Lock()
        self.daemon.send_event = self.capture
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.lock_path = Path(self.directory.name) / "port.lock"
        self.lock_patch = patch.object(self.mod, "_get_lock_path",
                                       return_value=str(self.lock_path))
        self.lock_patch.start()
        self.addCleanup(self.lock_patch.stop)
        self.threads = [threading.Thread(target=target, daemon=True)
                        for target in (self.daemon._rx_loop, self.daemon._read_loop)]
        for worker in self.threads:
            worker.start()

    def tearDown(self):
        self.daemon.running = False
        self.port.close()
        foreground = self.daemon._foreground_thread
        if foreground is not None:
            foreground.join(3)
        for worker in self.threads:
            worker.join(2)
        self.mod._release_lock(self.daemon.port)
        self.assertFalse(any(worker.is_alive() for worker in self.threads))
        if foreground is not None:
            self.assertFalse(foreground.is_alive())

    def capture(self, name, payload):
        with self.guard:
            self.events.append((name, payload))

    def output(self):
        with self.guard:
            return b"".join(base64.b64decode(data["data"])
                            for name, data in self.events if name == "terminal_data")

    def messages(self, event):
        with self.guard:
            return [data for name, data in self.events if name == event]

    def wait_for(self, predicate):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.005)
        self.fail("Baseline timeout; events=" + repr(self.events))

    def input(self, data):
        self.daemon.process_command({"action": "terminal_input",
                                     "data": base64.b64encode(data).decode("ascii")})

    def test_SER_001_friendly_stream_and_interrupt(self):
        self.input(b"main.fxn()\r")
        expected = b"first\r\n\xc3\xa9\r\nsecond\r\n"
        for part in (b"first\r\n", b"\xc3", b"\xa9\r\n", b"second\r\n"):
            self.port.emit(part)
        self.wait_for(lambda: len(self.output()) >= len(expected))
        self.assertEqual(self.output(), expected)
        self.input(b"\x03")
        self.wait_for(lambda: self.output().endswith(b">>>"))
        self.assertEqual(self.output(), expected + b"KeyboardInterrupt\r\n>>>")
        self.assertFalse(self.port.running)
        self.assertNotIn(b"\x04", self.port.writes)

    def test_SER_002_raw_paste_credit_and_output(self):
        source = "print('ready')"
        self.daemon.process_command({"action": "run_in_terminal", "code": source})
        self.wait_for(lambda: self.messages("terminal_run_finished"))
        self.assertTrue(self.messages("terminal_run_finished")[0]["success"])
        self.assertEqual(self.port.executed, [source.encode()])
        self.assertEqual(self.output(), b"ready \xc3\xa9\r\n")
        self.assertEqual(len(self.messages("terminal_run_started")), 1)
        self.assertFalse(self.daemon.in_raw_repl)

    def test_SER_003_foreground_stream_stop_and_reuse(self):
        self.daemon.process_command({"action": "run_in_terminal", "code": "loop()"})
        self.wait_for(lambda: self.messages("terminal_run_started"))
        self.port.emit(b"tick 1\r\n")
        self.wait_for(lambda: self.output() == b"tick 1\r\n")
        self.port.emit(b"tick 2\r\n")
        self.wait_for(lambda: self.output() == b"tick 1\r\ntick 2\r\n")
        self.daemon.process_command({"action": "suspend"})
        self.assertEqual(len(self.messages("transition_error")), 1)
        self.assertTrue(self.port.is_open)
        self.daemon.interrupt()
        self.wait_for(lambda: self.messages("terminal_run_finished"))
        self.assertTrue(self.messages("terminal_run_finished")[0]["success"])
        self.assertEqual(self.output(), b"tick 1\r\ntick 2\r\nKeyboardInterrupt\r\n")
        self.assertFalse(self.daemon.in_raw_repl)
        self.assertFalse(self.port.running)
        self.input(b"\r")
        self.wait_for(lambda: self.output().endswith(b">>>"))

    def test_SER_004_suspend_resume_releases_real_lock(self):
        self.assertTrue(self.mod._acquire_lock(self.daemon.port))
        self.assertFalse(self.mod._acquire_lock(self.daemon.port))
        for _ in range(3):
            self.daemon.process_command({"action": "suspend"})
            self.assertFalse(self.port.is_open)
            self.assertFalse(self.lock_path.exists())
            self.daemon.process_command({"action": "resume"})
            self.assertTrue(self.port.is_open)
            self.assertTrue(self.lock_path.exists())
        self.assertEqual(len(self.messages("suspended")), 3)
        self.assertEqual(len(self.messages("resumed")), 3)
        self.assertEqual(self.port.writes, [])


class BaselineRegistryTests(unittest.TestCase):
    def test_registry_maps_every_serial_scenario(self):
        registry = json.loads((Path(__file__).parent / "baselines" /
                               "serial.json").read_text(encoding="utf-8"))
        ids = [entry["id"] for entry in registry["contracts"]]
        self.assertEqual(len(ids), len(set(ids)))
        actual = {name for name in dir(VirtualSerialBaselineTests)
                  if name.startswith("test_SER_")}
        self.assertEqual({entry["test"] for entry in registry["contracts"]}, actual)
        for entry in registry["contracts"]:
            self.assertTrue(entry["expected"])


if __name__ == "__main__":
    unittest.main()
