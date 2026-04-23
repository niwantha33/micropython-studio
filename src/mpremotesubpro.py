# mpremotesubpro.py
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

    # Content lines (without any extra spaces)
    lines = [
        f"Project: {folder_name}",
        f"Port:    {port}",
        f"Running: {file_name}",
        f"Started: {timestamp}"
    ]
    title = "MicroPython Studio Execution Session"

    # Find the longest line (visual length, ignoring ANSI codes if any)
    max_len = max(len(title), max(len(line) for line in lines))

    # Optional: add extra padding to make the box wider (e.g., +4)
    extra_padding = 4   # Change this to make box bigger or smaller
    content_width = max_len + extra_padding

    # Box width includes: left border (1) + space (1) + content_width + space (1) + right border (1)
    box_width = content_width + 4

    # Top border
    print(f"{CLR_CYAN}╔{'═' * (box_width - 2)}╗{CLR_RESET}")

    # Title (centered or left-aligned? left-aligned as before)
    print(f"{CLR_CYAN}║{CLR_RESET} {title:<{content_width}} {CLR_CYAN}║{CLR_RESET}")

    # Separator
    print(f"{CLR_CYAN}╠{'═' * (box_width - 2)}╣{CLR_RESET}")

    # Key-value lines
    for line in lines:
        print(f"{CLR_CYAN}║{CLR_RESET} {line:<{content_width}} {CLR_CYAN}║{CLR_RESET}")

    # Bottom border
    print(f"{CLR_CYAN}╚{'═' * (box_width - 2)}╝{CLR_RESET}\n")

# Usage example:
# print_execution_header("MyProject", "COM3", "main.py")


def _strip_ansi(data: bytes) -> bytes:
    """Helper to strip terminal escape sequences from the serial buffer."""
    return ANSI_STRIP_RE.sub(b'', data)


