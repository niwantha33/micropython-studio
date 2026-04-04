# 🚀 MicroPython Studio - VS Code Extension
### ✨ Supporting MicroPython & CircuitPython Platforms ✨

[![MicroPython](https://img.shields.io/badge/MicroPython-v1.20%2B-blue?logo=micropython&logoColor=white)](https://micropython.org)
[![CircuitPython](https://img.shields.io/badge/CircuitPython-v8.0%2B-purple?logo=adafruit&logoColor=white)](https://circuitpython.org)

<p >
  <img src="https://raw.githubusercontent.com/niwantha33/micropython-studio/main/resource/project.png" alt="project" width="400">
</p>

<p >
  <img src="https://raw.githubusercontent.com/niwantha33/micropython-studio/main/resource/wizard.png" alt="wizard" width="400">
</p>

---

A powerful IDE extension for MicroPython development with hardware integration, device management, and seamless workflow tools.

## Features

### Setup

| # | Feature | How to Use | What Happens |
|---|---------|-----------|--------------|
| 1 | Setup Virtual Environment | Command Palette → *Setup Environment* | `.venv` created, `mpremote` installed |
| 2 | Create New Project | Status bar *MPS vX.X* → Create New Project | Project folder + `device.cfg` created |
| 3 | Open Existing Project | Command Palette → *Open Existing Project* | Workspace opens, `device.cfg` detected |

### Connection

| # | Feature | How to Use | What Happens |
|---|---------|-----------|--------------|
| 4 | Auto-detect device (USB) | Connect board via USB + click Refresh | Status bar shows COM port |
| 5 | Auto-detect device (Wi-Fi) | Set `webrepl_enabled=true` in `device.cfg` | Status bar shows Wi-Fi IP |
| 6 | Manual port override | Command Palette → *Update Device Port* | Port updates in status bar |
| 7 | Port picker — USB vs Wi-Fi | Click device status bar button | QuickPick shows USB + Wi-Fi options |
| 8 | WebREPL terminal | Click status bar *WebREPL* button | Terminal panel opens, shows `>>>` prompt |

### Run

| # | Feature | How to Use | What Happens |
|---|---------|-----------|--------------|
| 9 | Run on Host (mount mode) | USB connected, target=Host, click *Run* | Script runs via mounted folder |
| 10 | Run on MCU (USB) | USB connected, target=MCU, click *Run* | Script executed on device via serial |
| 11 | Run via Wi-Fi | Wi-Fi port selected, click *Run* | Script runs over WebREPL |
| 12 | Right-click Run script | Right-click `.py` → *Run on MCU Console* | Script runs in terminal |
| 13 | Stop running script | Click *Stop* button during run | Device soft reset, `>>>` prompt returns |
| 14 | Switch Host / MCU target | Click Host/MCU toggle in status bar | Label updates, next run uses new target |

### File Upload

| # | Feature | How to Use | What Happens |
|---|---------|-----------|--------------|
| 15 | Upload single file | Right-click `.py` → *Upload Current File* | File copied to `/` on device |
| 16 | Upload folder | Right-click folder → *Upload Folder to Device* | `/foldername` created + all files uploaded |
| 17 | Upload folder with subfolders | Right-click folder with nested subdirs | Subdirs created first, all files uploaded correctly |
| 18 | Upload — overwrite protection | Upload folder that already exists on device | Shows conflicting files, asks *Overwrite? Y/N* |
| 19 | Upload entire project | Command Palette → *Upload Project to Device* | All `main/` files copied to device root |

### Device File Explorer

| # | Feature | How to Use | What Happens |
|---|---------|-----------|--------------|
| 20 | Browse device files | Expand *Device Files* panel tree | Files and folders listed |
| 21 | Read file from device | Click a file in the tree | File contents open in editor (read-only) |
| 22 | Delete file | Right-click file → *Delete File* | Confirm dialog, file removed, tree refreshes |
| 23 | Delete folder (with contents) | Right-click folder → *Delete Folder* | Confirm dialog, folder + all contents removed |
| 24 | Refresh tree | Click refresh icon in panel header | Tree re-reads device filesystem |

### Tools

| # | Feature | How to Use | What Happens |
|---|---------|-----------|--------------|
| 25 | Open REPL Shell | Click *Shell* in status bar | mpremote interactive REPL opens |
| 26 | Compile to bytecode | Right-click `.py` → *Compile to Bytecode* | `.mpy` file generated |
| 27 | Generate flowchart | Right-click `.py` → *Generate Flowchart* | Flowchart panel opens |
| 28 | Install package (mip) | Command Palette → *Install Package* | Package installed on device via mip |
| 29 | Flash firmware | Click *Flash* in status bar | Firmware selection + flash to device |
| 30 | Download firmware | Command Palette → *Download Firmware* | Firmware downloaded locally |

### Dashboard

| # | Feature | How to Use | What Happens |
|---|---------|-----------|--------------|
| 31 | Open dashboard | Click *Dashboard* in status bar | Dashboard panel opens |
| 32 | Wi-Fi Manager | Dashboard → Wi-Fi tab | Set SSID + password, save to device |
| 33 | WebREPL config | Dashboard → Wi-Fi → enable WebREPL | `webrepl_enabled` saved to `device.cfg` |
| 34 | Pinout view | Dashboard → Pinout tab | Board pinout diagram shown |

## Requirements

- **VS Code**: Version 1.75.0 or higher
- **Python**: 3.7+ installed and available in PATH
- **Hardware**: MicroPython-compatible device (ESP32, RP2040, STM32, etc.)
- **USB Drivers**: Appropriate drivers for your microcontroller

## Extension Settings

The extension contributes the following settings:

- `micropython-studio.autoConnect`: Automatically connect to last used device
- `micropython-studio.defaultDeviceType`: Default microcontroller type
- `micropython-studio.syncOnSave`: Auto-sync files to device on save
- `micropython-studio.venvPath`: Custom path to Python virtual environment
- `micropython-studio.terminalMode`: Preferred terminal type (PowerShell, CMD, Bash)

## Known Issues

- **Windows Path Handling**: Some commands require Git Bash for proper path conversion
- **Device Recognition**: Certain ESP32 variants may require manual driver installation

## Release Notes

### 0.4.0 (Initial Release)

- **Core Features**:
  - Project creation wizard
  - Device detection and management
  - Basic code execution
  - Virtual environment setup
- **Workspace Organization**:
  - Dedicated device folder view
  - Visual workspace separation
- **Initial Device Support**:
  - ESP32 series
  - Raspberry Pi Pico (RP2040)
  - STM32 boards

### 0.5.0

- **Fixed**:
  - COM port access conflicts
  - Virtual environment setup on Windows
  - Path handling in Git Bash terminals
- **Improved**:
  - Device detection reliability
  - Error messaging for connection issues
  - Workspace loading performance

### 0.6.x 

- **New Features**:
  - Circuitpython (partial support)
  - Bytecode conversion 
  - Multiple device support
  - Circuitpython -  (partial support)
  - Bytecode conversion - Done
  - Multiple device support - Done
  - WebREPL terminal - (partial support)
  - File upload and download - Done
  - Device file explorer - Done
  - Dashboard - Done
  - Library Install - Done
  - Pinout view - Done
  
- **Enhanced**:
  - File sync performance 
  - IntelliSense

### 0.7.0

- **Complete Support**:
  - Full CircuitPython compatibility (USB & Web Workflow)
  - Enhanced Device Dashboard with live telemetry
  - Hardware Pinout Diagram (RP2, ESP32, STM32, SAMD, etc.)
  - High-performance File Upload/Download (Folder support)
  - Device File Explorer with Overwrite Protection
  - WebREPL Terminal for wireless debugging
  - Integrated Package Management (`mip`, `circup`)
  - Bytecode Compilation (.mpy)
- **Enhanced**:
  - File sync performance optimization
  - Improved IntelliSense for MicroPython modules
  - Unified command palette and status bar integration

### 0.7.1 
- **Added**:
  - More detailed error messages and troubleshooting guides

### 0.7.2
- **Added**:
  - Support device upload/download 
  - Improved error handling for file operations
  - onclick library support for file upload/download

### 0.7.3 (Current)
- **Added**:
  - **Clean Terminal UI**: Automatic clearing of terminal command echo for a clean, professional execution experience.
  - **Output Filtering**: Silent mounting and suppression of absolute local paths from `mpremote` output.
  - Enable file manupulation (upload/download) via onclick library for WebREPL connections, providing a seamless wireless file management experience.



---

## Working with MicroPython Studio

### Getting Started

1. Install the extension
2. Connect your MicroPython device via USB
3. Set up the development environment: `Ctrl+Shift+P > MicroPython: Setup Development Environment`
4. Create a new project: `Ctrl+Shift+P > MicroPython: Create New Project`
5. Update your device port: `Ctrl+Shift+P > MicroPython: Update Device Port`
6. Start coding and use `MicroPython: Run Script on Device` to execute

### Key Commands

| Command | Description |
|---------|-------------|
| `MicroPython: Setup Development Environment` | Initialize the Python virtual environment and install dependencies |
| `MicroPython: Create New Project` | Start the new project wizard |
| `MicroPython: Open Existing Project` | Open an existing MicroPython project folder |
| `MicroPython: Update Device Port` | Select or update the COM port / Wi-Fi connection |
| `MicroPython: Run Script on Device` | Execute current script on the device |
| `MicroPython: Stop Running Script` | Stop the currently executing script |
| `MicroPython: Open Device Shell` | Open an interactive REPL shell |
| `MicroPython: Upload Current File to Device` | Upload the active file to the device root |
| `MicroPython: Upload Project to Device` | Upload your entire project to the device |
| `MicroPython: Mount & Run on Device` | Mount local folder and run directly on device |
| `MicroPython: Refresh Device Files` | Refresh the device files tree view |
| `MicroPython: Start Debug Session` | Start a debug session on the device |

## Acknowledgements

MicroPython Studio is open source (MIT License) and builds on the following open source projects:

| Library | Author | License | Role |
|---------|--------|---------|------|
| [mpremote](https://github.com/micropython/micropython/tree/master/tools/mpremote) | MicroPython project | MIT | Device communication, file transfer, REPL |
| [websocket-client](https://github.com/websocket-client/websocket-client) | websocket-client contributors | Apache 2.0 | WebREPL Wi-Fi connection |
| [term.js](https://github.com/chjj/term.js) | Christopher Jeffrey | MIT | Terminal emulator in WebREPL panel |
| [FileSaver.js](https://github.com/eligrey/FileSaver.js) | Eli Grey | MIT | File download in WebREPL panel |
| [MicroPython WebREPL](https://github.com/micropython/webrepl) | MicroPython project | MIT | WebREPL client (modified for VS Code integration) |
| [CircuitPython](https://github.com/adafruit/circuitpython) | Adafruit Industries | MIT | CircuitPython firmware and runtime support |
| [circup](https://github.com/adafruit/circup) | Adafruit Industries | MIT | CircuitPython package management and library installation |
| [adafruit-ampy](https://github.com/scientifichackers/ampy) | Scientific Hackers / Adafruit | MIT | CircuitPython file execution via serial REPL |
| [CircuitPython Web Workflow](https://docs.circuitpython.org/en/latest/docs/workflows.html) | Adafruit Industries | MIT | Wi-Fi file access and REPL via HTTP/WebSocket API |
| [esptool](https://github.com/espressif/esptool) | Espressif Systems | GPL-2.0 | ESP32 firmware flashing |
| [pyserial](https://github.com/pyserial/pyserial) | pyserial contributors | BSD | Serial port communication and device detection |

A special thanks to **AI development tools**. This project has been a work in progress for approximately three years, and many complex implementation hurdles seemed insurmountable. AI tools provided the critical support and breakthroughs needed to finally bring these concepts to life and complete the project.

All bundled files retain their original license headers.

---

## For More Information

- [MicroPython Documentation](https://docs.micropython.org/)
- [Extension GitHub Repository](https://github.com/niwantha33/micropython-studio)
- [Submit Issues](https://github.com/niwantha33/micropython-studio/issues)
- [MicroPython Community Forum](https://forum.micropython.org/)

## Support & Contact

Have a question, found a bug, or need help getting started?

- **Email:** niwantha33@gmail.com
- **GitHub Issues:** [github.com/niwantha33/micropython-studio/issues](https://github.com/niwantha33/micropython-studio/issues)

**Enjoy developing with MicroPython! and CircuitPython!** 🚀
