"""Opt-in physical REPL qualification using the production daemon subprocess."""
import argparse
import hashlib
import tempfile
import base64
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]


class Session:
    def __init__(self, port):
        self.events = queue.Queue()
        self.output = bytearray()
        self.process = subprocess.Popen(
            [sys.executable, "-u", str(ROOT / "src" / "mpy_daemon.py")],
            cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=None, text=True, encoding="utf-8")
        threading.Thread(target=self.read, daemon=True).start()
        self.send(port=port, baudrate=115200)

    def read(self):
        try:
            for line in self.process.stdout:
                self.events.put(json.loads(line))
        except Exception as exc:
            self.events.put({"type": "error", "message": str(exc)})
        finally:
            self.events.put({"type": "error", "message": "Daemon stdout closed"})

    def send(self, **message):
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def wait(self, predicate, seconds=12):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                event = self.events.get(timeout=max(0.001, deadline-time.monotonic()))
            except queue.Empty:
                break
            if event["type"] == "error":
                raise RuntimeError(event.get("message", "Daemon error"))
            if event["type"] == "terminal_data":
                self.output.extend(base64.b64decode(event["data"]))
                if len(self.output) > 262144:
                    raise RuntimeError("Unexpected excessive output")
            if predicate(event):
                return event
        raise TimeoutError("Expected daemon event not received")

    def event(self, name):
        return self.wait(lambda e: e["type"] == name)

    def code(self, source):
        token = uuid.uuid4().hex
        self.send(action="run_code", id=token, code=source)
        result = self.wait(lambda e: e["type"] == "run_result" and e.get("id") == token)
        if not result.get("success") or result.get("stderr"):
            raise RuntimeError(str(result))
        return result["stdout"]

    def input(self, data):
        self.send(action="terminal_input", data=base64.b64encode(data).decode("ascii"))

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
                raise RuntimeError("Daemon required forced termination; inspect port ownership")
        self.process.stdout.close()
        if self.process.returncode:
            raise RuntimeError("Daemon exit code " + str(self.process.returncode))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True)
    parser.add_argument("--board", choices=["auto", "rp2040", "rp2350", "esp32"], default="auto")
    parser.add_argument("--confirm-dedicated-board", action="store_true")
    parser.add_argument("--cycles", type=int, choices=range(1, 101), default=10, metavar="1..100")
    parser.add_argument("--files", action="store_true", help="Write and remove only a unique test directory")
    parser.add_argument("--debug-port", help="Optional dedicated debug CDC port for protocol probe")
    parser.add_argument("--debug-execution", action="store_true", help="Run temporary breakpoint and RTA fixture")
    parser.add_argument("--compare-baseline", action="store_true", help="Compare matching measured RP2350 timing baseline")
    args = parser.parse_args()
    if args.debug_execution and not args.debug_port:
        parser.error("--debug-execution requires --debug-port")
    if not args.confirm_dedicated_board:
        parser.error("Use a dedicated idle test board. Tests interrupt execution and change REPL state.")
    from serial.tools.list_ports import comports
    port = args.port.upper() if os.name == "nt" else args.port
    matches = [p for p in comports() if p.device == port and p.vid is not None]
    if len(matches) != 1:
        parser.error("Selected port must be an enumerated physical USB serial device")
    device = matches[0]
    if args.board.startswith("rp") and device.vid != 0x2e8a:
        parser.error("Selected port does not have Raspberry Pi USB VID")
    if args.debug_port:
        args.debug_port = args.debug_port.upper() if os.name == "nt" else args.debug_port
        peers = [p for p in comports() if p.device == args.debug_port and p.device != port and p.vid is not None and p.vid == device.vid and p.pid == device.pid and p.serial_number and p.serial_number == device.serial_number]
        if len(peers) != 1:
            parser.error("Debug port must be a separate USB interface with matching board identity")
    report = {"board": args.board, "port": port, "usb_vid_pid": "%04x:%04x" % (device.vid, device.pid),
              "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
              "working_tree": "dirty" if subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip() else "clean",
              "scope": "Physical production REPL, transfer backend and optional debugger bridge; not VS Code UI",
              "cycles": args.cycles,
              "tests": [], "status": "FAIL"}
    session = None
    active = False

    def check(name, fn):
        start = time.monotonic()
        row = {"name": name, "status": "FAIL"}
        report["tests"].append(row)
        try:
            row["evidence"] = fn()
            row["status"] = "PASS"
        except Exception as exc:
            row["error"] = str(exc)
            raise
        finally:
            row["seconds"] = round(time.monotonic()-start, 3)
            print(name + ": " + row["status"], flush=True)

    def require(condition, message):
        if not condition:
            raise RuntimeError(message)

    try:
        session = Session(port)
        check("HIL-001 connect", lambda: session.event("connected"))
        def identify():
            value = session.code("import os,sys; print(sys.implementation.name); print(os.uname())")
            require("micropython" in value.lower(), "Not MicroPython")
            detected = next((b for b in ("rp2350", "rp2040", "esp32") if b in value.lower()), None)
            require(detected is not None, "Unsupported board: " + value)
            require(args.board == "auto" or args.board == detected, "Board identity mismatch: " + value)
            report["board"] = detected
            return value.strip()
        check("HIL-002 board identity", identify)

        def finite():
            marker = uuid.uuid4().hex
            require(session.code("print(" + repr(marker) + ")").strip() == marker,
                    "Raw execution output mismatch")
            return "Exact nonce received"
        check("HIL-003 raw execution", finite)

        def stream():
            nonlocal active
            marker = "HIL_" + uuid.uuid4().hex
            session.output.clear()
            active = True
            session.send(action="run_in_terminal", code="import time\nfor i in range(100):\n print(" +
                         repr(marker) + ",i)\n time.sleep_ms(100)")
            session.event("terminal_run_started")
            session.wait(lambda e: (marker + " 4").encode() in session.output)
            found = re.findall(re.escape(marker.encode()) + rb" (\d+)\r?\n", session.output)
            require(found[:4] == [b"0", b"1", b"2", b"3"], "Missing or duplicated live output")
            session.input(b"\x03")
            result = session.event("terminal_run_finished")
            active = False
            require(result.get("success"), str(result))
            require((marker + " 99").encode() not in session.output, "Loop completed instead of stopping")
            finite()
            return "Live ordered output, Ctrl+C and subsequent raw command confirmed"
        check("HIL-004 stream / Ctrl+C / reuse", stream)

        def handoff():
            for _ in range(args.cycles):
                session.send(action="suspend")
                session.event("suspended")
                session.send(action="resume")
                session.event("resumed")
                finite()
            return f"{args.cycles} suspend/resume cycles with successful REPL queries"
        check("HIL-005 COM handoff", handoff)

        def memory():
            value = session.code("import gc; print(gc.mem_free()); print(gc.mem_alloc())")
            numbers = [int(s) for s in value.split()]
            require(len(numbers) == 2 and min(numbers) >= 0, "Invalid memory sample")
            return {"free": numbers[0], "allocated": numbers[1]}
        check("HIL-006 read-only heap sample", memory)
        def gc_recovery():
            value = session.code("import gc\ngc.collect()\na=gc.mem_alloc()\nb=bytearray(4096)\nc=gc.mem_alloc()\ndel b\ngc.collect()\nprint(a,c,gc.mem_alloc())")
            before, allocated, after = map(int, value.split())
            require(allocated-before >= 4096 and allocated-after >= 4096,
                    "Heap allocation or collection not observed")
            return {"before": before, "allocated": allocated, "after": after}
        check("HIL-014 GC recovery", gc_recovery)

        if args.files:
            remote = "/mps_hil_" + uuid.uuid4().hex
            # Atomic mkdir proves ownership; never touch an existing directory.
            session.code("import os; os.mkdir(" + repr(remote) + ")")
            try:
                with tempfile.TemporaryDirectory() as temp:
                    root = Path(temp)
                    src = root / "source"
                    (src / "nested").mkdir(parents=True)
                    samples = {"payload.bin": bytes(range(256))*8,
                               "nested/second.bin": b"MicroPython HIL\x00\xff"*33}
                    for name, data in samples.items():
                        (src / name).write_bytes(data)
                    session.send(action="suspend")
                    session.event("suspended")
                    try:
                        # Use the actual production transfer implementation and
                        # acquire its normal cooperative serial lock.
                        sys.path.insert(0, str(ROOT / "src"))
                        import mps_backend as backend
                        require(backend._acquire_port_friendly(sys.executable, port),
                                "Backend could not acquire serial port")
                        conn = backend.SerialConnection(port)
                        try:
                            conn.connect()
                            check("HIL-007 single file upload", lambda:
                                  require(conn.put_file(src / "payload.bin", remote + "/payload.bin") == 0,
                                          "Production upload failed") or "2048 bytes acknowledged")
                            def verify(name):
                                target = root / "download.bin"
                                target.unlink(missing_ok=True)
                                require(conn.get_file(remote + "/" + name, target) == 0,
                                        "Production download failed")
                                require(target.read_bytes() == samples[name], "Downloaded bytes differ")
                                return hashlib.sha256(target.read_bytes()).hexdigest()
                            check("HIL-008 download integrity", lambda: verify("payload.bin"))
                            def nested():
                                conn.put_directory(src / "nested", remote + "/nested")
                                return verify("nested/second.bin")
                            check("HIL-009 nested folder transfer", nested)
                        finally:
                            conn.close()
                            backend._release_lock_if_owned(backend._get_lock_path(port))
                    finally:
                        session.send(action="resume")
                        session.event("resumed")
            finally:
                # Only known fixtures in the unique directory; no recursive delete.
                cleanup = "import os\nfor p in " + repr([remote+"/nested/second.bin", remote+"/payload.bin"]) + ":\n try: os.remove(p)\n except OSError as e:\n  if e.args[0] != 2: raise\nfor p in " + repr([remote+"/nested", remote]) + ":\n try: os.rmdir(p)\n except OSError as e:\n  if e.args[0] != 2: raise"
                session.code(cleanup)
                finite()
        if args.debug_port:
            from hardware_debug import probe
            check("HIL-010 debug protocol / attach-detach", lambda: probe(ROOT, args.debug_port))
        if args.debug_execution:
            from hardware_execution import exercise
            exercise(ROOT, args.debug_port, session, check)
        if args.compare_baseline:
            from hardware_performance import compare
            report["performance"] = compare(report, ROOT / "test" / "baselines" / "hardware-rp2350.json")
            require(report["performance"]["status"] == "PASS", "Performance comparison failed or not comparable")
        report["status"] = "PASS"
    except Exception as exc:
        report["error"] = str(exc)
    finally:
        if session:
            try:
                if active and session.process.poll() is None:
                    session.input(b"\x03")
                    session.event("terminal_run_finished")
            except Exception as exc:
                report["cleanup_error"] = str(exc)
                report["status"] = "FAIL"
            try:
                session.close()
            except Exception as exc:
                report["cleanup_error"] = str(exc)
                report["status"] = "FAIL"
        out = ROOT / "reports" / "qualification"
        out.mkdir(parents=True, exist_ok=True)
        path = out / ("hardware-" + report["board"] + ".json")
        path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print("Physical REPL qualification:", report["status"], "\nReport:", path)
    return int(report["status"] != "PASS")


if __name__ == "__main__":
    sys.exit(main())
