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
                say(evt="reply", text=payload.decode(errors="replace"))
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
    if len(sys.argv) < 2:
        say(evt="error", msg="usage: dbg_bridge.py <PORT>")
        sys.exit(1)
    port = sys.argv[1]
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
