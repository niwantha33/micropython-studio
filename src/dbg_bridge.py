# dbg_bridge.py — runs as a child of the VS Code extension.
#
# Opens the debug CDC port, reads framed events from the board, and sends
# commands from the extension. Talks to the extension via stdin/stdout using
# one JSON object per line.
#
# Stdin (extension → bridge):
#   {"op": "continue"}
#   {"op": "step"}
#   {"op": "step_in"}
#   {"op": "step_out"}
#   {"op": "locals"}
#   {"op": "quit"}
#
# Stdout (bridge → extension), one JSON per line:
#   {"evt": "open",   "port": "COM3"}
#   {"evt": "bp_hit", "ip": 8}
#   {"evt": "trace",  "ip": 12, "op": 55}
#   {"evt": "reply",  "text": "..."}
#   {"evt": "error",  "msg": "..."}
#   {"evt": "closed"}

import json
import sys
import threading
import time
import os

sys.path.append(os.path.dirname(__file__))
import mpy_parser

fun_map = {}
workspace_dir = ""

try:
    import serial
except ImportError:
    print(json.dumps({"evt": "error", "msg": "pyserial not installed"}), flush=True)
    sys.exit(1)

CMDS = {
    "continue": 0x10,
    "step":     0x11,
    "locals":   0x12,
    "step_in":  0x13,
    "step_out": 0x14,
    "call_stack": 0x17,
    "globals":  0x1A,
    "rta_on":   0x1B,
    "rta_off":  0x1C,
}


def say(**kw):
    sys.stdout.write(json.dumps(kw) + "\n")
    sys.stdout.flush()


