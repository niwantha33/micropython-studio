"""Run selected contracts against isolated, deliberately damaged source copies."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
MUTATIONS = [
    ("drop-shell-output", "mpy_daemon.py",
     'self.send_event("terminal_data", {"data": b64_data})',
     'pass  # mutation: drop output',
     "test_virtual_serial_baseline.VirtualSerialBaselineTests.test_SER_001_friendly_stream_and_interrupt"),
    ("ignore-stop", "mpy_daemon.py",
     "self.serial.write(b'\\x03')\n        time.sleep(0.05)\n        self.serial.write(b'\\x03')",
     "pass  # mutation: ignore explicit stop",
     "test_virtual_serial_baseline.VirtualSerialBaselineTests.test_SER_003_foreground_stream_stop_and_reuse"),
    ("leak-lock", "mpy_daemon.py",
     '_release_lock(self.port)\n                self.send_event("suspended", {})',
     'self.send_event("suspended", {})',
     "test_virtual_serial_baseline.VirtualSerialBaselineTests.test_SER_004_suspend_resume_releases_real_lock"),
    ("drop-breakpoint", "dbg_bridge.py",
     'say(evt="bp_hit", ip=ip, fun=fun)',
     'pass  # mutation: discard target hit',
     "test_virtual_debug_baseline.VirtualDebugBaselineTests.test_DBG_001_bridge_roundtrip"),
]


class MutationBaselineTests(unittest.TestCase):
    def test_contracts_detect_deliberate_regressions(self):
        for label, filename, old, new, target in MUTATIONS:
            with self.subTest(mutation=label), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                shutil.copytree(ROOT / "src", root / "src",
                                ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
                shutil.copytree(ROOT / "test", root / "test",
                                ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
                source = root / "src" / filename
                text = source.read_text(encoding="utf-8")
                self.assertEqual(text.count(old), 1, "Mutation anchor changed; review mutation")
                source.write_text(text.replace(old, new, 1), encoding="utf-8")
                env = dict(os.environ, PYTHONPATH=str(root / "test"),
                           PYTHONDONTWRITEBYTECODE="1")
                result = subprocess.run([sys.executable, "-m", "unittest", "-v", target],
                                        cwd=root, env=env, capture_output=True,
                                        text=True, timeout=25)
                log = result.stdout + result.stderr
                self.assertEqual(result.returncode, 1, log)
                self.assertIn("FAIL: " + target.rsplit(".", 1)[-1], log)
                self.assertNotIn("ERROR:", log)
                self.assertNotIn("ImportError", log)
                print("Detected mutation:", label, flush=True)