def _write_bytes_stdout(data: bytes):
    """Safely write bytes to sys.stdout even if it is redirected to a StringIO text buffer."""
    try:
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    except AttributeError:
        # sys.stdout is likely redirected to a text stream (e.g. io.StringIO in cmd_mip)
        sys.stdout.write(data.decode('utf-8', errors='replace'))
        sys.stdout.flush()


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

    def exec_code(self, code: 'Union[str, bytes]', timeout: float = 30) -> int:
        """
        Execute code via raw REPL. Streams stdout to sys.stdout.
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
            # Minimal sleep to allow small device buffers to catch up if needed
            # but much less than the original 0.02s
            time.sleep(0.001)

        self._ws_send('\x04')  # Ctrl+D to execute

        # Accumulate response until we see the end marker \x04>
        buf = bytearray()
        deadline = time.time() + timeout
        while time.time() < deadline:
            chunk = self._ws_recv(1)  # short timeout for chunks
            if chunk:
                buf.extend(chunk)
                if buf.endswith(b'\x04>'):
                    break
            else:
                # No data yet, wait a bit
                time.sleep(0.01)

        self._exit_raw_repl()

        # Parse:  OK<stdout>\x04<stderr>\x04>
        raw = bytes(buf)
        if raw.startswith(b'OK'):
            raw = raw[2:]

        # Split on \x04 — [stdout, stderr, '>']
        parts = bytes(raw).split(b'\x04')
        stdout_data = parts[0] if len(parts) > 0 else b''
        stderr_data = parts[1].strip(b'>').strip() if len(parts) > 1 else b''

        if stdout_data:
            _write_bytes_stdout(stdout_data)

        if stderr_data:
            sys.stderr.write(stderr_data.decode('utf-8', errors='replace'))
            return 1
        return 0

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

    def __init__(self, port: str, baudrate: int = 115200) -> None:
        self.port = port
        self.baudrate = baudrate
        self.serial: 'Any' = None

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
        try:
            # Creating serial object without port avoids automatic DTR/RTS assertions on connect
            self.serial = serial.Serial(None, self.baudrate, timeout=1)
            self.serial.port = self.port
            self.serial.dtr = False
            self.serial.rts = False
            self.serial.open()
        except serial.SerialException as e:
            if "Access is denied" in str(e) or "PermissionError" in str(e):
                raise Exception(f"Port {self.port} is BUSY. Please close any other terminal (like the shell) and try again.")
            raise Exception(f"Could not open port {self.port}: {e}")
        except Exception as e:
            raise Exception(f"Serial connection error on {self.port}: {e}")

    def close(self):
        if self.serial:
            self.serial.close()

    def _drain(self):
        """Consume all pending bytes aggressively."""
        deadline = time.time() + 0.3
        while time.time() < deadline:
            wait = self.in_waiting_safe
            if wait > 0:
                self.serial.read(wait)
                deadline = time.time() + 0.1  # reset deadline if data still arriving
            else:
                # Try reading one byte just in case in_waiting is flaky
                if self.serial.read(1):
                    deadline = time.time() + 0.1
                else:
                    time.sleep(0.01)

    def enter_raw_repl(self, soft_reset=True):
        """Aggressively enter raw REPL mode with firmware-aware synchronization."""
        sys.stderr.write(f"DEBUG: [SerialConnection] Entering raw REPL (soft_reset={soft_reset})\n")
        # 1. Break any running code with multiple interrupts
        self.serial.write(b'\r\x03\x03\x03\x03\x03')
        time.sleep(0.4) # Slightly longer for XBee stability

        if soft_reset:
            sys.stderr.write("DEBUG: [SerialConnection] Sending soft reset (Ctrl-D)\n")
            # 2. Trigger soft reboot
            self.serial.write(b'\x04')

            # 3. Wait for the reboot confirmation
            deadline = time.time() + 8.0
            rebooted = False
            data = b''
            while time.time() < deadline:
                if self.in_waiting_safe:
                    data += self.serial.read(self.in_waiting_safe)
                    clean_data = _strip_ansi(data)
                    if b'soft reboot' in clean_data or b'MPY: soft reboot' in clean_data:
                        rebooted = True
                        break
                else:
                    b = self.serial.read(1)
                    if b:
                        data += b
                        clean_data = _strip_ansi(data)
                        if b'soft reboot' in clean_data or b'MPY: soft reboot' in clean_data:
                            rebooted = True
                            break
                    else:
                        time.sleep(0.1)

            if not rebooted:
                sys.stderr.write("DEBUG: [SerialConnection] Soft reboot message not detected (timed out or quiet firmware)\n")
                time.sleep(0.5)

            # 4. Break again to catch the board before main.py takes over
            self.serial.write(b'\x03\x03')

        self._drain()

        # 5. Enter raw REPL mode (Ctrl-A)
        sys.stderr.write("DEBUG: [SerialConnection] Sending Ctrl-A to enter raw REPL\n")
        self.serial.write(b'\x01')
        time.sleep(0.3)

        # 6. Read until we see the prompt '>'
        data = b''
        deadline = time.time() + 6.0
        while time.time() < deadline:
            if self.in_waiting_safe:
                data += self.serial.read(self.in_waiting_safe)
                if b'>' in _strip_ansi(data):
                    sys.stderr.write("DEBUG: [SerialConnection] Raw REPL prompt '>' detected.\n")
                    return True
            else:
                b = self.serial.read(1)
                if b:
                    data += b
                    if b'>' in _strip_ansi(data):
                        sys.stderr.write("DEBUG: [SerialConnection] Raw REPL prompt '>' detected via read(1).\n")
                        return True
                else:
                    time.sleep(0.1)
        sys.stderr.write(f"DEBUG: [SerialConnection] FAILED to detect raw REPL prompt. Buffer: {data!r}\n")
        return False

    def _exec_raw_no_exit(self, code: Union[str, bytes], timeout=30):
        """Execute code on device and return (rc, stdout_bytes, stderr_bytes), but STAY in raw REPL mode."""
        self._drain()
        code_buf = code.encode() if isinstance(code, str) else code
        
        # Send code in safe chunks to avoid device UART buffer overflow
        chunk_size = 128
        for i in range(0, len(code_buf), chunk_size):
            self.serial.write(code_buf[i:i+chunk_size])
            time.sleep(0.01)
            
        self.serial.write(b'\x04')  # Ctrl-D

        # Read: OK<stdout>\x04<stderr>\x04>
        # We want to stream <stdout> in real-time
        buf = bytearray()
        deadline = time.time() + timeout
        
        # 1. Wait for 'OK'
        while time.time() < deadline:
            b = self.serial.read(1)
            if b:
                buf.extend(b)
                if buf.endswith(b'OK'):
                    break
            else:
                time.sleep(0.01)
        
        # 2. Stream until \x04
        stdout_buf = bytearray()
        while time.time() < deadline:
            b = self.serial.read(1)
            if b:
                if b == b'\x04':
                    break
                stdout_buf.extend(b)
                _write_bytes_stdout(b) # Real-time stream to IDE console
            else:
                time.sleep(0.01)
        
        # 3. Stream stderr until \x04
        stderr_buf = bytearray()
        while time.time() < deadline:
            b = self.serial.read(1)
            if b:
                if b == b'\x04':
                    break
                stderr_buf.extend(b)
                sys.stderr.write(b.decode('utf-8', errors='replace'))
            else:
                time.sleep(0.01)
        
        # 4. Final prompt
        self.serial.read_until(b'>')
        
        return (0 if not stderr_buf else 1), bytes(stdout_buf), bytes(stderr_buf)

    def exec_code(self, code: Union[str, bytes], timeout=30, soft_reset=False):
        """Execute code on device and return (rc, stdout_bytes, stderr_bytes)."""
        if soft_reset:
            if not self.enter_raw_repl(soft_reset=True):
                raise Exception("Could not enter raw REPL via soft reset")
        else:
            if not self.enter_raw_repl(soft_reset=False):
                if not self.enter_raw_repl(soft_reset=True):
                    raise Exception("Could not enter raw REPL via serial")

        try:
            rc, stdout, stderr = self._exec_raw_no_exit(code, timeout)
            # For general execution, we still want to show progress to the user
            if stdout:
                _write_bytes_stdout(stdout)
            if stderr:
                sys.stderr.write(stderr.decode('utf-8', errors='replace'))
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
        return self.exec_code(code)

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
            # Strategy A: Small files (< 512 bytes)
            if len(data) <= 512:
                hex_str = binascii.hexlify(data).decode()
                one_shot_code = (
                    f"import binascii\n"
                    f"try:\n"
                    f" import os\n"
                    f" try: os.remove({dest!r})\n"
                    f" except: pass\n"
                    f"except: pass\n"
                    f"try: import time; time.sleep(0.1)\n"
                    f"except: pass\n"
                    f"f=open({dest!r},'wb')\n"
                    f"f.write(binascii.unhexlify({hex_str!r}))\n"
                    f"f.close()"
                )
                return self._exec_raw_no_exit(one_shot_code)

            # Strategy B: Chunked upload for larger files
            # Initial cleanup and open
            setup_code = (
                f"import binascii, os, time\n"
                f"try: os.remove({dest!r})\n"
                f"except: pass\n"
                f"time.sleep(0.1)\n"
                f"_f=open({dest!r},'wb')"
            )
            self._exec_raw_no_exit(setup_code)

            chunk_size = 1024  # 512 bytes of binary
            hex_data = binascii.hexlify(data).decode()
            total_chunks = (len(hex_data) + chunk_size - 1) // chunk_size
            
            for i in range(total_chunks):
                chunk = hex_data[i*chunk_size : (i+1)*chunk_size]
                chunk_code = f"_f.write(binascii.unhexlify({chunk!r}))"
                self._exec_raw_no_exit(chunk_code)
                
                # Progress bar for files > 10KB
                if len(data) > 10240 and i % 5 == 0:
                    percent = int((i+1) / total_chunks * 100)
                    bar = ('#' * (percent // 10)).ljust(10, '.')
                    sys.stderr.write(f"\r   [{bar}] {percent}% - {source_path.name}")
                    sys.stderr.flush()

            # Finalize
            self._exec_raw_no_exit("_f.close()")
            sys.stderr.write(f"\nDEBUG: Upload of {source_path.name} finalized.\n")
            return 0
        finally:
            self.serial.write(b'\x02')  # Exit raw REPL

    def put_directory(self, source_dir: Path, remote_dir: str):
        """Recursively upload a directory to the device."""
        remote_dir = remote_dir.replace('\\', '/').rstrip('/')
        files = sorted(f for f in source_dir.rglob('*') if f.is_file())
        sys.stderr.write(f"DEBUG: Scanning {source_dir} -> Found {len(files)} files to upload to {remote_dir}\n")
        
        # 1. Create directories first
        dirs = sorted(set(
            str(f.relative_to(source_dir).parent).replace('\\', '/')
            for f in files if f.relative_to(source_dir).parent != Path('.')
        ))
        
        # Enter raw REPL once
        sys.stderr.write("DEBUG: Entering raw REPL for bulk upload...\n")
        if not self.enter_raw_repl(soft_reset=False):
            sys.stderr.write("DEBUG: Failed to enter raw REPL normally, trying soft reset...\n")
            if not self.enter_raw_repl(soft_reset=True):
                raise Exception(f"Could not enter raw REPL for directory upload")

        try:
            # Create base remote_dir if it's not root
            if remote_dir != '/':
                sys.stderr.write(f"DEBUG: Ensuring directory {remote_dir} exists\n")
                self._exec_raw_no_exit(f"import os\ntry: os.mkdir({remote_dir!r})\nexcept: pass")
            
            for d in dirs:
                full_remote_dir = f"{remote_dir}/{d}"
                sys.stderr.write(f"DEBUG: Creating subdirectory {full_remote_dir}\n")
                self._exec_raw_no_exit(f"import os\ntry: os.mkdir({full_remote_dir!r})\nexcept: pass")

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
        """Internal helper for uploading a file while ALREADY in raw REPL mode."""
        import binascii
        data = source_path.read_bytes()
        dest = remote_path.replace('\\', '/')

        # Initial cleanup and open
        setup_code = (
            f"import binascii, os, time\n"
            f"try: os.remove({dest!r})\n"
            f"except: pass\n"
            f"time.sleep(0.01)\n"
            f"_f=open({dest!r},'wb')"
        )
        self._exec_raw_no_exit(setup_code)

        chunk_size = 1024
        hex_data = binascii.hexlify(data).decode()
        total_chunks = (len(hex_data) + chunk_size - 1) // chunk_size

        for i in range(0, len(hex_data), chunk_size):
            chunk = hex_data[i:i+chunk_size]
            self._exec_raw_no_exit(f"_f.write(binascii.unhexlify({chunk!r}))")
        
        self._exec_raw_no_exit("_f.close()")

    def get_file(self, remote_path: str, local_path: Path):
        """Download a file using hex-encoding via stdout."""
        dest = remote_path.replace('\\', '/')
        code = f"import binascii; f=open({dest!r},'rb'); print(binascii.hexlify(f.read()).decode()); f.close()"

        import io as _io
        import binascii as _ba
        buf = _io.BytesIO()
        old_stdout = sys.stdout
        sys.stdout = _io.TextIOWrapper(buf, encoding='utf-8')
        try:
            rc = self.exec_code(code)
            sys.stdout.flush()
        finally:
            sys.stdout = old_stdout

        if rc == 0:
            hex_str = buf.getvalue().decode('utf-8', errors='ignore').strip()
            local_path.write_bytes(_ba.unhexlify(hex_str))
            return 0
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

def cmd_mip(python_exe: str, port: str, package: str, index: str = None):
    """Install a package on-device, falling back to PC-side download if needed."""
    sys.stderr.write(f"DEBUG: Starting mip installation for '{package}' on {port}\n")
    print(f"Installing '{package}' on device via mip...", file=sys.stderr)
    
    mip_code = f"""
