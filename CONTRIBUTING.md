# Contributing to MicroPython Studio

Thanks for your interest in contributing! Here's how to get involved.

## How to Contribute

### Report a Bug

1. Go to [GitHub Issues](https://github.com/niwantha33/micropython-studio/issues)
2. Check if it's already reported
3. Create a new issue with:
   - What you expected to happen
   - What actually happened
   - Your OS, VS Code version, and board/device
   - Steps to reproduce

### Suggest a Feature

Open an issue with the title starting with `[Feature]` and describe what you'd like and why it would be useful.

### Submit Code

1. Fork the repo
2. Create a branch: `git checkout -b my-fix`
3. Make your changes
4. Test on a real device if possible
5. Push and open a Pull Request

## Code Standards

Keep it simple and readable. Here's what we follow:

### JavaScript (VS Code Extension)

- Use `const` and `let`, never `var`
- Use single quotes for strings
- Add JSDoc comments for functions
- Keep functions short — if it's over 50 lines, consider splitting it
- Use descriptive variable names (`devicePort` not `dp`)
- Handle errors — always wrap device communication in try/catch

### Python (mpremotesubpro.py, scripts)

- Follow PEP 8 (4-space indent, snake_case)
- Add docstrings to functions
- Wrap device I/O in try/except — devices can disconnect at any time
- Print user-facing messages to `sys.stderr`, data to `sys.stdout`
- Use `Path` from pathlib for file paths

### General Rules

- **Don't break existing platforms.** If you're adding XBee support, ESP32 and Pico must still work
- **Guard new code paths.** Use `if/else` checks so new features only activate for the right device
- **Test before submitting.** Run on at least one real board if you can
- **Keep commits clean.** One change per commit, clear commit messages
- **No console.log spam.** Remove debug logs before submitting

## Project Structure

```
micropython-studio/
├── src/
│   ├── extension.js          # Main extension entry point
│   ├── mpremotesubpro.py     # Serial/WebREPL device communication
│   ├── createNewProject.js   # Project creation wizard
│   ├── deviceDashboard.js    # Device telemetry dashboard
│   ├── packageManager.js     # Package installation (mip/circup)
│   ├── flashFirmware.js      # Firmware flashing
│   ├── commonFxn.js          # Shared utilities
│   └── ...
├── resource/                 # Icons, pinouts, AI model files
├── scripts/                  # Helper scripts (XBee stubs, etc.)
├── package.json              # Extension manifest
└── README.md
```

## Supported Platforms

When making changes, keep in mind we support:

- **MicroPython** — ESP32, RP2040/RP2350, STM32, SAMD, NRF
- **CircuitPython** — ESP32-S2/S3, RP2040, SAMD, NRF
- **XBee MicroPython** — XBee3 (Zigbee, DigiMesh, Cellular, Wi-SUN, BLU)
- **Connections** — USB serial, Wi-Fi (WebREPL), CircuitPython Web Workflow

## Questions?

Open an issue or email **niwantha33@gmail.com**. Happy to help!
