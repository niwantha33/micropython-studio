"""Physical bridge protocol probe; no breakpoint or application execution."""
import json
import queue
import subprocess
import sys
import threading
import time


def probe(root, port):
    evidence = []
    for cycle in range(1, 4):
        phase = 'open'
        history = []
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
                history.append(event)
                if len(history) > 30:
                    history.pop(0)
                if event["evt"] in ("error", "transport_lost", "eof"):
                    raise RuntimeError(str(event))
                if predicate(event):
                    return event
            raise TimeoutError("Debug firmware did not return expected response")
        def send(op):
            proc.stdin.write(json.dumps({"op": op}) + "\n")
            proc.stdin.flush()
        primary_failure = False
        try:
            wait(lambda e: e["evt"] == "open")
            phase = "pump_info"
            send("pump_info")
            reply = wait(lambda e: e["evt"] == "reply" and e.get("text", "").startswith("pump_info="))
            evidence.append(reply["text"])
            phase = "rta_off acknowledgement"
            send("rta_off")
            wait(lambda e: e["evt"] == "reply" and e.get("text") == "RTA trace disabled")
            phase = "clear_all_bp acknowledgement"
            send("clear_all_bp")
            wait(lambda e: e["evt"] == "reply" and e.get("text", "").startswith("cleared all bp slots"))
        except Exception as exc:
            primary_failure = True
            raise RuntimeError(f"cycle {cycle}/3, {phase}: {exc}; events={history!r}") from exc
        finally:
            try:
                if proc.poll() is None:
                    send("quit")
                    try:
                        wait(lambda e: e["evt"] == "closed")
                    except Exception as exc:
                        # Preserve an active primary exception instead of replacing it.
                        if primary_failure:
                            print(f"cycle {cycle}/3 cleanup: {exc}", file=sys.stderr)
                        else:
                            raise RuntimeError(f"cycle {cycle}/3 detach: {exc}; events={history!r}") from exc
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
            raise RuntimeError(f"cycle {cycle}/3: bridge exited unsuccessfully")
        time.sleep(0.25)
    return {"cycles": len(evidence), "firmware_replies": evidence}
