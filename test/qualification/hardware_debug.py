"""Physical bridge protocol probe; no breakpoint or application execution."""
import json
import queue
import subprocess
import sys
import threading
import time


def pump_snapshot(session):
    """Observe loaded firmware modules; never import/start/restart the pump."""
    source = """def _mps_hil_snapshot():
    import sys
    p=sys.modules.get('trace_pump')
    r=sys.modules.get('dbgref')
    result={'pump_loaded':p is not None,'dbgref_loaded':r is not None}
    if p is not None:
        for k in ('_running','PUMP_PROTOCOL','PUMP_BUILD','bytes_in','cmds','continues'):
            result[k]=getattr(p,k,None)
    if r is not None:
        c=getattr(r,'cdc',None)
        result['cdc_present']=c is not None
        if c is not None:
            try: result['cdc_open']=bool(c.is_open())
            except Exception as e: result['cdc_open_error']=repr(e)
            try: result['cdc_dtr']=bool(c.dtr)
            except Exception as e: result['cdc_dtr_error']=repr(e)
    print(result)
try:
    _mps_hil_snapshot()
finally:
    del _mps_hil_snapshot
"""
    try:
        return {"status": "OBSERVED", "reply": session.code(source).strip()}
    except Exception as exc:
        return {"status": "UNAVAILABLE", "error": str(exc)}


def probe(root, port, observe=None):
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
            if observe:
                phase = "live DTR observation"
                observe(cycle, "open-before-write")
            phase = "pump_info"
            send("pump_info")
            reply = wait(lambda e: e["evt"] == "reply" and e.get("text", "").startswith("pump_info="))
            evidence.append(reply["text"])
            if observe:
                phase = "live receive counters"
                observe(cycle, "after-pump-info")
            print(f"  Debug cycle {cycle}/3: {reply['text']}", flush=True)
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
