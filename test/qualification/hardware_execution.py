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
        self.eof = threading.Event()
        self.history = []
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
            self.eof.set()

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
                if self.eof.is_set():
                    raise RuntimeError("Debug bridge exited; events=" + repr(self.history))
                continue
            self.history.append(event)
            if len(self.history) > 30:
                self.history.pop(0)
            if event["evt"] in ("error", "transport_lost", "exception"):
                raise RuntimeError(str(event))
            if event["evt"] == "reply" and event.get("text", "").startswith("err:"):
                raise RuntimeError(event["text"])
            if predicate(event):
                return event
        raise TimeoutError("Expected physical debugger event not received; events=" + repr(self.history))

    def reply(self, op, prefix, **fields):
        self.send(op, **fields)
        return self.wait(lambda e: e["evt"] == "reply" and
                         e.get("text", "").startswith(prefix))["text"]

    def close(self):
        if self.proc.poll() is None:
            try:
                self.send("quit")
            except BrokenPipeError:
                pass
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
        self.wait(lambda event: event["evt"] == "closed", timeout=1)


def require(ok, reason):
    if not ok:
        raise RuntimeError(reason)


def finish_fixture(bridge, session, slot, running):
    """Clear owned breakpoint, resume finite code and await completion.
    No concurrent Ctrl+C: the two USB interfaces have independent ordering.
    """
    if slot is not None:
        bridge.reply("clear_bp", "cleared bp ", slot=slot)
    if running:
        bridge.send("continue")
        result = session.event("terminal_run_finished")
        require(result.get("success"), "Fixture did not finish after Continue: " + repr(result))
    bridge.reply("pump_info", "pump_info=")


def exercise(root, port, session, check):
    module = "mpshil_" + uuid.uuid4().hex[:12]
    path = "/" + module + ".py"
    # Argument is initialized on frame entry, independently of line mapping.
    source = ("HIL_GLOBAL = 73419\n"
              "def worker(local):\n"
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
    fun = None
    ip = None
    try:
        session.code("import " + module)
        bridge = Bridge(root, port)
        bridge.wait(lambda e: e["evt"] == "open")
        bridge.reply("pump_info", "pump_info=")
        def breakpoint():
            nonlocal slot, running, paused, fun, ip
            reply = bridge.reply("set_bp", "bp ", module=module, func="worker", line=3)
            match = re.fullmatch(r"bp (\d+) @ " + re.escape(module) +
                                 r"\.worker:3 ip=(\d+) fun=(\d+)", reply)
            require(match is not None, "Unexpected registration: " + reply)
            slot, ip, fun = map(int, match.groups())
            require(slot < 256 and fun > 0, "Invalid breakpoint identity")
            session.output.clear()
            running = True
            session.send(action="run_in_terminal", code="print('HIL_DONE', "+module+".worker(17321))")
            session.event("terminal_run_started")
            hit = bridge.wait(lambda e: e["evt"] == "bp_hit")
            paused = True
            require(hit.get("fun") == fun and hit.get("ip") == ip, "Wrong function or instruction hit")
            return {"registration": reply, "hit": hit}
        check("HIL-011 physical breakpoint", breakpoint)

        def locals_check():
            local = bridge.reply("locals", "depth=")
            stack = bridge.reply("call_stack", "stack=")
            try:
                state = ast.literal_eval(local.split("state=", 1)[1])
                require(isinstance(state, (list, tuple)), "Unexpected local state type")
                require(any(type(v) is int and v == 17321 or
                            type(v) is str and v == "17321" for v in state),
                        "Expected argument missing")
            except (ValueError, SyntaxError, IndexError, RuntimeError) as exc:
                raise RuntimeError(str(exc) + "; raw locals=" + local) from exc
            return {"locals": local, "stack": stack}
        check("HIL-013 paused locals", locals_check)

        # A malformed value reply is independent of stepping, but a transport
        # failure must still abort. Obtain the actual reply before deferring
        # the semantic assertion.
        global_reply = bridge.reply("globals", "depth=")
        def globals_check():
            try:
                require("globals=" in global_reply, "Firmware globals unavailable")
                values = ast.literal_eval(global_reply.split("globals=", 1)[1])
                require(isinstance(values, dict) and str(values.get("HIL_GLOBAL")) == "73419",
                        "Expected module global missing")
                return {"globals": global_reply}
            except (ValueError, SyntaxError, IndexError, RuntimeError) as exc:
                raise RuntimeError(str(exc) + "; raw globals=" + global_reply) from exc
        check("HIL-018 paused globals", globals_check, defer_failure=True)

        def step_continue():
            nonlocal paused, running, slot
            bridge.send("step")
            hit = bridge.wait(lambda e: e["evt"] == "bp_hit")
            local = bridge.reply("locals", "depth=")
            require(hit.get("fun") == fun and hit.get("ip") != ip,
                    "Step did not advance in fixture: " + repr({"initial_fun": fun, "initial_ip": ip, "step_hit": hit, "step_locals": local}))
            require("state=" in local, "No paused frame after step: " + local)
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
                session.send(action="run_in_terminal", code="for _ in range(5):\n "+module+".worker(17321)\nprint('HIL_RTA_DONE')")
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
        # Preserve primary failure and record cleanup failures separately.
        # Avoid deleting a module whose function could still be executing.
        primary = sys.exc_info()[1]
        errors = []
        safe = bridge is None and not running
        if bridge:
            try:
                finish_fixture(bridge, session, slot, running)
                safe = True
            except Exception as exc:
                errors.append("fixture finish: " + str(exc))
            try:
                bridge.close()
            except Exception as exc:
                errors.append("bridge close: " + str(exc))
        if safe:
            try:
                session.code("import os,sys\nsys.modules.pop("+repr(module)+",None)\n"
                             "globals().pop("+repr(module)+",None)\nos.remove("+repr(path)+")")
            except Exception as exc:
                errors.append("fixture removal: " + str(exc))
        else:
            errors.append("fixture retained for safety: " + path)
        if errors:
            raise RuntimeError(("primary: " + str(primary) + "; " if primary else "") +
                               "cleanup: " + "; ".join(errors)) from primary
