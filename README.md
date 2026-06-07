# MicroPython Studio - VS Code Extension
### Write, Deploy, Live Debug, and Simulate MicroPython & CircuitPython Applications

[![MicroPython](https://img.shields.io/badge/MicroPython-v1.20%2B-blue?logo=micropython&logoColor=white)](https://micropython.org)
[![CircuitPython](https://img.shields.io/badge/CircuitPython-v10.x-purple?logo=adafruit&logoColor=white)](https://circuitpython.org)
[![XBee](https://img.shields.io/badge/XBee-MicroPython-orange)](https://www.digi.com/xbee)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE.md)

---

## 🎉 Welcome to Version 2.0.0 (The Hardware Simulator & Co-Pilot Release)

MicroPython Studio v2.0.0 brings hardware emulation directly into your coding editor, enabling a complete test environment without physical boards.

### What's New in v2.0.0:
* **Integrated Hardware Simulator**: Run and test MicroPython code on an emulated Raspberry Pi Pico 2 W (MPS2 AN385 Cortex-M3 target) powered by portable QEMU binaries.
* **Dynamic Status Bar Controls**: Toggle the simulator with a single click in your status bar. When running, the button turns **Vibrant Green** (`✔ Sim Active`) and lets you stop the emulator cleanly.
* **Automatic Execution Routing**: When the simulator is active, clicking the main **Run** button automatically routes code execution to "Run on MCU" (direct socket REPL stream), bypassing serial limits.
* **Filesystem Write Guards**: Clear dialog warnings guide you on simulator constraints (filesystem is read-only VfsRom) and suggest placing missing files (like `asyncio` or custom modules) inside a local `lib/` directory.
* **TCP Connection Robustness**: Upgraded socket adapters in `mps_backend.py` with automatic retry logic to prevent race conditions during QEMU boot.

---

## 🚀 Key Features

* **Bytecode-Level Live Debugger**: Set breakpoints, step through lines, view the call stack, and inspect local variables directly on your board (or simulator) over USB with a rich VS Code debugger UI. No JTAG or complex wiring required.
* **Local Private AI Co-Pilot**: Context-aware AI assistant powered by **Ollama** (`micro_ai` models). Keeps your code 100% private, automatically reads your active file contents, and understands your connected hardware.
* **Device File Explorer**: Browse, read, delete, create, and rename files directly on the micro-controller filesystem.
* **Digi XBee Support**: Full project templates, serial execution, and filesystem routing for XBee3 cellular/mesh modules.
* **Unified Telemetry Dashboard**: Telemetry status, Wi-Fi manager configuration, WebREPL configurations, and interactive Pinout Diagrams (RP2040, ESP32, STM32, etc.) at a glance.

[![MicroPython Studio Debugger Video](https://img.youtube.com/vi/or_aG-Rhnb8/maxresdefault.jpg)](https://www.youtube.com/watch?v=or_aG-Rhnb8)

---

## 💻 Working with the QEMU Simulator

The simulator provides a great workspace to prototype application logic without needing physical hardware.

### 1. Launching and Stopping
- Click the **Simulator** button on the bottom status bar. 
- The extension automatically downloads a lightweight, portable QEMU binary (cross-platform for Windows, macOS, Linux) and the emulator firmware.
- The button turns green and shows **`✔ Sim Active`**. Click it again to terminate the emulation.

### 2. Execution Target
- Keep your run target on the default settings. Clicking **Run** while the simulator is enabled will automatically execute your code via raw REPL memory streaming.

### 3. Read-Only Filesystem Alert
- The simulated board uses a **read-only ROM filesystem** (`VfsRom`).
- Direct file uploads or package downloads (via `mip` / package manager) will be blocked with a warning dialog.
- **How to use libraries**: If your code requires libraries (such as `asyncio`), simply create a `lib/` directory inside your local PC workspace and place them there. When you click Run, the directory is temporarily mounted, making the libraries available to your code in RAM.

---

## 🧠 Setting Up Local AI Assistant (Ollama)
1. Install [Ollama](https://ollama.com) on your computer.
2. Click the **AI Assistant** icon in the VS Code sidebar.
3. The assistant will detect your Ollama installation and download the optimized `micro_ai` coding model automatically.
4. Ask questions, insert code snippets directly into your files, or run them with a single click.

---

## 🛠️ Quick Commands

| Command | Action |
|---------|--------|
| `MicroPython: Setup Development Environment` | Initialize Python `.venv` and install `mpremote` |
| `MicroPython: Create New Project` | Start the wizard to generate configuration files and directories |
| `MicroPython: Open Existing Project` | Open an existing workspace containing `device.cfg` |
| `MicroPython: Run Script on Device` | Run the active `.py` script |
| `MicroPython: Stop Running Script` | Stop execution and perform a soft-reboot |
| `MicroPython: Open Device Shell` | Launch an interactive REPL shell in your terminal panel |

---

## 📋 Release History

### 2.0.0 (The Hardware Simulator & Co-Pilot Release)
* **QEMU Simulator Integration**: Full emulation support for Raspberry Pi Pico 2 W targets directly in VS Code.
* **Dynamic Simulator Control**: Interactive, colorized status bar buttons to start, stop, and monitor emulator state.
* **Auto-Routing**: Automatically directs execution requests to direct REPL streaming when the simulator is enabled.
* **VfsRom Guards**: Warnings intercepting write attempts on the read-only simulator filesystem and explaining local `lib/` directory fallbacks for files like `asyncio`.
* **TCP Connection Robustness**: Retry loops in the socket backend to ensure clean connections on slow device boot.

### 1.0.0 (Live Debugger Release)
* **Bytecode-Level Debugging**: Support for breakpoints, call-stack inspection, and locals analysis directly over serial/USB.
* **Conditional Breakpoints**: Pause debugger execution when specific evaluations are met.

### 0.9.0 (Backend Refactoring)
* **mpremote to mps migration**: Migrated all core operations to a dedicated, high-performance `mps_backend` to eliminate port locks and busy conflicts.
* **Enhanced File Operations**: Folder rename, mkdir, and targeted folder uploads added.

### 0.8.x (Local AI Assistance)
* **Ollama Integration**: Multi-turn chat assistant with deep hardware context sensitivity and file awareness.

---

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
| [xbee-micropython](https://github.com/digidotcom/xbee-micropython) | Digi International | MIT | XBee MicroPython typehints, stubs, and libraries |
| [esptool](https://github.com/espressif/esptool) | Espressif Systems | GPL-2.0 | ESP32 firmware flashing |
| [pyserial](https://github.com/pyserial/pyserial) | pyserial contributors | BSD | Serial port communication and device detection |
| [QEMU](https://www.qemu.org) | QEMU Project | GPL-2.0 | Hardware emulated processor execution & simulation |
| [Ollama](https://ollama.com) | Ollama Contributors | MIT | Local AI LLM model orchestration & execution engine |
| [Gemma](https://ai.google.dev/gemma) | Google DeepMind | Gemma Terms | Optimized local LLM for private AI assistance |

A special piece of **project history**: This extension has been a work in progress for approximately three years. Early on, many complex implementation hurdles for hardware interactions seemed insurmountable. **AI development tools** provided the critical support, documentation insights, and breakthroughs needed to finally bring these concepts to life. AI is at the very heart of how MicroPython Studio was built.

All bundled files retain their original license headers.

---

## For More Information

- [MicroPython Documentation](https://docs.micropython.org/)
- [Extension GitHub Repository](https://github.com/niwantha33/micropython-studio)
- [Contributing Guide](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Submit Issues](https://github.com/niwantha33/micropython-studio/issues)
- [MicroPython Community Forum](https://forum.micropython.org/)

## Support & Contact

Have a question, found a bug, or need help getting started?

- **Email:** niwantha33@gmail.com
- **GitHub Issues:** [github.com/niwantha33/micropython-studio/issues](https://github.com/niwantha33/micropython-studio/issues)
- **YouTube:** [youtube.com/@NiwanthaDev](https://www.youtube.com/@NiwanthaDev)

**Enjoy developing with MicroPython, CircuitPython and XBee!** 🚀

---

## License

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE.md)

This project is licensed under the **MIT License** — see [LICENSE.md](LICENSE.md) for full details.

XBee MicroPython typehints and libraries are sourced from [Digi International's xbee-micropython](https://github.com/digidotcom/xbee-micropython) repository, also under the MIT License. All third-party dependencies retain their original licenses as listed in the [Acknowledgements](#acknowledgements) section above.
