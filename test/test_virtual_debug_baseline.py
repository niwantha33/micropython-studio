"""Scripted debug CDC peer exercising the real bridge command and RX loops."""
import json
import queue
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import test_debug_bridge_stream


def frame(kind, payload):
    return bytes([0xaa, kind, len(payload)]) + payload


class VirtualDebugCDC:
    def __init__(self):
        self.incoming = queue.Queue()
        self.writes = []
        self.closed = False
        self.flushed = False
        self.paused = False

    def open(self):
        pass

    def read(self, size):
        try:
            chunk = self.incoming.get(timeout=0.01)
        except queue.Empty:
            return b""
        if isinstance(chunk, Exception):
            raise chunk
        return chunk

    def emit(self, packet):
        for index in range(0, len(packet), 3):
            self.incoming.put(packet[index:index + 3])

    def write(self, packet):
        self.writes.append(packet)
        responses = {
            b"\xaa\x15\x0b\x04main\x03fxn\x09\x00":
                frame(3, b"bp 0 @ main.fxn:9 ip=8 fun=123"),
            b"\xaa\x10\x00": frame(2, b"\x08\x00\x7b\x00\x00\x00"),
            b"\xaa\x11\x00": frame(2, b"\x0a\x00\x7b\x00\x00\x00"),
            b"\xaa\x12\x00": frame(3, b"frame=(1,0,10,123) state=[17]"),
        }
        if packet in responses:
            self.emit(responses[packet])
        return len(packet)

    def flush(self):
        self.flushed = True

    def close(self):
        self.closed = True


class VirtualDebugBaselineTests(unittest.TestCase):
    def test_DBG_001_bridge_roundtrip(self):
        bridge = test_debug_bridge_stream.DebugBridgeOutputTests().load_bridge()
        port = VirtualDebugCDC()
        events = []
        condition = threading.Condition()

        def capture(**event):
            with condition:
                events.append(event)
                condition.notify_all()

        def commands():
            cases = [
                ({"op": "set_bp", "module": "main", "func": "fxn", "line": 9},
                 {"evt": "reply", "text": "bp 0 @ main.fxn:9 ip=8 fun=123"}),
                ({"op": "continue"}, {"evt": "bp_hit", "ip": 8, "fun": 123}),
                ({"op": "step"}, {"evt": "bp_hit", "ip": 10, "fun": 123}),
                ({"op": "locals"}, {"evt": "reply", "text": "frame=(1,0,10,123) state=[17]"}),
            ]
            for command, expected in cases:
                yield json.dumps(command)
                with condition:
                    self.assertTrue(condition.wait_for(lambda: expected in events, timeout=3),
                                    repr(events))
            yield '{"op":"quit"}'

        with patch.object(bridge.serial, "Serial", return_value=port, create=True), \
             patch.object(bridge, "say", side_effect=capture), \
             patch.object(sys, "argv", ["dbg_bridge.py", "VIRTUAL"]), \
             patch.object(sys, "stdin", commands()), \
             patch.object(bridge.os, "walk", return_value=[]):
            bridge.main()
        self.assertEqual(port.writes, [
            b"\xaa\x15\x0b\x04main\x03fxn\x09\x00",
            b"\xaa\x10\x00", b"\xaa\x11\x00", b"\xaa\x12\x00",
            b"\xaa\x1c\x00", b"\xaa\x1d\x00"])
        self.assertTrue(port.flushed and port.closed)
        self.assertEqual(events[-1], {"evt": "closed"})

    def test_DBG_002_read_loss_is_reported(self):
        bridge = test_debug_bridge_stream.DebugBridgeOutputTests().load_bridge()
        port = VirtualDebugCDC()
        port.emit(frame(2, b"\x08\x00"))
        port.incoming.put(OSError("virtual USB removed"))
        events = []
        stop = threading.Event()
        bridge.say = lambda **event: events.append(event)
        bridge.reader_loop(port, stop)
        self.assertTrue(stop.is_set())
        self.assertEqual(events[0], {"evt": "bp_hit", "ip": 8})
        self.assertEqual(events[1]["evt"], "transport_lost")
        self.assertIn("virtual USB removed", events[1]["msg"])

    def test_registry(self):
        registry = json.loads((Path(__file__).parent / "baselines" /
                               "debug.json").read_text(encoding="utf-8"))
        actual = {name for name in dir(type(self)) if name.startswith("test_DBG_")}
        self.assertEqual({entry["test"] for entry in registry["contracts"]}, actual)
        self.assertEqual(len(registry["contracts"]), len(actual))
