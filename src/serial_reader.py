#!/usr/bin/env python3
import serial
import serial.tools.list_ports
import json
import sys
import time
import threading


class SerialReader:
    def __init__(self):
        self.serial_conn = None
        self.running = False
        self.port = None
        self.baudrate = 1000000
        self.save_file = None
        self.saving = False
        self.start_time = None

    def list_ports(self):
        """List all available serial ports with proper error handling"""
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
                # Try to get more info if available
                if hasattr(port, 'product'):
                    port_info['product'] = port.product or ''
                if hasattr(port, 'serial_number'):
                    port_info['serial_number'] = port.serial_number or ''

                result.append(port_info)

            print(json.dumps({'ports': result}), flush=True)
            return result

        except Exception as e:
            error_msg = {'error': f"Failed to list ports: {str(e)}"}
            print(json.dumps(error_msg), flush=True)
            return []

    def connect(self, port_path):
        """Connect to specified serial port"""
        try:
            self.serial_conn = serial.Serial(
                port=port_path,
                baudrate=self.baudrate,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=0.1,
                write_timeout=0.1
            )

            # Test if port is actually accessible
            if self.serial_conn.is_open:
                self.port = port_path
                self.running = True
                self.start_time = time.time()
                print(json.dumps({'status': 'connected',
                      'port': port_path}), flush=True)
                return True
            else:
                raise Exception("Port opened but not accessible")

        except serial.SerialException as e:
            error_msg = {'error': f"Serial connection failed: {str(e)}"}
            print(json.dumps(error_msg), flush=True)
            return False
        except Exception as e:
            error_msg = {'error': f"Connection error: {str(e)}"}
            print(json.dumps(error_msg), flush=True)
            return False

    def start_saving(self, filename):
        """Start saving data to file"""
        try:
            self.save_file = open(filename, 'w', buffering=1)
            self.saving = True
            print(json.dumps({'status': 'saving_started',
                  'filename': filename}), flush=True)
            return True
        except Exception as e:
            error_msg = {'error': f"Failed to start saving: {str(e)}"}
            print(json.dumps(error_msg), flush=True)
            return False

    def stop_saving(self):
        """Stop saving data"""
        try:
            if self.save_file:
                self.save_file.close()
            self.saving = False
            print(json.dumps({'status': 'saving_stopped'}), flush=True)
            return True
        except Exception as e:
            error_msg = {'error': f"Failed to stop saving: {str(e)}"}
            print(json.dumps(error_msg), flush=True)
            return False

    def disconnect(self):
        """Disconnect from serial port"""
        try:
            self.stop_saving()
            if self.serial_conn and self.serial_conn.is_open:
                self.serial_conn.close()
            self.running = False
            self.port = None
            print(json.dumps({'status': 'disconnected'}), flush=True)
            return True
        except Exception as e:
            error_msg = {'error': f"Disconnect error: {str(e)}"}
            print(json.dumps(error_msg), flush=True)
            return False

    def read_data(self):
        """Read data from serial port with error handling"""
        if not self.serial_conn or not self.serial_conn.is_open or not self.running:
            return None

        try:
            # Read available data
            if self.serial_conn.in_waiting > 0:
                data = self.serial_conn.readline()
                if data:
                    decoded = data.decode('utf-8', errors='ignore').strip()
                    if decoded:
                        current_time = time.time()
                        elapsed_ms = int(
                            (current_time - self.start_time) * 1000)

                        # Process data format: [ch] data...
                        if decoded.startswith('[') and ']' in decoded:
                            end_bracket = decoded.find(']')
                            ch = decoded[1:end_bracket]
                            message = decoded[end_bracket+1:].strip()

                            result = {
                                'channel': ch,
                                'timestamp': int(self.start_time * 1000),
                                'elapsed_ms': elapsed_ms,
                                'data': message,
                                'raw': decoded
                            }

                            # Save to file if enabled
                            if self.saving and self.save_file:
                                save_line = f"{ch} {int(self.start_time * 1000)} {elapsed_ms} {message}\n"
                                self.save_file.write(save_line)

                            return result
            return None

        except serial.SerialException as e:
            error_msg = {'error': f"Read error: {str(e)}"}
            print(json.dumps(error_msg), flush=True)
            self.disconnect()
            return None
        except Exception as e:
            error_msg = {'error': f"Unexpected read error: {str(e)}"}
            print(json.dumps(error_msg), flush=True)
            return None

    def read_loop(self):
        """Main reading loop"""
        while self.running:
            data = self.read_data()
            if data:
                print(json.dumps(data), flush=True)
            time.sleep(0.001)  # Small delay to prevent CPU overload


def main():
    reader = SerialReader()
    read_thread = None

    print(json.dumps({'status': 'python_script_started'}), flush=True)

    try:
        while True:
            try:
                line = sys.stdin.readline().strip()
                if not line:
                    break

                command = json.loads(line)
                action = command.get('action')

                if action == 'list_ports':
                    reader.list_ports()

                elif action == 'connect':
                    port = command.get('port')
                    if port and reader.connect(port):
                        read_thread = threading.Thread(
                            target=reader.read_loop, daemon=True)
                        read_thread.start()

                elif action == 'start_save':
                    filename = command.get('filename', 'uart_capture.log')
                    reader.start_saving(filename)

                elif action == 'stop_save':
                    reader.stop_saving()

                elif action == 'disconnect':
                    reader.disconnect()
                    break

            except json.JSONDecodeError:
                error_msg = {'error': 'Invalid JSON command'}
                print(json.dumps(error_msg), flush=True)
            except Exception as e:
                error_msg = {'error': f"Command processing error: {str(e)}"}
                print(json.dumps(error_msg), flush=True)

    except KeyboardInterrupt:
        pass
    finally:
        reader.disconnect()
        if read_thread and read_thread.is_alive():
            read_thread.join(timeout=1.0)


if __name__ == '__main__':
    main()
