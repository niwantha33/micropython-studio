# MicroPython Studio - VS Code Extension

<img src="../micropython-studio/resource/project.png" alt="MicroPython Studio Banner" width="300"/>

<img src="../micropython-studio/resource/wizard.png" alt="MicroPython Studio Banner" width="300"/>


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

### 0.6.0 (Upcoming)

- **New Features**:
  - Circuitpython
  - Bytecode conversion 
  - Multiple device support
- **Enhanced**:
  - File sync performance 

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

- `MicroPython: Setup Development Environment` - Initialize the required Python virtual environment
- `MicroPython: Create New Project` - Start new project wizard
- `MicroPython: Open Existing Project` - Open an existing MicroPython project folder
- `MicroPython: Update Device Port` - Select or update the COM port for your connected device
- `MicroPython: Run Script on Device` - Execute current script on the device
- `MicroPython: Stop Running Script` - Stop the currently executing script on the device
- `MicroPython: Open Device Shell` - Open an interactive REPL shell for the device
- `MicroPython: Upload Current File to Device` - Upload the currently active file to the device
- `MicroPython: Upload Project to Device` - Upload your entire project to the device
- `MicroPython: Mount & Run on Device` - Mount local folder and run on device
- `MicroPython: Refresh Device Files` - Refresh the device files tree view
- `MicroPython: Start Debug Session` - Start debugging on the device

## For More Information

- [MicroPython Documentation](https://docs.micropython.org/)
- [Extension GitHub Repository](https://github.com/niwantha33/micropython-studio)
- [Submit Issues](https://github.com/niwantha33/micropython-studio/issues)
- [MicroPython Community Forum](https://forum.micropython.org/)

## Support & Contact

Have a question, found a bug, or need help getting started?

- **Email:** niwantha33@gmail.com
- **GitHub Issues:** [github.com/niwantha33/micropython-studio/issues](https://github.com/niwantha33/micropython-studio/issues)

**Enjoy developing with MicroPython!** 🚀
