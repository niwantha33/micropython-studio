#!/usr/bin/env python3
import serial.tools.list_ports
import json

def test_port_detection():
    try:
        ports = serial.tools.list_ports.comports()
        result = []
        for port in ports:
            port_info = {
                'path': port.device,
                'manufacturer': port.manufacturer or 'Unknown',
                'description': port.description or '',
                'hwid': port.hwid or ''
            }
            result.append(port_info)
        
        print("Detected ports:")
        for port in result:
            print(f"  {port['path']} - {port['manufacturer']}")
            
        return result
        
    except Exception as e:
        print(f"Error: {e}")
        return []

if __name__ == '__main__':
    test_port_detection()