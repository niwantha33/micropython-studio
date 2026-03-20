#!/usr/bin/env python3
"""
serial_reader.py
UART debug monitor for MicroPython Studio.

Connects to a SEPARATE hardware UART port (e.g. COM8 via USB-UART adapter)
to read debug output sent from MCU UART1/UART2 — completely independent of
the mpremote USB REPL connection (COM7).

Fast read pattern (from rfc_server.py):
  ser.read(1)              — blocks until first byte of a burst arrives
  ser.read(ser.in_waiting) — drains all remaining bytes already in OS buffer
No readline() timeout → latency is ~1ms instead of up to 100ms.

Protocol (newline-delimited JSON over stdin/stdout):
  stdin commands:
    {"action":"connect",   "port":"COM8", "baud":115200}
    {"action":"disconnect"}
    {"action":"start_save","filename":"debug.log"}
    {"action":"stop_save"}
    {"action":"list_ports"}
  stdout events:
    {"status":"python_script_started"}
    {"ports":[{"path":"COM8","description":"...","manufacturer":"..."},...]}
    {"status":"connected","port":"COM8","baud":115200}
    {"status":"disconnected"}
    {"status":"saving_started","filename":"..."}
    {"status":"saving_stopped"}
    {"channel":"1","timestamp":...,"elapsed_ms":...,"data":"hello","raw":"[1] hello"}
    {"error":"..."}
"""

import json
import serial
import serial.tools.list_ports
import sys
import threading
import time


# ── helpers ───────────────────────────────────────────────────────────────────

def _send(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


# ── reader ────────────────────────────────────────────────────────────────────

class SerialReader:
    def __init__(self) -> None:
        self._conn: 'serial.Serial | None' = None
        self._thread: 'threading.Thread | None' = None
        self._running = False
        self.port: 'str | None' = None
        self._start_time: float = 0.0
        self._save_file = None
        self._saving = False

    # ── port listing ──────────────────────────────────────────────────────────

    def list_ports(self) -> None:
        try:
            result = []
            for p in serial.tools.list_ports.comports():
                info = {
                    'path': p.device,
                    'manufacturer': p.manufacturer or 'Unknown',
                    'description': p.description or '',
                    'hwid': p.hwid or '',
                }
                if hasattr(p, 'product'):
                    info['product'] = p.product or ''
                if hasattr(p, 'serial_number'):
                    info['serial_number'] = p.serial_number or ''
                result.append(info)
            _send({'ports': result})
        except Exception as e:
            _send({'error': f'list_ports failed: {e}'})

    # ── connect ───────────────────────────────────────────────────────────────

    def connect(self, port: str, baud: int = 115200) -> bool:
        try:
            self._conn = serial.Serial(
                port=port,
                baudrate=baud,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=None,       # blocking read — no timeout delay
                write_timeout=1.0,
            )
            if not self._conn.is_open:
                raise serial.SerialException('Port opened but not accessible')
        except serial.SerialException as e:
            _send({'error': f'Serial connection failed: {e}'})
            return False
        except Exception as e:
            _send({'error': f'Connection error: {e}'})
            return False

        self.port = port
        self._running = True
        self._start_time = time.time()
        _send({'status': 'connected', 'port': port, 'baud': baud})

        self._thread = threading.Thread(target=self._read_loop, daemon=True)
        self._thread.start()
        return True

    # ── read loop ─────────────────────────────────────────────────────────────

    def _read_loop(self) -> None:
        """
        Fast read loop — same pattern as rfc_server.py:
          ser.read(1)               blocks until the first byte of a burst arrives
          ser.read(ser.in_waiting)  drains everything already in the OS buffer

        This gives ~1 ms latency vs up to 100 ms with readline(timeout=0.1).
        No sleep() needed — the blocking read(1) keeps CPU at 0 % while idle.
        """
        buf = b''
        conn = self._conn

        while self._running:
            try:
                # Wait for the start of a new burst
                byte = conn.read(1)
                if not byte:
                    continue

                # Grab everything else already buffered
                waiting = conn.in_waiting
                burst = byte + (conn.read(waiting) if waiting else b'')
                buf += burst

                # Process every complete line
                while b'\n' in buf:
                    line_bytes, buf = buf.split(b'\n', 1)
                    line = line_bytes.decode('utf-8', errors='ignore').rstrip('\r')
                    if line:
                        self._process_line(line)

            except serial.SerialException as e:
                _send({'error': f'Read error: {e}'})
                break
            except Exception as e:
                _send({'error': f'Unexpected read error: {e}'})
                break

        # Flush any leftover bytes without a trailing newline
        if buf:
            line = buf.decode('utf-8', errors='ignore').strip()
            if line:
                self._process_line(line)

        if self._running:
            _send({'status': 'disconnected', 'reason': 'port closed'})
            self._running = False

    def _process_line(self, decoded: str) -> None:
        elapsed_ms = int((time.time() - self._start_time) * 1000)

        # Expected format: "[channel] message"  e.g. "[1] sensor=23.4"
        if decoded.startswith('[') and ']' in decoded:
            end = decoded.find(']')
            ch = decoded[1:end]
            message = decoded[end + 1:].strip()
        else:
            ch = 'raw'
            message = decoded

        result = {
            'channel':    ch,
            'timestamp':  int(self._start_time * 1000),
            'elapsed_ms': elapsed_ms,
            'data':       message,
            'raw':        decoded,
        }

        if self._saving and self._save_file:
            try:
                self._save_file.write(
                    f"{ch} {int(self._start_time * 1000)} {elapsed_ms} {message}\n"
                )
            except Exception:
                pass

        _send(result)

    # ── disconnect ────────────────────────────────────────────────────────────

    def disconnect(self) -> None:
        self._running = False
        self.stop_saving()
        if self._conn:
            try:
                self._conn.close()
            except Exception:
                pass
            self._conn = None
        _send({'status': 'disconnected'})

    # ── save ──────────────────────────────────────────────────────────────────

    def start_saving(self, filename: str) -> None:
        try:
            self._save_file = open(filename, 'w', buffering=1)
            self._saving = True
            _send({'status': 'saving_started', 'filename': filename})
        except Exception as e:
            _send({'error': f'start_save failed: {e}'})

    def stop_saving(self) -> None:
        self._saving = False
        if self._save_file:
            try:
                self._save_file.close()
            except Exception:
                pass
            self._save_file = None
        _send({'status': 'saving_stopped'})


# ── main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    reader = SerialReader()
    _send({'status': 'python_script_started'})

    try:
        while True:
            line = sys.stdin.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                cmd = json.loads(line)
            except json.JSONDecodeError:
                _send({'error': 'Invalid JSON command'})
                continue

            action = cmd.get('action')

            if action == 'list_ports':
                reader.list_ports()

            elif action == 'connect':
                port = cmd.get('port', '')
                baud = int(cmd.get('baud', 115200))
                if port:
                    reader.connect(port, baud)
                else:
                    _send({'error': 'connect: missing port'})

            elif action == 'disconnect':
                reader.disconnect()
                break

            elif action == 'start_save':
                reader.start_saving(cmd.get('filename', 'debug.log'))

            elif action == 'stop_save':
                reader.stop_saving()

            else:
                _send({'error': f'Unknown action: {action}'})

    except KeyboardInterrupt:
        pass
    finally:
        reader.disconnect()


if __name__ == '__main__':
    main()
