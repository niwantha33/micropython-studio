"""Physical bridge protocol probe; no breakpoint or application execution."""
import json
import queue
import subprocess
import sys
import threading
import time


def probe(root, port):
    evidence = []
    for _ in range(3):
        events = queue.Queue()
        proc = subprocess.Popen([sys.executable, "-u", str(root / "src" / "dbg_bridge.py"), port],
                                cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                text=True, encoding="utf-8")
        def read():
            try:
                for line in proc.stdout:
                    events.put(json.loads(line))
            finally:
                events.put({"evt": "eof"})
        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        def wait(predicate):
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                try:
                    event = events.get(timeout=max(.001, deadline-time.monotonic()))
                except queue.Empty:
                    break
                if event["evt"] in ("error", "transport_lost", "eof"):
                    raise RuntimeError(str(event))
                if predicate(event):
                    return event
            raise TimeoutError("Debug firmware did not return expected response")
        def send(op):
            proc.stdin.write(json.dumps({"op": op}) + "\n")
            proc.stdin.flush()
        try:
            wait(lambda e: e["evt"] == "open")
            send("pump_info")
            reply = wait(lambda e: e["evt"] == "reply" and "pump" in e.get("text", "").lower())
            evidence.append(reply["text"])
        finally:
            try:
                if proc.poll() is None:
                    send("quit")
                    wait(lambda e: e["evt"] == "closed")
            finally:
                proc.stdin.close()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                    raise RuntimeError("Bridge required forced termination")
                reader.join(timeout=2)
                proc.stdout.close()
        if proc.returncode:
            raise RuntimeError("Bridge exited unsuccessfully")
    return {"cycles": len(evidence), "firmware_replies": evidence}
