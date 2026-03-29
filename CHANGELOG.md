# Change Log

All notable changes to the "micropython-studio" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.7.0] - 2026-03-29

### Added
- **CircuitPython Support**: Complete integration for CircuitPython devices, including auto-detection, library management with `circup`, and Web Workflow (wireless) support.
- **Enhanced Device Dashboard**: A central hub for hardware telemetry (RAM, Flash, CPU), Wi-Fi management, and Pinout diagrams.
- **Improved WebREPL**: A robust terminal for wireless communication and file transfer with MicroPython devices.
- **Device File Explorer**: A unified tree view for browsing, reading, and managing files on the device filesystem.
- **Package Management**: Integrated `mip` (MicroPython) and `circup` (CircuitPython) for easy library installation.
- **Flash Firmware**: Built-in tools for downloading and flashing firmware directly from VS Code.

### Changed
- Refactored file upload/download logic for significantly improved speed and reliability.
- Optimized telemetry polling to reduce impact on serial communication.
- Enhanced Workspace UI with dedicated "Device Files" and "MicroPython Studio" sidebars.