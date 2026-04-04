# mpremotesubpro.py
import argparse
import re
import subprocess
import sys
import struct
import time
from pathlib import Path
from typing import Any, Union


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

def _print_ui_header(port, folder, file_path):
    """Prints a professional UI header for the execution session."""
    file_name = Path(file_path).name
    folder_name = Path(folder).name if folder else "Device Filesystem"
    
    # Modern Box Drawing UI
    print(f"\n{CLR_CYAN}╔════════════════════════════════════════════════════════════════════════{CLR_RESET}")
    print(f"{CLR_CYAN}║{CLR_RESET}  {CLR_BOLD} MicroPython Studio - Execution Session{CLR_RESET}")
    print(f"{CLR_CYAN}╠══════════════════════════════════════════════════════════════════════════{CLR_RESET}")
    print(f"{CLR_CYAN}║{CLR_RESET}  {CLR_DIM} Project:{CLR_RESET}  {folder_name:<46}{CLR_CYAN}{CLR_RESET}")
    print(f"{CLR_CYAN}║{CLR_RESET}  {CLR_DIM} Port:   {CLR_RESET}  {port:<46}     {CLR_CYAN}{CLR_RESET}")
    print(f"{CLR_CYAN}║{CLR_RESET}  {CLR_DIM} Running:{CLR_RESET}  {file_name:<46}{CLR_CYAN}{CLR_RESET}")
    print(f"{CLR_CYAN}╚══════════════════════════════════════════════════════════════════════════{CLR_RESET}\n")

