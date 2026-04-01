import sys

with open('c:/My-Projects/micropython-studio-py/micropython-studio/src/mpremotesubpro.py', 'r', encoding='utf-8') as f:
    content = f.read()

target = '''# ----------------------------
# Command: exec
# ----------------------------'''

new_cmd_ls = '''# ----------------------------
# Command: ls
# ----------------------------

def cmd_ls(python_exe, port, path='/'):
    """List directory contents in a format compatible with mpremote fs ls."""
    if _is_ws_port(port):
        host, password = _parse_ws_port(port)
        conn = WebReplConnection(host, password)
        try:
            conn.connect()
            code = f"""
import os
try:
    for f in os.ilistdir('{path}'):
        size = f[3] if len(f)>3 else 0
        is_dir = (f[1] == 0x4000)
        name = f[0] + ('/' if is_dir else '')
        print('{{:10}} {{}}'.format(size, name))
except:
    pass
"""
            import io as _io
            buf = _io.BytesIO()
            old = sys.stdout
            sys.stdout = _io.TextIOWrapper(buf, encoding='utf-8')
            conn.exec_code(code)
            sys.stdout.flush()
            sys.stdout = old
            sys.stdout.write(buf.getvalue().decode('utf-8', errors='ignore'))
        except Exception:
            pass
        finally:
            conn.close()
        sys.exit(0)

    # Serial
    _serial_pre_interrupt(python_exe, port)
    result = run_mpremote(python_exe, ['connect', port, 'fs', 'ls', path], timeout=15)
    sys.exit(result.returncode)

# ----------------------------
# Command: exec
# ----------------------------'''

content = content.replace(target, new_cmd_ls)

with open('c:/My-Projects/micropython-studio-py/micropython-studio/src/mpremotesubpro.py', 'w', encoding='utf-8') as f:
    f.write(content)

print("cmd_ls injected!")
