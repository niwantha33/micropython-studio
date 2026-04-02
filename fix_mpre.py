import sys

with open('c:/My-Projects/micropython-studio-py/micropython-studio/src/mpremotesubpro.py', 'r', encoding='utf-8') as f:
    content = f.read()

old_1 = '''def _serial_pre_interrupt(python_exe, port):
    """Send Ctrl+C twice via mpremote to interrupt any running code on the device."""
    try:
        subprocess.run(
            [python_exe, '-m', 'mpremote', 'connect', port, 'exec', 'print()'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL, timeout=5
        )
    except KeyboardInterrupt:
        print("\\n\\n👋 Script manually interrupted. Exiting cleanly.", file=sys.stderr)
        sys.exit(0)
    except Exception:
        pass  # best-effort — device may not respond'''

new_1 = '''def _serial_pre_interrupt(python_exe, port):
    """Fast pre-interrupt using pyserial. Falls back to mpremote if serial is unavailable."""
    if _is_ws_port(port):
        return
        
    try:
        import serial
        import time
        s = serial.Serial(port, 115200, timeout=0.1)
        s.write(b'\\r\\x03\\x03')
        time.sleep(0.05)
        s.close()
        return
    except Exception:
        pass

    try:
        subprocess.run(
            [python_exe, '-m', 'mpremote', 'connect', port, 'exec', 'print()'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL, timeout=2
        )
    except KeyboardInterrupt:
        print("\\n\\n👋 Script manually interrupted. Exiting cleanly.", file=sys.stderr)
        sys.exit(0)
    except Exception:
        pass  # best-effort — device may not respond'''

content = content.replace(old_1, new_1)

old_2 = '''    # Exec
    exec_p = subparsers.add_parser('exec', help='Execute code on device')
    exec_p.add_argument('--port', required=True, help='Serial port (e.g., COM9)')
    exec_p.add_argument('--code', required=True, help='Code to execute')'''

new_2 = '''    # Exec
    exec_p = subparsers.add_parser('exec', help='Execute code on device')
    exec_p.add_argument('--port', required=True, help='Serial port (e.g., COM9)')
    exec_p.add_argument('--code', required=True, help='Code to execute')

    # ls
    ls_p = subparsers.add_parser('ls', help='List files on device')
    ls_p.add_argument('--port', required=True)
    ls_p.add_argument('--path', default='/')'''

content = content.replace(old_2, new_2)

old_3 = '''    elif args.command == 'download':
        owf = [f for f in args.overwrite_files.split('|') if f] if args.overwrite_files else None
        cmd_download(args.python, args.port, args.dest, args.overwrite, args.skip, owf)


if __name__ == '__main__':'''

new_3 = '''    elif args.command == 'download':
        owf = [f for f in args.overwrite_files.split('|') if f] if args.overwrite_files else None
        cmd_download(args.python, args.port, args.dest, args.overwrite, args.skip, owf)
    elif args.command == 'ls':
        cmd_ls(args.python, args.port, args.path)


if __name__ == '__main__':'''

content = content.replace(old_3, new_3)

with open('c:/My-Projects/micropython-studio-py/micropython-studio/src/mpremotesubpro.py', 'w', encoding='utf-8') as f:
    f.write(content)

print("done!")
