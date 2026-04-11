# Attempt to connect to the internet using the network module
import network
import time

# --- Configuration ---
SSID = "Your_WiFi_SSID"      # Replace with your actual network SSID
PASSWORD = "Your_WiFi_Password"  # Replace with your actual network password

def connect_to_wifi():
    print("Starting Wi-Fi connection attempt...")
    
    # Create an interface object
    wlan = network.WLAN(network.STA)
    
    if not wlan.isconnected():
        print(f"Scanning for networks...")
        wlan.active(True)
        
        # Wait for the network to find networks (this part is highly variable in MicroPython)
        time.sleep(5) 
        
        if wlan.isconnected():
            print("Wi-Fi connection established!")
            print("IP Address:", wlan.ifconfig()[0])
        else:
            print("Failed to connect to Wi-Fi. Check SSID and credentials.")
    else:
        print("Already connected to a network.")

try:
    connect_to_wifi()
except Exception as e:
    print(f"An error occurred during connection: {e}")

[MicroPython Studio AI]