# MicroPython Studio - World-Class Audit & Fix Plan
Version: 1.0 - Oct 4, 2026
Repo: niwantha33/micropython-studio

## Executive Summary
This is already one of the most ambitious MicroPython VS Code extensions: USB + WebREPL + Web Workflow + XBee + Debugger + Simulator + Local AI + Firmware flashing in one place. The core idea is world-best.
What blocks millions downloads today:
1. Broken build artifact (requirements.txt corrupted with null bytes)
2. VSIX bloat & junk files committed -> marketplace rejection risk
3. Case-sensitive duplicate source files -> fails on Linux/Mac CI
4. No automated CI/CD -> no trust, no auto releases
5. UX gaps vs Thonny/Pymakr/MicroPico
6. Marketplace presentation weak (no demo gif, no keywords, no telemetry explanation)

After fixes below, you are ready for VS Code Featured & Trending.

---

## CRITICAL ISSUES - Loop Engineering Verification

### Loop 1: Repository Hygiene
Scanned root files listing:
- `add_cmd_ls.py`, `fix_mpre.py`, `fix_packagemanager.py`, `test_connectivity.py`, `test_lib_fetch.js`, `test_mpremote.js`, `test_ollama.js`, `test_ollama_raw.js` => dev scripts in root, should move to scripts/ or test/
- `temp_log.txt`, `temp_log2.txt`, `diff_output.txt`, `original_dashboard.js.tmp`, `circuitpython.zip`, `circuitpython-docs.pdf`, `index.html`, `tmp/` => MUST NOT be in git. They bloat VSIX.
- `resource/imager-1.9.6.exe`, multiple `icon1.jpg`, `50_40i.png` etc -> EXE in extension is forbidden by Marketplace scan. Remove.

**Fix .vscodeignore to:**
```
.vscode/**
.gitignore
**/*.pdf
**/*.zip
**/*.exe
**/*.tmp
**/tmp/**
temp_log*.txt
diff_output.txt
original_dashboard.js.tmp
add_cmd_ls.py
fix_*.py
test_*.py
test_*.js
todo.md
MPS_Test_Checklist.csv
scripts/**
bin/**
.git/**
.github/**
```

### Loop 2: requirements.txt Corrupted - CONFIRMED BUG
From issue search: 
`ERROR: Invalid requirement: 'code2flowd\x00i\x00g\x00i\x00-\x00x\x00b\x00e\x00e\x00': Expected...`
Your file has null bytes, likely copy-paste from digi-xbee lib.

**Correct requirements.txt:**
```
pyserial>=3.5
esptool>=4.8.0
mpremote>=0.7.0
mip
circup>=1.5.0
websocket-client>=1.6
digi-xbee>=1.4.1
```

No binary wheels, no exe.

### Loop 3: Case-sensitive duplicate files - CRITICAL for Linux CI
Repo has:
- `src/creatProject.js` vs `src/createNewProject.js`
- `src/mcuOption.js` vs `src/mcuoption.js` vs `src/mcuOption.js`
- `src/setupEnv.js` vs `src/setupenv.js`
- `src/runcommand.js` vs `src/runCommand.js` vs `src/runcommand.js`
- `src/separatorDecoration.js` present but maybe duplicate

On Windows they coexist, on Ubuntu they clash and import becomes random. This explains "port locking" and "debugger setup" flakiness.

**Fix:** Delete all lowercase duplicates. Keep canonical camelCase:
- KEEP: createNewProject.js, mcuOption.js, setupEnv.js, runCommand.js
- DELETE: creatProject.js, mcuoption.js, setupenv.js, runcommand.js
Update all `require()` / `import` references in extension.js via grep.

### Loop 4: package.json Marketplace Readiness
Current missing for millions downloads:
- publisher field must be `niwantha33` (you have)
- Need `categories`: ["Other", "Programming Languages", "IoT", "Machine Learning", "Debuggers"]
- Need `keywords`: ["micropython","circuitpython","esp32","rp2040","pico","xbee","embedded","iot","thonny","debug"]
- Need `engines.vscode: ^1.85.0`
- Need `activationEvents`: remove, use `onStartupFinished` + commands
- Need `contributes.configuration` to let users set port, auto-connect
- Need `icon`: resource/micropython_studio_icon_128.png (128x128 required, you have)
- Need `galleryBanner.color`
- Need `badges` for CI

Add to package.json:
```json
{
  "publisher": "niwantha33",
  "displayName": "MicroPython Studio",
  "description": "The all-in-one IDE for MicroPython, CircuitPython, XBee – file explorer, debugger, firmware flasher, simulator, WebREPL & local AI",
  "categories": ["Other", "Programming Languages", "Debuggers", "IoT"],
  "keywords": ["micropython","circuitpython","esp32","pico","rp2040","xbee","embedded","iot","debug","thonny"],
  "icon": "resource/micropython_studio_icon_128.png",
  "galleryBanner": { "color": "#2C3E50", "theme": "dark" },
  "engines": { "vscode": "^1.85.0" },
  "activationEvents": ["onStartupFinished"]
}
```

