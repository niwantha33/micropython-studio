import sys
import json
import time
import serial
import threading
import struct
import os
import tempfile
import queue
from typing import Optional, Tuple

def _is_pid_running(pid: int) -> bool:
    if pid <= 0: return False
    try:
        if os.name == 'nt':
            import ctypes
            PROCESS_QUERY_INFORMATION = 0x0400
            process_handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_INFORMATION, False, pid)
            if process_handle:
                ctypes.windll.kernel32.CloseHandle(process_handle)
                return True
            return False
        else:
            os.kill(pid, 0)
            return True
    except:
        return False

g_verbose = False

def log_to_file(msg: str):
    pass

def _get_lock_path(port: str) -> str:
    safe_port = port.replace("\\", "_").replace("/", "_").replace(":", "_")
    lock_name = f"mps_lock_{safe_port}.lock"
    return os.path.join(tempfile.gettempdir(), lock_name)

def _acquire_lock(port: str) -> bool:
    lock_path = _get_lock_path(port)
    pid = os.getpid()
    log_to_file(f"Trying to acquire lock for port {port} at {lock_path}")
    if g_verbose:
        sys.stderr.write(f"[LOCK] PID {pid}: Trying to acquire lock for port {port} at {lock_path}\n")
    try:
        fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, f"{pid}:daemon".encode())
        os.close(fd)
        log_to_file(f"Acquired lock for port {port}")
        if g_verbose:
            sys.stderr.write(f"[LOCK] PID {pid}: Acquired lock for port {port}\n")
        return True
    except FileExistsError:
        try:
            with open(lock_path, 'r') as f:
                content = f.read().strip()
                parts = content.split(':')
                old_pid = int(parts[0])
                owner = parts[1] if len(parts) > 1 else "unknown"
            log_to_file(f"Port {port} is locked by PID {old_pid} ({owner})")
            if g_verbose:
                sys.stderr.write(f"[LOCK] PID {pid}: Port {port} is locked by PID {old_pid} ({owner})\n")
            is_parent = False
            try:
                if hasattr(os, 'getppid') and old_pid == os.getppid():
                    is_parent = True
            except:
                pass

            if not _is_pid_running(old_pid) or (owner == "suspended_lock" and is_parent):
                log_to_file(f"PID {old_pid} ({owner}) is stale or parent suspended_lock, removing lock file")
                if g_verbose:
                    sys.stderr.write(f"[LOCK] PID {pid}: PID {old_pid} ({owner}) is stale or parent suspended_lock, removing lock file\n")
                try: os.remove(lock_path)
                except: pass
                # Try one more time after removing stale lock
                fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, f"{pid}:daemon".encode())
                os.close(fd)
                log_to_file(f"Acquired lock after removing stale lock")
                if g_verbose:
                    sys.stderr.write(f"[LOCK] PID {pid}: Acquired lock after removing stale lock\n")
                return True
        except Exception as err:
            log_to_file(f"Error reading lock: {err}")
            if g_verbose:
                sys.stderr.write(f"[LOCK] PID {pid}: Error reading lock: {err}\n")
            pass
    return False

def _release_lock(port: str):
    lock_path = _get_lock_path(port)
    pid = os.getpid()
    log_to_file(f"Releasing lock for port {port}")
    if g_verbose:
        sys.stderr.write(f"[LOCK] PID {pid}: Releasing lock for port {port}\n")
    try:
        if os.path.exists(lock_path):
            with open(lock_path, 'r') as f:
                owner = f.read().strip()
            # Never remove another daemon's or the parent extension's lock.
            if owner != f"{pid}:daemon":
                return
            os.remove(lock_path)
            log_to_file("Lock released successfully")
            if g_verbose:
                sys.stderr.write(f"[LOCK] PID {pid}: Lock released successfully\n")
    except Exception as err:
        log_to_file(f"Error releasing lock: {err}")
        if g_verbose:
            sys.stderr.write(f"[LOCK] PID {pid}: Error releasing lock: {err}\n")
        pass

