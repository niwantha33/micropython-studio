#!/usr/bin/env python3
"""
rfc_server.py
Simple TCP-to-Serial bridge for remote MicroPython REPL access.
Usage: python rfc_server.py [--port COM3] [--baud 115200] [--tcp-port 2217]
"""

import argparse
import serial
import serial.tools.list_ports
import socket
import threading
import sys


def _serial_to_client(ser, client_socket, stop_event):
    """Forward data from serial port to TCP client (runs in its own thread)."""
    try:
        while not stop_event.is_set():
            data = ser.read(1)
            if data:
                if ser.in_waiting:
                    data += ser.read(ser.in_waiting)
                client_socket.send(data)
    except Exception:
        pass


def handle_client(client_socket, ser):
    """Handle a single TCP client connection, bridging to serial."""
    client_socket.settimeout(1.0)
    stop_event = threading.Event()

    # Dedicated thread to push serial output to the TCP client
    reader_thread = threading.Thread(
        target=_serial_to_client,
        args=(ser, client_socket, stop_event),
        daemon=True
    )
    reader_thread.start()

    try:
        while True:
            try:
                data = client_socket.recv(1024)
            except TimeoutError:
                continue
            if not data:
                break
            ser.write(data)
    except Exception as e:
        print(f"Client error: {e}")
    finally:
        stop_event.set()
        client_socket.close()


def start_server(serial_port, baudrate, tcp_port):
    """Start the TCP-to-serial bridge server."""
    try:
        ser = serial.Serial(serial_port, baudrate, timeout=1)
    except serial.SerialException as e:
        print(f"Failed to open serial port {serial_port}: {e}")
        return

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('0.0.0.0', tcp_port))
    server.listen(5)
    print(f"TCP-to-serial bridge running on 0.0.0.0:{tcp_port} -> {serial_port} @ {baudrate} baud")

    try:
        while True:
            client_socket, addr = server.accept()
            print(f"Client connected: {addr}")
            client_thread = threading.Thread(
                target=handle_client,
                args=(client_socket, ser),
                daemon=True
            )
            client_thread.start()
    except KeyboardInterrupt:
        print("\nShutting down server...")
        server.close()
        ser.close()


def main():
    parser = argparse.ArgumentParser(
        description="TCP-to-Serial bridge for MicroPython REPL"
    )
    parser.add_argument('--port', default=None,
                        help='Serial port (e.g., COM3 or /dev/ttyUSB0)')
    parser.add_argument('--baud', type=int, default=115200,
                        help='Baud rate (default: 115200)')
    parser.add_argument('--tcp-port', type=int, default=2217,
                        help='TCP port to listen on (default: 2217)')

    args = parser.parse_args()

    # If no port specified, list available ports and ask
    if args.port is None:
        print("Available serial ports:")
        ports = serial.tools.list_ports.comports()
        if not ports:
            print("  No serial ports found!")
            sys.exit(1)
        for i, port in enumerate(ports):
            print(f"  [{i}] {port.device}: {port.description}")
        try:
            choice = int(input("Select port number: "))
            args.port = ports[choice].device
        except (ValueError, IndexError):
            print("Invalid selection.")
            sys.exit(1)

    start_server(args.port, args.baud, args.tcp_port)


if __name__ == "__main__":
    main()