# Files/folders to avoid downloading from device to local project
DOWNLOAD_EXCLUDE = {
    'settings.toml',             # CircuitPython/MicroPython credentials
    'boot_out.txt',              # CircuitPython auto-generated
    '.Trashes',                  # macOS
    '.fseventsd',                # macOS
    '.Spotlight-V100',           # macOS
    '.metadata_never_index',     # macOS
    'System Volume Information', # Windows
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
            data = data.decode('latin-1')  # latin-1 preserves raw byte values as-is
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
            raise ConnectionError(f'WebREPL authentication failed. Check password. Got: {resp!r}')

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
            sys.stdout.buffer.write(stdout_data)
            sys.stdout.buffer.flush()

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
            len(dest_bytes), # filename length
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
            time.sleep(0.03)  # 30 ms — gives the device time to drain its buffer

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

    def connect(self):
        import serial
        self.serial = serial.Serial(self.port, self.baudrate, timeout=1)

    def close(self):
        if self.serial:
            self.serial.close()

    def _drain(self):
        """Consume all pending bytes aggressively."""
        deadline = time.time() + 0.3
        while time.time() < deadline:
            if self.serial.in_waiting:
                self.serial.read(self.serial.in_waiting)
                deadline = time.time() + 0.1 # reset deadline if data still arriving
            time.sleep(0.01)

    def enter_raw_repl(self, soft_reset=True):
        """Aggressively enter raw REPL mode."""
        self.serial.write(b'\r\x03\x03\x03') # Ctrl-C storm
        time.sleep(0.1)
        if soft_reset:
            self.serial.write(b'\x04') # Ctrl-D
            time.sleep(1.5) # Wait for reboot
            self.serial.write(b'\x03\x03') # Interrupt boot script
        
        self._drain()
        self.serial.write(b'\x01') # Ctrl-A (Raw REPL)
        time.sleep(0.1)
        
        # Read until we see the prompt '>' or timeout
        data = b''
        deadline = time.time() + 2
        while time.time() < deadline:
            if self.serial.in_waiting:
                data += self.serial.read(self.serial.in_waiting)
                if data.endswith(b'>'):
                    return True
            time.sleep(0.05)
        return False

    def exec_code(self, code: Union[str, bytes], timeout=30):
        if not self.enter_raw_repl(soft_reset=False):
             # Try one more time with soft reset if polite entry failed
            if not self.enter_raw_repl(soft_reset=True):
                raise Exception("Could not enter raw REPL via serial")

        code_buf = code.encode() if isinstance(code, str) else code
        self.serial.write(code_buf + b'\x04') # Code + Ctrl-D

        # Read: OK<stdout>\x04<stderr>\x04>
        buf = bytearray()
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.serial.in_waiting:
                buf.extend(self.serial.read(self.serial.in_waiting))
                if buf.endswith(b'\x04>'):
                    break
            time.sleep(0.02)
        
        # Exit raw REPL
        self.serial.write(b'\x02') # Ctrl-B
        
        raw = bytes(buf)
        if raw.startswith(b'OK'): raw = raw[2:]
        parts = raw.split(b'\x04')
        stdout = parts[0] if len(parts) > 0 else b''
        stderr = parts[1] if len(parts) > 1 else b''
        
        if stdout:
            sys.stdout.buffer.write(stdout)
            sys.stdout.buffer.flush()
        if stderr:
             sys.stderr.write(stderr.decode('utf-8', errors='replace'))
             return 1
        return 0

    def list_files(self, path='/'):
        """Fetch directory listing manually via raw REPL."""
        code = f"""
import os
try:
    for f in os.ilistdir({path!r}):
        size = f[3] if len(f)>3 else 0
        is_dir = (f[1] == 0x4000)
        name = f[0] + ('/' if is_dir else '')
        print('{{:10}} {{}}'.format(size, name))
except: pass
"""
        return self.exec_code(code)

    def put_file(self, source_path: Path, remote_path: str):
        """Upload a file using hex-encoding chunk by chunk."""
        import binascii
        data = source_path.read_bytes()
        dest = remote_path.replace('\\', '/')
        
        print(f"📤 Robust upload: {source_path.name} -> {dest} ({len(data)} bytes)", file=sys.stderr)
        
        # 1. Initialize file
        self.exec_code(f"f=open({dest!r},'wb')\nf.close()")
        
        # 2. Append hex-encoded chunks (safe-sized chunks for ESP/Pico buffers)
        chunk_size = 120 # 60 bytes of binary
        hex_data = binascii.hexlify(data).decode()
        
        total_chunks = (len(hex_data) + chunk_size - 1) // chunk_size
        for i in range(0, len(hex_data), chunk_size):
            chunk = hex_data[i:i+chunk_size]
            code = f"import binascii; f=open({dest!r},'ab'); f.write(binascii.unhexlify({chunk!r})); f.close()"
            self.exec_code(code)
            if (i // chunk_size) % 10 == 0:
                print(f"   [{ (i // chunk_size) + 1}/{total_chunks}]", file=sys.stderr)
        return 0

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
        run_mpremote(python_exe, ['connect', port, 'fs', 'mkdir', '/'.join(acc)], timeout=15)


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
    result = subprocess.run(
        [python_exe, '-m', 'mpremote', 'connect', port, 'fs', 'ls', f':{remote_path}'],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL, text=True, timeout=15
    )
    if result.returncode != 0:
        return set()
    files: set = set()
    for line in result.stdout.splitlines():
        trimmed = line.strip()
        if not trimmed or trimmed.startswith('ls'):
            continue
        m = re.match(r'^\s*\d+\s+(.+)$', trimmed)
        if m:
            name = m.group(1).strip()
            if not name.endswith('/'):   # skip subdirectories
                files.add(name)
    return files


def run_mpremote(python_exe, args_list, timeout=60):
    """Run mpremote and stream output in real-time with clean Ctrl+C handling"""
    cmd = [python_exe, '-m', 'mpremote'] + args_list

    proc = None
    try:
        # On Windows, CREATE_NEW_PROCESS_GROUP isolates the child from the
        # parent's console group so mpremote's internal Ctrl+C (sent via
        # serial to the device) does not propagate as KeyboardInterrupt here.
        # creationflags=0 is the default on all platforms so this is safe.
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.PIPE,
            text=True,
            encoding='utf-8',
            errors='replace',
            bufsize=1,
            creationflags=getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0) if sys.platform == 'win32' else 0
        )

        # Stream output line by line
        while True:
            try:
                line = proc.stdout.readline()  # type: ignore[union-attr]
                if line:
                    # Give a clear hint when a ws: connection is blocked
                    if 'failed to access' in line and args_list and any(a.startswith('ws:') for a in args_list):
                        print(line, end="")
                        print(
                            "💡 WebREPL tip: only one connection is allowed at a time.\n"
                            "   Close any open browser WebREPL tab (micropython.org/webrepl)\n"
                            "   and make sure no other mpremote session is running.",
                            file=sys.stderr
                        )
                    else:
                        # 🔇 Silence noisy "driver information" (long absolute paths)
                        # from mpremote to keep the professional look.
                        if "is mounted at /remote" in line or "Connected to " in line:
                            continue
                        print(line, end="")
                elif proc.poll() is not None:  # EOF and process has exited
                    break
            except KeyboardInterrupt:
                # KeyboardInterrupt can fire when mpremote sends \x03 to the
                # device on Windows even with CREATE_NEW_PROCESS_GROUP.
                # If mpremote already exited cleanly, treat this as normal completion.
                if proc.poll() is not None:
                    break  # process finished — not a real user Ctrl+C
                print("\n\n👋 Ctrl+C detected. Stopping...", file=sys.stderr)
                break

        # Terminate the process gracefully
        if proc.poll() is None:
            print("🔁 Sending soft reset (Ctrl+D) to device...", file=sys.stderr)
            # Note: mpremote auto-handles soft reset on exit
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except:
                proc.kill()

        return subprocess.CompletedProcess(cmd, proc.returncode or 0, "", "")

    except KeyboardInterrupt:
        print("\n\n👋 Script manually interrupted. Exiting cleanly.", file=sys.stderr)
        if proc:
            proc.terminate()
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
        print(f"📡 Wireless port detected — using direct run (no mount)", file=sys.stderr)
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

    # 🔥 Correct command: mount "folder" run "full/file/path"
    args = [
        'connect', port,
        'mount', str(folder),
        'run', str(file_path)  # ← Full path to the .py file
    ]

    result = run_mpremote(python_exe, args, timeout=30)

    # Auto-retry once on raw REPL failure (device may need an extra hard kick)
    if result.returncode != 0:
        print("💡 First attempt failed. Trying a hardware reset/kick...", file=sys.stderr)
        _serial_pre_interrupt(python_exe, port, hard=True)
        time.sleep(1.0)
        print("🔄 Retrying with mpremote...", file=sys.stderr)
        result = run_mpremote(python_exe, args, timeout=30)
        
    # Final fallback: if mpremote still fails, use our robust SerialConnection
    if result.returncode != 0:
        print("💡 mpremote still failing. Trying robust serial fallback...", file=sys.stderr)
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
        # Open with 1s timeout to ensure we don't hang if the port is busy elsewhere
        s = serial.Serial(port, 115200, timeout=1)
        
        if hard:
            # 💡 Hard Reset Sequence (ESP32/ESP8266 logic)
            # RTS pulls EN low (Reset), DTR pulls GPIO0 low (Boot)
            print(f"{CLR_YELLOW}🔌 Performing Hardware Reset (DTR/RTS) on {port}...{CLR_RESET}", file=sys.stderr)
            s.setRTS(True)
            s.setDTR(False)
            time.sleep(0.1)
            s.setRTS(False)  # Release reset
            time.sleep(0.5)  # Wait for boot
        
        # 💡 Ultimate Kick: Ctrl-C Storm + Soft Reset (Ctrl-D)
        print(f"{CLR_DIM}⚡ Synchronizing with device...{CLR_RESET}", file=sys.stderr)
        for _ in range(10):
            s.write(b'\x03')  # Ctrl-C
            time.sleep(0.01)
        
        s.write(b'\x04')      # Ctrl-D (Soft Reboot)
        time.sleep(1.5)       # CRITICAL: Wait for MicroPython to re-initialize
        
        for _ in range(5):
            s.write(b'\x03')  # Ctrl-C again to clear any boot messages
            time.sleep(0.01)

        s.write(b'\r')
        time.sleep(0.05)
        
        s.close()
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


