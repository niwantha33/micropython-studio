"""
webrepl_bridge.py — stdio ↔ WebREPL bridge for MicroPython Studio.

Usage:
    python webrepl_bridge.py --host IP --password PASS [--port 8266]

Protocol (newline-delimited JSON on stdout/stdin):
  Extension → bridge (stdin):
    {"type":"input","data":[...bytes...]}
    {"type":"quit"}

  Bridge → extension (stdout):
    {"type":"connected"}
    {"type":"output","data":[...bytes...]}
    {"type":"error","msg":"..."}
    {"type":"disconnected","reason":"..."}
"""

import sys
import json
import time
import threading
import argparse

try:
    import websocket
except ImportError:
    print(json.dumps({"type": "error", "msg": "websocket-client not installed"}), flush=True)
    sys.exit(1)


def send(obj):
    """Write a JSON message to stdout."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def recv_loop(ws):
    """Forward board output → extension (runs in background thread)."""
    try:
        while True:
            data = ws.recv()
            if data is None:
                break
            if isinstance(data, str):
                bdata = data.encode("latin-1", errors="replace")
            else:
                bdata = data
            send({"type": "output", "data": list(bdata)})
    except Exception as e:
        send({"type": "disconnected", "reason": str(e)})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--password", default="")
    parser.add_argument("--port", type=int, default=8266)
    args = parser.parse_args()

    url = f"ws://{args.host}:{args.port}"

    try:
        ws = websocket.create_connection(url, timeout=10)
    except Exception as e:
        send({"type": "error", "msg": f"Connection failed: {e}"})
        sys.exit(1)

    # Handle password prompt
    try:
        prompt = ws.recv()
        if "Password" in str(prompt):
            ws.send(args.password + "\r\n")
            time.sleep(0.2)
            resp = ws.recv()
            if "denied" in str(resp).lower():
                send({"type": "error", "msg": "WebREPL password incorrect"})
                ws.close()
                sys.exit(1)
        send({"type": "connected"})
        # Forward the 'connected' response text
        if resp:
            if isinstance(resp, str):
                bdata = resp.encode("latin-1", errors="replace")
            else:
                bdata = resp
            send({"type": "output", "data": list(bdata)})
    except Exception as e:
        send({"type": "error", "msg": f"Auth failed: {e}"})
        sys.exit(1)

    # Start background thread to forward board output
    t = threading.Thread(target=recv_loop, args=(ws,), daemon=True)
    t.start()

    # Main thread: read keystrokes from stdin and forward to board
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue

            if msg.get("type") == "quit":
                break
            elif msg.get("type") == "input":
                try:
                    ws.send_binary(bytes(msg["data"]))
                except Exception as e:
                    send({"type": "disconnected", "reason": str(e)})
                    break
    finally:
        try:
            ws.close()
        except Exception:
            pass
        send({"type": "disconnected", "reason": "Session ended"})


if __name__ == "__main__":
    main()
