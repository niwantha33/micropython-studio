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
    def test_debug_fixture_cleanup_waits_for_completion_before_probe(self):
        source = SOURCE.parent / "hardware_execution.py"
        spec = importlib.util.spec_from_file_location("hardware_execution_test", source)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        events = []

        class Bridge:
            def reply(self, op, prefix, **fields):
                events.append(op)
            def send(self, op):
                events.append(op)

        class Session:
            def event(self, name):
                events.append(name)
                return {"success": True}
            def input(self, data):
                self.fail("Cleanup must not issue Ctrl+C concurrently")

        module.finish_fixture(Bridge(), Session(), 0, True)
        self.assertEqual(events, ["clear_bp", "continue", "terminal_run_finished", "pump_info"])

    def test_scope_step_candidate_identity_rejects_old_firmware(self):
        spec = importlib.util.spec_from_file_location("hardware_debug_test", SOURCE.parent / "hardware_debug.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for value in ({}, {"scope_step_revision": None, "globals_api": False},
                      {"scope_step_revision": 1, "globals_api": False}):
            with self.assertRaises(RuntimeError):
                module.verify_fixed_firmware(value)
        good = {"scope_step_revision": 1, "globals_api": True}
        self.assertEqual(module.verify_fixed_firmware(good), good)

    def test_step_must_change_ip_and_execute_assignment(self):
        spec = importlib.util.spec_from_file_location("hardware_execution_test", SOURCE.parent / "hardware_execution.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        class Bridge:
            def __init__(self, rows):
                self.rows = iter(rows)
            def send(self, op):
                assert op == "step"
            def wait(self, predicate):
                ip, value = next(self.rows)
                self.value = value
                return {"evt": "bp_hit", "fun": 42, "ip": ip}
            def reply(self, op, prefix):
                return "depth=0 state=[None, %d]" % self.value

        with self.assertRaisesRegex(RuntimeError, "repeated instruction"):
            module.verify_step(Bridge([(7, 17321)]), 42, 7, 17322)
        rows = module.verify_step(Bridge([(8, 17321), (9, 17322)]), 42, 7, 17322)
        self.assertEqual(len(rows), 2)

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

    def test_js_evidence_is_per_file(self):
        records = [{"file": "a.test.js", "status": "pass"},
                   {"file": "b.test.js", "status": "fail"}]
        result = runner.js_suite_results(["a.test.js", "b.test.js", "c.test.js"], records)
        self.assertEqual(result["a.test.js"]["status"], "PASS")
        self.assertEqual(result["b.test.js"]["status"], "FAIL")
        self.assertEqual(result["c.test.js"]["status"], "NOT RUN")
