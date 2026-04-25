# mps_backend.py
import argparse
import re
import os
import subprocess
import sys
import struct
import time
from pathlib import Path
from typing import Any, Union
import tempfile
import threading
import json
import urllib.request

from ollama_helper import OllamaHelper
# ---------------------------------------------------------------------------
# UI Helpers for Professional Terminal Output
# ---------------------------------------------------------------------------

CLR_RESET = "\033[0m"
CLR_CYAN = "\033[36m"
CLR_YELLOW = "\033[33m"
CLR_GREEN = "\033[32m"
CLR_BLUE = "\033[34m"
CLR_MAGENTA = "\033[35m"
CLR_WHITE = "\033[37m"
CLR_DIM = "\033[2m"
CLR_BOLD = "\033[1m"

# Regular expression to strip ANSI escape sequences (including OSC/status bar noise)
ANSI_STRIP_RE = re.compile(
    rb'(?:\x1b\]0;.*?\x1b\\|\x1b\[[0-9;?]*[A-Za-z])', re.DOTALL)


BOX_WIDTH = 71  # Adjust as needed, must be odd for symmetry

ANSI_RE = re.compile(r'\x1b\[[^a-zA-Z]*[a-zA-Z]|\x1b\][^\x1b]*\x1b\\')



def _is_pid_running(pid: int) -> bool:
    """Check if a process ID is still active on the host system."""
    if pid <= 0: return False
    try:
        if os.name == 'nt':
            # Windows: use tasklist or OpenProcess
            import ctypes
            PROCESS_QUERY_INFORMATION = 0x0400
            process_handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_INFORMATION, False, pid)
            if process_handle:
                ctypes.windll.kernel32.CloseHandle(process_handle)
                return True
            return False
        else:
            # Unix/macOS: use kill(0)
            os.kill(pid, 0)
            return True
    except (OSError, AttributeError):
        return False


def parse_mpremote_output(raw: str) -> dict:
    """Extract TransportError and device output from mpremote failure."""
    result: dict[str, Any] = {"error": None, "device_output": None}

    # 1. Capture the TransportError line
    for line in raw.splitlines():
        if "TransportError" in line:
            result["error"] = line.strip()
            break

    # 2. Extract the raw bytes string (b'...' at the end)
    match = re.search(r"b'(.+)'", raw, re.DOTALL)
    if match:
        raw_bytes = match.group(1)
        # Unescape: \r\n → newline, \x1b sequences → strip
        decoded = raw_bytes.encode(
            'utf-8').decode('unicode_escape', errors='replace')
        cleaned = ANSI_RE.sub('', decoded)
        # Remove blank lines and >>> prompts
        lines = []
        for line in cleaned.splitlines():
            stripped = line.strip()
            if not stripped or stripped == '>>>':
                continue
            lines.append(stripped)
        result["device_output"] = "\n".join(lines)

    return result


def clean_output(raw: str) -> str:
    """Strip ANSI escapes and filter noisy mpremote lines."""
    lines = []
    for line in raw.splitlines():
        line = ANSI_RE.sub('', line)
        # Skip empty lines and noise
        if not line.strip():
            continue
        if "is mounted at /remote" in line or "Connected to " in line:
            continue
        lines.append(line)
    return "\n".join(lines)


def print_execution_header(folder_name, port, file_name):
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    lines = [
        f"Project: {folder_name}",
        f"Port:    {port}",
        f"Running: {file_name}",
        f"Started: {timestamp}"
    ]
    title = "MicroPython Studio Execution Session"
    max_len = max(len(title), max(len(line) for line in lines))
    extra_padding = 4
    content_width = max_len + extra_padding
    box_width = content_width + 4

    # Use ASCII for maximum compatibility on Windows
    def _write_ui(msg):
        sys.stderr.write(msg + "\n")

    _write_ui(f"{CLR_CYAN}+{'-' * (box_width - 2)}+{CLR_RESET}")
    _write_ui(f"{CLR_CYAN}|{CLR_RESET} {title:<{content_width}} {CLR_CYAN}|{CLR_RESET}")
    _write_ui(f"{CLR_CYAN}+{'-' * (box_width - 2)}+{CLR_RESET}")
    for line in lines:
        _write_ui(f"{CLR_CYAN}|{CLR_RESET} {line:<{content_width}} {CLR_CYAN}|{CLR_RESET}")
    _write_ui(f"{CLR_CYAN}+{'-' * (box_width - 2)}+{CLR_RESET}\n")

# Usage example:
# print_execution_header("MyProject", "COM3", "main.py")


# ---------------------------------------------------------------------------
# Device-side Recursive Directory Helper
# ---------------------------------------------------------------------------

def _mkdir_p_code(remote_dir: str) -> str:
    """Generate MicroPython code for recursive directory creation (mkdir -p)."""
    return f"""
import os
def _mkdir_p(p):
    parts = p.strip('/').split('/')
    acc = ''
    for part in parts:
        acc += '/' + part
        try: os.mkdir(acc)
        except: pass
_mkdir_p({remote_dir!r})
"""

# ----------------------------
# Command: mkdir
# ----------------------------

def cmd_mkdir(python_exe: str, port: str, path: str):
    """Create a directory on the device recursively (mkdir -p)."""
    conn = SerialConnection(port)
    try:
        conn.connect()
        # Use recursive logic
        code = _mkdir_p_code(path)
        conn.exec_code(code, stream_stdout=False)
        sys.exit(0)
    except Exception as e:
        sys.stderr.write(f"   Failed to create directory: {e}\n")
        sys.exit(1)
    finally:
        conn.close()

# ----------------------------
# Command: rename
# ----------------------------

def cmd_rename(python_exe: str, port: str, src: str, dest: str):
    """Rename a file or directory on the device."""
    conn = SerialConnection(port)
    try:
        conn.connect()
        code = f"import os\nos.rename({src!r}, {dest!r})"
        conn.exec_code(code, stream_stdout=False)
        sys.exit(0)
    except Exception as e:
        sys.stderr.write(f"   Failed to rename: {e}\n")
        sys.exit(1)
    finally:
        conn.close()


def _strip_ansi(data: bytes) -> bytes:
    """Helper to strip terminal escape sequences from the serial buffer."""
    return ANSI_STRIP_RE.sub(b'', data)


def _write_bytes_stdout(data: bytes):
    """Write bytes to stdout (used for data and streaming output)."""
    try:
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    except (AttributeError, io.UnsupportedOperation):
        # Fallback for environments where buffer is not available
        try:
            sys.stdout.write(data.decode('utf-8', errors='replace'))
            sys.stdout.flush()
        except:
            pass


def _print_ui_header(port, folder, file_path):
    """Prints a professional UI header for the execution session."""
    file_name = Path(file_path).name
    folder_name = Path(folder).name if folder else "Device Filesystem"

    # Modern Box Drawing UI
    print_execution_header(folder_name, port, file_name)


# Files/folders to avoid downloading from device to local project
DOWNLOAD_EXCLUDE = {
    'settings.toml',             # CircuitPython/MicroPython credentials
    'boot_out.txt',              # CircuitPython auto-generated
    '.Trashes',                  # macOS
    '.fseventsd',                # macOS
    '.Spotlight-V100',           # macOS
    '.metadata_never_index',     # macOS
    'System Volume Information',  # Windows
    '$RECYCLE.BIN',              # Windows
    '.mcu',                      # Extension-internal metadata
}


# ---------------------------------------------------------------------------
# WebREPL transport
# mpremote 1.27.0 has no ws: support (transport_ws.py doesn't exist).
# We use the websocket-client library for the WebSocket layer and implement
# MicroPython's raw-REPL protocol on top of it.
# ---------------------------------------------------------------------------

class WebReplConnection:
    """
    WebREPL transport using websocket-client for the WS layer.
    Handles authentication, raw-REPL code execution, and file upload.
    """
    CHUNK = 256  # raw-REPL / file-transfer chunk size (small for ESP buffer safety)

    def __init__(self, host: str, password: str, port: int = 8266) -> None:
        self.host = host
        self.password = password
        self.port = port
        self.ws: 'Any' = None  # assigned in connect() via websocket-client

    # ── WebSocket helpers ────────────────────────────────────────────────────

    def _ws_send(self, data: 'str | bytes') -> None:
        # WebREPL REPL input must be a WebSocket TEXT frame.
        # Binary frames (send_binary) are reserved for the file-transfer protocol.
        if isinstance(data, bytes):
            # latin-1 preserves raw byte values as-is
            data = data.decode('latin-1')
        self.ws.send(data)  # TEXT frame

    def _ws_recv(self, timeout: float = 5) -> bytes:
        import websocket as _wslib  # type: ignore[import]
        self.ws.settimeout(timeout)
        try:
            data = self.ws.recv()
            if data is None:
                return b''
            if isinstance(data, str):
                return data.encode('utf-8')
            return data
        except _wslib.WebSocketTimeoutException:
            return b''
        except Exception:
            return b''

    def _ws_recv_exact(self, size: int, timeout: float = 10) -> bytes:
        """Receive exactly 'size' bytes or timeout."""
        buf = bytearray()
        deadline = time.time() + timeout
        while len(buf) < size and time.time() < deadline:
            chunk = self._ws_recv(deadline - time.time())
            if not chunk:
                break
            buf.extend(chunk)
        return bytes(buf)

    # ── Connect and authenticate ─────────────────────────────────────────────

    def connect(self):
        import websocket as _wslib  # type: ignore[import]
        url = f'ws://{self.host}:{self.port}'
        self.ws = _wslib.create_connection(url, timeout=25)

        # Read password prompt — comes as a WebSocket TEXT frame
        prompt = self._ws_recv(8)
        if b'Password' not in prompt:
            raise ConnectionError(f'Expected password prompt, got: {prompt!r}')

        # Authenticate
        self._ws_send(self.password + '\r\n')
        time.sleep(0.3)
        resp = self._ws_recv(5)
        if b'connected' not in resp:
            raise ConnectionError(
                f'WebREPL authentication failed. Check password. Got: {resp!r}')

    def close(self):
        try:
            if hasattr(self, 'ws') and self.ws:
                self.ws.close()
        except Exception:
            pass

    # ── Raw REPL helpers ─────────────────────────────────────────────────────

    def _enter_raw_repl(self) -> None:
        """Interrupt running code and enter raw REPL mode."""
        self._ws_send('\r\x03\x03')  # Ctrl+C x2 — stop any running code
        time.sleep(0.3)
        self._drain()
        self._ws_send('\x01')        # Ctrl+A — enter raw REPL
        time.sleep(0.4)
        self._drain()                # consume 'raw REPL; CTRL-B to exit\r\n>'

    def _exit_raw_repl(self) -> None:
        self._ws_send('\x02')        # Ctrl+B — back to friendly REPL
        time.sleep(0.2)
        self._drain()

    def _drain(self) -> None:
        """Consume all pending WebSocket frames (discard)."""
        while self._ws_recv(0.3):
            pass

    def exec_code(self, code: 'Union[str, bytes]', timeout: float = 30, stream_stdout: bool = True) -> tuple:
        """
        Execute code via raw REPL. Returns (rc, stdout_bytes, stderr_bytes).
        Raw REPL response format after Ctrl+D:  OK<stdout>\x04<stderr>\x04>
        Returns 0 on success, 1 if there was stderr output.
        """
        code_buf = code.encode() if isinstance(code, str) else code
        self._enter_raw_repl()

        # Send code in chunks
        offset = 0
        while offset < len(code_buf):
            self._ws_send(code_buf[offset:offset + self.CHUNK])
            offset += self.CHUNK
            time.sleep(0.001)

        self._ws_send('\x04')  # Ctrl+D to execute

        # Accumulate response until we see the end marker \x04>
        buf = bytearray()
        deadline = time.time() + timeout
        while time.time() < deadline:
            chunk = self._ws_recv(1)
            if chunk:
                buf.extend(chunk)
                if buf.endswith(b'\x04>'):
                    break
            else:
                time.sleep(0.01)

        self._exit_raw_repl()

        # Parse:  OK<stdout>\x04<stderr>\x04>
        raw = bytes(buf)
        if raw.startswith(b'OK'):
            raw = raw[2:]

        parts = bytes(raw).split(b'\x04')
        stdout_data = parts[0] if len(parts) > 0 else b''
        stderr_data = parts[1].strip(b'>').strip() if len(parts) > 1 else b''

        if stdout_data and stream_stdout:
            _write_bytes_stdout(stdout_data)

        if stderr_data:
            sys.stderr.write(stderr_data.decode('utf-8', errors='replace'))
            return 1, stdout_data, stderr_data
        return 0, stdout_data, stderr_data

    def run_file(self, file_path):
        """Read a local .py file and execute it on the device via raw REPL."""
        code = Path(file_path).read_bytes()
        return self.exec_code(code)

    def upload_file(self, local_path, remote_path):
        """Upload a file using the WebREPL binary protocol (fastest)."""
        return self._ws_put_file(Path(local_path), remote_path)

    def _ws_put_file(self, source: Path, remote: str) -> int:
        """Upload using the official MicroPython WebREPL binary protocol.

        Header format (82 bytes total):  struct '<2sBBQLH64s'
          2s  = b'WA'           (magic)
          B   = 1 (PUT_FILE)    (command)
          B   = 0               (reserved)
          Q   = 0               (reserved / unused timestamp)
          L   = file size       (4 bytes, little-endian)
          H   = filename length (2 bytes)
          64s = filename        (padded with NULs)
        """
        data = source.read_bytes()
        dest = remote.lstrip('/')
        dest_bytes = dest.encode('utf-8')[:64]  # clamp to 64 bytes max

        # Build the 82-byte header exactly as webrepl_cli.py does
        header = struct.pack(
            '<2sBBQLH64s',
            b'WA',           # magic
            1,               # PUT_FILE command
            0,               # reserved
            0,               # reserved (Q = 8 bytes)
            len(data),       # file size
            len(dest_bytes),  # filename length
            dest_bytes,      # filename (zero-padded to 64 bytes)
        )
        self.ws.send_binary(header)

        # Device responds with b'WB' + 2-byte status (0 = OK)
        resp = self._ws_recv_exact(4, timeout=10)
        if not resp.startswith(b'WB') or struct.unpack('<H', resp[2:4])[0] != 0:
            # Fall back to raw-REPL hex method if binary protocol fails
            return _ws_upload_file_legacy(self, source, remote)

        # Send file data in small chunks with inter-chunk delay to avoid
        # overwhelming the ESP's tiny receive buffer (ECONNRESET / WinError 10054).
        offset = 0
        while offset < len(data):
            chunk = data[offset:offset + self.CHUNK]
            self.ws.send_binary(chunk)
            offset += len(chunk)
            # 30 ms — gives the device time to drain its buffer
            time.sleep(0.03)

        # Final response
        resp = self._ws_recv_exact(4, timeout=10)
        if resp.startswith(b'WB') and struct.unpack('<H', resp[2:4])[0] == 0:
            return 0
        return 1


