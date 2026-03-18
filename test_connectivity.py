import socket
import sys

def check_port(ip, port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(3)
    try:
        s.connect((ip, port))
        print(f"✅ Success: Port {port} on {ip} is OPEN.")
        s.close()
        return True
    except Exception as e:
        print(f"❌ Error: Could not connect to {ip}:{port} - {e}")
        return False

if __name__ == "__main__":
    ip = "192.168.1.175"
    if len(sys.argv) > 1:
        ip = sys.argv[1]
    
    print(f"Checking connectivity to MicroPython at {ip}...")
    webrepl_open = check_port(ip, 8266)
    
    if not webrepl_open:
        print("\nPossible issues:")
        print("1. The board is not connected to the same Wi-Fi network.")
        print("2. A firewall on Windows is blocking port 8266.")
        print("3. WebREPL crashed or stopped on the board.")
    else:
        print("\nConnectivity is fine. The issue might be with mpremote or the password.")
