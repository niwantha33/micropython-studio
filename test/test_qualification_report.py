"""Qualification report logic checks without starting VS Code."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).parent / "qualification" / "qualify.py"
spec = importlib.util.spec_from_file_location("qualification_runner", SOURCE)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class QualificationReportTests(unittest.TestCase):
    def test_status_never_invents_pass(self):
        self.assertEqual(runner.feature_status([], {}), "NOT COVERED")
        self.assertEqual(runner.feature_status(["a"], {}), "NOT RUN")
        self.assertEqual(runner.feature_status(["a", "b"], {"a": {"status": "PASS"}}), "NOT RUN")
        self.assertEqual(runner.feature_status(["a"], {"a": {"status": "FAIL"}}), "FAIL")
        self.assertEqual(runner.feature_status(["a"], {"a": {"status": "PASS"}}), "PASS")

    def test_unknown_change_impacts_every_feature(self):
        features = [{"id": "A", "paths": ["src/a.js"]},
                    {"id": "B", "paths": ["src/b.js"]}]
        with patch.object(runner, "git", side_effect=["src/new.js", "", ""]):
            _, affected = runner.impact("base", features)
        self.assertEqual(affected, {"A", "B"})
