import sys
import json
import time
import serial
import threading
import struct
import os
import tempfile
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
    lock_name = f"mps_lock_{port.replace('/', '_').replace('\\\\', '_').replace('\\', '_').replace(':', '_')}.lock"
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
        self._lock = threading.Lock()
        
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
                    is_transient = any(term in err_str for term in [
                        "device does not recognize",
                        "handle is invalid",
                        "PermissionError",
                        "SerialException",
                        "OSError",
                        "Bad command"
                    ])
                    if is_transient and self.running:
                        if self._try_reconnect():
                            try:
                                time.sleep(0.1)
                                self.serial.write(b'\r\x03')
                            except:
                                pass
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
                if is_transient and self.running:
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
        _acquire_lock(self.port)
        try:
            # We explicitly disable DTR/RTS on connect to avoid unwanted reset
            self.serial = serial.Serial()
            self.serial.port = self.port
            self.serial.baudrate = self.baudrate
            self.serial.timeout = 0.1
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
        # Print JSON separated by newline
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
            window_remain = window_size
 
            i = 0
            while i < len(code_bytes):
                while window_remain == 0:
                    b = self._rx_read(1, timeout=0.01)
                    if b == b'\x01':
                        window_remain += window_size
                    elif b == b'\x04':
                        self._paced_serial_write(b'\x04')
                        raise RuntimeError("Device aborted raw paste")
                    elif b == b'':
                        time.sleep(0.005)
                
                # Also drain any pending updates
                while True:
                    b = self._rx_read(1, timeout=0.0)
                    if b == b'\x01':
                        window_remain += window_size
                    elif b == b'\x04':
                        self._paced_serial_write(b'\x04')
                        raise RuntimeError("Device aborted raw paste")
                    elif b == b'':
                        break
                
                chunk = code_bytes[i : min(i + window_remain, len(code_bytes))]
                self._paced_serial_write(chunk)
                window_remain -= len(chunk)
                i += len(chunk)
        finally:
            pass

        # End of data
        self._paced_serial_write(b'\x04')
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

    def process_command(self, cmd: dict):
        action = cmd.get("action")
        
        if action == "terminal_input":
            import base64
            data = base64.b64decode(cmd["data"])
            with self._lock:
                if self.in_raw_repl or self.suspended or not self.serial or not self.serial.is_open:
                    if len(self._terminal_input_buffer) + len(data) <= self._input_buffer_limit:
                        self._terminal_input_buffer += data
                else:
                    try:
                        self._paced_serial_write(data)
                    except Exception as e:
                        self.send_event("error", {"message": f"Write error: {e}"})
                    
        elif action == "run_code":
            req_id = cmd.get("id")
            code = cmd.get("code", "")
            
            with self._lock:
                self.in_raw_repl = True
                try:
                    self.enter_raw_repl()
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
            with self._lock:
                self.in_raw_repl = True
                try:
                    # Switch to friendly REPL first to reset state cleanly, then raw REPL
                    self._paced_serial_write(b'\r\x02\r\x03')
                    time.sleep(0.1)
                    self.enter_raw_repl()
                    stdout, stderr = self.exec_raw_paste(code)
                    if stdout:
                        import base64
                        self.send_event("terminal_data", {
                            "data": base64.b64encode(stdout.encode('utf-8', errors='replace')).decode('ascii')
                        })
                    if stderr:
                        import base64
                        self.send_event("terminal_data", {
                            "data": base64.b64encode(stderr.encode('utf-8', errors='replace')).decode('ascii')
                        })
                except Exception as e:
                    self.send_event("error", {"message": f"Run failed: {e}"})
                finally:
                    try:
                        self.exit_raw_repl()
                    except:
                        pass
                    self.in_raw_repl = False
                    self._flush_terminal_input()
        elif action == "suspend":
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
                self.suspended = False
                self.send_event("resumed", {})
                self._flush_terminal_input()

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

    # Read loop for incoming commands
    try:
        while True:
            line = sys.stdin.readline()
            if not line:
                break
            try:
                cmd = json.loads(line)
                daemon.process_command(cmd)
            except json.JSONDecodeError:
                pass
    finally:
        _release_lock(daemon.port)

if __name__ == "__main__":
    main()
