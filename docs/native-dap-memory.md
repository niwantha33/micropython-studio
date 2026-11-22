# Native VS Code debugging and Memory & GC analysis

**Status: experimental feature branch — do not publish until hardware-qualified.** No debugger firmware is installed, flashed or changed by this host-only feature.

## Native debugger: VS Code Debug Adapter Protocol

MicroPython Studio registers a `micropython-studio` debug type for VS Code's **Run and Debug** interface. The adapter is an in-extension DAP implementation sharing the existing `mpyDebugger.js` / `dbg_bridge.py` protocol. It does not start another debug CDC reader.

Use the Studio command **Start Debug** (or F5), or add this to `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "micropython-studio",
      "request": "launch",
      "name": "MicroPython Studio: Native Debugger",
      "replPort": "COM8",
      "debugPort": "COM13"
    }
  ]
}
```

Choose the actual REPL and dedicated debugger COM ports for your board. The ports **must differ**. The board requires matching, debugger-enabled firmware with the frozen trace pump; CI-built test firmware must not be mistaken for an approved release.

### Select and remember the debug adapter

Use **MicroPython: Configure Debug Adapter (CDC)** or click **Debug: COM… / Adapter** in the Studio status bar. The picker uses a debugger icon for detected serial ports, a warning icon for an unavailable saved port, and an edit icon for manual entry. Confirm the correct *debug CDC*: Studio does not guess based on COM ordering or shared VID:PID. For example, if COM5 is the REPL interface, select COM13 for the debugger.

Studio stores the selection in the current project’s `device.cfg`:

```ini
[device]
port = "COM5"

[debug]
adapter_port = "COM13"
```

The REPL/upload port is not changed. **Start Debug** and F5 reuse the saved adapter after reopening VS Code. If different ports are detected, Studio prompts rather than silently switching. Cancelling leaves `device.cfg` unchanged. The legacy Debug/RTA panel uses the same selection. A non-empty `debugPort` in `launch.json` intentionally overrides and updates the saved adapter; leave it empty to use `device.cfg`.

Serial-port detection does **not** prove that compatible frozen debugger firmware is installed. Choosing an adapter does not flash firmware or upload files.


VS Code supports source breakpoints, stepping and read-only variable lookup. Breakpoints begin unverified and are confirmed by actual firmware slot replies. The existing debugger panel remains visible for specialised runtime tracing and detailed diagnostics. Firmware that does not provide source mapping may produce an address-only stack frame. Variable editing, arbitrary expression evaluation, restart and asynchronous VM halt are intentionally **not** claimed/supported.

When switching to the separate classic debugger view, close the native session first.

## Memory & Garbage Collection Analyzer

Open **MicroPython: Memory & Garbage Collection Analyzer** from the Command Palette, or use the **Memory & GC** status-bar item. First connect the **USB REPL** through the normal Studio connection path and make sure it is idle.

- **Sample heap**: retrieves allocated/free heap counters without calling `gc.collect()`.
- **Collect GC + compare**: explicit, potentially disruptive collection with before/after counters. The collection duration uses `time.ticks_us()/ticks_diff()` where supported.
- **History**: up to 500 manual snapshots, observed peak, approximate growth, chart of free/allocated heap.
- **Export CSV**: raw counts, local timestamp, GC duration, reclaimed bytes and optional threshold; unsupported values remain empty rather than becoming zero.

Memory Analyzer sampling is disabled while a native debug session is active. It reuses the existing REPL daemon and the common device-operation queue; it never opens a competing COM handle or copies scripts to the board. It does not change `boot.py` or `main.py`.

### Measurement limitations

Sampling requires the REPL to execute a short script, which can interrupt running code. The default action is **manual** to avoid accidental perturbation. The reported `gc.mem_alloc()` and `gc.mem_free()` describe the managed MicroPython GC heap, not every region of RAM. Manual collections may alter application timing; the displayed reclaimed number is a before/after difference, not a complete audit of allocations. No automatic GC event counter exists here. Use repeated comparable snapshots, then further investigation, before calling increasing allocated bytes a leak.

## Acceptance / release checklist

1. `npm ci`, `npm run lint`, `npm test`, and VSIX packaging pass.
2. On the already exercised Pico 2 W firmware: native F5, breakpoint register/remove/clear, step over/in/out, Variables, Watch, Call Stack, disconnect and reattach.
3. Verify Legacy RTA traces and symbol resolution are unchanged, including conditional breakpoints.
4. Check no duplicate COM ownership, firmware flash, helper upload or `boot.py` mutation.
5. With normal USB REPL idle, sample before GC and after explicit GC; verify chart and CSV against raw `gc` values.
6. Deliberately simulate missing GC APIs, disconnected/suspended ports and debug-port loss.
7. Perform board-specific validation before claiming Pico/Pico W/Pico 2/ESP32-S3 compatibility; keep ESP32-C3 unapproved.

Only after these checks should a release tag and Marketplace publication be considered.