class MpyDaemon:
    def __init__(self, port: str, baudrate: int = 115200):
        self.port = port
        self.baudrate = baudrate
        self.serial: Optional[serial.Serial] = None
        self.running = False
        self.in_raw_repl = False
        self.suspended = False
        self._read_buf = b""
        # Reconnect can be requested from a normal terminal write while
        # holding this lock. Raw execution intentionally does NOT reconnect.
        self._lock = threading.RLock()
        self._state_lock = threading.Lock()
        self._event_lock = threading.Lock()
        # A foreground MCU program runs on its own worker. The main stdin
        # reader must stay responsive to Ctrl+C and port-state commands.
        self._foreground_active = False
        self._foreground_executing = False
        self._foreground_interrupt = False
        self._foreground_thread = None
        self._foreground_fault = None
        self._raw_uploading = False
        self._raw_payload_open = False
        self._cancel_upload = threading.Event()
        self._stop_generation = 0

        # New RX queue & lock
        self._rx_queue = bytearray()
        self._rx_lock = threading.Lock()
        
        # Terminal input buffering
        self._terminal_input_buffer = b""
        self._input_buffer_limit = 4096

    def _rx_loop(self):
        while self.running:
            if self.suspended or not self.serial or not self.serial.is_open:
                time.sleep(0.05)
                continue
            try:
                if self.serial.in_waiting > 0:
                    data = self.serial.read(self.serial.in_waiting)
                    if data:
                        with self._rx_lock:
                            self._rx_queue.extend(data)
                else:
                    time.sleep(0.002)
            except Exception as e:
                if not self.suspended:
                    err_str = str(e)
                    with self._state_lock:
                        foreground = self._foreground_active
                        if foreground:
                            self._foreground_fault = err_str
                    if foreground:
                        # Never silently reconnect/reset the transport while
                        # a foreground raw program is executing. Its worker
                        # will fail cleanly and release the port on exit.
                        time.sleep(0.05)
                        continue
                    is_transient = any(term in err_str for term in [
                        "device does not recognize",
                        "handle is invalid",
                        "PermissionError",
                        "SerialException",
                        "OSError",
                        "Bad command"
                    ])
                    if is_transient and self.running and not self.in_raw_repl:
                        if self._try_reconnect():
                            # Reconnection is transport recovery, NOT permission
                            # to interrupt whatever script is now running.
                            self.send_event("connected", {"port": self.port})
                            continue
                    time.sleep(0.1)

    def _rx_read(self, n: int, timeout: float = 0.0) -> bytes:
        start = time.time()
        while True:
            with self._rx_lock:
                if len(self._rx_queue) >= n:
                    res = bytes(self._rx_queue[:n])
                    del self._rx_queue[:n]
                    return res
                elif len(self._rx_queue) > 0 and timeout == 0:
                    res = bytes(self._rx_queue)
                    self._rx_queue.clear()
                    return res
            
            if timeout <= 0 or (time.time() - start) >= timeout:
                break
            time.sleep(0.001)
        
        with self._rx_lock:
            if self._rx_queue:
                res = bytes(self._rx_queue[:n])
                del self._rx_queue[:n]
                return res
        return b""

    def _paced_serial_write(self, data: bytes):
        if not self.serial or not self.serial.is_open:
            return
        chunk_size = 64
        for i in range(0, len(data), chunk_size):
            chunk = data[i:i + chunk_size]
            try:
                self.serial.write(chunk)
            except Exception as e:
                err_str = str(e)
                is_transient = any(term in err_str for term in [
                    "device does not recognize",
                    "handle is invalid",
                    "PermissionError",
                    "SerialException",
                    "OSError",
                    "Bad command"
                ])
                if is_transient and self.running and not self.in_raw_repl:
                    if self._try_reconnect():
                        try:
                            self.serial.write(chunk)
                            continue
                        except:
                            pass
                raise e
            if len(data) > chunk_size:
                time.sleep(0.002)

    def _flush_terminal_input(self):
        if self._terminal_input_buffer and not self.in_raw_repl and not self.suspended and self.serial and self.serial.is_open:
            try:
                self._paced_serial_write(self._terminal_input_buffer)
                self._terminal_input_buffer = b""
            except Exception as e:
                self.send_event("error", {"message": f"Buffered write error: {e}"})

    def connect(self):
        self._read_buf = b""
        self._rx_queue = bytearray()
        if not _acquire_lock(self.port):
            self.send_event("error", {"message": f"Port {self.port} is in use by another owner. Close its serial connection first."})
            sys.exit(1)
        try:
            # We explicitly disable DTR/RTS on connect to avoid unwanted reset
            self.serial = serial.Serial()
            self.serial.port = self.port
            self.serial.baudrate = self.baudrate
            self.serial.timeout = 0.1
            self.serial.write_timeout = 1.0
            self.serial.exclusive = True
            
            # Prevent asserting DTR/RTS during open()
            self.serial.dtr = False
            self.serial.rts = False
            self.serial.open()
            
            # Post-open configuration: assert DTR/RTS to enable transmission
            try:
                self.serial.dtr = True
                self.serial.rts = True
            except Exception as e:
                if g_verbose:
                    sys.stderr.write(f"[DAEMON] Failed to set DTR/RTS: {e}\n")
            
            self.running = True
            self.send_event("connected", {"port": self.port})
            
            # Start background RX thread and read loop
            threading.Thread(target=self._rx_loop, daemon=True).start()
            threading.Thread(target=self._read_loop, daemon=True).start()
        except serial.SerialException as e:
            if "PermissionError" in str(e) or "Access is denied" in str(e):
                self.send_event("error", {"message": f"Port {self.port} is BUSY! Please close any other terminal, VS Code shell, or program (like Thonny/Putty) using it, then try again."})
            else:
                self.send_event("error", {"message": f"Serial error: {e}"})
            sys.exit(1)
        except Exception as e:
            self.send_event("error", {"message": f"Unknown error: {e}"})
            sys.exit(1)

    def send_event(self, type_: str, payload: dict):
        """Sends an event to the Node.js host over stdout."""
        msg = {"type": type_, **payload}
        # Worker, RX and command threads all send events. Never interleave
        # their JSON lines: a damaged event can make the terminal appear dead.
        with self._event_lock:
            sys.stdout.write(json.dumps(msg) + "\n")
            sys.stdout.flush()

    def _try_reconnect(self, retries=50, delay=0.1) -> bool:
        """Tries to reopen the serial port after a transient disconnect (e.g. USB CDC reboot)."""
        with self._lock:
            if self.serial:
                try:
                    self.serial.close()
                except:
                    pass
            
            # Wait a brief moment before we start probing
            time.sleep(0.2)
            
            for attempt in range(retries):
                if not self.running:
                    return False
                try:
                    self.serial = serial.Serial()
                    self.serial.port = self.port
                    self.serial.baudrate = self.baudrate
                    self.serial.timeout = 0.1
                    self.serial.write_timeout = 1.0
                    self.serial.exclusive = True
                    self.serial.dtr = False
                    self.serial.rts = False
                    self.serial.open()
                    
                    # Post-open configuration: assert DTR/RTS to enable transmission
                    try:
                        self.serial.dtr = True
                        self.serial.rts = True
                    except Exception as e:
                        if g_verbose:
                            sys.stderr.write(f"[DAEMON] Failed to set DTR/RTS on reconnect: {e}\n")
                    return True
                except (serial.SerialException, OSError, PermissionError):
                    time.sleep(delay)
            return False

    def _read_loop(self):
        import base64
        while self.running:
            try:
                if self.in_raw_repl or self.suspended:
                    time.sleep(0.01)
                    continue

                data = b""
                with self._rx_lock:
                    if self._rx_queue and not self.in_raw_repl and not self.suspended:
                        data = bytes(self._rx_queue)
                        self._rx_queue.clear()

                if data:
                    b64_data = base64.b64encode(data).decode('ascii')
                    self.send_event("terminal_data", {"data": b64_data})
                else:
                    time.sleep(0.01)
            except Exception as e:
                time.sleep(0.1)
        
        self.send_event("disconnected", {})

    def _read_until(self, ending: bytes, timeout: float = 5.0) -> bytes:
        start = time.time()
        while time.time() - start < timeout:
            if ending in self._read_buf:
                idx = self._read_buf.find(ending)
                res = self._read_buf[:idx + len(ending)]
                self._read_buf = self._read_buf[idx + len(ending):]
                return res
            
            with self._rx_lock:
                if self._rx_queue:
                    self._read_buf += bytes(self._rx_queue)
                    self._rx_queue.clear()
            time.sleep(0.005)
        
        buf = self._read_buf
        self._read_buf = b""
        raise TimeoutError(f"Timeout waiting for {ending!r}. Got: {buf!r}")

    def enter_raw_repl(self):
        # Interrupt
        self.serial.write(b'\r\x03\x03')
        time.sleep(0.1)
        
        # Flush input
        if self.serial.in_waiting > 0:
            self.serial.read(self.serial.in_waiting)

        # Enter raw REPL
        self.serial.write(b'\r\x01')
        self._read_until(b'raw REPL; CTRL-B to exit\r\n>')

    def exit_raw_repl(self):
        self.serial.write(b'\r\x02')
        try:
            self._read_until(b'>>>', timeout=1.0)
        except:
            pass
        try:
            while self.serial.in_waiting > 0:
                self.serial.read(self.serial.in_waiting)
                time.sleep(0.02)
        except:
            pass

    def _do_raw_paste(self, code: str):
        self._raw_uploading = True
        try:
            return self._upload_raw_paste(code)
        except Exception:
            if self._raw_payload_open:
                # Raw-paste still expects source bytes. Force a syntax error
                # before EOT so a partial user file is never executed.
                self.serial.write(b'\x03\x04')
                try:
                    self._read_until(b'>', timeout=1.0)
                except Exception:
                    pass
            raise
        finally:
            self._raw_uploading = False
            self._raw_payload_open = False

    def _check_upload(self, deadline):
        if self._cancel_upload.is_set():
            raise InterruptedError('MCU upload cancelled by Ctrl+C')
        if not self.running or not self.serial or not self.serial.is_open:
            raise OSError('Serial connection lost during MCU upload')
        if time.monotonic() >= deadline:
            raise TimeoutError('Raw-paste flow control stopped responding')

    def _upload_raw_paste(self, code: str):
        self._check_upload(time.monotonic() + 5.0)
        code_bytes = code.encode('utf-8')
        
        # Enter raw paste
        self.serial.write(b'\x05A\x01')
        resp = self._read_until(b'R\x01', timeout=2.0)
        
        # Next 2 bytes are window size
        window_size_bytes = self._read_buf
        self._read_buf = b""
        
        start_t = time.time()
        try:
            while len(window_size_bytes) < 2 and time.time() - start_t < 2.0:
                chunk = self._rx_read(2 - len(window_size_bytes), timeout=0.01)
                if chunk:
                    window_size_bytes += chunk
                else:
                    time.sleep(0.01)
            if len(window_size_bytes) < 2:
                raise TimeoutError("Timeout waiting for window size bytes")
            
            window_size = struct.unpack("<H", window_size_bytes[:2])[0]
            if window_size == 0:
                raise RuntimeError('Invalid zero raw-paste window')
            self._raw_payload_open = True
            # Preserve an initial credit coalesced with the window header.
            with self._rx_lock:
                self._rx_queue[:0] = window_size_bytes[2:]
            window_remain = window_size
            deadline = time.monotonic() + 5.0
 
            i = 0
            while i < len(code_bytes):
                self._check_upload(deadline)
                while window_remain == 0:
                    self._check_upload(deadline)
                    b = self._rx_read(1, timeout=0.01)
                    if b == b'\x01':
                        window_remain += window_size
                        deadline = time.monotonic() + 5.0
                    elif b == b'\x04':
                        self._paced_serial_write(b'\x04')
                        raise RuntimeError("Device aborted raw paste")
                    elif b == b'':
                        time.sleep(0.005)
                
                # Also drain any pending updates
                while True:
                    self._check_upload(deadline)
                    b = self._rx_read(1, timeout=0.0)
                    if b == b'\x01':
                        window_remain += window_size
                        deadline = time.monotonic() + 5.0
                    elif b == b'\x04':
                        self._paced_serial_write(b'\x04')
                        raise RuntimeError("Device aborted raw paste")
                    elif b == b'':
                        break
                
                chunk = code_bytes[i : min(i + window_remain, len(code_bytes))]
                self._paced_serial_write(chunk)
                window_remain -= len(chunk)
                i += len(chunk)
                deadline = time.monotonic() + 5.0
        finally:
            pass

        # End of data
        self._paced_serial_write(b'\x04')
        self._raw_payload_open = False
        self._read_until(b'\x04')

    def exec_raw_paste(self, code: str) -> Tuple[str, str]:
        self._do_raw_paste(code)

        # Execution output: <stdout>\x04<stderr>\x04>
        out_data = self._read_until(b'\x04')
        stdout = out_data[:-1].decode('utf-8', errors='replace')
        
        err_data = self._read_until(b'\x04')
        stderr = err_data[:-1].decode('utf-8', errors='replace')
        
        # Consume the final '>'
        self._read_until(b'>')

        return stdout, stderr

    def _stream_terminal_bytes(self, data: bytes):
        """Forward incremental stdout/stderr bytes without waiting for EOF."""
        if not data:
            return
        import base64
        self.send_event("terminal_data", {
            "data": base64.b64encode(data).decode("ascii")
        })

    def _stream_raw_execution(self):
        """Consume MicroPython raw REPL: stdout EOT, stderr EOT, prompt.

        The raw-paste handshake has already consumed its first OK EOT.
        Unlike exec_raw_paste(), this forwards each piece of output as soon
        as the RX thread receives it. It remains active for infinite loops
        until a user Ctrl+C actually interrupts target execution.
        """
        stage = 0
        while self.running:
            with self._state_lock:
                fault = self._foreground_fault
            if fault:
                raise OSError("Serial transport lost during MCU execution: " + fault)
            if not self.serial or not self.serial.is_open:
                raise OSError("REPL disconnected while MCU program was running")
            if self._read_buf:
                data = self._read_buf
                self._read_buf = b""
            else:
                data = self._rx_read(2048, timeout=0.04)
            if not data:
                continue
            index = 0
            while index < len(data):
                if stage >= 2:
                    if b">" in data[index:]:
                        return
                    # Final prompt is a protocol delimiter, not stdout.
                    break
                end = data.find(b"\x04", index)
                if end < 0:
                    self._stream_terminal_bytes(data[index:])
                    break
                self._stream_terminal_bytes(data[index:end])
                index = end + 1
                stage += 1
        raise OSError("Serial daemon stopped during MCU execution")

    def _run_foreground_worker(self, code: str, generation=None):
        if generation is None:
            generation = self._stop_generation
        failure = None
        started = False
        try:
            with self._lock:
                # This is an explicit Run action, not an implicit effect of
                # opening Shell. It may interrupt an already running script.
                self._paced_serial_write(b"\r\x02\r\x03")
                time.sleep(0.1)
                if generation != self._stop_generation:
                    raise InterruptedError('MCU Run cancelled by Stop')
                self.enter_raw_repl()
                if generation != self._stop_generation:
                    raise InterruptedError('MCU Run cancelled by Stop')
                self._do_raw_paste(code)
                with self._state_lock:
                    self._foreground_executing = True
                    pending_interrupt = self._foreground_interrupt
                self.send_event("terminal_run_started", {})
                started = True
                if pending_interrupt:
                    self._paced_serial_write(b"\x03")
                self._stream_raw_execution()
        except Exception as error:
            failure = str(error)
            self._stream_terminal_bytes(("\r\n[MCU Run] " + failure + "\r\n").encode("utf-8", errors="replace"))
        finally:
            # Never reset the target. Return the serial transport to the
            # friendly REPL for the existing terminal and file explorer.
            try:
                if self.serial and self.serial.is_open:
                    self.exit_raw_repl()
            except Exception:
                pass
            with self._state_lock:
                self._foreground_executing = False
                self._foreground_active = False
                self._foreground_interrupt = False
                self._foreground_fault = None
                self.in_raw_repl = False
            self._flush_terminal_input()
            self.send_event("terminal_run_finished", {
                "success": started and failure is None,
                "error": failure or ""
            })

    def process_command(self, cmd: dict):
        action = cmd.get("action")
        generation = cmd.get('_stop_generation', self._stop_generation)
        if generation != self._stop_generation:
            if action == 'run_code':
                self.send_event('run_result', {'id': cmd.get('id'), 'success': False, 'error': 'Cancelled by Stop'})
            elif action == 'run_in_terminal':
                self.send_event('terminal_run_finished', {'success': False, 'error': 'Cancelled by Stop'})
            if action in ('terminal_input', 'run_code', 'run_in_terminal'):
                return
        if action in ('run_code', 'run_in_terminal'):
            self._cancel_upload.clear()
        
        if action == "terminal_input":
            import base64
            data = base64.b64decode(cmd["data"])
            with self._state_lock:
                foreground = self._foreground_active
                executing = self._foreground_executing
                if foreground and b"\x03" in data and not executing:
                    self._foreground_interrupt = True
            if foreground:
                # Control-C must bypass the long-running worker's serial lock.
                # Regular terminal input also remains interactive once code
                # is executing (for input() etc). During raw-paste upload,
                # only record the pending interrupt; don't corrupt payload.
                if executing and self.serial and self.serial.is_open:
                    try:
                        self._paced_serial_write(data)
                    except Exception as error:
                        self.send_event("error", {"message": "REPL input failed: " + str(error)})
                return
            with self._lock:
                if generation != self._stop_generation:
                    return
                if self.in_raw_repl or self.suspended or not self.serial or not self.serial.is_open:
                    if len(self._terminal_input_buffer) + len(data) <= self._input_buffer_limit:
                        self._terminal_input_buffer += data
                    else:
                        self.send_event("error", {"message": "REPL input buffer full; input was not sent"})
                else:
                    try:
                        self._paced_serial_write(data)
                    except Exception as error:
                        self.send_event("error", {"message": "Write error: " + str(error)})
        elif action == "run_code":
            req_id = cmd.get("id")
            code = cmd.get("code", "")
            with self._state_lock:
                foreground = self._foreground_active
            if foreground:
                self.send_event("run_result", {
                    "id": req_id, "success": False,
                    "error": "MCU program is running. Stop it with Ctrl+C before using raw REPL tools."
                })
                return

            with self._lock:
                self.in_raw_repl = True
                try:
                    self.enter_raw_repl()
                    if generation != self._stop_generation:
                        raise InterruptedError('Device operation cancelled by Stop')
                    stdout, stderr = self.exec_raw_paste(code)
                    self.send_event("run_result", {
                        "id": req_id,
                        "success": True,
                        "stdout": stdout,
                        "stderr": stderr
                    })
                except Exception as e:
                    self.send_event("run_result", {
                        "id": req_id,
                        "success": False,
                        "error": str(e)
                    })
                finally:
                    try:
                        self.exit_raw_repl()
                    except:
                        pass
                    self.in_raw_repl = False
                    self._flush_terminal_input()
        elif action == "run_in_terminal":
            code = cmd.get("code", "")
            with self._state_lock:
                if self._foreground_active or self.in_raw_repl or self.suspended:
                    self.send_event("terminal_run_finished", {
                        "success": False,
                        "error": "REPL busy with another MCU/device operation."
                    })
                    return
                self._foreground_active = True
                self._foreground_executing = False
                self._foreground_interrupt = False
                self._foreground_fault = None
                self.in_raw_repl = True
            try:
                self._foreground_thread = threading.Thread(
                    target=self._run_foreground_worker, args=(code, generation), daemon=True
                )
                self._foreground_thread.start()
            except Exception as error:
                # A failed worker launch must not leave the port permanently
                # marked as in raw mode or running.
                with self._state_lock:
                    self._foreground_active = False
                    self._foreground_executing = False
                    self.in_raw_repl = False
                self.send_event("terminal_run_finished", {
                    "success": False, "error": "Cannot start MCU worker: " + str(error)
                })
        elif action == "suspend":
            with self._state_lock:
                busy = self._foreground_active
            if busy:
                self.send_event("transition_error", {
                    "action": "suspend",
                    "message": "A foreground MCU script is running; press Ctrl+C before transferring files."
                })
                return
            with self._lock:
                self.suspended = True
                if self.serial and self.serial.is_open:
                    self.serial.close()
                _release_lock(self.port)
                self.send_event("suspended", {})
        elif action == "resume":
            with self._lock:
                if self.serial and not self.serial.is_open:
                    # Explicitly set dtr/rts to avoid resetting
                    self.serial.dtr = False
                    self.serial.rts = False
                    
                    # Robust retry to handle Windows port release delays
                    opened = False
                    for attempt in range(40):
                        if _acquire_lock(self.port):
                            try:
                                self.serial.open()
                                opened = True
                                break
                            except (serial.SerialException, OSError, PermissionError):
                                _release_lock(self.port)
                                time.sleep(0.1)
                        else:
                            time.sleep(0.1)
                    if not opened:
                        self.send_event("error", {"message": f"Resume failed: Could not open port {self.port}"})
                        self.running = False
                    else:
                        # Post-open configuration: assert DTR/RTS to enable transmission
                        try:
                            self.serial.dtr = True
                            self.serial.rts = True
                        except Exception as e:
                            if g_verbose:
                                sys.stderr.write(f"[DAEMON] Failed to set DTR/RTS on resume: {e}\n")
                if not self.running:
                    # Do not falsely acknowledge a failed resume.
                    return
                self.suspended = False
                self.send_event("resumed", {})
                self._flush_terminal_input()

    def interrupt(self):
        """An explicit user stop bypasses queued raw operations and serial locks."""
        if self.suspended or not self.serial or not self.serial.is_open:
            raise OSError('REPL port is not available for interruption')
        with self._state_lock:
            self._stop_generation += 1
            # A Stop racing with the final raw-paste handshake must not be
            # lost before the foreground worker enters its execution phase.
            if self._foreground_active and not self._foreground_executing:
                self._foreground_interrupt = True
        self._terminal_input_buffer = b''
        self._cancel_upload.set()
        if self._raw_uploading:
            # The upload worker aborts the partial payload safely. Sending
            # Ctrl+C into raw-paste source bytes would corrupt the protocol.
            return
        # MicroPython may need a second Ctrl+C to cancel nested asyncio tasks
        # and return to the friendly prompt. Neither byte is a soft reset.
        # Never acquire the raw-operation lock here; it may be held by a loop.
        self.serial.write(b'\x03')
        time.sleep(0.05)
        self.serial.write(b'\x03')


