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
                written = 0
                retries = 0
                while written < len(data) and _running:
                    try:
                        w = cdc.write(data[written:])
                        if w:
                            written += w
                            retries = 0
                        else:
                            retries += 1
                            if retries > 100:  # host disconnected or buffer stuck
                                break
                            time.sleep_ms(1)
                    except OSError:
                        # EWOULDBLOCK / buffer full - retry
                        retries += 1
                        if retries > 100:
                            break
                        time.sleep_ms(1)
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
            cmd_type = cmd_buf[1]
            cmd_len = cmd_buf[2]

            # Robust frame validation for commands from host
            is_valid = True
            if cmd_type in (0x10, 0x11, 0x13, 0x14, 0x17, 0x1B, 0x1C, 0x20) and cmd_len != 0:
                is_valid = False
            elif cmd_type in (0x12, 0x1A) and cmd_len > 1:
                is_valid = False
            elif cmd_type == 0x16 and cmd_len != 1:
                is_valid = False
            elif cmd_type == 0x18 and cmd_len < 2:
                is_valid = False
            elif cmd_type == 0x19 and cmd_len < 3:
                is_valid = False
            elif cmd_type == 0x15 and cmd_len < 4:
                is_valid = False
            elif cmd_type not in (0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x1B, 0x1C, 0x20):
                is_valid = False
            elif cmd_len > 256:
                is_valid = False

            if not is_valid:
                cmd_buf.pop(0)
                continue

            total = 3 + cmd_len
            if len(cmd_buf) < total:
                break
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
                    depth = cmd_buf[3] if cmd_len > 0 else 0
                    try:
                        if hasattr(dbg, 'globals'):
                            g = dbg.globals(depth)
                            while g is not None and g.get('__name__') == 'trace_pump':
                                try:
                                    next_g = dbg.globals(depth + 1)
                                    if next_g is None:
                                        break
                                    depth += 1
                                    g = next_g
                                except ValueError:
                                    break
                        else:
                            g = None
                    except ValueError:
                        pass
                    vals = dbg.locals(depth)
                    if vals is None:
                        text = "(not paused)"
                    else:
                        text = "depth=%d state=%s" % (depth, repr(vals))
                except Exception as e:
                    text = "err: " + repr(e)
                payload = text.encode()[:250]
                frame = bytes([0xAA, 0x03, len(payload)]) + payload
                try:
                    cdc.write(frame)
                except Exception:
                    pass
            elif cmd_type == 0x18:
                # poke_local: payload = slot_idx (1 byte), depth_idx (optional 1 byte), expr (str)
                try:
                    slot_idx = cmd_buf[3]
                    if cmd_len >= 2:
                        depth_idx = cmd_buf[4]
                        expr_bytes = cmd_buf[5:total]
                    else:
                        depth_idx = 0
                        expr_bytes = cmd_buf[4:total]
                    expr_str = expr_bytes.decode()
                    try:
                        if hasattr(dbg, 'globals'):
                            g = dbg.globals(depth_idx)
                            while g is not None and g.get('__name__') == 'trace_pump':
                                try:
                                    next_g = dbg.globals(depth_idx + 1)
                                    if next_g is None:
                                        break
                                    depth_idx += 1
                                    g = next_g
                                except ValueError:
                                    break
                        else:
                            g = None
                    except ValueError:
                        g = None
                    val = eval(expr_str, g if g is not None else {})
                    res = dbg.poke(slot_idx, val, depth_idx)
                    if res:
                        text = "poked slot %d (depth %d) = %r" % (slot_idx, depth_idx, val)
                    else:
                        text = "poke failed (not paused)"
                except Exception as e:
                    text = "err: " + repr(e)
                payload = text.encode()[:250]
                frame = bytes([0xAA, 0x03, len(payload)]) + payload
                try:
                    cdc.write(frame)
                except Exception:
                    pass
            elif cmd_type == 0x19:
                # poke_global: payload = depth_idx (1 byte), name_len (1 byte), name (str), expr (str)
                try:
                    p = cmd_buf[3:total]
                    depth_idx = p[0]
                    name_len = p[1]
                    name = bytes(p[2:2+name_len]).decode()
                    expr = bytes(p[2+name_len:]).decode()
                    try:
                        if hasattr(dbg, 'globals'):
                            g = dbg.globals(depth_idx)
                            while g is not None and g.get('__name__') == 'trace_pump':
                                try:
                                    next_g = dbg.globals(depth_idx + 1)
                                    if next_g is None:
                                        break
                                    depth_idx += 1
                                    g = next_g
                                except ValueError:
                                    break
                        else:
                            g = None
                    except ValueError:
                        g = None
                    if g is None:
                        try:
                            import sys
                            g = sys.modules['__main__'].__dict__
                        except Exception:
                            g = globals()
                    if g is not None:
                        val = eval(expr, g)
                        g[name] = val
                        text = "poked global %s (depth %d) = %r" % (name, depth_idx, val)
                    else:
                        text = "poke global failed (no globals context)"
                except Exception as e:
                    text = "err: " + repr(e) + " in " + repr(expr)
                payload = text.encode()[:250]
                frame = bytes([0xAA, 0x03, len(payload)]) + payload
                try:
                    cdc.write(frame)
                except Exception:
                    pass
            elif cmd_type == 0x1A:
                # globals: return dictionary of user globals
                try:
                    depth = cmd_buf[3] if cmd_len > 0 else 0
                    try:
                        if hasattr(dbg, 'globals'):
                            g = dbg.globals(depth)
                            while g is not None and g.get('__name__') == 'trace_pump':
                                try:
                                    next_g = dbg.globals(depth + 1)
                                    if next_g is None:
                                        break
                                    depth += 1
                                    g = next_g
                                except ValueError:
                                    break
                        else:
                            g = None
                    except ValueError:
                        g = None
                    if g is None:
                        text = "(not paused)"
                    else:
                        user_globals = {}
                        for k, v in g.items():
                            if not k.startswith("__"):
                                user_globals[k] = repr(v)
                        text = "depth=%d globals=%r" % (depth, user_globals)
                except Exception as e:
                    text = "err: " + repr(e)
                payload = text.encode()[:250]
                frame = bytes([0xAA, 0x03, len(payload)]) + payload
                try:
                    cdc.write(frame)
                except Exception:
                    pass
            elif cmd_type == 0x20:
                try:
                    dbg.halt()
                    text = "halt pending"
                except Exception as e:
                    text = "err: " + repr(e)
                payload = text.encode()[:250]
                frame = bytes([0xAA, 0x03, len(payload)]) + payload
                try:
                    cdc.write(frame)
                except Exception:
                    pass
            elif cmd_type == 0x1B:
                try:
                    dbg.rta_on()
                    text = "RTA trace enabled"
                except Exception as e:
                    text = "err: " + repr(e)
                payload = text.encode()[:250]
                frame = bytes([0xAA, 0x03, len(payload)]) + payload
                try:
                    cdc.write(frame)
                except Exception:
                    pass
            elif cmd_type == 0x1C:
                try:
                    dbg.rta_off()
                    text = "RTA trace disabled"
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