import sys, os
try:
    import mip
except ImportError:
    try:
        import upip as mip
    except ImportError:
        print("ERROR: This device does not have 'mip' or 'upip' installed.")
        sys.exit(1)

try:
    print("mip.install({package!r})")
    mip.install({package!r}{f', index={index!r}' if index else ''})
    print("Installation successful!")
    sys.exit(0)
except OSError as e:
    if len(e.args) > 0 and e.args[0] == -6:
        print("NETWORK_ERROR")
    sys.exit(1)
except Exception as e:
    print(f"ERROR: Installation failed: {{e}}")
    sys.exit(1)
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
                rc, stdout, stderr = conn.exec_code(mip_code, timeout=120, soft_reset=False)
                
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
        sys.stderr.write(f"DEBUG: Digi/XBee package detected. Skipping on-device mip and forcing PC-side fallback.\n")
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
            
            sys.stderr.write(f"DEBUG: Finalizing upload from {actual_source} to /lib\n")
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
                            "💡 WebREPL tip: only one connection is allowed at a time.\n"
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
                print("\n\n👋 Ctrl+C detected. Stopping...", file=sys.stderr)
                break

        # Terminate the process gracefully
        if proc.poll() is None:
            print("🔁 Sending soft reset (Ctrl+D) to device...", file=sys.stderr)
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
        print("\n\n👋 Script manually interrupted. Exiting cleanly.", file=sys.stderr)
        if proc:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
        return subprocess.CompletedProcess(cmd, 0, "", "")
    except Exception as e:
        print(f"\n💥 Failed to run: {e}", file=sys.stderr)
        return subprocess.CompletedProcess(cmd, 1, "", str(e))