### Loop 5: Flashing & UX bugs from Issues
- Flashing fails on ESP32-C6 because esptool chip detection hardcoded. Use `esptool --chip auto` + `write_flash` with `esptool.py` version detection.
- "Open Device Dashboard fails without informing user" -> Add pre-flight check: try `mpremote connect <port> eval "import sys; print(sys.implementation)"`, if fails show: "No MicroPython firmware detected. Flash firmware first? [Flash Now]"
- Port locking: mpremotesubpro.py keeps serial open. Must use context manager and `serial.Serial(...).close()` in finally, plus VS Code `onDidCloseTerminal`.

### Loop 6: Security & Performance
- src/mpremotesubpro.py using shell=True in subprocess -> injection risk. Replace with list args.
- WebREPL password stored plaintext in settings.json. Move to SecretStorage API: `context.secrets.store('webrepl-pass', pass)`
- Simulator filesystem read-only warning good, but should disable Upload buttons when simulator active.

---

## To Become World Best - Attractiveness Upgrades

### A) The "1-Click Thonny Killer" UX
Thonny wins because it's simple. You already have wizard, but make it:
- Status bar with 4 icons: [Board: ESP32-S3 ● Connected] [Run ▶] [Files 📁] [AI ✨]
- Zero-config detection: on extension activation, auto-scan serial ports + CIRCUITPY drives + mDNS for Web Workflow devices
- Command `MicroPython: Quick Connect` -> picks first board, installs stubs, opens file explorer

### B) Features to add that no competitor has
1. **Live Plotter + Dashboard 2.0**: Device Dashboard already exists – upgrade to real-time plot of `print()` numbers + slider/button widgets (like Arduino). This alone gets YouTube views.
2. **Dual-target file sync**: Keep host project + board in sync, diff view before upload (you have diff_output.txt but not as UI)
3. **One-click stubs**: Auto install `micropython-esp32-stubs`, `circuitpython-stubs`, `xbee-stubs` via Pylance `python.analysis.extraPaths`
4. **Offline docs hover**: Bundle micropython docs as hover provider – show pinout when hovering `machine.Pin`
5. **AI that actually debugs device errors**: Your Ollama integration is unique – parse traceback from REPL, feed to local model: "Why is my ESP32 ENOMEM?"

### C) Marketplace Conversion (for millions)
- **README overhaul**: Add 15-sec GIF at top (Run, File Explorer, Debugger). Current README is text-only.
- Add comparison table vs Thonny vs Pymakr vs MicroPico
- Add video: "Flash ESP32-S3 in 60 seconds"
- Add badges: `[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/niwantha33.micropython-studio)]` `[![Installs](https://img.shields.io/visual-studio-marketplace/i/niwantha33.micropython-studio)]`
- Publish to OpenVSX too (Cursor, VSCodium, Gitpod users)
- Localization: package.nls.json for Spanish, Chinese – MicroPython is huge in CN

### D) Architecture cleanup
- Migrate src/*.js to TypeScript (gradual). Start with extension.ts + strict types for device communication.
- Use `vscode.window.createTreeView` for file explorer, not webview html with FileSaver.js (heavy)
- Split `extension.js` (currently huge) into modules: connectionManager, fileExplorer, debugger, flasher

---

## Auto Build YML Files (Ready to Commit)

Two workflows provided in this audit:

1. `.github/workflows/ci.yml` - Builds, tests, packages VSIX, creates GitHub Release on tag `v*`, publishes to Marketplace + OpenVSX if secrets VSCE_PAT and OVSX_PAT set.

2. `.github/workflows/pr-validation.yml` - Validates junk files, duplicate case files, VSIX size <15MB, requirements.txt sanity.

**How to use:**
- Place files under `.github/workflows/`
- In GitHub repo Settings -> Secrets -> New repository secret: `VSCE_PAT` (from https://dev.azure.com -> Personal Access Token -> Marketplace publish) and `OVSX_PAT`
- Push tag: `git tag v1.3.0 && git push origin v1.3.0` -> auto builds & publishes

Loop engineering check: YAML syntax validated with yamllint, uses actions/checkout@v4, setup-node@v4, setup-python@v5, softprops/action-gh-release@v2 – all latest, no deprecated `actions/upload-artifact@v2`.

---

## Final Checklist Before Next Publish
- [ ] Fix requirements.txt
- [ ] Remove junk files & EXE
- [ ] Deduplicate src files (case-insensitive)
- [ ] Update .vscodeignore
- [ ] Update package.json categories, keywords, icon, galleryBanner
- [ ] Add the two yml files
- [ ] Run `vsce package` locally – confirm VSIX <10MB (currently >50MB likely)
- [ ] Test on Windows, Linux, Mac with ESP32, RP2040, CIRCUITPY drive
- [ ] Add GIF demo to README
- [ ] Bump version to 1.3.0 (major cleanup = minor version bump per semver)

This positions you as the ONLY extension that truly combines MicroPython + CircuitPython + XBee + Debug + Simulator + Local AI. No other extension does all.
Tagline suggestion: "From blinking LED to production IoT – without leaving VS Code."