def reader_loop(ser, stop_evt):
    buf = bytearray()
    while not stop_evt.is_set():
        try:
            data = ser.read(128)
        except Exception as e:
            say(evt="error", msg=f"read: {e}")
            return
        if not data:
            continue
        buf.extend(data)
        while len(buf) >= 3 and buf[0] == 0xAA:
            t = buf[1]
            n = buf[2]

            # Robust frame validation
            is_valid = True
            if t == 0x01 and n != 3:
                is_valid = False
            elif t == 0x02 and n != 2:
                is_valid = False
            elif t in (0x05, 0x06) and n != 8:
                is_valid = False
            elif t not in (0x01, 0x02, 0x03, 0x04, 0x05, 0x06):
                is_valid = False
            elif n > 256: # Avoid huge buffer reads on corrupt length
                is_valid = False

            if is_valid:
                total = 3 + n
                if len(buf) > total and buf[total] != 0xAA:
                    is_valid = False

            if not is_valid:
                buf.pop(0)
                continue

            total = 3 + n
            if len(buf) < total:
                break
            payload = bytes(buf[3:total])
            if t == 0x01 and n == 3:
                ip = payload[0] | (payload[1] << 8)
                say(evt="trace", ip=ip, op=payload[2])
            elif t == 0x02 and n == 2:
                ip = payload[0] | (payload[1] << 8)
                say(evt="bp_hit", ip=ip)
            elif t == 0x03:
                text = payload.decode(errors="replace")
                say(evt="reply", text=text)
                
                # Parse breakpoint registration to map funPtr -> (module, func)
                if text.startswith("bp "):
                    try:
                        import re
                        m = re.search(r"bp\s+(\d+)\s+@\s+([^.]+)\.([^:]+):(\d+)\s+ip=(\d+)\s+fun=(\d+)", text)
                        if m:
                            slot = int(m.group(1))
                            mod_name = m.group(2)
                            func_name = m.group(3)
                            line_num = int(m.group(4))
                            bp_ip = int(m.group(5))
                            fun_address = int(m.group(6))
                            
                            fun_map[fun_address] = {
                                "file_name": f"{mod_name}.py",
                                "func_name": func_name
                            }
                    except Exception:
                        pass
                
                # Parse paused frame info to resolve stepping source lines
                if "frame=" in text:
                    try:
                        import re
                        m = re.search(r"frame=\((\d+),\s*(\d+),\s*(\d+),\s*(\d+)\)", text)
                        if m:
                            state_len = int(m.group(1))
                            depth = int(m.group(2))
                            ip = int(m.group(3))
                            fun_address = int(m.group(4))
                            
                            if fun_address in fun_map:
                                info = fun_map[fun_address]
                                file_path = None
                                if workspace_dir:
                                    for root, dirs, files in os.walk(workspace_dir):
                                        if info["file_name"] in files:
                                            file_path = os.path.join(root, info["file_name"])
                                            break
                                if not file_path:
                                    for root, dirs, files in os.walk(os.getcwd()):
                                        if info["file_name"] in files:
                                            file_path = os.path.join(root, info["file_name"])
                                            break
                                            
                                if file_path and os.path.exists(file_path):
                                    mpy_file = file_path.replace(".py", ".mpy")
                                    if not os.path.exists(mpy_file) or os.path.getmtime(file_path) > os.path.getmtime(mpy_file):
                                        try:
                                            import subprocess
                                            subprocess.run([sys.executable, "-m", "mpy_cross", file_path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                                        except:
                                            pass
                                            
                                    if os.path.exists(mpy_file):
                                        try:
                                            rc, qstrs, objs = mpy_parser.parse_mpy(mpy_file)
                                            line_map = mpy_parser.build_line_map(rc)
                                            func_code = None
                                            for name, code in line_map.items():
                                                if name.endswith(info["func_name"]):
                                                    func_code = code
                                                    break
                                            if func_code:
                                                line1 = func_code.get_source_line(ip)
                                                say(evt="step_line", file=file_path.replace("\\", "/"), line=line1)
                                        except:
                                            pass
                    except Exception:
                        pass
            elif t == 0x04 and n >= 2:
                ip = payload[0] | (payload[1] << 8)
                msg = payload[2:].decode(errors="replace")
                say(evt="exception", ip=ip, msg=msg)
            elif t == 0x05 and n == 8:
                fun = payload[0] | (payload[1] << 8) | (payload[2] << 16) | (payload[3] << 24)
                ts = payload[4] | (payload[5] << 8) | (payload[6] << 16) | (payload[7] << 24)
                say(evt="rta_entry", fun=fun, ts=ts)
            elif t == 0x06 and n == 8:
                fun = payload[0] | (payload[1] << 8) | (payload[2] << 16) | (payload[3] << 24)
                ts = payload[4] | (payload[5] << 8) | (payload[6] << 16) | (payload[7] << 24)
                say(evt="rta_exit", fun=fun, ts=ts)
            else:
                say(evt="raw", type=t, payload=payload.hex())
            del buf[:total]
        while buf and buf[0] != 0xAA:
            buf.pop(0)


def main():
    global workspace_dir
    if len(sys.argv) < 2:
        say(evt="error", msg="usage: dbg_bridge.py <PORT> [WORKSPACE_DIR]")
        sys.exit(1)
    port = sys.argv[1]
    if len(sys.argv) > 2:
        workspace_dir = sys.argv[2]
    try:
        ser = serial.Serial(port, 115200, timeout=0.1, write_timeout=1.0,
                            dsrdtr=False, rtscts=False)
    except Exception as e:
        say(evt="error", msg=f"open {port}: {e}")
        sys.exit(1)
    time.sleep(0.1)
    say(evt="open", port=port)

    stop_evt = threading.Event()
    t = threading.Thread(target=reader_loop, args=(ser, stop_evt), daemon=True)
    t.start()

    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                say(evt="error", msg=f"bad json: {line!r}")
                continue
            op = msg.get("op")
            if op == "quit":
                break
            code = CMDS.get(op)
            if code is None and op not in ("set_bp", "clear_bp", "poke_local", "poke_global"):
                say(evt="error", msg=f"unknown op: {op}")
                continue
            try:
                if op == "set_bp":
                    mn = msg.get("module", "").encode()
                    fn = msg.get("func", "").encode()
                    line = int(msg.get("line", 0)) & 0xFFFF
                    payload = bytes([len(mn)]) + mn + bytes([len(fn)]) + fn \
                              + bytes([line & 0xFF, (line >> 8) & 0xFF])
                    ser.write(bytes([0xAA, 0x15, len(payload)]) + payload)
                elif op == "clear_bp":
                    slot = int(msg.get("slot", 0)) & 0xFF
                    ser.write(bytes([0xAA, 0x16, 1, slot]))
                elif op == "poke_local":
                    slot = int(msg.get("slot", 0)) & 0xFF
                    depth = int(msg.get("depth", 0)) & 0xFF
                    expr = msg.get("expr", "").encode()
                    payload = bytes([slot, depth]) + expr
                    ser.write(bytes([0xAA, 0x18, len(payload)]) + payload)
                elif op == "poke_global":
                    depth = int(msg.get("depth", 0)) & 0xFF
                    name = msg.get("name", "").encode()
                    expr = msg.get("expr", "").encode()
                    payload = bytes([depth, len(name)]) + name + expr
                    ser.write(bytes([0xAA, 0x19, len(payload)]) + payload)
                else:
                    ser.write(bytes([0xAA, code, 0x00]))
                ser.flush()
                say(evt="sent", op=op)
            except Exception as e:
                say(evt="error", msg=f"write: {e}")
    finally:
        stop_evt.set()
        time.sleep(0.2)
        try:
            ser.close()
        except Exception:
            pass
        say(evt="closed")


if __name__ == "__main__":
    main()