def read_commands(daemon, commands, stream):
    """Keep Ctrl+C readable even while run_code holds the command worker."""
    import base64
    try:
        for line in stream:
            try:
                cmd = json.loads(line)
                if not isinstance(cmd, dict):
                    continue
                data = base64.b64decode(cmd.get('data', '')) if cmd.get('action') == 'terminal_input' else b''
                if cmd.get('action') == 'interrupt' or b'\x03' in data:
                    try:
                        daemon.interrupt()
                        if cmd.get('id') is not None:
                            daemon.send_event('run_result', {'id': cmd['id'], 'success': True, 'stdout': '', 'stderr': ''})
                    except Exception as error:
                        daemon.send_event('run_result' if cmd.get('id') is not None else 'error',
                                          {'id': cmd.get('id'), 'success': False, 'error': str(error), 'message': str(error)})
                else:
                    cmd['_stop_generation'] = daemon._stop_generation
                    commands.put(cmd)
            except (ValueError, TypeError):
                continue
    finally:
        commands.put(None)

def main():
    # Read first line as initialization config
    try:
        init_line = sys.stdin.readline()
        if not init_line:
            return
        config = json.loads(init_line)
    except Exception as e:
        sys.stderr.write(f"Init error: {e}\n")
        sys.exit(1)

    global g_verbose
    g_verbose = config.get("verbose", False)

    daemon = MpyDaemon(port=config["port"], baudrate=config.get("baudrate", 115200))

    # Start parent checker thread to prevent orphaned daemon processes
    try:
        parent_pid = os.getppid()
        if parent_pid > 0:
            def parent_checker():
                while True:
                    time.sleep(3.0)
                    if not _is_pid_running(parent_pid):
                        log_to_file(f"Parent VS Code PID {parent_pid} has died. Cleaning up lock and exiting daemon.")
                        try:
                            _release_lock(daemon.port)
                        except:
                            pass
                        os._exit(0)
            threading.Thread(target=parent_checker, daemon=True).start()
    except Exception as e:
        sys.stderr.write(f"Failed to start parent checker: {e}\n")

    daemon.connect()

    # Input reading and device operations are separate. A synchronous raw
    # query must never prevent the host's Stop/Ctrl+C from reaching the MCU.
    commands = queue.Queue()
    threading.Thread(target=read_commands, args=(daemon, commands, sys.stdin), daemon=True).start()
    try:
        while True:
            cmd = commands.get()
            if cmd is None:
                break
            daemon.process_command(cmd)
    finally:
        _release_lock(daemon.port)

if __name__ == "__main__":
    main()
