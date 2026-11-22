"""No-hardware MicroPython REPL streaming and interactive Stop regression tests."""
import base64
import importlib.util
from pathlib import Path
import sys
import threading
import time
import types
import unittest


DAEMON_PATH = Path(__file__).resolve().parents[1] / "src" / "mpy_daemon.py"


def load_daemon():
    # Tests must run on GitHub CI without pyserial or a physical board.
    stub = types.ModuleType("serial")
    old = sys.modules.get("serial")
    sys.modules["serial"] = stub
    try:
        spec = importlib.util.spec_from_file_location("_mps_test_stream_daemon", DAEMON_PATH)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    finally:
        if old is None:
            sys.modules.pop("serial", None)
        else:
            sys.modules["serial"] = old


class FakeMicroPythonSerial:
    is_open = True
    in_waiting = 0

    def __init__(self, daemon, continuous=False):
        self.daemon = daemon
        self.continuous = continuous
        self.writes = []
        self.dtr = False
        self.rts = False

    def _rx(self, data):
        with self.daemon._rx_lock:
            self.daemon._rx_queue.extend(data)

    def write(self, data):
        self.writes.append(data)
        if data == b'\r\x01':
            self._rx(b'raw REPL; CTRL-B to exit\r\n>')
        elif data == b'\x05A\x01':
            self._rx(b'R\x01\x00\x04')  # raw paste, 1024-byte window
        elif data == b'\x04':
            self._rx(b'\x04tick\r\n' if self.continuous
                     else b'\x04output \xc3\xa9\r\n\x04\x04>')
        elif data == b'\x03' and self.continuous:
            self._rx(b'\x04KeyboardInterrupt\x04>')
        elif data == b'\r\x02':
            self._rx(b'>>>')
        return len(data)

    def setDTR(self, enabled):
        self.dtr = enabled

    def setRTS(self, enabled):
        self.rts = enabled


class SerialStreamingTests(unittest.TestCase):
    def setUp(self):
        self.module = load_daemon()
        self.daemon = self.module.MpyDaemon("COM5")
        self.daemon.running = True
        self.events = []
        self.events_lock = threading.Lock()

        def record(event, payload):
            with self.events_lock:
                self.events.append((event, payload))

        self.daemon.send_event = record

    def _events(self, name):
        with self.events_lock:
            return [payload for event, payload in self.events if event == name]

    def _wait(self, name, timeout=3.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._events(name):
                return
            time.sleep(0.01)
        self.fail("No %s event; daemon worker stayed blocked" % name)

    def tearDown(self):
        self.daemon.running = False
        self.daemon._program_cancel.set()
        worker = self.daemon._run_worker
        if worker:
            worker.join(timeout=2.0)
            self.assertFalse(worker.is_alive(), "Run worker failed to stop")

    def test_run_streams_output_and_finishes_without_blocking_command_loop(self):
        fake = FakeMicroPythonSerial(self.daemon)
        self.daemon.serial = fake
        self.daemon.process_command({"action": "run_in_terminal",
                                     "id": 31, "code": "print('ok')"})
        self._wait("run_finished")
        self.assertEqual(self._events("run_started"), [{"id": 31, "success": True}])
        binary = b"".join(base64.b64decode(e["data"])
                          for e in self._events("terminal_data"))
        self.assertIn(b"output \xc3\xa9", binary)
        self.assertFalse(self.daemon._program_running)
        self.assertFalse(self.daemon.in_raw_repl)

    def test_ctrl_c_interrupts_infinite_program_and_input_is_not_blocked(self):
        fake = FakeMicroPythonSerial(self.daemon, continuous=True)
        self.daemon.serial = fake
        self.daemon.process_command({"action": "run_in_terminal",
                                     "id": 32, "code": "while True: pass"})
        self._wait("terminal_data")
        start = time.monotonic()
        self.daemon.process_command({
            "action": "terminal_input",
            "data": base64.b64encode(b"\x03").decode("ascii")
        })
        self.assertLess(time.monotonic() - start, 0.5, "stdin command loop blocked")
        self._wait("run_finished")
        binary = b"".join(base64.b64decode(e["data"])
                          for e in self._events("terminal_data"))
        self.assertIn(b"tick", binary)
        self.assertIn(b"KeyboardInterrupt", binary)
        self.assertIn(b"\x03", fake.writes)

    def test_explicit_hard_reset_can_cancel_a_running_script(self):
        fake = FakeMicroPythonSerial(self.daemon, continuous=True)
        self.daemon.serial = fake
        self.daemon.process_command({"action": "run_in_terminal",
                                     "id": 35, "code": "while True: pass"})
        self._wait("terminal_data")
        self.daemon.process_command({"action": "hard_reset", "id": 36})
        self._wait("run_finished")
        self.assertEqual(self._events("reset_result"),
                         [{"id": 36, "success": True}])
        self.assertTrue(self.daemon._program_cancel.is_set())
        self.assertFalse(self.daemon._program_running)
        self.assertIn(("RTS", True), [("RTS", v) for v in
                                      [getattr(fake, "rts", None), True]])

    def test_usb_reconnect_failure_emits_disconnected_state_instead_of_ghost_repl(self):
        class DisappearedSerial:
            is_open = True

            @property
            def in_waiting(self):
                raise OSError("USB CDC device not functioning")

        self.daemon.serial = DisappearedSerial()
        self.daemon._try_reconnect = lambda: False
        self.daemon._rx_loop()
        self.assertFalse(self.daemon.running)
        self.assertTrue(self._events("reconnecting"))
        self.assertTrue(self._events("error"))

    def test_reject_second_run_while_first_is_active(self):
        fake = FakeMicroPythonSerial(self.daemon, continuous=True)
        self.daemon.serial = fake
        self.daemon.process_command({"action": "run_in_terminal",
                                     "id": 33, "code": "while True: pass"})
        self._wait("terminal_data")
        self.daemon.process_command({"action": "run_in_terminal",
                                     "id": 34, "code": "print('no')"})
        self.assertEqual(self._events("run_started")[-1]["id"], 34)
        self.assertFalse(self._events("run_started")[-1]["success"])
        self.daemon.process_command({
            "action": "terminal_input",
            "data": base64.b64encode(b"\x03").decode("ascii")
        })
        self._wait("run_finished")


if __name__ == "__main__":
    unittest.main()
