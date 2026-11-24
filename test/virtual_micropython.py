"""Deterministic byte-level REPL fixture; never opens a physical port.

Only the scripted friendly/raw REPL subset is implemented, not a Python VM.
"""
import threading


class VirtualMicroPython:
    def __init__(self, window=8, read_limit=3):
        self.window = window
        self.read_limit = read_limit
        self.is_open = True
        self.mode = "friendly"
        self.running = False
        self.writes = []
        self.executed = []
        self._rx = bytearray()
        self._source = bytearray()
        self._credit = window
        self._lock = threading.RLock()

    @property
    def in_waiting(self):
        with self._lock:
            return min(len(self._rx), self.read_limit)

    def read(self, count):
        with self._lock:
            if not self.is_open:
                raise OSError("virtual port closed")
            count = min(count, self.read_limit)
            result = bytes(self._rx[:count])
            del self._rx[:count]
            return result

    def close(self):
        with self._lock:
            self.is_open = False

    def open(self):
        with self._lock:
            if self.is_open:
                raise OSError("virtual port already open")
            self.is_open = True

    def emit(self, data):
        with self._lock:
            if not self.running or not self.is_open:
                raise RuntimeError("no active virtual program")
            self._rx.extend(data)

    def write(self, data):
        with self._lock:
            if not self.is_open:
                raise OSError("virtual port closed")
            data = bytes(data)
            self.writes.append(data)
            if self.mode == "paste":
                if data == b"\x03\x04":
                    self._source.clear()
                    self.mode = "raw"
                    self._rx.extend(b"\x04SyntaxError\r\n\x04>")
                elif data == b"\x04":
                    source = bytes(self._source)
                    self.executed.append(source)
                    self.mode = "raw"
                    self._rx.extend(b"\x04")
                    if source == b"loop()":
                        self.running = True
                    else:
                        self._rx.extend(b"ready \xc3\xa9\r\n\x04\x04>")
                else:
                    if len(data) > self._credit:
                        raise AssertionError("host exceeded raw-paste credit")
                    self._source.extend(data)
                    self._credit -= len(data)
                    if self._credit == 0:
                        self._credit = self.window
                        self._rx.extend(b"\x01")
            elif data == b"\r\x01":
                self.mode = "raw"
                self._rx.extend(b"raw REPL; CTRL-B to exit\r\n>")
            elif data == b"\x05A\x01" and self.mode == "raw":
                self.mode = "paste"
                self._source.clear()
                self._credit = self.window
                self._rx.extend(b"R\x01" + self.window.to_bytes(2, "little"))
            elif data == b"\r\x02":
                self.mode = "friendly"
                self._rx.extend(b">>>")
            elif b"\x03" in data and self.running:
                self.running = False
                if self.mode == "raw":
                    self._rx.extend(b"\x04KeyboardInterrupt\r\n\x04>")
                else:
                    self._rx.extend(b"KeyboardInterrupt\r\n>>>")
            elif data == b"main.fxn()\r" and self.mode == "friendly":
                self.running = True
            elif data == b"\r" and self.mode == "friendly":
                self._rx.extend(b">>>")
            return len(data)