def cmd_run_mcu(python_exe, port, file_path):
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

    # Serial: pre-interrupt any running code, then run
    _serial_pre_interrupt(python_exe, port, hard=False)
    args = ['connect', port, 'run', str(file_path)]
    result = run_mpremote(python_exe, args, timeout=30)

    # Auto-retry once on failure with hardware kick
    if result.returncode != 0:
        print("💡 First attempt failed. Trying a hardware reset/kick...", file=sys.stderr)
        _serial_pre_interrupt(python_exe, port, hard=True)
        time.sleep(1.0)
        print("🔄 Retrying with mpremote...", file=sys.stderr)
        result = run_mpremote(python_exe, args, timeout=30)

    # Final fallback: robust serial
    if result.returncode != 0:
        print("💡 mpremote still failing. Trying robust serial fallback...", file=sys.stderr)
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
    chunk_size = 120  # hex chars per line (60 bytes) — safe for raw REPL line buffer
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
                print(f"📤 Uploading {source.name} -> {remote}", file=sys.stderr)
                rc = _ws_upload_file(conn, source, remote)
                if rc == 0:
                    print(f"✅ Upload complete", file=sys.stderr)
            else:
                files = sorted(f for f in source.rglob('*') if f.is_file())
                if not files:
                    print("⚠️ Source folder is empty.", file=sys.stderr)
                    sys.exit(0)
                print(f"📁 Uploading {len(files)} file(s) from {source}", file=sys.stderr)
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
                    time.sleep(0.5)
                if rc == 0:
                    print(f"\n✅ Upload complete ({len(files)} file(s))", file=sys.stderr)
        except ConnectionError as e:
            print(f"❌ WebREPL connection failed: {e}", file=sys.stderr)
            rc = 1
        except Exception as e:
            print(f"❌ WebREPL upload error: {e}", file=sys.stderr)
            rc = 1
        finally:
            conn.close()
        sys.exit(rc)

    # ── Serial path — use mpremote ───────────────────────────────────────────
    if source.is_file():
        remote = dest.rstrip('/') + '/' + source.name
        print(f"📤 Uploading {source.name} -> {remote}", file=sys.stderr)
        # 💡 Safety delay to prevent port conflict
        time.sleep(0.5)
        result = run_mpremote(python_exe, ['connect', port, 'fs', 'cp', str(source), f':{remote}'], timeout=30)
        
        # Robust Fallback
        if result.returncode != 0:
             print("💡 mpremote failed. Trying robust serial fallback...", file=sys.stderr)
             conn = SerialConnection(port)
             try:
                 conn.connect()
                 rc = conn.put_file(source, remote)
                 sys.exit(rc)
             except Exception as e:
                 print(f"❌ Robust fallback also failed: {e}", file=sys.stderr)
                 sys.exit(1)
             finally: conn.close()
        sys.exit(result.returncode)

    files = sorted(f for f in source.rglob('*') if f.is_file())
    if not files:
        print("⚠️ Source folder is empty, nothing to upload.", file=sys.stderr)
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
            print(f"⚠️  These files already exist in {dest} on the device:", file=sys.stderr)
            for c in sorted(conflicts):
                print(f"   • {c}", file=sys.stderr)
            if not overwrite:
                # Exit code 3 signals the extension to show a confirmation dialog
                # and re-run with --overwrite if the user confirms.
                print("CONFLICTS_FOUND", flush=True)
                sys.exit(3)
            print("⚠️  Overwriting existing files...", file=sys.stderr)

    dirs_to_create = sorted(set(
        str(f.relative_to(source).parent).replace('\\', '/')
        for f in files if f.relative_to(source).parent != Path('.')
    ))

    print(f"📁 Uploading {len(files)} file(s) from {source}", file=sys.stderr)
    print(f"🔌 Port: {port}", file=sys.stderr)
    print("-" * 50, file=sys.stderr)

    # Create dest directory first (if not root), then any subdirectories inside it
    if dest != '/':
        print(f"📁 mkdir {dest}", file=sys.stderr)
        run_mpremote(python_exe, ['connect', port, 'fs', 'mkdir', dest], timeout=15)
    for d in dirs_to_create:
        remote_dir = dest.rstrip('/') + '/' + d
        print(f"📁 mkdir {remote_dir}", file=sys.stderr)
        run_mpremote(python_exe, ['connect', port, 'fs', 'mkdir', remote_dir], timeout=15)

    for i, f in enumerate(files, 1):
        rel = str(f.relative_to(source)).replace('\\', '/')
        remote = dest.rstrip('/') + '/' + rel
        print(f"[{i}/{len(files)}] {rel}", file=sys.stderr)
        
        time.sleep(0.5) # Port safety delay
        result = run_mpremote(python_exe, ['connect', port, 'fs', 'cp', str(f), f':{remote}'], timeout=30)
        
        # Robust Fallback per file
        if result.returncode != 0:
            print(f"💡 mpremote failed for {rel}. Trying robust fallback...", file=sys.stderr)
            conn = SerialConnection(port)
            try:
                conn.connect()
                rc = conn.put_file(f, remote)
                if rc != 0: sys.exit(rc)
            except Exception as e:
                print(f"❌ Robust fallback also failed for {rel}: {e}", file=sys.stderr)
                sys.exit(1)
            finally: conn.close()
            time.sleep(0.5)

    print(f"\n✅ Upload complete ({len(files)} file(s))", file=sys.stderr)
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
            import subprocess as _sp
            proc = _sp.Popen(
                [python_exe, '-m', 'mpremote', 'connect', port, 'run', str(tmp)],
                stdout=_sp.PIPE, stderr=_sp.PIPE, stdin=_sp.DEVNULL
            )
            raw_bytes, _ = proc.communicate(timeout=30)
            output = bytes(raw_bytes).decode('utf-8', errors='ignore')
    finally:
        try: tmp.unlink()
        except Exception: pass

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
                _owf: 'list[str]' = overwrite_files or []  # type: ignore[assignment]
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
            import subprocess as _sp
            time.sleep(0.5) # Port safety delay
            result = _sp.run(
                [python_exe, '-m', 'mpremote', 'connect', port,
                 'fs', 'cp', f':{remote_path}', str(local_path)],
                capture_output=True, timeout=30
            )
            if result.returncode != 0:
                err = result.stderr.decode('utf-8', errors='ignore').strip()
                print(f"❌ Failed: {remote_path}: {err}", file=sys.stderr)
                continue

        downloaded += 1

    print("-" * 50, file=sys.stderr)
    print(f"✅ Download complete: {downloaded} downloaded, {skipped} skipped.", file=sys.stderr)


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
    for f in os.ilistdir('{path}'):
        size = f[3] if len(f)>3 else 0
        is_dir = (f[1] == 0x4000)
        name = f[0] + ('/' if is_dir else '')
        print('{{:10}} {{}}'.format(size, name))
