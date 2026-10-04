"""
MicroPython Studio - Live Debugger - trace_pump_pro.py
Original concept & trace method by Niwantha Nadeesh (niwantha33)
Enhanced v1.3.0 - Professional Edition
License: MIT
"""

import sys
import gc
import json

try:
    import micropython
    micropython.alloc_emergency_exception_buf(100)
except Exception:
    pass

_breakpoints = set()
_current_frame = None

def _safe_repr(obj, max_len=80):
    try:
        r = repr(obj)
        return r[:max_len]+"..." if len(r)>max_len else r
    except Exception:
        return "<unrepr>"

def _get_locals(frame):
    result = {}
    for k, v in frame.f_locals.items():
        if k.startswith("__mpy_debug"): continue
        try:
            result[k] = {"value": _safe_repr(v), "type": type(v).__name__}
        except Exception:
            result[k] = {"value": "<error>", "type": "unknown"}
    try:
        result["__mem_free__"] = {"value": gc.mem_free(), "type": "int"}
    except Exception:
        pass
    return result

def _get_stack(frame, max_depth=20):
    stack = []
    f = frame
    depth = 0
    while f and depth < max_depth:
        try:
            stack.append({"file": f.f_code.co_filename, "line": f.f_lineno, "func": f.f_code.co_name})
        except Exception:
            pass
        f = f.f_back
        depth += 1
    return stack

def _trace_func(frame, event, arg):
    global _current_frame
    filename = frame.f_code.co_filename
    lineno = frame.f_lineno
    if filename.startswith("<") or "trace_pump" in filename:
        return _trace_func
    should_break = (filename, lineno) in _breakpoints or event == 'exception'
    if should_break:
        _current_frame = frame
        payload = {"t": "break" if event!='exception' else "exception", "file": filename, "line": lineno, "func": frame.f_code.co_name, "locals": _get_locals(frame), "stack": _get_stack(frame), "mem_free": gc.mem_free() if hasattr(gc, 'mem_free') else 0}
        try:
            print("__MPY_DEBUG__" + json.dumps(payload), file=sys.stderr)
        except Exception:
            pass
        while True:
            try:
                cmd = sys.stdin.readline().strip().lower()
                if cmd in ("c", "continue", "s", "step", "n", "next"): break
                if cmd in ("q", "quit"): 
                    stop_debugging()
                    sys.exit(0)
            except Exception:
                break
    return _trace_func

def set_breakpoints(bps):
    global _breakpoints
    _breakpoints = set((b["file"], b["line"]) for b in bps if "file" in b and "line" in b)

def start_debugging():
    sys.settrace(_trace_func)
    print("__MPY_DEBUG__" + json.dumps({"t": "started", "free": gc.mem_free() if hasattr(gc, 'mem_free') else 0}), file=sys.stderr)

def stop_debugging():
    try:
        sys.settrace(None)
        print("__MPY_DEBUG__" + json.dumps({"t": "stopped"}), file=sys.stderr)
    except Exception:
        pass
