# MicroPython Studio

### A friendly VS Code workspace for MicroPython, CircuitPython, and XBee

[![MicroPython](https://img.shields.io/badge/MicroPython-1.20%2B-blue?logo=micropython&logoColor=white)](https://micropython.org)
[![CircuitPython](https://img.shields.io/badge/CircuitPython-10.x-purple?logo=adafruit&logoColor=white)](https://circuitpython.org)
[![XBee](https://img.shields.io/badge/XBee-MicroPython-orange)](https://www.digi.com/xbee)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE.md)

MicroPython Studio helps you build embedded Python projects without leaving VS Code. Create projects, connect boards, manage files, run scripts, debug code, flash firmware, use WebREPL/Web Workflow, and prototype with a built-in simulator.

[Watch the live debugger demo](https://www.youtube.com/watch?v=or_aG-Rhnb8)

---

## Why Use It?

| Need | MicroPython Studio Helps With |
|------|-------------------------------|
| Start quickly | Project wizard, environment setup, board config, templates |
| Work with real boards | Serial REPL, file explorer, upload/download, package install |
| Debug harder problems | Breakpoints, stepping, locals, call stack, debug firmware flow |
| Test without hardware | QEMU-based simulator for fast prototype runs |
| Use wireless workflows | MicroPython WebREPL and CircuitPython Web Workflow support |
| Keep code private | Optional local AI assistant powered by Ollama |

---

## Main Features

- **Device File Explorer**
  Browse, upload, download, rename, delete, and create files on your board.

- **One-Click Run and Shell**
  Run the active Python file or open an interactive REPL from VS Code.

- **Live Debugger**
  Set breakpoints, step through code, inspect locals, and view call stack data.

- **CircuitPython Support**
  Detect CIRCUITPY drives, install libraries, sync files, and use Web Workflow.

- **MicroPython WebREPL**
  Configure Wi-Fi access and connect to supported boards over the network.

- **Firmware Tools**
  Download and flash firmware for supported targets, including debug firmware.

- **QEMU Simulator**
  Run code against an emulated MicroPython target when hardware is not nearby.

- **Private AI Assistant**
  Use local Ollama models for code help and device-error investigation.

---

## Quick Start

1. Install the extension in VS Code.
2. Run **MicroPython: Setup Development Environment**.
3. Connect your board by USB.
4. Run **MicroPython: Refresh Device Files**.
5. Create or open a project.
6. Press **Run** to execute your active Python file.

That is the normal daily loop: connect, edit, run, inspect files, repeat.

---

## Common Commands

| Command | What It Does |
|---------|--------------|
| `MicroPython: Setup Development Environment` | Creates the Python environment and installs required tools |
| `MicroPython: Create New Project` | Starts a guided project setup |
| `MicroPython: Open Existing Project` | Opens a project with existing device configuration |
| `MicroPython: Refresh Device Files` | Connects to the board and refreshes the device file tree |
| `MicroPython: Run Script on Device` | Runs the active Python file |
| `MicroPython: Open Device Shell` | Opens an interactive REPL |
| `MicroPython: Upload File to Device` | Copies one file to the board |
| `MicroPython: Upload Project to Device` | Copies the project to the board |
| `MicroPython: Start Debug` | Starts the live debugger setup/connect flow |
| `MicroPython: Flash Firmware` | Opens firmware flashing tools |

---

## Debugging

The debugger is designed for embedded Python workflows where JTAG is not always practical.

It supports:

- breakpoints
- stepping
- locals inspection
- call stack view
- runtime trace events
- **Connect only** workflow for supported firmware with the debugger already frozen inside the image
- optional, explicit legacy Pico debug-file upload for older existing firmware
- dedicated debug firmware flow for supported boards

For best results, start with a simple script first, confirm upload/run works, then enable the debugger.

---

## Simulator

The built-in simulator is useful when you want to test application logic before connecting a board.

- Start or stop it from the status bar.
- Run code through the same VS Code workflow.
- Use local `lib/` folders for dependencies.
- The simulated filesystem is read-only, so direct uploads are blocked with a clear warning.

---

## Local AI Assistant

MicroPython Studio can use [Ollama](https://ollama.com) for private local AI help.

1. Install Ollama.
2. Open the MicroPython Studio AI view.
3. Let the extension prepare the local model.
4. Ask questions about your active file, device errors, or MicroPython APIs.

Your source code stays on your machine.

---

## Supported Workflows

| Platform | USB Serial | File Explorer | Packages | Wireless | Debugging |
|----------|------------|---------------|----------|----------|-----------|
| MicroPython | Yes | Yes | `mip` | WebREPL | Supported targets |
| CircuitPython | Yes | CIRCUITPY drive / Web Workflow | `circup` | Web Workflow | Limited |
| Digi XBee | Yes | Project/library support | Bundled helpers | Device dependent | Device dependent |
| Simulator | TCP REPL | Read-only target | Local `lib/` | Local only | Prototype/debug flow |

---

## Project Status

MicroPython Studio is actively developed and already used by many embedded Python developers. The current focus is reliability: port locking, debugger setup, ESP32-S3 workflows, automated CI checks, and better regression testing.

If something breaks, please open an issue with:

- board name
- firmware type and version
- operating system
- selected port
- output from the **MicroPython IDE** or **MPy Debugger Setup** panel

---

## Useful Links

- [Project Website](https://niwantha33.github.io/micropython-studio/)
- [MicroPython Documentation](https://docs.micropython.org/)
- [CircuitPython Documentation](https://docs.circuitpython.org/)
- [Project Repository](https://github.com/niwantha33/micropython-studio)
- [Issue Tracker](https://github.com/niwantha33/micropython-studio/issues)
- [Contributing Guide](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [YouTube Channel](https://www.youtube.com/@NiwanthaDev)

---

## Acknowledgements

MicroPython Studio builds on excellent open source projects:

| Project | License | Used For |
|---------|---------|----------|
| [MicroPython](https://micropython.org/) | MIT | Runtime, REPL, tools |
| [mpremote](https://github.com/micropython/micropython/tree/master/tools/mpremote) | MIT | Device communication |
| [CircuitPython](https://github.com/adafruit/circuitpython) | MIT | CircuitPython support |
| [circup](https://github.com/adafruit/circup) | MIT | CircuitPython library management |
| [MicroPython WebREPL](https://github.com/micropython/webrepl) | MIT | Wireless REPL workflow |
| [websocket-client](https://github.com/websocket-client/websocket-client) | Apache 2.0 | WebREPL transport |
| [term.js](https://github.com/chjj/term.js) | MIT | Terminal UI |
| [FileSaver.js](https://github.com/eligrey/FileSaver.js) | MIT | Browser-side file save support |
| [xbee-micropython](https://github.com/digidotcom/xbee-micropython) | MIT | XBee stubs and helpers |
| [esptool](https://github.com/espressif/esptool) | GPL-2.0 | ESP firmware flashing |
| [pyserial](https://github.com/pyserial/pyserial) | BSD | Serial communication |
| [QEMU](https://www.qemu.org) | GPL-2.0 | Simulator backend |
| [Ollama](https://ollama.com) | MIT | Local AI runtime |
| [Gemma](https://ai.google.dev/gemma) | Gemma Terms | Local AI model option |

All bundled third-party files retain their original license headers.

---

## Support

Questions, bugs, and ideas are welcome.

- Email: niwantha33@gmail.com
- Issues: [github.com/niwantha33/micropython-studio/issues](https://github.com/niwantha33/micropython-studio/issues)
- YouTube: [youtube.com/@NiwanthaDev](https://www.youtube.com/@NiwanthaDev)

---

## License

MicroPython Studio is licensed under the [MIT License](LICENSE.md).

XBee MicroPython type hints and libraries are sourced from [Digi International's xbee-micropython](https://github.com/digidotcom/xbee-micropython), also under the MIT License.


## Frozen debugger firmware — Pico and ESP32-S3 (development branches)

**One firmware flash, then Start Debug → Connect only** is the intended workflow
when using a debugger-enabled image that includes frozen Python helpers.
There is **no separate upload of** `boot.py`, `dbgref.py`, or
`trace_pump.py` for a newly flashed frozen-debugger image.

| Board | Project REPL and file upload | Debugger + RTA | USB cables |
| --- | --- | --- | --- |
| Pico / Pico W / Pico 2 / Pico 2 W (frozen UF2 candidate) | CDC0 COM | CDC1 COM | One |
| ESP32-S3 test candidate | Physical Serial/JTAG COM | Physical native-USB debugger COM | Two |

1. Flash the **matching board-specific** debugger-enabled firmware once.
2. Connect the REPL/upload COM in Studio; check the `>>>` prompt and file access.
3. Select **Start Debug → Connect only**, then enter the *other*, dedicated
   debugger COM port. Do not use the REPL COM as the debugger port.
4. Test breakpoint, locals, Continue, breakpoint removal; then RTA On/Off.

**Legacy Pico compatibility:** The older published UF2s might not contain the
frozen debugger helpers and may still require the **Legacy Pico setup** option.
That option overwrites `/boot.py`, `/dbgref.py` and `/trace_pump.py`, so only
use it for older Pico firmware. **Never** use it on ESP32-S3 or on a new
frozen-debugger Pico. It is not part of the normal installation flow.

The frozen Pico build is isolated on
[`feature/pico-frozen-debugger-v1`](https://github.com/niwantha33/micropython_live_debugger/tree/feature/pico-frozen-debugger-v1)
and the ESP32-S3 firmware remains isolated on
[`feature/esp32-s3-debugger-v1`](https://github.com/niwantha33/micropython_live_debugger/tree/feature/esp32-s3-debugger-v1).
The Pico frozen candidate has **not** passed hardware acceptance yet; neither
candidate is released by these branch changes.

**RTA explanation:** The `Observed VM %` field is exclusive *measured elapsed
segment time share*, not physical CPU utilization. The `Total` field is
inclusive elapsed time; long native waits or sleeps may inflate it. Unknown
addresses are unresolved function names, not CPU-load alarms. A proper
scheduler CPU/idle metric would require additional target instrumentation.