# ----------------------------
# Command: run (mount folder + run full file path)
# ----------------------------


def cmd_run(python_exe, port, file_path, folder=None):
    file_path = Path(file_path).resolve()
    if not file_path.is_file():
        print(f"❌ File not found: {file_path}", file=sys.stderr)
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
        print(f"❌ Mount folder not found: {folder}", file=sys.stderr)
        sys.exit(1)

    _print_ui_header(port, folder, file_path)

    # Pre-interrupt: send Ctrl+C to stop any running code on the device.
    # This prevents "could not enter raw repl" when the device is busy.
    _serial_pre_interrupt(python_exe, port, hard=False)
    time.sleep(1.0)
    # 🔥 Correct command: mount "folder" run "full/file/path"
    args = [
        'connect', port, 'resume',
        'mount', str(folder),
        'run', str(file_path)  # ← Full path to the .py file
    ]

    result = run_mpremote(python_exe, args, timeout=30)
    errors = ['TypeError', 'NameError', 'SyntaxError', 'ImportError', 'Traceback']
    if any(err in result.stdout for err in errors):
        sys.exit(result.returncode)
        
    # Auto-retry once on raw REPL failure (device may need an extra hard kick)
    if result.returncode != 0:
        print("💡 First attempt failed. Trying a hardware reset/kick...",
              file=sys.stderr)
        _serial_pre_interrupt(python_exe, port, hard=True)
        time.sleep(1.0)
        print("🔄 Retrying with mpremote...", file=sys.stderr)
        result = run_mpremote(python_exe, args, timeout=30)

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
            print(f"❌ Robust fallback also failed: {e}", file=sys.stderr)
            sys.exit(1)
        finally:
            conn.close()

    sys.exit(result.returncode)