# ---------------------------------------------------------------------------
# Serial transport (robust fallback for mpremote)
# ---------------------------------------------------------------------------

class SerialConnection:
    """
    Direct serial transport using pyserial.
    Provides a more robust 'enter_raw_repl' than mpremote in some cases.
    """

    def __init__(self, port, baudrate=115200, debug=False):
        self.port = port
        self.baudrate = baudrate
        self.serial = None
        self.debug = debug
        self.lock_path = None
        self.dtr_active = False # Track if DTR was enabled during handshake

    @property
    def in_waiting_safe(self) -> int:
        """Safely check for pending bytes, handling driver errors on Windows (Dual-CDC)."""
        if not self.serial:
            return 0
        try:
            return self.serial.in_waiting
        except Exception:
            # On some Windows drivers (like secondary CDC interfaces), ClearCommError fails.
            # We return 0 and rely on read() timeouts.
            return 0

    def connect(self):
        import serial
        import time
        import os
        import tempfile
        
        # ── Global File Lock ─────────────────────────────────────────────────
        lock_name = f"mps_lock_{self.port.replace('/', '_').replace('\\', '_').replace(':', '_')}.lock"
        self.lock_path = os.path.join(tempfile.gettempdir(), lock_name)
        
        deadline = time.time() + 5.0
        while time.time() < deadline:
            try:
                # Exclusive creation as lock
                fd = os.open(self.lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, str(os.getpid()).encode())
                os.close(fd)
                break
            except FileExistsError:
                # Check for stale lock
                try:
                    with open(self.lock_path, 'r') as f:
                        old_pid = int(f.read().strip())
                    if not _is_pid_running(old_pid):
                        try: os.remove(self.lock_path)
                        except: pass
                except: pass
                
                if time.time() % 1.0 < 0.1: # Throttle message
                    sys.stderr.write(f"{CLR_DIM} [LOCK] Waiting for port {self.port} to be released...{CLR_RESET}\r")
                time.sleep(0.2)
        
        # ── Serial Connection ────────────────────────────────────────────────
        last_err = None
        for attempt in range(15):
            try:
                if self.debug: sys.stderr.write(f"{CLR_DIM}[DEBUG] Opening {self.port} (Attempt {attempt})...{CLR_RESET}\n")
                
                # Adaptive DTR Strategy:
                # Start with DTR=False (safer for MicroPython/ESP32 reboots)
                self.serial = serial.Serial(
                    port=self.port,
                    baudrate=self.baudrate,
                    timeout=1.5,
                    write_timeout=2.0,
                    dsrdtr=False,
                    rtscts=False,
                    exclusive=True
                )
                self.serial.dtr = False
                self.serial.rts = False
                return # Success!
            except serial.SerialException as e:
                last_err = e
                if "Access is denied" in str(e) or "PermissionError" in str(e):
                    if attempt < 14:
                        time.sleep(0.5)
                        continue
                raise Exception(f"Port {self.port} is BUSY. Please close any other terminal (like the shell) and try again.")
            except Exception as e:
                raise Exception(f"Serial connection error on {self.port}: {e}")
        
        if last_err:
            raise Exception(f"Could not open port {self.port} after 15 attempts: {last_err}")

    def close(self):
        if self.serial:
            self.serial.close()
        # Release the global lock
        if hasattr(self, 'lock_path'):
            try:
                import os
                if os.path.exists(self.lock_path):
                    os.remove(self.lock_path)
            except:
                pass

    def _drain(self):
        """Consume all pending bytes aggressively."""
        deadline = time.time() + 0.5
        while time.time() < deadline:
            wait = self.in_waiting_safe
            if wait > 0:
                self.serial.read(wait)
                deadline = time.time() + 0.2  # Keep draining if data is flowing
            else:
                time.sleep(0.05)
                # If we've had no data for 0.1s, we're likely done
                if time.time() > (deadline - 0.3):
                    break

    def enter_raw_repl(self, soft_reset=True):
        """Aggressively enter raw REPL mode with firmware-aware synchronization."""
        # 1. Break any running code with multiple interrupts
        self.serial.write(b'\r\x03\x03')
        time.sleep(0.3) 

        if soft_reset:
            # 2. Trigger soft reboot
            self.serial.write(b'\x04')

            # 3. Wait for the reboot confirmation
            deadline = time.time() + 6.0
            rebooted = False
            data = b''
            while time.time() < deadline:
                wait = self.in_waiting_safe
                if wait > 0:
                    data += self.serial.read(wait)
                    clean_data = _strip_ansi(data)
                    if b'soft reboot' in clean_data or b'MPY: soft reboot' in clean_data or b'CircuitPython' in clean_data:
                        rebooted = True
                        break
                else:
                    time.sleep(0.1)

            if not rebooted:
                time.sleep(0.3)

            # 4. Break again to catch the board before main.py takes over
            self.serial.write(b'\r\x03\x03')

        self._drain()

        # 5. Enter raw REPL mode (Ctrl-A)
        # Attempt 0: Standard Fast Sync (MicroPython preferred, DTR=False)
        # Attempt 1-2: Deep Sync Fallback (CircuitPython/RP2350 preferred, DTR=True)
        has_seen_data = False
        for attempt in range(3):
            if attempt > 0:
                # 💡 Adaptive DTR: If we haven't seen any data yet, the board 
                # might be an RP2350/Pico 2 that requires DTR to be High.
                if not has_seen_data and self.serial:
                    if self.debug: sys.stderr.write(f"{CLR_DIM}[DEBUG] No response seen. Enabling DTR...{CLR_RESET}\n")
                    self.serial.dtr = True
                    self.dtr_active = True
                
                # Deep Sync Kick: extra interrupts for stubborn boards
                if self.debug: sys.stderr.write(f"{CLR_DIM}[DEBUG] Sync Attempt {attempt}...{CLR_RESET}\n")
                self._write_trace(b'\r\x03\x03\x03\x03\x03')
                time.sleep(0.5)
                self._drain()
            
            self._write_trace(b'\x01')
            time.sleep(0.5 if attempt == 0 else 0.8)

            # 6. Read until we see the prompt '>'
            data = b''
            deadline = time.time() + (3.0 if attempt == 0 else 6.0)
            while time.time() < deadline:
                wait = self.in_waiting_safe
                if wait > 0:
                    has_seen_data = True
                    chunk = self.serial.read(wait)
                    if self.debug: sys.stderr.write(f"{CLR_DIM}[RECV] {chunk!r}{CLR_RESET}\n")
                    data += chunk
                    if b'>' in _strip_ansi(data):
                        return True
                else:
                    time.sleep(0.1)
        
        return False

    def _write_trace(self, data):
        """Helper to write data and log it if debug is enabled."""
        if self.debug:
            sys.stderr.write(f"{CLR_DIM}[SENT] {data!r}{CLR_RESET}\n")
        self.serial.write(data)

    def _send_code_raw_paste(self, code_buf: bytes) -> bool:
        """Send code via raw-paste mode (Ctrl-E variant) with proper flow control.
        Returns True on success, False if device rejected raw-paste (caller falls back).
        This is the same protocol mpremote uses; it prevents RX buffer overrun on
        large transfers by waiting for the device to ack each window."""
        # Initiate raw-paste
        self.serial.write(b'\x05A\x01')
        # Read 2-byte response: 'R\x01' means OK, 'R\x00' means not supported
        deadline = time.time() + 2
        resp = bytearray()
        while len(resp) < 2 and time.time() < deadline:
            n = self.in_waiting_safe
            if n:
                resp.extend(self.serial.read(min(n, 2 - len(resp))))
            else:
                time.sleep(0.005)
        if len(resp) < 2 or resp[0:1] != b'R' or resp[1:2] != b'\x01':
            return False
        # Read window-size: 2 bytes little-endian
        deadline = time.time() + 2
        ws_bytes = bytearray()
        while len(ws_bytes) < 2 and time.time() < deadline:
            n = self.in_waiting_safe
            if n:
                ws_bytes.extend(self.serial.read(min(n, 2 - len(ws_bytes))))
            else:
                time.sleep(0.005)
        if len(ws_bytes) < 2:
            return False
        window = ws_bytes[0] | (ws_bytes[1] << 8)
        window_remain = window
        # Stream code, refilling window as device acks (\x01) or aborts (\x04)
        i = 0
        while i < len(code_buf):
            # First drain any control bytes
            while self.in_waiting_safe:
                b = self.serial.read(1)
                if b == b'\x01':
                    window_remain += window
                elif b == b'\x04':
                    # Device aborted
                    self.serial.write(b'\x04')
                    return False
            if window_remain == 0:
                # wait for ack
                b = self.serial.read(1)
                if b == b'\x01':
                    window_remain += window
                elif b == b'\x04':
                    self.serial.write(b'\x04')
                    return False
                continue
            n = min(window_remain, len(code_buf) - i, 256)
            self.serial.write(code_buf[i:i+n])
            i += n
            window_remain -= n
        # Signal end-of-data; outer state machine will read the response.
        self.serial.write(b'\x04')
        return True

    def _exec_raw_no_exit(self, code: Union[str, bytes], timeout=30, stream_stdout=True):
        """Execute code on device and return (rc, stdout_bytes, stderr_bytes), but STAY in raw REPL mode."""
        self._drain()
        code_buf = code.encode() if isinstance(code, str) else code

        # Use raw-paste mode (proper flow control) ONLY for large payloads
        # where the slow chunked path would overflow the device RX buffer.
        # Small commands (ls, file ops) use the safer original path.
        used_paste = False
        if len(code_buf) > 4096:
            used_paste = self._send_code_raw_paste(code_buf)
        if not used_paste:
            chunk_size = 128
            for i in range(0, len(code_buf), chunk_size):
                self.serial.write(code_buf[i:i+chunk_size])
                time.sleep(0.02)
            self.serial.write(b'\x04')

        # In raw-paste mode the device skips the leading "OK" — output goes
        # straight to stdout, then \x04 stderr \x04 >. Pre-seed the state
        # machine past the OK-search if we used raw-paste.
        _start_state = 1 if used_paste else 0

        # Read: OK<stdout>\x04<stderr>\x04>
        # We use a state machine to parse the response as it arrives
        # States: 0=wait OK, 1=wait stdout \x04, 2=wait stderr \x04, 3=wait >
        state = _start_state
        stdout_buf = bytearray()
        stderr_buf = bytearray()
        
        deadline = time.time() + timeout
        buf = bytearray()
        
        while state < 4 and time.time() < deadline:
            wait = self.in_waiting_safe
            if wait > 0:
                chunk = self.serial.read(wait)
            else:
                chunk = self.serial.read(1)
            
            if not chunk:
                time.sleep(0.01)
                continue
                
            buf.extend(chunk)
            
            while len(buf) > 0:
                if state == 0: # Wait for 'OK'
                    idx = buf.find(b'OK')
                    if idx >= 0:
                        # Found OK, discard it and anything before it
                        buf = buf[idx+2:]
                        state = 1
                    else:
                        # Keep only the last byte to check for 'OK' across chunks
                        if len(buf) > 1:
                            buf = buf[-1:]
                        break # Need more data
                
                elif state == 1: # Wait for stdout \x04
                    idx = buf.find(b'\x04')
                    if idx >= 0:
                        out = buf[:idx]
                        stdout_buf.extend(out)
                        if stream_stdout:
                            _write_bytes_stdout(out)
                        buf = buf[idx+1:]
                        state = 2
                    else:
                        # Stream everything we have so far
                        stdout_buf.extend(buf)
                        if stream_stdout:
                            _write_bytes_stdout(buf)
                        buf = bytearray()
                        break
                
                elif state == 2: # Wait for stderr \x04
                    idx = buf.find(b'\x04')
                    if idx >= 0:
                        err = buf[:idx]
                        stderr_buf.extend(err)
                        if err:
                            sys.stderr.write(err.decode('utf-8', errors='replace'))
                        buf = buf[idx+1:]
                        state = 3
                    else:
                        # Accumulate stderr
                        stderr_buf.extend(buf)
                        # We don't stream stderr in real-time to avoid intermingling?
                        # Actually, better to stream it.
                        sys.stderr.write(buf.decode('utf-8', errors='replace'))
                        buf = bytearray()
                        break
                
                elif state == 3: # Wait for '>'
                    idx = buf.find(b'>')
                    if idx >= 0:
                        buf = buf[idx+1:]
                        state = 4
                    else:
                        # Just wait
                        break
        
        return (0 if not stderr_buf else 1), bytes(stdout_buf), bytes(stderr_buf)

    def exec_code(self, code: Union[str, bytes], timeout=30, soft_reset=False, stream_stdout=True):
        """Execute code on device and return (rc, stdout_bytes, stderr_bytes)."""
        if soft_reset:
            if not self.enter_raw_repl(soft_reset=True):
                raise Exception("Could not enter raw REPL via soft reset")
        else:
            if not self.enter_raw_repl(soft_reset=False):
                # 💡 Fallback: Wait a bit and try with soft reset. 
                # This helps if the board is stuck in an auto-reload loop.
                time.sleep(1.0)
                if not self.enter_raw_repl(soft_reset=True):
                    raise Exception("Could not enter raw REPL via serial")

        try:
            rc, stdout, stderr = self._exec_raw_no_exit(code, timeout, stream_stdout=stream_stdout)
            # Output is already streamed by _exec_raw_no_exit
            return rc, stdout, stderr
        finally:
            # Exit raw REPL
            self.serial.write(b'\x02')  # Ctrl-B

    def list_files(self, path='/'):
        """Fetch directory listing efficiently via a single raw REPL call (no JSON dependency)."""
        code = f"""
import os
def l():
    try:
        for f in os.ilistdir({path!r}):
            is_dir = (f[1] == 0x4000)
            print('{{}}|{{}}|{{}}'.format(f[0], is_dir, f[3] if len(f)>3 else 0))
    except: pass
l()
"""
        return self.exec_code(code, stream_stdout=False)

    def put_file(self, source_path: Path, remote_path: str):
        """Upload a file using hex-encoding chunk by chunk (optimized persistent session)."""
        import binascii
        data = source_path.read_bytes()
        dest = remote_path.replace('\\', '/')

        # 1. Enter raw REPL once for the entire file transfer
        if not self.enter_raw_repl(soft_reset=False):
            if not self.enter_raw_repl(soft_reset=True):
                raise Exception(f"Could not enter raw REPL for {dest}")

        try:
            # 1. Ensure parent directory exists
            parent_dir = str(Path(dest).parent).replace('\\', '/')
            if parent_dir != '/':
                self._exec_raw_no_exit(_mkdir_p_code(parent_dir))

            # Strategy A: one-shot for ALL sizes (chunked path had a corruption
            # bug where chunk-write echoes occasionally interleaved into the
            # file content). Slower for very large files but reliable.
            if True or len(data) <= 512:
                hex_str = binascii.hexlify(data).decode()
                one_shot_code = (
                    f"import binascii, os, time\n"
                    f"try: os.remove({dest!r})\n"
                    f"except: pass\n"
                    f"time.sleep(0.01)\n"
                    f"try:\n"
                    f" _f=open({dest!r},'wb')\n"
                    f" _f.write(binascii.unhexlify({hex_str!r}))\n"
                    f" _f.close()\n"
                    f"except Exception as e: print('FAIL:', e)"
                )
                rc, stdout, _ = self._exec_raw_no_exit(one_shot_code)
                if b'FAIL:' in stdout: return 1
                return rc

            # Initial cleanup and open
            setup_code = (
                f"import binascii, os, time\n"
                f"try: os.remove({dest!r})\n"
                f"except: pass\n"
                f"time.sleep(0.01)\n"
                f"_f=open({dest!r},'wb')"
            )
            rc, _, _ = self._exec_raw_no_exit(setup_code)
            if rc != 0:
                sys.stderr.write(f"   [ERROR] Failed to open {dest} for writing. Aborting.\n")
                return 1

            chunk_size = 1024  # 512 bytes of binary
            hex_data = binascii.hexlify(data).decode()
            total_chunks = (len(hex_data) + chunk_size - 1) // chunk_size
            
            for i in range(total_chunks):
                chunk = hex_data[i*chunk_size : (i+1)*chunk_size]
                # Robust check: only write if handle _f exists
                chunk_code = f"if '_f' in globals(): _f.write(binascii.unhexlify({chunk!r}))"
                self._exec_raw_no_exit(chunk_code)
                
                # Progress bar for files > 10KB
                if len(data) > 10240 and i % 5 == 0:
                    percent = int((i+1) / total_chunks * 100)
                    bar = ('#' * (percent // 10)).ljust(10, '.')
                    sys.stderr.write(f"\r   [{bar}] {percent}% - {source_path.name}")
                    sys.stderr.flush()

            # Finalize
            self._exec_raw_no_exit("if '_f' in globals(): _f.close()")
            sys.stderr.write(f"\n   Upload of {source_path.name} finalized.\n")
            return 0
        finally:
            self.serial.write(b'\x02')  # Exit raw REPL

    def put_directory(self, source_dir: Path, remote_dir: str):
        """Recursively upload a directory to the device."""
        remote_dir = remote_dir.replace('\\', '/').rstrip('/')
        files = sorted(f for f in source_dir.rglob('*') if f.is_file())
        sys.stderr.write(f"DEBUG: Scanning {source_dir} -> Found {len(files)} files to upload to {remote_dir}\n")
        
        # 1. Create directories first (including all intermediate parents)
        all_dirs = set()
        for f in files:
            rel_parts = f.relative_to(source_dir).parent.parts
            for i in range(1, len(rel_parts) + 1):
                all_dirs.add('/'.join(rel_parts[:i]))
        
        dirs = sorted(list(all_dirs))
        
        # Enter raw REPL once
        sys.stderr.write("DEBUG: Entering raw REPL for bulk upload...\n")
        if not self.enter_raw_repl(soft_reset=False):
            sys.stderr.write("DEBUG: Failed to enter raw REPL normally, trying soft reset...\n")
            if not self.enter_raw_repl(soft_reset=True):
                raise Exception(f"Could not enter raw REPL for directory upload")

        try:
            # 1. Create all required directories in one go
            all_target_dirs = []
            if remote_dir != '/':
                all_target_dirs.append(remote_dir)
            for d in dirs:
                all_target_dirs.append(f"{remote_dir.rstrip('/')}/{d}")
            
            if all_target_dirs:
                sys.stderr.write(f"DEBUG: Ensuring {len(all_target_dirs)} directories exist on device...\n")
                # Efficiently create all directories using a single script
                # We use the recursive logic to be extra safe
                dir_code = f"""
import os
for d in {all_target_dirs!r}:
    p = ''
    for part in d.strip('/').split('/'):
        p += '/' + part
        try: os.mkdir(p)
        except: pass
"""
                self._exec_raw_no_exit(dir_code)

            # 2. Upload files
            for i, f in enumerate(files, 1):
                rel = str(f.relative_to(source_dir)).replace('\\', '/')
                remote_path = f"{remote_dir}/{rel}"
                sys.stderr.write(f"DEBUG: [{i}/{len(files)}] Uploading {rel} -> {remote_path}\n")
                # We can't use put_file directly because it manages its own raw REPL session
                # So we inline the logic here to stay in the SAME raw REPL session
                self._put_file_internal(f, remote_path)
        finally:
            sys.stderr.write("DEBUG: Exiting raw REPL.\n")
            self.serial.write(b'\x02') # Exit raw REPL

    def _put_file_internal(self, source_path: Path, remote_path: str):
        """Internal helper for uploading a file while ALREADY in raw REPL mode.
        One-shot hex transfer via raw-paste flow control — same path as put_file."""
        import binascii
        data = source_path.read_bytes()
        dest = remote_path.replace('\\', '/')
        hex_str = binascii.hexlify(data).decode()
        one_shot = (
            f"import binascii, os, time\n"
            f"try: os.remove({dest!r})\n"
            f"except: pass\n"
            f"time.sleep(0.01)\n"
            f"try:\n"
            f" _f=open({dest!r},'wb')\n"
            f" _f.write(binascii.unhexlify({hex_str!r}))\n"
            f" _f.close()\n"
            f"except Exception as e: print('FAIL:', e)"
        )
        rc, stdout, _ = self._exec_raw_no_exit(one_shot)
        if b'FAIL:' in stdout:
            sys.stderr.write(f"   [ERROR] Upload of {dest} reported FAIL\n")
            return 1
        return rc

    def get_file(self, remote_path: str, local_path: Path):
        """Download a file using hex-encoding bracketed by sentinel markers.
        Robust to any echo/duplication noise in the serial stream."""
        dest = remote_path.replace('\\', '/')
        # Print hex in small chunks with tiny sleeps so the USB-CDC RX buffer
        # on the host doesn't overrun.
        code = (
            "import binascii as _b, sys as _s, time as _t\n"
            f"_f=open({dest!r},'rb');_d=_f.read();_f.close()\n"
            "print('<<HEXLEN:%d>>' % len(_d))\n"
            "print('<<HEXSTART>>')\n"
            "_h=_b.hexlify(_d).decode()\n"
            "for _i in range(0,len(_h),128):\n"
            "    _s.stdout.write(_h[_i:_i+128]);_s.stdout.write('\\n')\n"
            "    _t.sleep_ms(3)\n"
            "print('<<HEXEND>>')"
        )

        rc, stdout, stderr = self.exec_code(code, stream_stdout=False)
        if stdout:
            try:
                import re as _re
                text = stdout.decode('utf-8', errors='ignore')
                lm = _re.search(r'<<HEXLEN:(\d+)>>', text)
                if not lm:
                    sys.stderr.write(f"   No HEXLEN marker for {remote_path}\n")
                    return 1
                expected_bytes = int(lm.group(1))
                a = text.find('<<HEXSTART>>')
                if a < 0:
                    sys.stderr.write(f"   No HEXSTART marker for {remote_path}\n")
                    return 1
                hex_part_start = a + len('<<HEXSTART>>')
                # Walk forward collecting hex chars until we have exactly the
                # expected count. Ignore any duplication / echo after that.
                need = expected_bytes * 2
                got = []
                for c in text[hex_part_start:]:
                    if c in '0123456789abcdefABCDEF':
                        got.append(c)
                        if len(got) == need:
                            break
                if len(got) != need:
                    sys.stderr.write(f"   Got {len(got)} hex chars, expected {need} for {remote_path}\n")
                    return 1
                local_path.write_bytes(bytes.fromhex(''.join(got)))
                return 0
            except Exception as e:
                sys.stderr.write(f"   Failed to parse hex data for {remote_path}: {e}\n")
                return 1
        return 1

# ---------------------------------------------------------------------------
# mip Package Manager Fallback (Bypass mpremote for stability)
# ---------------------------------------------------------------------------

class LocalTransport:
    """Mock mpremote transport that writes to a local directory instead of a device."""
    def __init__(self, target_dir):
        self.target_dir = Path(target_dir)
        self.target_dir.mkdir(parents=True, exist_ok=True)

    def fs_exists(self, path):
        return (self.target_dir / path.lstrip('/')).exists()

    def fs_mkdir(self, path):
        (self.target_dir / path.lstrip('/')).mkdir(parents=True, exist_ok=True)

    def fs_writefile(self, path, data, progress_callback=None):
        target = self.target_dir / path.lstrip('/')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    def exec(self, code):
        return b""

    def eval(self, expr):
        if "sys.path" in expr:
            return ["/lib"] 
        if "getattr(sys.implementation" in expr or "sys.implementation" in expr:
            return 0 # Force .py downloads
        return None

    def fs_hashfile(self, path, method):
        # Used for checking existing files - always return mismatch to force download
        return b"mismatch"

def _acquire_port_friendly(python_exe, port, retries=4):
    """Robust port acquisition. Tries pre-interrupt with retries, gives friendly message on fail."""
    if _is_ws_port(port):
        return True
    import time
    last_err = None
    for i in range(retries):
        try:
            _serial_pre_interrupt(python_exe, port, hard=False, light=True)
            time.sleep(0.4)
            return True
        except Exception as e:
            last_err = e
            if i < retries - 1:
                sys.stderr.write(f" [RETRY {i+1}/{retries}] Port busy, waiting...\n")
                time.sleep(0.8)
    sys.stderr.write(
        f"\n [ERROR] Cannot access {port}.\n"
        f"   Another program is using it. Try one of these:\n"
        f"     1. Close the Device Dashboard panel\n"
        f"     2. Close the WebREPL / Terminal tab connected to {port}\n"
        f"     3. Close Thonny / PuTTY / other serial tools\n"
        f"     4. Unplug + replug the board\n"
        f"   (Last error: {last_err})\n"
    )
    return False


def cmd_mip(python_exe: str, port: str, package: str, index: str = None):
    """Install a package on-device, falling back to PC-side download if needed."""
    sys.stderr.write(f"   Starting mip installation for '{package}' on {port}\n")
    sys.stderr.write(f"Installing '{package}' on device via mip...\n")
    # Robust port acquisition — clears stale locks, retries on busy
    if not _acquire_port_friendly(python_exe, port):
        sys.exit(1)
    
    mip_code = f"""
try:
    import mip as _mip
except ImportError:
    try:
        import upip as _mip
    except ImportError:
        print('ERROR: device has no mip/upip')
        _mip = None

if _mip is not None:
    try:
        print("mip.install({package!r})")
        _mip.install({package!r}{f', index={index!r}' if index else ''})
        print("Installation successful!")
    except OSError as _e:
        print("NETWORK_ERROR")
    except Exception as _e:
        print("ERROR: Installation failed: " + repr(_e))
print("<<MIP_DONE>>")
"""

    def _run_on_device():
        if _is_ws_port(port):
            host, password = _parse_ws_port(port)
            sys.stderr.write(f"DEBUG: Attempting on-device installation via WebREPL ({host})\n")
            conn = WebReplConnection(host, password)
            try:
                conn.connect()
                output = conn.run_file_content(mip_code)
                return 0, "NETWORK_ERROR" in output, "Installation successful!" in output
            finally:
                conn.close()
        else:
            sys.stderr.write(f"DEBUG: Attempting on-device installation via Serial ({port})\n")
            conn = SerialConnection(port)
            try:
                conn.connect()
                # Run WITHOUT soft reset to avoid dropping Wi-Fi
                rc, stdout, stderr = conn.exec_code(mip_code, timeout=20, soft_reset=False)
                
                output = stdout.decode('utf-8', errors='replace')
                sys.stderr.write(f"DEBUG: Device output: {output.strip()}\n")
                return rc, "NETWORK_ERROR" in output, "Installation successful!" in output
            finally:
                conn.close()

    # ── XBee / Digi Logic ──────────────────────────────────────────────────
    # Digi XBee MicroPython typically lacks a network stack that 'mip' can use
    # directly over Wi-Fi/Cellular for arbitrary GitHub URLs.
    # If the package is from the Digi repo, skip on-device and go straight to PC.
    if "digidotcom" in package.lower():
        sys.stderr.write(f"   Digi/XBee package detected. Using PC-side fallback...\n")
        is_network_error = True # Force fallback
    else:
        rc, is_network_error, is_success = _run_on_device()
        # Check for success message in addition to return code
        # (MicroPython sys.exit(1) doesn't always signal properly in raw REPL stderr)
        if rc == 0 and is_success and not is_network_error:
            sys.stderr.write("DEBUG: On-device installation check complete.\n")
            sys.exit(0)

    if not is_network_error:
        sys.stderr.write(f"DEBUG: On-device installation failed with code {rc}. No network error detected.\n")
        print(f"On-device installation failed.", file=sys.stderr)
        sys.exit(rc)

    # ── Fallback: PC-side download ─────────────────────────────────────────
    sys.stderr.write("DEBUG: Device has no network. Starting PC-side fallback...\n")
    print(f"Device has no network. Falling back to PC-side download...", file=sys.stderr)
    try:
        import mpremote.mip
    except ImportError:
        print("'mpremote' package is not installed in the IDE virtual environment.", file=sys.stderr)
        print("   Cannot perform PC-side fallback. Please connect the board to Wi-Fi.", file=sys.stderr)
        sys.exit(1)

    with tempfile.TemporaryDirectory() as td:
        target_dir = Path(td) / "lib"
        target_dir.mkdir()
        
        print(f"   Downloading package to PC...", file=sys.stderr)
        try:
            # We use a custom transport to download to the local dir
            transport = LocalTransport(target_dir)
            sys.stderr.write(f"DEBUG: Using mpremote.mip for PC-side download...\n")
            mpremote.mip._install_package(
                transport,
                package,
                index or mpremote.mip._PACKAGE_INDEX,
                "/lib",
                None,  # version
                False # mpy (force .py)
            )
        except Exception as e:
            sys.stderr.write(f"DEBUG: mpremote.mip failed: {e}\n")
            if "digidotcom" in package.lower():
                sys.stderr.write("DEBUG: Falling back to manual GitHub API download for Digi library...\n")
                _download_digi_repo_folder(package, target_dir)
            else:
                print(f"PC-side download failed: {e}", file=sys.stderr)
                sys.exit(1)

        print(f"   Uploading to device...", file=sys.stderr)
        conn = SerialConnection(port)
        try:
            conn.connect()
            # Find the actual files. mpremote.mip often creates a 'lib' folder inside target_dir.
            # If target_dir/lib/lib exists, we want target_dir/lib/lib.
            # If only target_dir/lib exists, we want target_dir/lib.
            # Otherwise we want target_dir.
            actual_source = target_dir
            if (target_dir / "lib" / "lib").is_dir():
                actual_source = target_dir / "lib" / "lib"
            elif (target_dir / "lib").is_dir():
                actual_source = target_dir / "lib"
            
            sys.stderr.write(f"   Finalizing upload from {actual_source} to /lib\n")
            conn.put_directory(actual_source, "/lib")
            print(f"Package '{package}' installed successfully via PC fallback.")
            sys.exit(0)
        except Exception as e:
            print(f"Upload failed: {e}", file=sys.stderr)
            sys.exit(1)
        finally:
            conn.close()


def _download_digi_repo_folder(package_url: str, target_dir: Path):
    """Download all files from a Digi XBee GitHub folder using the GitHub API."""
    # Example: github:digidotcom/xbee-micropython/lib/sensor
    # Convert to: https://api.github.com/repos/digidotcom/xbee-micropython/contents/lib/sensor
    raw_path = package_url.replace("github:", "")
    parts = raw_path.split("/")
    if len(parts) < 2:
        raise Exception(f"Invalid GitHub path: {package_url}")
    
    org, repo = parts[0], parts[1]
    path_in_repo = "/".join(parts[2:])
    
    api_url = f"https://api.github.com/repos/{org}/{repo}/contents/{path_in_repo}"
    sys.stderr.write(f"DEBUG: Fetching directory listing from {api_url}\n")
    
    try:
        headers = {"User-Agent": "MicroPython-Studio-IDE"}
        req = urllib.request.Request(api_url, headers=headers)
        with urllib.request.urlopen(req) as resp:
            items = json.loads(resp.read().decode())
        
        if not isinstance(items, list):
            # Might be a single file
            if isinstance(items, dict) and items.get("type") == "file":
                items = [items]
            else:
                raise Exception(f"Unexpected API response for {api_url}")

        for item in items:
            if item["type"] == "file":
                file_url = item["download_url"]
                file_name = item["name"]
                sys.stderr.write(f"   Downloading {file_name}...\n")
                with urllib.request.urlopen(file_url) as f_resp:
                    (target_dir / file_name).write_bytes(f_resp.read())
            elif item["type"] == "dir":
                # Recursive download for subdirectories
                sub_dir = target_dir / item["name"]
                sub_dir.mkdir(exist_ok=True)
                # Note: This is a simple non-recursive implementation for now
                # but could be made recursive if needed.
                sys.stderr.write(f"   Skipping subdirectory {item['name']} (recursive not yet supported)\n")
                
    except Exception as e:
        raise Exception(f"Failed to download Digi library from GitHub: {e}")


def _parse_ws_port(port):
    """Parse 'ws:IP,password' or 'ws:IP' into (host, password)."""
    raw = port[3:]  # strip 'ws:'
    if ',' in raw:
        host, password = raw.split(',', 1)
    else:
        host, password = raw, ''
    return host.strip(), password.strip()


def _is_ws_port(port):
    return port.startswith('ws:')


def _normalize_dest(dest: str) -> str:
    """Normalize the dest argument to an absolute device path.

    Git Bash on Windows expands a bare '/' to the Git installation directory
    (e.g. 'C:/Program Files/Git/'). Detect that and reset to device root '/'.
    """
    if not dest or re.match(r'^[A-Za-z]:[/\\]', dest):
        return '/'
    if not dest.startswith('/'):
        dest = '/' + dest
    return dest


def _serial_mkdir_p(python_exe: str, port: str, remote_dir: str) -> None:
    """Create remote_dir and all parent directories on device (serial)."""
    if remote_dir == '/':
        return
    parts = [p for p in remote_dir.strip('/').split('/') if p]
    acc = ['']
    for part in parts:
        acc.append(part)
        run_mpremote(python_exe, ['connect', port,
                     'fs', 'mkdir', '/'.join(acc)], timeout=15)


def _ws_mkdir_p(conn: 'WebReplConnection', remote_dir: str) -> None:
    """Create remote_dir and all parent directories on device (WebREPL)."""
    if remote_dir == '/':
        return
    parts = [p for p in remote_dir.strip('/').split('/') if p]
    acc = ['']
    for part in parts:
        acc.append(part)
        d = '/'.join(acc)
        conn.exec_code(f"import os\ntry:\n os.mkdir({d!r})\nexcept:pass")


def _serial_list_remote_files(python_exe: str, port: str, remote_path: str) -> set:
    """Return set of filenames (not dirs) found at remote_path on device.
    Returns empty set if the path doesn't exist or is empty."""
    code = f"""
import os
try:
    for f in os.ilistdir({remote_path!r}):
        if len(f) > 1 and f[1] != 0x4000:
            print(f[0])
except: pass
"""
    files: set = set()
    conn = SerialConnection(port)
    try:
        conn.connect()
        import io as _io
        _buf = _io.BytesIO()
        old_stdout = sys.stdout
        sys.stdout = _io.TextIOWrapper(_buf, encoding='utf-8')
        conn.exec_code(code)
        sys.stdout.flush()
        sys.stdout = old_stdout
        output = _buf.getvalue().decode('utf-8', errors='ignore')
        for line in output.splitlines():
            trimmed = line.strip()
            if trimmed:
                files.add(trimmed)
    except Exception:
        pass
    finally:
        conn.close()
    return files


def hard_reboot_before_send_cmd(python_exe):
    """Hard reset"""
    cmd = [python_exe, '-m', 'mpremote', 'reset']
    try:
        subprocess.run(
            cmd,  # use it here instead of duplicating
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL, timeout=2
        )
        time.sleep(0.5)
    except:
        pass

def readline_with_timeout(proc, timeout=60):
    result = [None]
    
    def read():
        result[0] = proc.stdout.readline()
    
    t = threading.Thread(target=read, daemon=True)
    t.start()
    t.join(timeout)
    
    if t.is_alive():
        # Timed out
        return None
    return result[0]


def run_mpremote(python_exe, args_list, timeout=60):
    """Run mpremote and stream output in real-time with clean Ctrl+C handling"""
    cmd = [python_exe, '-m', 'mpremote'] + args_list
    hard_reboot_before_send_cmd(python_exe)
    proc = None
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding='utf-8',
            errors='replace',
            bufsize=1,
            creationflags=getattr(
                subprocess, 'CREATE_NEW_PROCESS_GROUP', 0) if sys.platform == 'win32' else 0
        )

        output_lines = []

        # Stream output line by line
        while True:
            try:
                line = proc.stdout.readline()                
                if line:
                    if 'failed to access' in line and args_list and any(a.startswith('ws:') for a in args_list):
                        print(line, end="")
                        output_lines.append(line)
                        print(
                            " [INFO] WebREPL tip: only one connection is allowed at a time.\n"
                            "   Close any open browser WebREPL tab (micropython.org/webrepl)\n"
                            "   and make sure no other mpremote session is running.",
                            file=sys.stderr
                        )
                    else:
                        if "is mounted at /remote" in line or "Connected to " in line:
                            continue
                        print(line, end="")

                        output_lines.append(line)
                        
                elif proc.poll() is not None:
                    break
            except KeyboardInterrupt:
                if proc.poll() is not None:
                    break
                print("\n\n [INFO] Ctrl+C detected. Stopping...", file=sys.stderr)
                break

        # Terminate the process gracefully
        if proc.poll() is None:
            print(" [RESET] Sending soft reset (Ctrl+D) to device...", file=sys.stderr)
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()

        # --- After streaming mpremote ---
        captured = "".join(output_lines)
        parsed = parse_mpremote_output(captured)
        # Build a human-readable summary for the AI
        # At the end of run_mpremote, write captured output to a known file
        with open(os.path.join(tempfile.gettempdir(), 'mpremote-output.txt'), 'w', encoding='utf-8') as f:
            f.write(''.join(output_lines))
        device_summary = ""
        if parsed["error"]:
            device_summary += f"Error: {parsed['error']}\n"
        if parsed["device_output"]:
            device_summary += f"Device output:\n{parsed['device_output']}\n"

        data_output = "\n\n" + device_summary

        return subprocess.CompletedProcess(cmd, proc.returncode or 0, data_output, "")
        # return subprocess.CompletedProcess(cmd, proc.returncode or 0, captured, "")

    except KeyboardInterrupt:
        print("\n\n [INFO] Script manually interrupted. Exiting cleanly.", file=sys.stderr)
        if proc:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
        return subprocess.CompletedProcess(cmd, 0, "", "")
    except Exception as e:
        print(f"\n [ERROR] Failed to run: {e}", file=sys.stderr)
        return subprocess.CompletedProcess(cmd, 1, "", str(e))
# ----------------------------
# Command: run (mount folder + run full file path)
# ----------------------------


def cmd_run(python_exe, port, file_path, folder=None):
    file_path = Path(file_path).resolve()
    if not file_path.is_file():
        print(f" [ERROR] File not found: {file_path}", file=sys.stderr)
        sys.exit(1)

    # WebSocket (ws:) ports don't support mount — fall back to run_mcu automatically
    if port.startswith('ws:'):
        print(f"📡 Wireless port detected — using direct run (no mount)",
              file=sys.stderr)
        cmd_run_mcu(python_exe, port, file_path)
        return

    # If folder not given, use parent of the file
    if folder is None:
        folder = file_path.parent
    folder = Path(folder).resolve()

    if not folder.is_dir():
        print(f" [ERROR] Mount folder not found: {folder}", file=sys.stderr)
        sys.exit(1)

    _print_ui_header(port, folder, file_path)

    # Robust port acquisition — friendly message on port-busy.
    if not _acquire_port_friendly(python_exe, port):
        sys.exit(1)
    # 🔥 Strategy: First attempt uses standard connect (with reset) for stability.
    # Retry attempt uses 'resume' after a hardware reset.
    args = [
        'connect', port, 
        'mount', str(folder),
        'run', str(file_path)
    ]

    result = run_mpremote(python_exe, args, timeout=30)
    errors = ['TypeError', 'NameError', 'SyntaxError', 'ImportError', 'Traceback']
    if any(err in result.stdout for err in errors):
        sys.exit(result.returncode)
        
    # Auto-retry once on raw REPL failure (device may need an extra hard kick)
    if result.returncode != 0:
        print(" [INFO] First attempt failed. Trying a hardware reset/kick...",
              file=sys.stderr)
        _serial_pre_interrupt(python_exe, port, hard=True, light=False)
        time.sleep(1.0)
        print(" [RETRY] Retrying with mpremote (resume)...", file=sys.stderr)
        retry_args = ['connect', port, 'resume', 'mount', str(folder), 'run', str(file_path)]
        result = run_mpremote(python_exe, retry_args, timeout=30)

    # Final fallback: if mpremote still fails, use our robust SerialConnection
    if result.returncode != 0:
        print("💡 mpremote still failing. Trying robust serial fallback...",
              file=sys.stderr)
        conn = SerialConnection(port)
        try:
            conn.connect()
            code = Path(file_path).read_bytes()
            rc = conn.exec_code(code)
            sys.exit(rc)
        except Exception as e:
            print(f" [ERROR] Robust fallback also failed: {e}", file=sys.stderr)
            sys.exit(1)
        finally:
            conn.close()

    sys.exit(result.returncode)


def _serial_pre_interrupt(python_exe, port, hard=False, light=False):
    """Fast pre-interrupt using pyserial. Falls back to mpremote if serial is unavailable.
    If hard=True, toggles DTR/RTS to trigger a hardware reset on ESP32/8266.
    If light=True, just sends interrupts without a full raw REPL handshake (prevents mpremote collision).
    """
    if _is_ws_port(port):
        return False

    try:
        import serial
        import time
        
        if hard:
            # Use safe open pattern
            s = serial.Serial(None, 115200, timeout=0.1)
            s.port = port
            s.dtr = False
            s.rts = False
            s.open()

            # Hard Reset Sequence (ESP32/ESP8266 logic)
            print(f" [RESET] Performing Hardware Reset (DTR/RTS) on {port}...", file=sys.stderr)
            s.setRTS(True)
            s.setDTR(False)
            time.sleep(0.1)
            s.setRTS(False)  # Release reset
            time.sleep(0.5)  # Wait for boot
            s.close()

        if light:
            # Light Kick: Ensure we are at a friendly prompt '>>>'
            s = serial.Serial(port, 115200, timeout=0.5)
            s.dtr = False
            s.rts = False
            # Break everything and force friendly REPL
            s.write(b'\r\x03\x03\x02\r') 
            time.sleep(0.3)
            # Drain residual output
            s.read_all()
            s.close()
            return False

        # Ultimate Kick: Deliberate Sync without soft-rebooting
        print(f" [SYNC] Synchronizing with device...", file=sys.stderr)
        conn = SerialConnection(port)
        conn.connect()
        is_active = False
        if conn.enter_raw_repl(soft_reset=False):
            is_active = conn.dtr_active
            conn.serial.write(b'\x02') # Exit to friendly REPL
            time.sleep(0.1)
        conn.close()
        return is_active
    except KeyboardInterrupt:
        print("\n\n [INFO] Script manually interrupted. Exiting cleanly.", file=sys.stderr)
        sys.exit(0)
    except Exception:
        pass  # best-effort — device may not respond


# ----------------------------
# Command: run_mcu (mpremote run — no mount, file sent directly to device)
# ----------------------------


def cmd_run_mcu(python_exe: str, port: str, file_path: str, soft_reset: bool = True, quiet: bool = False):
    file_path = Path(file_path).resolve()
    if not file_path.is_file():
        sys.stderr.write(f"   [ERROR] File not found: {file_path}\n")
        sys.exit(1)

    if not quiet:
        _print_ui_header(port, None, file_path)

    # WebSocket: mpremote has no ws: transport — use our own WebREPL implementation
    if _is_ws_port(port):
        host, password = _parse_ws_port(port)
        conn = WebReplConnection(host, password)
        try:
            conn.connect()
            rc, stdout, stderr = conn.exec_code(Path(file_path).read_bytes())
        except ConnectionError as e:
            sys.stderr.write(f"   [ERROR] WebREPL connection failed: {e}\n")
            rc = 1
        except Exception as e:
            sys.stderr.write(f"   [ERROR] WebREPL error: {e}\n")
            rc = 1
        finally:
            conn.close()
        sys.exit(rc)

    # Serial: Execute natively using pure PySerial
    sys.stderr.write(f"{CLR_DIM} [EXEC] Executing directly via pure serial...{CLR_RESET}\n")
    # Check for debug flag in environment or common args
    debug_mode = os.environ.get('MPS_DEBUG') == '1'
    conn = SerialConnection(port, debug=debug_mode)
    try:
        conn.connect()
        code = Path(file_path).read_bytes()
        rc, stdout, stderr = conn.exec_code(code, soft_reset=soft_reset, stream_stdout=True)
        sys.exit(rc)
    except Exception as e:
        sys.stderr.write(f" [ERROR] Pure serial execution failed: {e}\n")
        sys.exit(1)
    finally:
        conn.close()


# ----------------------------
# Command: mount
# ----------------------------


def cmd_mount(python_exe, port, folder):
    folder = Path(folder).resolve()
    if not folder.is_dir():
        print(f" [ERROR] Folder not found: {folder}", file=sys.stderr)
        sys.exit(1)

    print(f" [UPLOAD] Mounting {folder} to /remote...", file=sys.stderr)
    args = [
        'connect', port,
        'mount', str(folder),
        'exec', "print('✅ Mounted /remote')"
    ]
    result = run_mpremote(python_exe, args, timeout=15)
    if result.returncode != 0:
        print("❌ Mount failed", file=sys.stderr)
        sys.exit(1)

# ----------------------------
# Command: unmount
# ----------------------------


def cmd_unmount(python_exe, port):
    print("⏏️ Unmounting /remote...", file=sys.stderr)
    code = "import os; os.umount('/remote')"
    args = ['connect', port, 'exec', code]
    result = run_mpremote(python_exe, args, timeout=10)
    if result.returncode == 0:
        print("✅ Unmounted /remote")
    else:
        print("⚠️ Unmount returned non-zero (device may already be unmounted)", file=sys.stderr)


# ----------------------------
# Command: upload
# ----------------------------

def _ws_upload_file_legacy(conn: WebReplConnection, source: Path, remote: str) -> int:
    """Upload a single file via WebREPL raw REPL using hex encoding (fallback)."""
    import binascii
    data = source.read_bytes()
    hex_data = binascii.hexlify(data).decode()
    # Build Python code that reconstructs the file on the device
    # hex chars per line (60 bytes) — safe for raw REPL line buffer
    chunk_size = 120
    lines = ['import binascii', f"_f=open({remote!r},'wb')"]
    for i in range(0, len(hex_data), chunk_size):
        chunk = hex_data[i:i+chunk_size]
        lines.append(f"_f.write(binascii.unhexlify({chunk!r}))")
    lines.append('_f.close()')
    lines.append("print('OK')")
    rc, stdout, stderr = conn.exec_code('\n'.join(lines))
    return rc


def _ws_upload_file(conn: WebReplConnection, source: Path, remote: str) -> int:
    """Upload a single file using the best available WebREPL method."""
    return conn.upload_file(source, remote)


def cmd_upload(python_exe, port, source, dest: str = '/', overwrite: bool = False):
    """Upload a file or folder to the device filesystem."""
    dest = _normalize_dest(dest)
    source = Path(source).resolve()

    if not source.exists():
        print(f"❌ Source not found: {source}", file=sys.stderr)
        sys.exit(1)

    # ── WebSocket path — use our WebREPL transport ──────────────────────────
    if _is_ws_port(port):
        host, password = _parse_ws_port(port)
        conn = WebReplConnection(host, password)
        try:
            conn.connect()
            if source.is_file():
                _ws_mkdir_p(conn, dest)
                remote = dest.rstrip('/') + '/' + source.name
                print(
                    f"   Uploading {source.name} -> {remote}", file=sys.stderr)
                rc = _ws_upload_file(conn, source, remote)
                if rc == 0:
                    print(f"   Upload complete", file=sys.stderr)
            else:
                files = sorted(f for f in source.rglob('*') if f.is_file())
                if not files:
                    print("   [WARN] Source folder is empty.", file=sys.stderr)
                    sys.exit(0)
                print(
                    f"   Uploading {len(files)} file(s) from {source}", file=sys.stderr)
                print(f"   Port: {port}", file=sys.stderr)
                print("-" * 50, file=sys.stderr)
                # Create dest and all subdirectories first
                _ws_mkdir_p(conn, dest)
                dirs = sorted(set(
                    str(f.relative_to(source).parent).replace('\\', '/')
                    for f in files if f.relative_to(source).parent != Path('.')
                ))
                for d in dirs:
                    _ws_mkdir_p(conn, dest.rstrip('/') + '/' + d)
                rc = 0
                for i, f in enumerate(files, 1):
                    rel = str(f.relative_to(source)).replace('\\', '/')
                    remote = dest.rstrip('/') + '/' + rel
                    print(f"[{i}/{len(files)}] {rel}", file=sys.stderr)
                    rc = _ws_upload_file(conn, f, remote)
                    if rc != 0:
                        print(f"   [FAILED] {rel}", file=sys.stderr)
                        break
                    # Brief pause between files so the device can finish
                    # writing to flash before the next transfer starts.
                    time.sleep(0.1)
                if rc == 0:
                    print(
                        f"\n   Upload complete ({len(files)} file(s))", file=sys.stderr)
        except ConnectionError as e:
            print(f"   [ERROR] WebREPL connection failed: {e}", file=sys.stderr)
            rc = 1
        except Exception as e:
            print(f"   [ERROR] WebREPL upload error: {e}", file=sys.stderr)
            rc = 1
        finally:
            conn.close()
        sys.exit(rc)

    # ── Serial path — use pure serial ───────────────────────────────────────────
    if source.is_file():
        remote = dest.rstrip('/') + '/' + source.name
        print(f"Uploading {source.name} -> {remote}", file=sys.stderr)
        # Safety delay to prevent port conflict
        time.sleep(0.1)

        conn = SerialConnection(port)
        try:
            conn.connect()
            rc = conn.put_file(source, remote)
            if rc == 0:
                print(f"   Upload complete", file=sys.stderr)
            sys.exit(rc)
        except Exception as e:
            print(f"Upload failed: {e}", file=sys.stderr)
            sys.exit(1)
        finally:
            conn.close()

    files = sorted(f for f in source.rglob('*') if f.is_file())
    if not files:
        print("Source folder is empty, nothing to upload.", file=sys.stderr)
        sys.exit(0)

    # Check for conflicts before touching the device
    existing = _serial_list_remote_files(python_exe, port, dest)
    if existing:
        uploading_names = {
            str(f.relative_to(source)).replace('\\', '/')
            for f in files
        }
        conflicts = existing & uploading_names
        if conflicts:
            print(
                f"These files already exist in {dest} on the device:", file=sys.stderr)
            for c in sorted(conflicts):
                sys.stderr.write(f"   * {c}\n")
            if not overwrite:
                print("CONFLICTS_FOUND", flush=True)
                sys.exit(3)
            print("Overwriting existing files...", file=sys.stderr)

    dirs_to_create = sorted(set(
        str(f.relative_to(source).parent).replace('\\', '/')
        for f in files if f.relative_to(source).parent != Path('.')
    ))

    print(f"Uploading {len(files)} file(s) from {source}", file=sys.stderr)
    print(f"Port: {port}", file=sys.stderr)
    print("-" * 50, file=sys.stderr)

    conn = SerialConnection(port)
    try:
        conn.connect()
        conn.put_directory(source, dest)
    except Exception as e:
        print(f"Upload failed: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        conn.close()

    print(f"\nUpload complete ({len(files)} file(s))", file=sys.stderr)
    sys.exit(0)


# ----------------------------
# Command: exec
# ----------------------------
# ----------------------------
# Command: download
# ----------------------------

def _get_device_files(python_exe: str, port: str) -> 'list[str]':
    """Return a list of all file paths on the device (recursive)."""
    import json as _json

    # Script that walks the device filesystem and prints a JSON list of file paths
    walk_code = (
        "import os\n"
        "def _w(p):\n"
        " try:\n"
        "  for e in os.listdir(p):\n"
        "   f=(p+'/'+e).replace('//','/') \n"
        "   try:\n"
        "    if os.stat(f)[0]&0x4000:_w(f)\n"
        "    else:print('FILE:'+f)\n"
        "   except:pass\n"
        " except:pass\n"
        "_w('/')\n"
    )

    tmp = Path(sys.executable).parent / '_mps_ls.py'
    output: str = ''
    try:
        tmp.write_text(walk_code, encoding='utf-8')
        if _is_ws_port(port):
            host, password = _parse_ws_port(port)
            conn = WebReplConnection(host, password)
            try:
                conn.connect()
                rc, stdout_bytes, stderr_bytes = conn.exec_code(walk_code, stream_stdout=False)
                output = stdout_bytes.decode('utf-8', errors='ignore')
            finally:
                conn.close()
        else:
            conn = SerialConnection(port)
            try:
                conn.connect()
                rc, stdout_bytes, stderr_bytes = conn.exec_code(walk_code, stream_stdout=False)
                output = stdout_bytes.decode('utf-8', errors='ignore')
            except Exception as e:
                sys.stderr.write(f"   Error walking device files: {e}\n")
                pass
            finally:
                conn.close()
    finally:
        try:
            tmp.unlink()
        except Exception:
            pass

    files = []
    for line in output.splitlines():
        line = line.strip()
        if line.startswith('FILE:'):
            files.append(line[5:])
    return files


def cmd_download(python_exe: str, port: str, dest_dir: str,
                 overwrite: bool = False, skip: bool = False,
                 rename: bool = False,
                 overwrite_files: 'list[str] | None' = None) -> None:
    """Download all files from the device to a local directory."""
    import json as _json

    dest = Path(dest_dir).resolve()
    dest.mkdir(parents=True, exist_ok=True)

    sys.stderr.write("   Reading device filesystem...\n")
    device_files = _get_device_files(python_exe, port)

    if not device_files:
        sys.stderr.write("   No files found on device.\n")
        sys.exit(0)

    sys.stderr.write(f"   Found {len(device_files)} file(s) on device.\n")

    # Filter out excluded files/folders
    filtered_files = []
    for f in device_files:
        name = f.split('/')[-1]
        # Skip if name is in exclude list or starts with . (hidden junk)
        if name in DOWNLOAD_EXCLUDE or (name.startswith('.') and name != '.py'):
            continue
        # Also skip if any parent part is in exclude list
        if any(part in DOWNLOAD_EXCLUDE for part in f.split('/')):
            continue
        filtered_files.append(f)

    if len(filtered_files) < len(device_files):
        diff = len(device_files) - len(filtered_files)
        sys.stderr.write(f"   Ignored {diff} system/junk file(s).\n")
        device_files = filtered_files

    # Detect conflicts (files that already exist locally)
    conflicts = [
        f for f in device_files
        if (dest / f.lstrip('/')).exists()
    ]

    if conflicts and not overwrite and not skip and not rename and overwrite_files is None:
        sys.stderr.write("   The following files already exist on your PC:\n")
        for c in conflicts:
            sys.stderr.write(f"   * {c}\n")
        # Machine-readable output for the extension
        # We print this to stdout so the extension can capture it, but it should be hidden from UI
        print(_json.dumps({'conflicts': conflicts}), flush=True)
        sys.exit(3)

    sys.stderr.write(f"   Downloading to: {dest}\n")
    sys.stderr.write("-" * 50 + "\n")

    downloaded = 0
    skipped = 0

    conn = None
    if _is_ws_port(port):
        host, password = _parse_ws_port(port)
        conn = WebReplConnection(host, password)
    else:
        conn = SerialConnection(port)

    try:
        conn.connect()
        for remote_path in device_files:
            rel = remote_path.lstrip('/')
            local_path = dest / rel

            if local_path.exists():
                if skip:
                    sys.stderr.write(f"   Skipped:  {rel}\n")
                    skipped += 1
                    continue
                if rename:
                    base = local_path.stem
                    ext = local_path.suffix
                    counter = 1
                    new_local = local_path.parent / f"{base}_{counter}{ext}"
                    while new_local.exists():
                        counter += 1
                        new_local = local_path.parent / f"{base}_{counter}{ext}"
                    local_path = new_local
                    rel = str(local_path.relative_to(dest)).replace('\\', '/')
                else:
                    _owf: 'list[str]' = overwrite_files or []
                    if overwrite_files is not None and remote_path not in _owf:
                        sys.stderr.write(f"   Skipped:  {rel}\n")
                        skipped += 1
                        continue

            local_path.parent.mkdir(parents=True, exist_ok=True)
            sys.stderr.write(f"   {remote_path}  ->  {rel}\n")
            
            try:
                res = conn.get_file(remote_path, local_path)
                if res == 0:
                    downloaded += 1
                else:
                    sys.stderr.write(f"   Failed: {remote_path} (Backend error)\n")
            except Exception as e:
                sys.stderr.write(f"   Failed: {remote_path}: {e}\n")
                continue
    finally:
        if conn:
            conn.close()

    sys.stderr.write("-" * 50 + "\n")
    sys.stderr.write(f"   Download complete: {downloaded} downloaded, {skipped} skipped.\n")


# ----------------------------
# Command: kick / hard_reset
# ----------------------------

def cmd_kick(python_exe, port):
    """Wake up a device using hardware toggles and interrupts."""
    print(f"🚀 Attempting to wake up device on {port}...", file=sys.stderr)
    _serial_pre_interrupt(python_exe, port, hard=True)
    print("✅ Kick complete.", file=sys.stderr)
    sys.exit(0)


def cmd_hard_reset(python_exe, port):
    """Force a reboot using hardware toggles and soft commands."""
    sys.stderr.write(f"   Performing hard reset on {port}...\n")
    _serial_pre_interrupt(python_exe, port, hard=True)
    # Attempt to send software reset command if we can connect now
    args = ['connect', port, 'exec', 'import machine; machine.reset()']
    run_mpremote(python_exe, args, timeout=5)
    sys.stderr.write("   Reset signal sent.\n")
    sys.exit(0)


# ----------------------------
# Command: shell
# ----------------------------
def cmd_shell(python_exe, port):
    """Start an interactive Miniterem session via pure serial, without resetting the board."""
    print(f" [SYNC] Syncing with device for interactive shell...", file=sys.stderr)
    dtr_required = _serial_pre_interrupt(python_exe, port, hard=False)
    # 💡 Safety delay: Give Windows time to release the port after sync
    time.sleep(0.5)
    
    print(f" [SUCCESS] Connected to MicroPython at {port}")
    print("Use Ctrl-] or Ctrl-x to exit this shell. If '>>>' is not visible, press Enter.")
    
    # Custom pyserial shell with DEL->BS translation so Backspace works on
    # Windows. Exit with Ctrl-] or Ctrl-X.
    import serial as _ser
    import threading
    try:
        s = _ser.Serial(port, 115200, timeout=0.05, write_timeout=1.0,
                        dsrdtr=False, rtscts=False)
        s.dtr = bool(dtr_required)
        s.rts = False
    except Exception as e:
        print(f" [ERROR] Cannot open {port}: {e}", file=sys.stderr)
        sys.exit(1)

    stop = threading.Event()

    def reader():
        while not stop.is_set():
            try:
                data = s.read(256)
            except Exception:
                break
            if data:
                try:
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
                except Exception:
                    break

    t = threading.Thread(target=reader, daemon=True)
    t.start()

    # Drain anything VS Code's Python extension auto-types into our pty
    # (e.g. the venv activate path). We swallow the first ~700ms of stdin
    # so it never reaches the device's REPL.
    _drain_until = time.time() + 0.7
    if os.name == 'nt':
        try:
            import msvcrt as _m0
            while time.time() < _drain_until:
                if _m0.kbhit():
                    _m0.getch()
                else:
                    time.sleep(0.02)
        except Exception:
            pass
    else:
        try:
            import select as _sel
            while time.time() < _drain_until:
                r, _, _ = _sel.select([sys.stdin], [], [], 0.05)
                if r:
                    os.read(sys.stdin.fileno(), 4096)
        except Exception:
            pass

    # Try to put stdin in raw mode so keystrokes pass through byte-by-byte.
    # On Windows use msvcrt; on POSIX use termios+tty.
    try:
        if os.name == 'nt':
            import msvcrt
            while not stop.is_set():
                if msvcrt.kbhit():
                    ch = msvcrt.getch()
                    # Ctrl-] (0x1D) or Ctrl-X (0x18) -> exit
                    if ch in (b'\x1d', b'\x18'):
                        break
                    # DEL -> BS
                    if ch == b'\x7f':
                        ch = b'\x08'
                    # Windows arrow keys come as 0xE0 then a code; translate to ANSI
                    if ch in (b'\xe0', b'\x00'):
                        ch2 = msvcrt.getch()
                        m = {b'H': b'\x1b[A', b'P': b'\x1b[B',
                             b'M': b'\x1b[C', b'K': b'\x1b[D',
                             b'S': b'\x7f'}  # Delete key -> DEL for REPL
                        ch = m.get(ch2, b'')
                    try:
                        s.write(ch)
                    except Exception:
                        break
                else:
                    time.sleep(0.01)
        else:
            import termios, tty
            fd = sys.stdin.fileno()
            old = termios.tcgetattr(fd)
            try:
                tty.setraw(fd)
                while not stop.is_set():
                    ch = os.read(fd, 1)
                    if ch in (b'\x1d', b'\x18'):
                        break
                    if ch == b'\x7f':
                        ch = b'\x08'
                    s.write(ch)
            finally:
                termios.tcsetattr(fd, termios.TCSADRAIN, old)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        try: s.close()
        except: pass
    sys.exit(0)

# ----------------------------
# Command: ls
# ----------------------------

def cmd_ls(python_exe, port, path='/'):
    """List directory contents in a format compatible with `mpremote fs ls`."""
    if _is_ws_port(port):
        host, password = _parse_ws_port(port)
        conn = WebReplConnection(host, password)
        try:
            conn.connect()
            code = f"""
import os
try:
    for f in os.ilistdir({path!r}):
        size = f[3] if len(f)>3 else 0
        is_dir = (f[1] == 0x4000)
        name = f[0] + ('/' if is_dir else '')
        print('{{:10}} {{}}'.format(size, name))
except Exception as _e:
    import sys as _sys
    print('ls_error:' + str(_e), file=_sys.stderr)
"""
            conn.exec_code(code)
        except Exception as e:
            print(f"WebREPL ls failed: {e}", file=sys.stderr)
            sys.exit(1)
        finally:
            conn.close()
        sys.exit(0)

    # Serial
    conn = SerialConnection(port)
    try:
        conn.connect()
        # list_files calls exec_code internally
        rc, stdout, stderr = conn.list_files(path) # list_files uses exec_code(stream_stdout=True) by default, but we want it False
        output = stdout.decode('utf-8', errors='ignore').strip()
        
        # Parse the custom pipe-separated format: name|is_dir|size
        for line in output.splitlines():
            parts = line.strip().split('|')
            if len(parts) == 3:
                name, is_dir, size = parts[0], parts[1] == 'True', parts[2]
                print(f"{size:>10} {name}{'/' if is_dir else ''}")
        sys.exit(rc)
    except Exception as e:
        sys.stderr.write(f"❌ Pure serial ls failed: {e}\n")
        sys.stderr.flush()
        sys.exit(1)
    finally:
        conn.close()


# ----------------------------
# Command: cat
# ----------------------------
def cmd_cat(python_exe, port, remote_path):
    """Print file contents to stdout. Uses hex-encoded binary transfer for
    reliability (text-mode streaming was losing chunks on large files)."""
    # Read the file as binary, hex-encode on device, print one line.
    # Host decodes hex → bytes → decode utf-8.
    code = f"""
import binascii as _b, sys as _s, time as _t
try:
    _f = open({remote_path!r}, 'rb')
    _d = _f.read()
    _f.close()
    print('<<HEXLEN:%d>>' % len(_d))
    print('<<HEXSTART>>')
    _h = _b.hexlify(_d).decode()
    for _i in range(0, len(_h), 128):
        _s.stdout.write(_h[_i:_i+128])
        _s.stdout.write('\\n')
        _t.sleep_ms(3)
    print('<<HEXEND>>')
except Exception as _e:
    print('CAT_ERR:'+str(_e), file=_s.stderr)
"""

    def _decode_and_print(stdout_bytes):
        try:
            import re as _re
            text = stdout_bytes.decode('utf-8', errors='replace')
            lm = _re.search(r'<<HEXLEN:(\d+)>>', text)
            if not lm:
                sys.stderr.write('cat: no HEXLEN marker. Got stdout:\n')
                sys.stderr.write(text[:2000] + '\n')
                return 1
            expected = int(lm.group(1))
            a = text.find('<<HEXSTART>>')
            if a < 0:
                sys.stderr.write('cat: no HEXSTART. Got stdout:\n')
                sys.stderr.write(text[:2000] + '\n')
                return 1
            need = expected * 2
            got = []
            for c in text[a + len('<<HEXSTART>>'):]:
                if c in '0123456789abcdefABCDEF':
                    got.append(c)
                    if len(got) == need:
                        break
            if len(got) != need:
                sys.stderr.write(f'cat: got {len(got)} hex chars, expected {need}\n')
                return 1
            sys.stdout.buffer.write(bytes.fromhex(''.join(got)))
            sys.stdout.buffer.flush()
            return 0
        except Exception as _e:
            sys.stderr.write(f'cat: {_e}\n')
            return 1

    if _is_ws_port(port):
        host, password = _parse_ws_port(port)
        conn = WebReplConnection(host, password)
        try:
            conn.connect()
            rc, stdout, stderr = conn.exec_code(code, stream_stdout=False)
        except Exception as e:
            print(f"WebREPL cat failed: {e}", file=sys.stderr)
            sys.exit(1)
        finally:
            conn.close()
        sys.exit(_decode_and_print(stdout))

    # Serial
    conn = SerialConnection(port)
    try:
        conn.connect()
        rc, stdout, stderr = conn.exec_code(code, stream_stdout=False)
    except Exception as e:
        sys.stderr.write(f"   Serial cat failed: {e}\n")
        sys.exit(1)
    finally:
        conn.close()
    sys.exit(_decode_and_print(stdout))


# ----------------------------
# Command: rm
# ----------------------------
def cmd_rm(python_exe, port, remote_path, recursive=False):
    """Remove a file or folder from the device. Handles serial and WebREPL."""
    if recursive:
        code = f"""
import os as _os
def _rm(p):
    try:
        for e in _os.listdir(p):
            _rm(p + '/' + e)
        _os.rmdir(p)
    except OSError:
        _os.remove(p)
_rm({remote_path!r})
print('ok')
"""
    else:
        code = f"import os; os.remove({remote_path!r}); print('ok')"

    if _is_ws_port(port):
        host, password = _parse_ws_port(port)
        conn = WebReplConnection(host, password)
        try:
            conn.connect()
            conn.exec_code(code)
        except Exception as e:
            print(f"WebREPL rm failed: {e}", file=sys.stderr)
            sys.exit(1)
        finally:
            conn.close()
        sys.exit(0)

    # Serial
    conn = SerialConnection(port)
    try:
        conn.connect()
        conn.exec_code(code)
    except Exception as e:
        print(f"Serial rm failed: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        conn.close()
    sys.exit(0)


# ----------------------------
# Command: mv
# ----------------------------
def cmd_mv(python_exe, port, src_path, dest_path):
    """Move/rename a file on the device. Handles serial and WebREPL."""
    code = f"import os; os.rename({src_path!r}, {dest_path!r}); print('ok')"
    if _is_ws_port(port):
        host, password = _parse_ws_port(port)
        conn = WebReplConnection(host, password)
        try:
            conn.connect()
            conn.exec_code(code)
        except Exception as e:
            print(f"WebREPL mv failed: {e}", file=sys.stderr)
            sys.exit(1)
        finally:
            conn.close()
        sys.exit(0)

    # Serial
    conn = SerialConnection(port)
    try:
        conn.connect()
        conn.exec_code(code)
    except Exception as e:
        print(f"Serial mv failed: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        conn.close()
    sys.exit(0)


# ----------------------------
# Command: exec
# ----------------------------
def cmd_exec(python_exe, port, code):
    if not code.strip():
        print("❌ No code to execute", file=sys.stderr)
        sys.exit(1)

    print(
        f"⚡ Executing: {code[:50]}{'...' if len(code) > 50 else ''}", file=sys.stderr)

    if _is_ws_port(port):
        host, password = _parse_ws_port(port)
        conn = WebReplConnection(host, password)
        try:
            conn.connect()
            rc = conn.exec_code(code)
        except ConnectionError as e:
            print(f"❌ WebREPL connection failed: {e}", file=sys.stderr)
            rc = 1
        finally:
            conn.close()
        sys.exit(rc)

    # Serial path: use robust SerialConnection
    conn = SerialConnection(port)
    try:
        conn.connect()
        rc, stdout, stderr = conn.exec_code(code)
        sys.exit(rc)
    except Exception as e:
        print(f"❌ Pure serial execution failed: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        conn.close()
    sys.exit(0)

# ----------------------------
# CLI
# ----------------------------


def main():
    parser = argparse.ArgumentParser(
        description="MicroPython IDE Backend (uses mpremote mount + run)"
    )
    parser.add_argument('--python', required=True,
                        help='Path to venv Python executable')

    subparsers = parser.add_subparsers(
        dest='command', required=True, help='Available commands')

    # Run: mount folder and run file (full path)
    run_p = subparsers.add_parser(
        'run', help='Mount folder and run a file by full path')
    run_p.add_argument('--port', required=True,
                       help='Serial port (e.g., COM9)')
    run_p.add_argument('--file', required=True,
                       help='Full path to the .py file to run')
    run_p.add_argument(
        '--folder', help='Folder to mount (default: parent of file)')

    # Run MCU: send file directly to device and run (no mount)
    run_mcu_p = subparsers.add_parser(
        'run_mcu', help='Run a file directly on the MCU (mpremote run, no mount)')
    run_mcu_p.add_argument('--port', required=True,
                           help='Serial port (e.g., COM9)')
    run_mcu_p.add_argument('--file', required=True,
                           help='Full path to the .py file to run')
    run_mcu_p.add_argument('--no-reset', action='store_true',
                           help='Do not trigger soft reset (Ctrl-D) before running')
    run_mcu_p.add_argument('--quiet', action='store_true',
                           help='Suppress UI header')

    # Upload
    upload_p = subparsers.add_parser(
        'upload', help='Upload a file or folder to the device')
    upload_p.add_argument('--port', required=True,
                          help='Serial port (e.g., COM9)')
    upload_p.add_argument('--source', required=True,
                          help='Local file or folder to upload')
    upload_p.add_argument('--dest', default='/',
                          help='Remote destination path (default: /)')
    upload_p.add_argument('--overwrite', action='store_true',
                          help='Overwrite existing files without prompting')

    # Download
    dl_p = subparsers.add_parser(
        'download', help='Download all files from device to local folder')
    dl_p.add_argument('--port', required=True,
                      help='Serial port or ws: address')
    dl_p.add_argument('--dest', required=True,
                      help='Local destination folder (e.g. main/)')
    dl_p.add_argument('--overwrite', action='store_true',
                      help='Overwrite all existing local files')
    dl_p.add_argument('--skip', action='store_true',
                      help='Skip files that already exist locally')
    dl_p.add_argument('--rename', action='store_true',
                      help='Keep both by renaming the incoming file')
    dl_p.add_argument('--overwrite-files', default='',
                      help='Pipe-separated list of specific files to overwrite')

    # Mkdir
    mkdir_p = subparsers.add_parser(
        'mkdir', help='Create a directory on the device')
    mkdir_p.add_argument('--port', required=True, help='Serial port')
    mkdir_p.add_argument('--path', required=True, help='Directory path')

    # Rename
    rename_p = subparsers.add_parser(
        'rename', help='Rename a file or directory on the device')
    rename_p.add_argument('--port', required=True, help='Serial port')
    rename_p.add_argument('--src', required=True, help='Source path')
    rename_p.add_argument('--dest', required=True, help='Destination path')

    # Exec
    exec_p = subparsers.add_parser('exec', help='Execute code on device')
    exec_p.add_argument('--port', required=True,
                        help='Serial port (e.g., COM9)')
    exec_p.add_argument('--code', required=True, help='Code to execute')

    # ls
    ls_p = subparsers.add_parser('ls', help='List files on device')
    ls_p.add_argument('--port', required=True)
    ls_p.add_argument('--path', default='/')

    # cat
    cat_p = subparsers.add_parser(
        'cat', help='Print file contents from device')
    cat_p.add_argument('--port', required=True)
    cat_p.add_argument('--path', required=True,
                       help='Remote file path (e.g. /main.py)')

    # rm
    rm_p = subparsers.add_parser(
        'rm', help='Remove a file or folder from device')
    rm_p.add_argument('--port', required=True)
    rm_p.add_argument('--path', required=True, help='Remote path to remove')
    rm_p.add_argument('--recursive', action='store_true',
                      help='Remove folder recursively')

    # mv
    mv_p = subparsers.add_parser('mv', help='Move/rename a file on device')
    mv_p.add_argument('--port', required=True)
    mv_p.add_argument('--src', required=True, help='Source path on device')
    mv_p.add_argument('--dest', required=True,
                      help='Destination path on device')

    # Mount
    mount_p = subparsers.add_parser('mount', help='Mount folder only')
    mount_p.add_argument('--port', required=True)
    mount_p.add_argument('--folder', required=True)

    # shell
    shell_p = subparsers.add_parser('shell', help='Run interactive shell using native miniterm')
    shell_p.add_argument('--port', required=True)

    # Unmount
    unmount_p = subparsers.add_parser('unmount', help='Unmount /remote')
    unmount_p.add_argument('--port', required=True)

    # Kick
    kick_p = subparsers.add_parser(
        'kick', help='Wake up a device using hardware reset lines')
    kick_p.add_argument('--port', required=True)

    # Hard reset
    hr_p = subparsers.add_parser(
        'hard_reset', help='Force hardware reset and software reboot')
    hr_p.add_argument('--port', required=True)

    # mip
    mip_p = subparsers.add_parser('mip', help='Install package via on-device mip')
    mip_p.add_argument('--port', required=True)
    mip_p.add_argument('--package', required=True, help='Package name')
    mip_p.add_argument('--index', help='Optional index URL')

    args = parser.parse_args()

    # Dispatch
    if args.command == 'run':
        cmd_run(args.python, args.port, args.file, args.folder)
    elif args.command == 'run_mcu':
        # Default to soft-resetting unless --no-reset provided
        soft_reset = not getattr(args, 'no_reset', False)
        cmd_run_mcu(args.python, args.port, args.file, 
                    soft_reset=soft_reset, quiet=args.quiet)
    elif args.command == 'mount':
        cmd_mount(args.python, args.port, args.folder)
    elif args.command == 'shell':
        cmd_shell(args.python, args.port)
    elif args.command == 'unmount':
        cmd_unmount(args.python, args.port)
    elif args.command == 'exec':
        cmd_exec(args.python, args.port, args.code)
    elif args.command == 'upload':
        cmd_upload(args.python, args.port, args.source,
                   args.dest, args.overwrite)
    elif args.command == 'download':
        owf = [f for f in args.overwrite_files.split(
            '|') if f] if args.overwrite_files else None
        cmd_download(args.python, args.port, args.dest,
                     args.overwrite, args.skip, args.rename, owf)
    elif args.command == 'ls':
        cmd_ls(args.python, args.port, args.path)
    elif args.command == 'cat':
        cmd_cat(args.python, args.port, args.path)
    elif args.command == 'rm':
        cmd_rm(args.python, args.port, args.path, args.recursive)
    elif args.command == 'mv':
        cmd_mv(args.python, args.port, args.src, args.dest)
    elif args.command == 'kick':
        cmd_kick(args.python, args.port)
    elif args.command == 'hard_reset':
        cmd_hard_reset(args.python, args.port)
    elif args.command == 'mip':
        cmd_mip(args.python, args.port, args.package, args.index)
    elif args.command == 'mkdir':
        cmd_mkdir(args.python, args.port, args.path)
    elif args.command == 'rename':
        cmd_rename(args.python, args.port, args.src, args.dest)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        import sys
        print("\n\n [INFO] Script manually interrupted. Exiting cleanly.", file=sys.stderr)
        sys.exit(0)
