#!/usr/bin/env python3
"""Local TCP-to-serial REPL bridge.

The REPL has arbitrary code execution privileges on the device. By default it
is reachable only from this computer. Remote access must be explicitly enabled
and should be protected by a VPN or another authenticated transport.
"""

import argparse
import socket
import sys
import threading

import serial
import serial.tools.list_ports


def _serial_to_client(ser, client_socket, stop_event):
    """Read serial data for the currently connected client only."""
    while not stop_event.is_set():
        try:
            data = ser.read(1)
            if data:
                waiting = min(ser.in_waiting, 4096)
                if waiting:
                    data += ser.read(waiting)
                client_socket.sendall(data)
        except (OSError, serial.SerialException):
            stop_event.set()
            break


def handle_client(client_socket, ser):
    """Allow one client at a time; never share a serial port across clients."""
    stop_event = threading.Event()
    with client_socket:
        client_socket.settimeout(1.0)
        reader = threading.Thread(
            target=_serial_to_client,
            args=(ser, client_socket, stop_event),
            daemon=True,
        )
        reader.start()
        try:
            while not stop_event.is_set():
                try:
                    data = client_socket.recv(1024)
                except socket.timeout:
                    continue
                if not data:
                    break
                ser.write(data)
        except (OSError, serial.SerialException) as error:
            print("Client disconnected: {}".format(error), file=sys.stderr)
        finally:
            stop_event.set()
            # serial.read() has a bounded timeout; wait for its reader to stop
            # before accepting a client that could otherwise receive stale data.
            reader.join(timeout=2.0)


def start_server(serial_port, baudrate, tcp_port, host="127.0.0.1",
                 allow_remote=False):
    """Serve a single REPL client, closing serial and socket on every exit."""
    if host not in ("127.0.0.1", "localhost", "::1") and not allow_remote:
        raise ValueError(
            "Non-loopback binding requires --allow-remote; "
            "the serial REPL has no built-in authentication."
        )
    if allow_remote and host not in ("127.0.0.1", "localhost", "::1"):
        print("WARNING: The REPL is unauthenticated. Use a VPN or secure tunnel.",
              file=sys.stderr)

    with serial.Serial(serial_port, baudrate, timeout=0.2) as ser:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind((host, tcp_port))
            server.listen(1)
            print("TCP-to-serial bridge on {}:{} -> {} @ {} baud".format(
                host, tcp_port, serial_port, baudrate
            ))
            try:
                while True:
                    client_socket, address = server.accept()
                    print("Client connected:", address)
                    handle_client(client_socket, ser)
            except KeyboardInterrupt:
                print("\nShutting down bridge...")


def main():
    parser = argparse.ArgumentParser(description="TCP-to-serial MicroPython REPL bridge")
    parser.add_argument("--port", help="Serial port (COM3 or /dev/ttyUSB0)")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--tcp-port", type=int, default=2217)
    parser.add_argument("--host", default="127.0.0.1",
                        help="Listen address (default: 127.0.0.1 only)")
    parser.add_argument("--allow-remote", action="store_true",
                        help="Explicitly allow an unauthenticated remote REPL (unsafe without VPN)")
    args = parser.parse_args()

    if not 1 <= args.tcp_port <= 65535 or args.baud <= 0:
        parser.error("TCP port must be 1..65535 and baud must be positive")

    if not args.port:
        ports = list(serial.tools.list_ports.comports())
        if not ports:
            parser.error("No serial ports found")
        for i, port in enumerate(ports):
            print("[{}] {}: {}".format(i, port.device, port.description))
        try:
            choice = int(input("Select port number: "))
            args.port = ports[choice].device
            if choice < 0:
                raise IndexError
        except (ValueError, IndexError):
            parser.error("Invalid serial port selection")

    try:
        start_server(args.port, args.baud, args.tcp_port,
                     host=args.host, allow_remote=args.allow_remote)
    except (OSError, serial.SerialException, ValueError) as error:
        parser.exit(1, "Bridge failed: {}\n".format(error))


if __name__ == "__main__":
    main()