def _serial_pre_interrupt(python_exe, port, hard=False):
    """Fast pre-interrupt using pyserial. Falls back to mpremote if serial is unavailable.
    If hard=True, toggles DTR/RTS to trigger a hardware reset on ESP32/8266.
    """
    if _is_ws_port(port):
        return

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

            # 💡 Hard Reset Sequence (ESP32/ESP8266 logic)
            # RTS pulls EN low (Reset), DTR pulls GPIO0 low (Boot)
            print(
                f"{CLR_YELLOW}🔌 Performing Hardware Reset (DTR/RTS) on {port}...{CLR_RESET}", file=sys.stderr)
            s.setRTS(True)
            s.setDTR(False)
            time.sleep(0.1)
            s.setRTS(False)  # Release reset
            time.sleep(0.5)  # Wait for boot
            s.close()

        # 💡 Ultimate Kick: Deliberate Sync without soft-rebooting
        print(f"{CLR_DIM}⚡ Synchronizing with device...{CLR_RESET}",
              file=sys.stderr)

        conn = SerialConnection(port)
        conn.connect()
        # Strictly breaks loop and enters raw REPL without triggering a soft reboot
        if conn.enter_raw_repl(soft_reset=False):
            # Exit raw REPL gracefully to friendly REPL so mpremote isn't confused
            conn.serial.write(b'\x02')
            time.sleep(0.1)
        conn.close()
        return
    except Exception as e:
        # If pyserial fails (e.g. port already open by another tool),
        # mpremote will likely fail too, but we try its polite method as fallback.
        pass

    try:
        subprocess.run(
            [python_exe, '-m', 'mpremote', 'connect', port, 'exec', 'print()'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL, timeout=2
        )
    except KeyboardInterrupt:
        print("\n\n👋 Script manually interrupted. Exiting cleanly.", file=sys.stderr)
        sys.exit(0)
    except Exception:
        pass  # best-effort — device may not respond


# ----------------------------
# Command: run_mcu (mpremote run — no mount, file sent directly to device)
# ----------------------------


def cmd_run_mcu(python_exe: str, port: str, file_path: str, soft_reset: bool = True):
    file_path = Path(file_path).resolve()
    if not file_path.is_file():
        print(f"❌ File not found: {file_path}", file=sys.stderr)
        sys.exit(1)

    _print_ui_header(port, None, file_path)

    # WebSocket: mpremote has no ws: transport — use our own WebREPL implementation
    if _is_ws_port(port):
        host, password = _parse_ws_port(port)
        conn = WebReplConnection(host, password)
        try:
            conn.connect()
            rc = conn.run_file(file_path)
        except ConnectionError as e:
            print(f"❌ WebREPL connection failed: {e}", file=sys.stderr)
            rc = 1
        except Exception as e:
            print(f"❌ WebREPL error: {e}", file=sys.stderr)
            rc = 1
        finally:
            conn.close()
        sys.exit(rc)

    # Serial: Execute natively using pure PySerial
    print(f"{CLR_DIM}⚡ Executing directly via pure serial...{CLR_RESET}", file=sys.stderr)
    conn = SerialConnection(port)
    try:
        conn.connect()
        code = Path(file_path).read_bytes()
        rc = conn.exec_code(code, soft_reset=soft_reset)
        sys.exit(rc)
    except Exception as e:
        print(f"❌ Pure serial execution failed: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        conn.close()


# ----------------------------
# Command: mount
# ----------------------------


def cmd_mount(python_exe, port, folder):
    folder = Path(folder).resolve()
    if not folder.is_dir():
        print(f"❌ Folder not found: {folder}", file=sys.stderr)
        sys.exit(1)

    print(f"📁 Mounting {folder} to /remote...", file=sys.stderr)
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
    return conn.exec_code('\n'.join(lines))


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
                    f"📤 Uploading {source.name} -> {remote}", file=sys.stderr)
                rc = _ws_upload_file(conn, source, remote)
                if rc == 0:
                    print(f"✅ Upload complete", file=sys.stderr)
            else:
                files = sorted(f for f in source.rglob('*') if f.is_file())
                if not files:
                    print("⚠️ Source folder is empty.", file=sys.stderr)
                    sys.exit(0)
                print(
                    f"📁 Uploading {len(files)} file(s) from {source}", file=sys.stderr)
                print(f"🔌 Port: {port}", file=sys.stderr)
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
                        print(f"❌ Failed: {rel}", file=sys.stderr)
                        break
                    # Brief pause between files so the device can finish
                    # writing to flash before the next transfer starts.
                    time.sleep(0.1)
                if rc == 0:
                    print(
                        f"\n✅ Upload complete ({len(files)} file(s))", file=sys.stderr)
        except ConnectionError as e:
            print(f"❌ WebREPL connection failed: {e}", file=sys.stderr)
            rc = 1
        except Exception as e:
            print(f"❌ WebREPL upload error: {e}", file=sys.stderr)
            rc = 1
        finally:
            conn.close()
        sys.exit(rc)

    # ── Serial path — use pure serial ───────────────────────────────────────────
    if source.is_file():
        remote = dest.rstrip('/') + '/' + source.name
        print(f"Uploading {source.name} -> {remote}", file=sys.stderr)
        # 💡 Safety delay to prevent port conflict
        time.sleep(0.1)

        conn = SerialConnection(port)
        try:
            conn.connect()
            rc = conn.put_file(source, remote)
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
                print(f"   • {c}", file=sys.stderr)
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
        "import os,json\n"
        "def _w(p,r):\n"
        " try:\n"
        "  for e in os.listdir(p):\n"
        "   f=(p+'/'+e).replace('//','/') \n"
        "   try:\n"
        "    if os.stat(f)[0]&0x4000:_w(f,r)\n"
        "    else:r.append(f)\n"
        "   except:pass\n"
        " except:pass\n"
        "r=[]\n"
        "_w('/',r)\n"
        "print(json.dumps(r))\n"
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
                import io as _io
                _buf = _io.BytesIO()
                old_stdout = sys.stdout
                sys.stdout = _io.TextIOWrapper(_buf, encoding='utf-8')
                conn.exec_code(walk_code)
                sys.stdout.flush()
                sys.stdout = old_stdout
                output = _buf.getvalue().decode('utf-8', errors='ignore')
            finally:
                conn.close()
        else:
            import io as _io
            conn = SerialConnection(port)
            try:
                conn.connect()
                _buf = _io.BytesIO()
                old_stdout = sys.stdout
                sys.stdout = _io.TextIOWrapper(_buf, encoding='utf-8')
                conn.exec_code(walk_code)
                sys.stdout.flush()
                sys.stdout = old_stdout
                output = _buf.getvalue().decode('utf-8', errors='ignore')
            except Exception as e:
                # Silently catch so that it returns empty list normally.
                pass
            finally:
                conn.close()
    finally:
        try:
            tmp.unlink()
        except Exception:
            pass

    for line in output.splitlines():
        line = line.strip()
        if line.startswith('['):
            try:
                return _json.loads(line)
            except Exception:
                pass
    return []


def cmd_download(python_exe: str, port: str, dest_dir: str,
                 overwrite: bool = False, skip: bool = False,
                 rename: bool = False,
                 overwrite_files: 'list[str] | None' = None) -> None:
    """Download all files from the device to a local directory."""
    import json as _json

    dest = Path(dest_dir).resolve()
    dest.mkdir(parents=True, exist_ok=True)

    print("🔍 Reading device filesystem...", file=sys.stderr)
    device_files = _get_device_files(python_exe, port)

    if not device_files:
        print("⚠️  No files found on device.", file=sys.stderr)
        sys.exit(0)

    print(f"📋 Found {len(device_files)} file(s) on device.", file=sys.stderr)

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
        print(f"🧹 Ignored {diff} system/junk file(s).", file=sys.stderr)
        device_files = filtered_files

    # Detect conflicts (files that already exist locally)
    conflicts = [
        f for f in device_files
        if (dest / f.lstrip('/')).exists()
    ]

    if conflicts and not overwrite and not skip and not rename and overwrite_files is None:
        # Signal the extension: print conflict list as JSON then exit 3
        for c in conflicts:
            print(f"   * {c}", file=sys.stderr)
        print(_json.dumps({'conflicts': conflicts}), flush=True)
        sys.exit(3)

    print(f"📥 Downloading to: {dest}", file=sys.stderr)
    print("-" * 50, file=sys.stderr)

    downloaded = 0
    skipped = 0

    for remote_path in device_files:
        rel = remote_path.lstrip('/')
        local_path = dest / rel

        # Decide: overwrite / skip / selective / rename
        if local_path.exists():
            if skip:
                print(f"⏭  Skipped:  {rel}", file=sys.stderr)
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
                # type: ignore[assignment]
                _owf: 'list[str]' = overwrite_files or []
                if overwrite_files is not None and remote_path not in _owf:
                    print(f"⏭  Skipped:  {rel}", file=sys.stderr)
                    skipped += 1
                    continue
            # fall through → download (either to original name if overwrite, or new name if renamed)

        # Create parent directories locally
        local_path.parent.mkdir(parents=True, exist_ok=True)

        print(f"⬇  {remote_path}  →  {rel}", file=sys.stderr)

        if _is_ws_port(port):
            host, password = _parse_ws_port(port)
            conn = WebReplConnection(host, password)
            try:
                conn.connect()
                # Read file via exec_code, capture output
                read_code = (
                    f"import binascii\n"
                    f"with open({remote_path!r},'rb') as _f:\n"
                    f"    print(binascii.hexlify(_f.read()).decode())\n"
                )
                import io as _io
                buf = _io.BytesIO()
                old = sys.stdout
                sys.stdout = _io.TextIOWrapper(buf, encoding='utf-8')
                conn.exec_code(read_code)
                sys.stdout.flush()
                sys.stdout = old
                hex_str = buf.getvalue().decode('utf-8', errors='ignore').strip()
                import binascii as _ba
                local_path.write_bytes(_ba.unhexlify(hex_str))
            finally:
                conn.close()
        else:
            time.sleep(0.5)  # Port safety delay
            conn = SerialConnection(port)
            try:
                conn.connect()
                # Read file via exec_code, capture output exactly like WebREPL
                read_code = (
                    f"import binascii\n"
                    f"with open({remote_path!r},'rb') as _f:\n"
                    f"    print(binascii.hexlify(_f.read()).decode())\n"
                )
                import io as _io
                buf = _io.BytesIO()
                old = sys.stdout
                sys.stdout = _io.TextIOWrapper(buf, encoding='utf-8')
                conn.exec_code(read_code)
                sys.stdout.flush()
                sys.stdout = old
                hex_str = buf.getvalue().decode('utf-8', errors='ignore').strip()
                import binascii as _ba
                local_path.write_bytes(_ba.unhexlify(hex_str))
            except Exception as e:
                print(f"❌ Failed: {remote_path}: {e}", file=sys.stderr)
                continue
            finally:
                conn.close()

        downloaded += 1

    print("-" * 50, file=sys.stderr)
    print(
        f"✅ Download complete: {downloaded} downloaded, {skipped} skipped.", file=sys.stderr)


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
    print(f"🔥 Performing hard reset on {port}...", file=sys.stderr)
    _serial_pre_interrupt(python_exe, port, hard=True)
    # Attempt to send software reset command if we can connect now
    args = ['connect', port, 'exec', 'import machine; machine.reset()']
    run_mpremote(python_exe, args, timeout=5)
    print("✅ Reset signal sent.", file=sys.stderr)
    sys.exit(0)


# ----------------------------
# Command: shell
# ----------------------------
def cmd_shell(python_exe, port):
    """Start an interactive Miniterem session via pure serial, without resetting the board."""
    if _is_ws_port(port):
        print("❌ Shell is not supported over WebREPL yet.", file=sys.stderr)
        sys.exit(1)
        
    print(f"{CLR_DIM}⚡ Syncing with device for interactive shell...{CLR_RESET}", file=sys.stderr)
    _serial_pre_interrupt(python_exe, port, hard=False)
    
    print(f"✅ Connected to MicroPython at {port}")
    print("Use Ctrl-] or Ctrl-x to exit this shell")
    
    # Hand over to miniterm, strictly configuring DTR=0 to prevent reboots
    import subprocess as _sp
    sys.exit(_sp.call([
        python_exe, '-m', 'serial.tools.miniterm',
        port, '115200', '--dtr=0', '--rts=0'
    ]))

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
        rc, stdout, stderr = conn.list_files(path)
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
    """Print file contents to stdout (text mode). Handles both serial and WebREPL."""
    code = f"""
try:
    _f = open({remote_path!r}, 'r')
    print(_f.read(), end='')
    _f.close()
except Exception as _e:
    import sys as _sys
    print(str(_e), file=_sys.stderr)
"""
    if _is_ws_port(port):
        host, password = _parse_ws_port(port)
        conn = WebReplConnection(host, password)
        try:
            conn.connect()
            conn.exec_code(code)
        except Exception as e:
            print(f"WebREPL cat failed: {e}", file=sys.stderr)
            sys.exit(1)
        finally:
            conn.close()
        sys.exit(0)

    # Serial
    conn = SerialConnection(port)
    try:
        conn.connect()
        rc, stdout, stderr = conn.exec_code(code)
        # Output is already printed by exec_code
    except Exception as e:
        print(f"Serial cat failed: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        conn.close()
    sys.exit(0)


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
        rc = conn.exec_code(code)
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
        cmd_run_mcu(args.python, args.port, args.file, soft_reset=soft_reset)
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


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        import sys
        print("\n\n👋 Script manually interrupted. Exiting cleanly.", file=sys.stderr)
        sys.exit(0)
