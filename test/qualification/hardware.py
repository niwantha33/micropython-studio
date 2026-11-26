"""Opt-in physical REPL qualification using the production daemon subprocess."""
import argparse
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
    parser.add_argument("--board", choices=["rp2040", "rp2350", "esp32"], required=True)
    parser.add_argument("--confirm-dedicated-board", action="store_true")
    args = parser.parse_args()
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
    report = {"board": args.board, "port": port, "usb_vid_pid": "%04x:%04x" % (device.vid, device.pid),
              "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
              "working_tree": "dirty" if subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip() else "clean",
              "scope": "Physical production REPL daemon only; not VS Code UI or debugger qualification",
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
            require(args.board in value.lower(), "Board identity mismatch: " + value)
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
            for _ in range(5):
                session.send(action="suspend")
                session.event("suspended")
                session.send(action="resume")
                session.event("resumed")
                finite()
            return "5 suspend/resume cycles with successful REPL queries"
        check("HIL-005 COM handoff", handoff)

        def memory():
            value = session.code("import gc; print(gc.mem_free()); print(gc.mem_alloc())")
            numbers = [int(s) for s in value.split()]
            require(len(numbers) == 2 and min(numbers) >= 0, "Invalid memory sample")
            return {"free": numbers[0], "allocated": numbers[1]}
        check("HIL-006 read-only heap sample", memory)
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
        path = out / ("hardware-" + args.board + ".json")
        path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print("Physical REPL qualification:", report["status"], "\nReport:", path)
    return int(report["status"] != "PASS")


if __name__ == "__main__":
    sys.exit(main())