except:
    pass
"""
            import io as _io
            buf = _io.BytesIO()
            old = sys.stdout
            sys.stdout = _io.TextIOWrapper(buf, encoding='utf-8')
            conn.exec_code(code)
            sys.stdout.flush()
            sys.stdout = old
            sys.stdout.write(buf.getvalue().decode('utf-8', errors='ignore'))
        except Exception:
            pass
        finally:
            conn.close()
        sys.exit(0)

    # Serial
    time.sleep(0.5) # Port safety delay
    _serial_pre_interrupt(python_exe, port, hard=False)
    result = run_mpremote(python_exe, ['connect', port, 'fs', 'ls', path], timeout=15)
    
    if result.returncode != 0:
        print("💡 mpremote ls failed. Trying robust serial fallback...", file=sys.stderr)
        conn = SerialConnection(port)
        try:
            conn.connect()
            rc = conn.list_files(path)
            sys.exit(rc)
        except Exception as e:
             print(f"❌ Robust fallback also failed: {e}", file=sys.stderr)
             sys.exit(1)
        finally: conn.close()
        
    sys.exit(result.returncode)


# ----------------------------
# Command: exec
# ----------------------------
def cmd_exec(python_exe, port, code):
    if not code.strip():
        print("❌ No code to execute", file=sys.stderr)
        sys.exit(1)

    print(f"⚡ Executing: {code[:50]}{'...' if len(code) > 50 else ''}", file=sys.stderr)

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

    # Serial path: try mpremote first, then our robust SerialConnection
    result = run_mpremote(python_exe, ['connect', port, 'exec', code], timeout=15)
    if result.returncode != 0:
        print("💡 mpremote failed to execute. Trying robust serial fallback...", file=sys.stderr)
        conn = SerialConnection(port)
        try:
            conn.connect()
            rc = conn.exec_code(code)
            sys.exit(rc)
        except Exception as e:
            print(f"❌ Robust fallback also failed: {e}", file=sys.stderr)
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
    run_mcu_p.add_argument('--port', required=True, help='Serial port (e.g., COM9)')
    run_mcu_p.add_argument('--file', required=True, help='Full path to the .py file to run')

    # Upload
    upload_p = subparsers.add_parser('upload', help='Upload a file or folder to the device')
    upload_p.add_argument('--port', required=True, help='Serial port (e.g., COM9)')
    upload_p.add_argument('--source', required=True, help='Local file or folder to upload')
    upload_p.add_argument('--dest', default='/', help='Remote destination path (default: /)')
    upload_p.add_argument('--overwrite', action='store_true', help='Overwrite existing files without prompting')

    # Download
    dl_p = subparsers.add_parser('download', help='Download all files from device to local folder')
    dl_p.add_argument('--port', required=True, help='Serial port or ws: address')
    dl_p.add_argument('--dest', required=True, help='Local destination folder (e.g. main/)')
    dl_p.add_argument('--overwrite', action='store_true', help='Overwrite all existing local files')
    dl_p.add_argument('--skip', action='store_true', help='Skip files that already exist locally')
    dl_p.add_argument('--rename', action='store_true', help='Keep both by renaming the incoming file')
    dl_p.add_argument('--overwrite-files', default='', help='Pipe-separated list of specific files to overwrite')

    # Exec
    exec_p = subparsers.add_parser('exec', help='Execute code on device')
    exec_p.add_argument('--port', required=True, help='Serial port (e.g., COM9)')
    exec_p.add_argument('--code', required=True, help='Code to execute')

    # ls
    ls_p = subparsers.add_parser('ls', help='List files on device')
    ls_p.add_argument('--port', required=True)
    ls_p.add_argument('--path', default='/')

    # Mount
    mount_p = subparsers.add_parser('mount', help='Mount folder only')
    mount_p.add_argument('--port', required=True)
    mount_p.add_argument('--folder', required=True)

    # Unmount
    unmount_p = subparsers.add_parser('unmount', help='Unmount /remote')
    unmount_p.add_argument('--port', required=True)

    # Kick
    kick_p = subparsers.add_parser('kick', help='Wake up a device using hardware reset lines')
    kick_p.add_argument('--port', required=True)

    # Hard reset
    hr_p = subparsers.add_parser('hard_reset', help='Force hardware reset and software reboot')
    hr_p.add_argument('--port', required=True)

    args = parser.parse_args()

    # Dispatch
    if args.command == 'run':
        cmd_run(args.python, args.port, args.file, args.folder)
    elif args.command == 'run_mcu':
        cmd_run_mcu(args.python, args.port, args.file)
    elif args.command == 'mount':
        cmd_mount(args.python, args.port, args.folder)
    elif args.command == 'unmount':
        cmd_unmount(args.python, args.port)
    elif args.command == 'exec':
        cmd_exec(args.python, args.port, args.code)
    elif args.command == 'upload':
        cmd_upload(args.python, args.port, args.source, args.dest, args.overwrite)
    elif args.command == 'download':
        owf = [f for f in args.overwrite_files.split('|') if f] if args.overwrite_files else None
        cmd_download(args.python, args.port, args.dest, args.overwrite, args.skip, args.rename, owf)
    elif args.command == 'ls':
        cmd_ls(args.python, args.port, args.path)
    elif args.command == 'kick':
        cmd_kick(args.python, args.port)
    elif args.command == 'hard_reset':
        cmd_hard_reset(args.python, args.port)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        import sys
        print("\n\n👋 Script manually interrupted. Exiting cleanly.", file=sys.stderr)
        sys.exit(0)
