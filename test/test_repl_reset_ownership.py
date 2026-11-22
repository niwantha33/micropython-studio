"""Regression gates for original 2.6.1 REPL and safe CLI COM handoff."""
import ast
import os
from pathlib import Path
import tempfile
import unittest


SRC = Path(__file__).resolve().parents[1] / "src"


class SerialResetOwnershipTests(unittest.TestCase):
    def test_backend_reset_does_not_kill_foreign_port_owner(self):
        source = (SRC / "mps_backend.py").read_text(encoding="utf-8")
        ast.parse(source)
        self.assertNotIn("_kill_port_owner(", source)
        self.assertNotIn("_kill_comport_processes(", source)
        self.assertNotIn("taskkill", source)
        self.assertNotIn("os.kill(pid, 9)", source)
        self.assertIn("os.O_CREAT | os.O_EXCL", source)
        self.assertIn("hard_reset", source)

    def test_own_lock_cleanup_preserves_parent_or_foreign_owner(self):
        source = (SRC / "mps_backend.py").read_text(encoding="utf-8")
        node = next(n for n in ast.parse(source).body
                    if isinstance(n, ast.FunctionDef) and
                    n.name == "_release_lock_if_owned")
        scope = {"os": os}
        exec(compile(ast.Module(body=[node], type_ignores=[]),
                     "backend_lock_helper", "exec"), scope)
        cleanup = scope["_release_lock_if_owned"]
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / "port.lock"
            for value in ("1234:daemon", f"{os.getpid()}:suspended_lock",
                          "888888:cli", f"{os.getpid()}:cli_run"):
                lock.write_text(value, encoding="utf-8")
                cleanup(str(lock))
                self.assertEqual(lock.read_text(encoding="utf-8"), value)
            lock.write_text(f"{os.getpid()}:cli", encoding="utf-8")
            cleanup(str(lock))
            self.assertFalse(lock.exists())

    def test_repl_daemon_has_only_original_passive_command_protocol(self):
        source = (SRC / "mpy_daemon.py").read_text(encoding="utf-8")
        ast.parse(source)
        self.assertIn('action == "terminal_input"', source)
        self.assertIn('action == "run_in_terminal"', source)
        self.assertIn('action == "suspend"', source)
        self.assertIn('action == "resume"', source)
        self.assertNotIn('action == "hard_reset"', source)
        self.assertNotIn('_run_terminal_worker', source)


if __name__ == "__main__":
    unittest.main()
