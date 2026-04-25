# trace_pump.py — runs on the Pico.
#
# Bidirectional:
#   - Drains the C ring buffer to dbg_cdc (trace + bp_hit events).
#   - Reads commands from dbg_cdc.
#         0xAA 0x10 0x00  = continue (resume from bp pause)
#
# Diagnostic counters (readable from REPL):
#   trace_pump.bytes_in     how many bytes read from cdc total
#   trace_pump.cmds         how many command frames parsed
#   trace_pump.continues    how many continue commands applied

import _thread
import time
import dbg

_running = False
bytes_in = 0
cmds = 0
continues = 0


def _pump():
    global _running, bytes_in, cmds, continues
    import dbgref
    cdc = dbgref.cdc
    cmd_buf = bytearray()
    dbg.set_pump_fun(_pump)

    while _running:
        dbg.mute()
        while True:
            data = dbg.read_trace(256)
            if not data:
                break
            try:
                cdc.write(data)
            except Exception:
                pass

        try:
            inc = cdc.read(64)
        except Exception:
            inc = None
        if inc:
            bytes_in += len(inc)
            cmd_buf.extend(inc)

        while len(cmd_buf) >= 3 and cmd_buf[0] == 0xAA:
            cmd_len = cmd_buf[2]
            total = 3 + cmd_len
            if len(cmd_buf) < total:
                break
            cmd_type = cmd_buf[1]
            cmds += 1
            if cmd_type == 0x10:
                dbg.resume()
                continues += 1
            elif cmd_type == 0x11:
                dbg.step()
                continues += 1
            elif cmd_type == 0x13:
                dbg.step_in()
                continues += 1
            elif cmd_type == 0x14:
                dbg.step_out()
                continues += 1
            elif cmd_type == 0x15:
                # set_bp_line: payload = mn_len(1), mn, fn_len(1), fn, line_lo, line_hi
                try:
                    p = cmd_buf[3:total]
                    i = 0
                    mn_len = p[i]; i += 1
                    mn = bytes(p[i:i+mn_len]).decode(); i += mn_len
                    fn_len = p[i]; i += 1
                    fn = bytes(p[i:i+fn_len]).decode(); i += fn_len
                    line = p[i] | (p[i+1] << 8)
                    mod = __import__(mn)
                    func = getattr(mod, fn)
                    ip = dbg.line_to_ip(func, line)
                    if ip < 0:
                        text = "no code on %s.%s line %d" % (mn, fn, line)
                    else:
                        slot = dbg.set_bp(func, ip)
                        text = "bp %d @ %s.%s:%d ip=%d fun=%d" % (slot, mn, fn, line, ip, id(func))
                except Exception as e:
                    text = "err: " + repr(e)
                payload = text.encode()[:250]
                frame = bytes([0xAA, 0x03, len(payload)]) + payload
                try:
                    cdc.write(frame)
                except Exception:
                    pass
            elif cmd_type == 0x16:
                # clear_bp: payload = slot (1 byte)
                try:
                    slot = cmd_buf[3]
                    dbg.clear_bp(slot)
                    text = "cleared bp %d" % slot
                except Exception as e:
                    text = "err: " + repr(e)
                payload = text.encode()[:250]
                frame = bytes([0xAA, 0x03, len(payload)]) + payload
                try:
                    cdc.write(frame)
                except Exception:
                    pass
            elif cmd_type == 0x17:
                # call_stack: return list of (fun_bc_ptr, ip_off)
                try:
                    stack = dbg.call_stack()
                    text = "stack=" + repr(stack)
                except Exception as e:
                    text = "err: " + repr(e)
                payload = text.encode()[:250]
                frame = bytes([0xAA, 0x03, len(payload)]) + payload
                try:
                    cdc.write(frame)
                except Exception:
                    pass
            elif cmd_type == 0x12:
                try:
                    vals = dbg.locals()
                    fi = dbg.frame_info()
                    if vals is None:
                        text = "(not paused)"
                    else:
                        text = "frame=" + repr(fi) + " state=" + repr(vals)
                except Exception as e:
                    text = "err: " + repr(e)
                payload = text.encode()[:250]
                frame = bytes([0xAA, 0x03, len(payload)]) + payload
                try:
                    cdc.write(frame)
                except Exception:
                    pass
            cmd_buf[:] = cmd_buf[total:]
        while cmd_buf and cmd_buf[0] != 0xAA:
            cmd_buf.pop(0)

        dbg.unmute()
        time.sleep_ms(5)


def start():
    global _running
    if _running:
        print("trace_pump: already running")
        return
    _running = True
    _thread.start_new_thread(_pump, ())
    print("trace_pump: started")


def stop():
    global _running
    _running = False
    print("trace_pump: stopping")


def stats():
    print("bytes_in =", bytes_in, "cmds =", cmds, "continues =", continues)
