"""Opt-in live debugger exercise through the production bridge and daemon."""
import ast
import json
import queue
import re
import subprocess
import sys
import threading
import time
import uuid


class Bridge:
    def __init__(self, root, port):
        self.events = queue.Queue(maxsize=8192)
        self.overflow = threading.Event()
        self.proc = subprocess.Popen(
            [sys.executable, "-u", str(root / "src" / "dbg_bridge.py"), port],
            cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            text=True, encoding="utf-8")
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()

    def read(self):
        try:
            for line in self.proc.stdout:
                try:
                    self.events.put_nowait(json.loads(line))
                except queue.Full:
                    self.overflow.set()
        finally:
            self.overflow.set()

    def send(self, op, **fields):
        self.proc.stdin.write(json.dumps(dict(op=op, **fields)) + "\n")
        self.proc.stdin.flush()

    def wait(self, predicate, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.overflow.is_set():
                raise RuntimeError("Debug stream ended or overflowed")
            try:
                event = self.events.get(timeout=min(.1, max(.001, deadline-time.monotonic())))
            except queue.Empty:
                continue
            if event["evt"] in ("error", "transport_lost", "exception"):
                raise RuntimeError(str(event))
            if event["evt"] == "reply" and event.get("text", "").startswith("err:"):
                raise RuntimeError(event["text"])
            if predicate(event):
                return event
        raise TimeoutError("Expected physical debugger event not received")

    def reply(self, op, prefix, **fields):
        self.send(op, **fields)
        return self.wait(lambda e: e["evt"] == "reply" and
                         e.get("text", "").startswith(prefix))["text"]

    def close(self):
        if self.proc.poll() is None:
            self.send("quit")
        self.proc.stdin.close()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
            raise RuntimeError("Debugger bridge required forced termination")
        self.reader.join(timeout=2)
        self.proc.stdout.close()
        if self.proc.returncode:
            raise RuntimeError("Debugger bridge exited unsuccessfully")


def require(ok, reason):
    if not ok:
        raise RuntimeError(reason)


def exercise(root, port, session, check):
    module = "mpshil_" + uuid.uuid4().hex[:12]
    path = "/" + module + ".py"
    # The sentinel local is already initialized at the breakpoint line.
    source = ("HIL_GLOBAL = 73419\n"
              "def worker():\n"
              "    local = 17321\n"
              "    local += 1\n"
              "    local += 2\n"
              "    return local\n")
    # Exclusive creation; no existing file can be overwritten.
    session.code("import os\nassert " + repr(module+".py") + " not in os.listdir('/')\n"
                 "f=open(" + repr(path) + ",'w')\nf.write(" + repr(source) + ")\nf.close()")
    bridge = None
    running = False
    paused = False
    slot = None
    try:
        session.code("import " + module)
        bridge = Bridge(root, port)
        bridge.wait(lambda e: e["evt"] == "open")
        bridge.reply("pump_info", "pump_info=")
        def breakpoint():
            nonlocal slot, running, paused
            reply = bridge.reply("set_bp", "bp ", module=module, func="worker", line=4)
            match = re.fullmatch(r"bp (\d+) @ " + re.escape(module) +
                                 r"\.worker:4 ip=(\d+) fun=(\d+)", reply)
            require(match is not None, "Unexpected registration: " + reply)
            slot, ip, fun = map(int, match.groups())
            require(slot < 256 and fun > 0, "Invalid breakpoint identity")
            session.output.clear()
            running = True
            session.send(action="run_in_terminal", code="print('HIL_DONE', "+module+".worker())")
            session.event("terminal_run_started")
            hit = bridge.wait(lambda e: e["evt"] == "bp_hit")
            paused = True
            require(hit.get("fun") == fun and hit.get("ip") == ip, "Wrong function or instruction hit")
            return {"registration": reply, "hit": hit}
        check("HIL-011 physical breakpoint", breakpoint)

        def variables():
            local = bridge.reply("locals", "depth=")
            state = ast.literal_eval(local.split("state=", 1)[1])
            require(17321 in state, "Expected initialized local missing")
            global_reply = bridge.reply("globals", "depth=")
            values = ast.literal_eval(global_reply.split("globals=", 1)[1])
            require(str(values.get("HIL_GLOBAL")) == "73419", "Expected module global missing")
            return {"locals": local, "globals": global_reply}
        check("HIL-013 paused variables", variables)

        def step_continue():
            nonlocal paused, running, slot
            bridge.send("step")
            hit = bridge.wait(lambda e: e["evt"] == "bp_hit")
            local = bridge.reply("locals", "depth=")
            require("state=" in local, "No paused frame after step")
            bridge.reply("clear_bp", "cleared bp ", slot=slot)
            slot = None
            bridge.send("continue")
            paused = False
            result = session.event("terminal_run_finished")
            running = False
            require(result.get("success") and b"HIL_DONE 17324" in session.output,
                    "Continue failed to finish fixture")
            return {"step_hit": hit, "step_locals": local, "result": 17324}
        check("HIL-012 step and continue", step_continue)

        def rta():
            nonlocal running
            fun = int(session.code("print(id("+module+".worker))").strip())
            bridge.reply("rta_on", "RTA trace enabled")
            try:
                running = True
                session.output.clear()
                session.send(action="run_in_terminal", code="for _ in range(5):\n "+module+".worker()\nprint('HIL_RTA_DONE')")
                session.event("terminal_run_started")
                entries, durations = [], []
                deadline = time.monotonic()+10
                while len(durations) < 5:
                    event = bridge.wait(lambda e: e["evt"] in ("rta_entry", "rta_exit")
                                        and e.get("fun") == fun,
                                        timeout=max(.001, deadline-time.monotonic()))
                    if event["evt"] == "rta_entry":
                        entries.append(event["ts"])
                    elif entries:
                        duration = (event["ts"] - entries.pop()) & 0xffffffff
                        require(0 <= duration < 1000000, "Invalid fixture duration")
                        durations.append(duration)
                result = session.event("terminal_run_finished")
                running = False
                require(result.get("success") and b"HIL_RTA_DONE" in session.output,
                        "RTA fixture did not finish")
                return {"function": fun, "completed_calls": len(durations),
                        "durations_us": durations}
            finally:
                bridge.reply("rta_off", "RTA trace disabled")
        check("HIL-015 physical RTA events", rta)
    finally:
        # Resume only our explicitly started fixture; never resume on passive attach.
        try:
            if bridge:
                if slot is not None:
                    bridge.reply("clear_bp", "cleared bp ", slot=slot)
                if running:
                    bridge.send("continue")
                    session.input(b"\x03")
                    session.event("terminal_run_finished")
        finally:
            try:
                if bridge:
                    bridge.close()
            finally:
                session.code("import os,sys\nsys.modules.pop("+repr(module)+",None)\n"
                             "globals().pop("+repr(module)+",None)\nos.remove("+repr(path)+")")
