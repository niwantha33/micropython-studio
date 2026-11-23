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
    def load_bridge(self):
        stub = types.ModuleType('serial')
        with patch.dict(sys.modules, {'serial': stub}):
            spec = importlib.util.spec_from_file_location('_bridge_rx_test', SRC)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        return module

    def read_frames(self, chunks):
        module = self.load_bridge()
        stop = threading.Event()
        events = []
        module.say = lambda **event: events.append(event)

        class Port:
            def read(self, size):
                if chunks:
                    return chunks.pop(0)
                stop.set()
                return b''

        module.reader_loop(Port(), stop)
        return events

    def test_noise_and_invalid_header_do_not_delay_complete_reply(self):
        text = b'cleared all bp slots []'
        frame = bytes([0xAA, 3, len(text)]) + text
        for prefix in (b'usb noise', b'\xaa\xff\x00', b'\xaa\x01\x00'):
            with self.subTest(prefix=prefix):
                events = self.read_frames([prefix + frame])
                self.assertEqual(events, [{'evt': 'reply', 'text': text.decode()}])

    def test_valid_breakpoint_before_noise_is_not_discarded(self):
        frame = b'\xaa\x02\x02\x08\x00'
        events = self.read_frames([frame + b'noise' + frame])
        self.assertEqual(events, [{'evt': 'bp_hit', 'ip': 8}] * 2)

    def test_fragmented_and_coalesced_frames_preserve_order(self):
        frame = b'\xaa\x02\x02\x08\x00'
        events = self.read_frames([frame[:1], frame[1:4], frame[4:] + frame])
        self.assertEqual(events, [{'evt': 'bp_hit', 'ip': 8}] * 2)

    def test_quit_releases_paused_vm_before_closing_debug_cdc(self):
        module = self.load_bridge()
        operations = []

        class Port:
            def open(self):
                pass
            def write(self, data):
                operations.append(data)
            def flush(self):
                operations.append('flush')
            def close(self):
                operations.append('close')

        module.serial.Serial = Port
        module.say = lambda **event: None
        with patch.object(sys, 'argv', ['dbg_bridge.py', 'COM5']), \
             patch.object(sys, 'stdin', io.StringIO('{"op":"quit"}\n')), \
             patch.object(module.threading, 'Thread'), \
             patch.object(module.time, 'sleep'):
            module.main()
        self.assertEqual(operations[:3], [b'\xaa\x1c\x00', b'\xaa\x1d\x00', b'\xaa\x10\x00'])
        self.assertLess(operations.index('flush'), operations.index('close'))

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
