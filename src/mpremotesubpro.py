# mpremotesubpro.py
import argparse
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


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
    CHUNK = 256  # raw-REPL send chunk size

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
            if isinstance(data, str):
                return data.encode('utf-8')
            return data or b''
        except _wslib.WebSocketTimeoutException:
            return b''
        except Exception:
            return b''

    # ── Connect and authenticate ─────────────────────────────────────────────

    def connect(self):
        import websocket as _wslib  # type: ignore[import]
        url = f'ws://{self.host}:{self.port}'
        self.ws = _wslib.create_connection(url, timeout=15)

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

    def exec_code(self, code: 'str | bytes', timeout: float = 30) -> int:
        """
        Execute code via raw REPL. Streams stdout to sys.stdout.
        Raw REPL response format after Ctrl+D:  OK<stdout>\x04<stderr>\x04>
        Returns 0 on success, 1 if there was stderr output.
        """
        code_buf: bytearray = bytearray(code.encode() if isinstance(code, str) else code)

        self._enter_raw_repl()

        # Send code in CHUNK-byte pieces then Ctrl+D to execute
        offset = 0
        while offset < len(code_buf):
            self._ws_send(bytes(code_buf[offset:offset + self.CHUNK]))  # type: ignore[index]
            offset += self.CHUNK
            time.sleep(0.02)
        self._ws_send('\x04')

        # Accumulate response until we see the end marker \x04>
        buf: bytearray = bytearray()
        deadline = time.time() + timeout
        while time.time() < deadline:
            chunk = self._ws_recv(2)
            if chunk:
                buf.extend(chunk)
                if b'\x04>' in buf:
                    break

        self._exit_raw_repl()

        # Parse:  OK<stdout>\x04<stderr>\x04>
        raw: bytearray = buf
        if raw.startswith(b'OK'):
            raw = bytearray(raw[2:])  # type: ignore[index]

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
        """Upload a file using raw REPL (base64 chunks — works for any file size)."""
        import binascii
        data = Path(local_path).read_bytes()
        hex_data = binascii.hexlify(data).decode()

        # Write in 128-byte hex chunks to avoid raw REPL line length limits
        chunk_size = 128
        code_lines = [
            f"import binascii",
            f"_f = open({remote_path!r}, 'wb')",
        ]
        for i in range(0, len(hex_data), chunk_size):
            chunk = hex_data[i:i + chunk_size]  # type: ignore[index]
            code_lines.append(f"_f.write(binascii.unhexlify({chunk!r}))")
        code_lines.append("_f.close()")
        code_lines.append("print('OK')")

        return self.exec_code('\n'.join(code_lines))


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
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.PIPE,
            text=True,
            encoding='utf-8',
            errors='replace',
            bufsize=1
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
                        print(line, end="")
                elif proc.poll() is not None:  # EOF and process has exited
                    break
            except KeyboardInterrupt:
                # This catches Ctrl+C while reading output
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

    print(f"📁 Mounting: {folder}", file=sys.stderr)
    print(f"🚀 Running: {file_path}", file=sys.stderr)
    print(f"🔌 Port: {port}", file=sys.stderr)
    print("-" * 50, file=sys.stderr)

    # 🔥 Correct command: mount "folder" run "full/file/path"
    args = [
        'connect', port,
        'mount', str(folder),
        'run', str(file_path)  # ← Full path to the .py file
    ]

    result = run_mpremote(python_exe, args, timeout=30)
    sys.exit(result.returncode)

# ----------------------------
# Command: run_mcu (mpremote run — no mount, file sent directly to device)
# ----------------------------


def cmd_run_mcu(python_exe, port, file_path):
    file_path = Path(file_path).resolve()
    if not file_path.is_file():
        print(f"❌ File not found: {file_path}", file=sys.stderr)
        sys.exit(1)

    print(f"🚀 Running on MCU: {file_path}", file=sys.stderr)
    print(f"🔌 Port: {port}", file=sys.stderr)
    print("-" * 50, file=sys.stderr)

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

    # Serial: use mpremote as normal
    args = ['connect', port, 'run', str(file_path)]
    result = run_mpremote(python_exe, args, timeout=30)
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

def _ws_upload_file(conn: WebReplConnection, source: Path, remote: str) -> int:
    """Upload a single file via WebREPL raw REPL using hex encoding."""
    import binascii
    data = source.read_bytes()
    hex_data = binascii.hexlify(data).decode()
    # Build Python code that reconstructs the file on the device
    chunk_size = 120  # hex chars per line (60 bytes) — safe for raw REPL line buffer
    lines = ['import binascii', f"_f=open({remote!r},'wb')"]
    for i in range(0, len(hex_data), chunk_size):
        chunk = hex_data[i:i+chunk_size]  # type: ignore[index]
        lines.append(f"_f.write(binascii.unhexlify({chunk!r}))")
    lines.append('_f.close()')
    lines.append("print('OK')")
    return conn.exec_code('\n'.join(lines))


def cmd_upload(python_exe, port, source, dest: str = '/'):
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
        result = run_mpremote(python_exe, ['connect', port, 'fs', 'cp', str(source), f':{remote}'], timeout=30)
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
            answer = input("Overwrite? [y/N]: ").strip().lower()
            if answer != 'y':
                print("❌ Upload cancelled.", file=sys.stderr)
                sys.exit(0)

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
        result = run_mpremote(python_exe, ['connect', port, 'fs', 'cp', str(f), f':{remote}'], timeout=30)
        if result.returncode != 0:
            print(f"❌ Failed to upload {rel}", file=sys.stderr)
            sys.exit(result.returncode)

    print(f"\n✅ Upload complete ({len(files)} file(s))", file=sys.stderr)
    sys.exit(0)


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

    result = run_mpremote(python_exe, ['connect', port, 'exec', code], timeout=10)
    if result.returncode != 0:
        sys.exit(result.returncode)

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

    # Exec
    exec_p = subparsers.add_parser('exec', help='Execute code on device')
    exec_p.add_argument('--port', required=True, help='Serial port (e.g., COM9)')
    exec_p.add_argument('--code', required=True, help='Code to execute')

    # Mount
    mount_p = subparsers.add_parser('mount', help='Mount folder only')
    mount_p.add_argument('--port', required=True)
    mount_p.add_argument('--folder', required=True)

    # Unmount
    unmount_p = subparsers.add_parser('unmount', help='Unmount /remote')
    unmount_p.add_argument('--port', required=True)

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
        cmd_upload(args.python, args.port, args.source, args.dest)


if __name__ == '__main__':
    main()