def get_tasks():
    try:
        import asyncio, machine
        q = asyncio.core._task_queue
        t = []
        while q.peek():
            t.append(q.pop())
        res = ','.join(str(x.coro) for x in t)
        for x in t:
            q.push(x, machine.mem32[id(x)+20])
        return res
    except Exception as e:
        return "err: " + repr(e)


def get_taskmap():
    try:
        import asyncio, machine
        q = asyncio.core._task_queue
        t = []
        while q.peek():
            t.append(q.pop())
        res = ','.join('%d:%s' % (machine.mem32[id(x.coro)+8], x.coro) for x in t)
        for x in t:
            q.push(x, machine.mem32[id(x)+20])
        return res
    except Exception as e:
        return "err: " + repr(e)


_sym_list = []


def get_symmap():
    global _sym_list
    try:
        import sys
        res = []
        for n, m in list(sys.modules.items()):
            if n not in ('sys', 'builtins'):
                for k in dir(m):
                    if k[0] != '_':
                        try:
                            o = getattr(m, k)
                            t = type(o).__name__
                            if t == 'function':
                                res.append('%d:object \'%s.%s\'' % (id(o), n, k))
                            elif t == 'type':
                                for c in dir(o):
                                    if c[0] != '_':
                                        f = getattr(o, c)
                                        if type(f).__name__ == 'function':
                                            res.append('%d:object \'%s.%s.%s\'' % (id(f), n, k, c))
                        except:
                            pass
        _sym_list = res
        print("get_symmap populated _sym_list with", len(res), "items")
        return str(len(res))
    except Exception as e:
        print("get_symmap error:", e)
        return "err: " + repr(e)


def get_symmap_chunk():
    global _sym_list
    try:
        print("get_symmap_chunk called, current _sym_list len =", len(_sym_list))
        chunk = _sym_list[:6]
        del _sym_list[:6]
        res = ','.join(chunk) if chunk else "None"
        print("returning chunk:", res[:50])
        return res
    except Exception as e:
        print("get_symmap_chunk error:", e)
        return "err: " + repr(e)
