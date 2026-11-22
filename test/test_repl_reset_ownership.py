"""Serial reset / lock ownership regression gates: no hardware required."""
import ast
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock


SRC = Path(__file__).resolve().parents[1] / "src"


class SerialResetOwnershipTests(unittest.TestCase):
    def test_backend_never_kills_port_owner(self):
        source = (SRC / "mps_backend.py").read_text(encoding="utf-8")
        ast.parse(source)
        self.assertNotIn("_kill_port_owner(", source)
        self.assertNotIn("_kill_comport_processes(", source)
        self.assertNotIn("taskkill", source)
        self.assertNotIn("os.kill(pid, 9)", source)
        self.assertIn("os.O_CREAT | os.O_EXCL", source)

    def test_backend_cleanup_preserves_parent_and_foreign_locks(self):
        source = (SRC / "mps_backend.py").read_text(encoding="utf-8")
        node = next(n for n in ast.parse(source).body
                    if isinstance(n, ast.FunctionDef) and
                    n.name == "_release_lock_if_owned")
        scope = {"os": os}
        exec(compile(ast.Module(body=[node], type_ignores=[]),
                     "mps_backend_lock_helper", "exec"), scope)
        cleanup = scope["_release_lock_if_owned"]
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / "port.lock"
            for value in ("1234:daemon", f"{os.getpid()}:suspended_lock",
                          "888888:cli"):
                lock.write_text(value, encoding="utf-8")
                cleanup(str(lock))
                self.assertEqual(lock.read_text(encoding="utf-8"), value)
            lock.write_text(f"{os.getpid()}:cli_run", encoding="utf-8")
            cleanup(str(lock))
            self.assertEqual(lock.read_text(encoding="utf-8"),
                             f"{os.getpid()}:cli_run")
            lock.write_text(f"{os.getpid()}:cli", encoding="utf-8")
            cleanup(str(lock))
            self.assertFalse(lock.exists())

    def test_reset_uses_daemon_existing_serial_handle(self):
        # Import under an isolated serial stub: no pyserial or MCU is required.
        name = "_mps_daemon_reset_test"
        serial_stub = types.ModuleType("serial")
        old_serial = sys.modules.get("serial")
        sys.modules["serial"] = serial_stub
        try:
            spec = importlib.util.spec_from_file_location(name, SRC / "mpy_daemon.py")
            daemon_module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(daemon_module)
        finally:
            if old_serial is None:
                sys.modules.pop("serial", None)
            else:
                sys.modules["serial"] = old_serial

        operations = []

        class FakeSerial:
            is_open = True

            def write(self, data):
                operations.append(("write", data))
                return len(data)

            def setDTR(self, value):
                operations.append(("DTR", value))

            def setRTS(self, value):
                operations.append(("RTS", value))

        daemon = daemon_module.MpyDaemon("COM5")
        daemon.serial = FakeSerial()
        daemon.running = True
        messages = []
        daemon.send_event = lambda event, payload: messages.append((event, payload))
        with mock.patch.object(daemon_module.time, "sleep", lambda seconds: None):
            daemon.process_command({"action": "hard_reset", "id": 11})

        self.assertIn(("write", b"\r\x03\x03"), operations)
        self.assertIn(("write", b"\r\x04"), operations)
        self.assertIn(("RTS", True), operations)
        self.assertEqual(messages, [("reset_result", {"id": 11, "success": True})])

        daemon.suspended = True
        messages.clear()
        daemon.process_command({"action": "hard_reset", "id": 12})
        self.assertEqual(messages[0][0], "reset_result")
        self.assertFalse(messages[0][1]["success"])

        # Reentrant acquisition is required for USB recovery called while
        # a terminal_input write holds the serial lock.
        with daemon._lock:
            self.assertTrue(daemon._lock.acquire(blocking=False))
            daemon._lock.release()


if __name__ == "__main__":
    unittest.main()
