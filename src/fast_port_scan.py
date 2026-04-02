#!/usr/bin/env python3
"""Fast COM port scanner using pyserial — outputs JSON to stdout.

Much faster than `mpremote connect list` because it avoids loading
the full mpremote package and attempting serial connections.

Known MicroPython/CircuitPython USB VID:PID pairs are tagged.
"""
import json
import serial.tools.list_ports

# Known vendor IDs for MicroPython / CircuitPython boards
KNOWN_VIDS = {
    0x2E8A: 'Raspberry Pi',       # Pico, Pico W, Pico 2
    0x239A: 'Adafruit',           # CircuitPython boards
    0x303A: 'Espressif',          # ESP32-S2, S3 native USB
    0x1A86: 'CH340',              # CH340 USB-serial (many ESP32 boards)
    0x10C4: 'Silicon Labs',       # CP210x (ESP32 DevKit)
    0x0403: 'FTDI',               # FT232 / FT2232
    0x04D8: 'Microchip',          # PIC / SAMD boards
    0x16C0: 'Teensy',             # Teensy boards
}

def scan():
    ports = serial.tools.list_ports.comports()
    result = []
    for p in sorted(ports, key=lambda x: x.device):
        vid = p.vid or 0
        pid = p.pid or 0
        vidpid = f"{vid:04X}:{pid:04X}"
        vendor = KNOWN_VIDS.get(vid, '')
        result.append({
            'port': p.device,
            'vidpid': vidpid,
            'vendor': vendor,
            'desc': p.description or '',
            'hwid': p.hwid or '',
        })
    print(json.dumps(result))

if __name__ == '__main__':
    scan()
