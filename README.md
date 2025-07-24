# MicroPython Studio - VS Code Extension

<img src="../micropython-studio/resource/project_logo.png" alt="MicroPython Studio Banner" width="600"/>



A powerful IDE extension for MicroPython development with hardware integration, device management, and seamless workflow tools.

## Features

### 🚀 Core Functionality

- **Project Creation Wizard**: Create MicroPython projects with device-specific templates
- **Device Management**: Detect, connect, and manage MicroPython devices (ESP32, RP2040, STM32)
- **Code Execution**: Run MicroPython code directly on connected devices
- **File Syncing**: Automatic sync between local files and device filesystem
- **Virtual Environment**: Built-in Python environment with required dependencies

### ⚙️ Workspace Features

- **Dedicated Device View**: Visual representation of device filesystem
- **Workspace Organization**: Clean project structure with logical separation
- **Hardware-Specific Settings**: Auto-configured settings for different microcontrollers
- **Serial Monitor**: Built-in terminal for device communication

### 🔌 Hardware Integration

- **Automatic Device Detection**: Identify connected MicroPython boards
- **One-Click Upload**: Deploy code to devices with a single button
- **Real-time File Sync**: Instantly see device filesystem changes
- **Mount Mode**: Develop directly on device filesystem

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

- **Port Conflicts**: Occurs when multiple processes access the same COM port simultaneously
- **Windows Path Handling**: Some commands require Git Bash for proper path conversion
- **Device Recognition**: Certain ESP32 variants may require manual driver installation
- **Virtual Environment**: First-time setup may take several minutes to complete

## Release Notes

### 1.0.0 (Initial Release)

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

### 1.0.1

- **Fixed**:
  - COM port access conflicts
  - Virtual environment setup on Windows
  - Path handling in Git Bash terminals
- **Improved**:
  - Device detection reliability
  - Error messaging for connection issues
  - Workspace loading performance

### 1.1.0 (Upcoming)

- **New Features**:
  - Serial monitor with plotter visualization
  - WiFi configuration manager
  - OTA (Over-the-Air) update support
  - Multiple device support
- **Enhanced**:
  - File sync performance
  - Project templates system
  - Hardware debugging support
- **Expanded Device Support**:
  - ESP8266
  - Raspberry Pi Pico W
  - BBC micro:bit

---

## Working with MicroPython Studio

### Getting Started

1. Install the extension
2. Connect your MicroPython device via USB
3. Create a new project using `Ctrl+Shift+P > MicroPython: Detect Device`
4. Detect your device with `MicroPython: Detect Device`
5. Start coding and use `MicroPython: Run Code` to execute

### Key Commands

- `Micropython: Create Project` - Start new project wizard
- `Micropython: Detect Device` - Scan for connected devices
- `Micropython: Run Code` - Execute current script on device
- `Micropython: Sync Folder` - Sync local folder to device
- `Micropython: Mount Device` - Enable direct filesystem editing

## For More Information

- [MicroPython Documentation](https://docs.micropython.org/)
- [Extension GitHub Repository](https://github.com/niwantha33/micropython-studio)
- [Submit Issues](https://github.com/niwantha33/micropython-studio/issues)
- [MicroPython Community Forum](https://forum.micropython.org/)

**Enjoy developing with MicroPython!** 🚀
