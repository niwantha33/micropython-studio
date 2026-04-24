# Change Log

All notable changes to the "micropython-studio" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.9.1] - 2026-04-23

### Fixed
- **MIP Installation Stability**: Implemented recursive directory creation (`mkdir -p`) on the device to support complex package structures during installation.
- **Robust File Operations**: Added device-side handle validation (`if '_f' in globals()`) to prevent "NameError cascades" when file operations fail due to filesystem limits.
- **Optimized Bulk Uploads**: Refactored directory creation to execute in a single device-side block, significantly reducing the overhead of nested path creation.

## [0.9.0] - 2026-04-23

### Added
- **Native High-Performance Serial Backend**: Migrated core operations to a native PySerial implementation (`mps`) for superior stability on Windows Dual-CDC devices.
- **Adaptive DTR Strategy**: Intelligent signaling that supports both MicroPython (DTR=False) and CircuitPython/RP2350 (DTR=True) automatically.
- **Professional ASCII UI**: Cleaned up all terminal outputs and documentation to a professional ASCII-only standard for maximum cross-platform compatibility.
- **Light Kick (Ctrl-B) Sync**: Improved synchronization for "Run on Host" commands to prevent `mpremote` handshake collisions.

## [0.8.1] - 2026-04-06

### Added
- **Enhanced AI Context Awareness**: Dynamically detects project root and connected device configuration to provide more accurate, hardware-specific guidance.
- **Interactive AI Code Actions**: Added "Insert", "Run", "New File", and "Copy" buttons directly in the AI Chat window for a seamless coding workflow.
- **Structured Prompt Engineering**: Improved AI response quality through structured context injection (`[device]`, `[filePath]`).
- **Stable WebREPL**: Resolved connection stability issues by enforcing mandatory WebSocket frame masking compliant with RFC 6455.
- **Robust Boot Configuration**: New `boot.py` template with improved Wi-Fi connectivity and a dedicated USB-detection window to prevent remote-access lockouts.

## [0.8.0] - 2026-04-05

### Added
- **Premium AI Assistance**: Completely redesigned UI with glassmorphism and modern aesthetics.
- **Conversation Memory**: Switched to multi-turn chat history (supports Ollama's `api/chat`).
- **History Persistence**: Chat sessions are saved and restored across VS Code reloads.
- **High-Performance Communication**: Refactored backend to use `stdin` data streams for large chat histories.

## [0.7.3] - 2026-04-04

### Added
- **Clean Terminal UI**: Implemented automatic terminal clearing that hides the long execution command echo, providing a professional, GUI-like experience.
- **Output Filtering**: Added logic to suppress noisy `mpremote` system messages (e.g., "is mounted at /remote") and absolute local paths to keep the terminal output focused on code results.

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