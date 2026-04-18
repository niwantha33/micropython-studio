import urllib.request
import zipfile
import io
import sys
import os

def fetch_xbee_repo_contents(stubs_target_dir, lib_target_dir=None):
    print(f"Fetching XBee MicroPython repository from GitHub...")
    url = "https://github.com/digidotcom/xbee-micropython/archive/refs/heads/master.zip"
    
    os.makedirs(stubs_target_dir, exist_ok=True)
    if lib_target_dir:
        os.makedirs(lib_target_dir, exist_ok=True)
    
    try:
        with urllib.request.urlopen(url) as response:
            with zipfile.ZipFile(io.BytesIO(response.read())) as z:
                for info in z.infolist():
                    if info.is_dir():
                        continue
                        
                    # Extract typehints to stubs dir
                    if info.filename.startswith("xbee-micropython-master/typehints/"):
                        extracted_name = info.filename.replace("xbee-micropython-master/typehints/", "", 1)
                        if extracted_name:
                            file_path = os.path.join(stubs_target_dir, extracted_name)
                            os.makedirs(os.path.dirname(file_path), exist_ok=True)
                            with z.open(info) as source, open(file_path, "wb") as target:
                                target.write(source.read())
                                
                    # Extract lib to lib dir
                    elif lib_target_dir and info.filename.startswith("xbee-micropython-master/lib/"):
                        extracted_name = info.filename.replace("xbee-micropython-master/lib/", "", 1)
                        if extracted_name:
                            file_path = os.path.join(lib_target_dir, extracted_name)
                            os.makedirs(os.path.dirname(file_path), exist_ok=True)
                            with z.open(info) as source, open(file_path, "wb") as target:
                                target.write(source.read())
                                
        print("Successfully downloaded XBee repository contents.")
    except Exception as e:
        print(f"Error downloading XBee repository: {str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python fetch_xbee_stubs.py <stubs_target_dir> [lib_target_dir]")
        sys.exit(1)
        
    stubs_dir = sys.argv[1]
    lib_dir = sys.argv[2] if len(sys.argv) > 2 else None
    fetch_xbee_repo_contents(stubs_dir, lib_dir)
