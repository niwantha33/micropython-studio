# mpremotesubpro.py
import argparse
import subprocess
import sys
from pathlib import Path

def run_mpremote(python_exe, args_list, timeout=60):
    """Run mpremote and stream output in real-time with clean Ctrl+C handling"""
    cmd = [python_exe, '-m', 'mpremote'] + args_list

    proc = None
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.PIPE,
            text=True,
            encoding='utf-8',
            errors='replace',
            bufsize=1
        )

        # Stream output line by line
        while True:
            try:
                line = proc.stdout.readline()
                if line:
                    print(line, end="")
                if proc.poll() is not None:  # Process ended
                    break
            except KeyboardInterrupt:
                # This catches Ctrl+C while reading output
                print("\n\n👋 Ctrl+C detected. Stopping...", file=sys.stderr)
                break

        # Terminate the process gracefully
        if proc.poll() is None:
            print("🔁 Sending soft reset (Ctrl+D) to device...", file=sys.stderr)
            # Note: mpremote auto-handles soft reset on exit
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except:
                proc.kill()

        return subprocess.CompletedProcess(cmd, proc.returncode or 0, "", "")

    except KeyboardInterrupt:
        print("\n\n👋 Script manually interrupted. Exiting cleanly.", file=sys.stderr)
        if proc:
            proc.terminate()
            proc.kill()
        return subprocess.CompletedProcess(cmd, 0, "", "")
    except Exception as e:
        print(f"\n💥 Failed to run: {e}", file=sys.stderr)
        return subprocess.CompletedProcess(cmd, 1, "", str(e))
# ----------------------------
# Command: run (mount folder + run full file path)
# ----------------------------


def cmd_run(python_exe, port, file_path, folder=None):
    file_path = Path(file_path).resolve()
    if not file_path.is_file():
        print(f"❌ File not found: {file_path}", file=sys.stderr)
        sys.exit(1)

    # If folder not given, use parent of the file
    if folder is None:
        folder = file_path.parent
    folder = Path(folder).resolve()

    if not folder.is_dir():
        print(f"❌ Mount folder not found: {folder}", file=sys.stderr)
        sys.exit(1)

    print(f"📁 Mounting: {folder}", file=sys.stderr)
    print(f"🚀 Running: {file_path}", file=sys.stderr)
    print(f"🔌 Port: {port}", file=sys.stderr)
    print("-" * 50, file=sys.stderr)

    # 🔥 Correct command: mount "folder" run "full/file/path"
    args = [
        'connect', port,
        'mount', str(folder),
        'run', str(file_path)  # ← Full path to the .py file
    ]

    result = run_mpremote(python_exe, args, timeout=30)
    sys.exit(result.returncode)

# ----------------------------
# Command: mount
# ----------------------------


def cmd_mount(python_exe, port, folder):
    folder = Path(folder).resolve()
    if not folder.is_dir():
        print(f"❌ Folder not found: {folder}", file=sys.stderr)
        sys.exit(1)

    print(f"📁 Mounting {folder} to /remote...", file=sys.stderr)
    args = [
        'connect', port,
        'mount', str(folder),
        'exec', "print('✅ Mounted /remote')"
    ]
    result = run_mpremote(python_exe, args, timeout=15)
    if result.returncode != 0:
        print(f"❌ Mount failed:\n{result.stderr}")
        sys.exit(1)

# ----------------------------
# Command: unmount
# ----------------------------


def cmd_unmount(python_exe, port):
    print("⏏️ Unmounting /remote...", file=sys.stderr)
    code = "import os; os.umount('/remote')"
    args = ['connect', port, 'exec', code]
    result = run_mpremote(python_exe, args, timeout=10)
    if result.returncode == 0:
        print("✅ Unmounted /remote")
    else:
        if "ENODEV" in result.stderr or "not mounted" in result.stderr.lower():
            print("ℹ️ Already unmounted.")
        else:
            print(f"❌ Unmount failed:\n{result.stderr}")

# ----------------------------
# CLI
# ----------------------------


def main():
    parser = argparse.ArgumentParser(
        description="MicroPython IDE Backend (uses mpremote mount + run)"
    )
    parser.add_argument('--python', required=True,
                        help='Path to venv Python executable')

    subparsers = parser.add_subparsers(
        dest='command', required=True, help='Available commands')

    # Run: mount folder and run file (full path)
    run_p = subparsers.add_parser(
        'run', help='Mount folder and run a file by full path')
    run_p.add_argument('--port', required=True,
                       help='Serial port (e.g., COM9)')
    run_p.add_argument('--file', required=True,
                       help='Full path to the .py file to run')
    run_p.add_argument(
        '--folder', help='Folder to mount (default: parent of file)')

    # Mount
    mount_p = subparsers.add_parser('mount', help='Mount folder only')
    mount_p.add_argument('--port', required=True)
    mount_p.add_argument('--folder', required=True)

    # Unmount
    unmount_p = subparsers.add_parser('unmount', help='Unmount /remote')
    unmount_p.add_argument('--port', required=True)

    args = parser.parse_args()

    # Dispatch
    if args.command == 'run':
        cmd_run(args.python, args.port, args.file, args.folder)
    elif args.command == 'mount':
        cmd_mount(args.python, args.port, args.folder)
    elif args.command == 'unmount':
        cmd_unmount(args.python, args.port)


if __name__ == '__main__':
    main()
