# REPL stability checkpoint — 8 October 2026

**Draft candidate only:** `fix/repl-stability-v1`. This branch does not
modify MicroPython firmware, debugger patches, Pico USB descriptors or ESP32
firmware. Do not merge or publish until Pico 2 W and ESP32-S3 hardware checks.

## What was broken and what this patch addresses

- Opening/reopening the built-in terminal automatically sent **Ctrl-C and
  `import os; print(os.uname())`**. This interrupted running scripts without
  permission. Terminal open is now passive (the user may press Enter).
- Terminal opening deleted **all** data/connection/error listeners from the
  shared daemon, disrupting unrelated features. Terminal tracks and removes
  **only its own** listeners on close.
- Closing a terminal previously disconnected the shared daemon even if the
  file explorer or other features used it. Closing the Shell now only
  detaches the terminal.
- Opening Shell during an upload could automatically `resume()` and
  steal the COM port from the upload. Shell now displays a busy message.
- Daemon-start `connect()` had no deadline and could kill any live PID
  named in a stale-looking `daemon` lock. It now has a deadline and
  respects other live processes instead of terminating them.
- `suspend()`, `resume()` and `runCodeSilently()` could wait indefinitely.
  They now have acknowledgement/operation deadlines and report failure.
- A timer used to resume the port independently of the current transfer
  owner. Auto-resume is disabled; the owner must explicitly resume.
- Queue logic ignored a valid suspended lock older than eight seconds
  and could spin forever waiting for a COM port. It now honours live
  owners and gives a bounded error if another operation holds the port.
- The daemon could send **Ctrl-C after an automatic USB reconnect** and
  could falsely acknowledge `resumed` after failing to reopen COM.
  It no longer sends that unsolicited interrupt and reports a failed
  resume accurately.
- Error/exit handling in regular backend processes now awaits suspend
  acknowledgement and restores the port in `finally`; a failed process
  never produces a success message.

The 120-second raw-REPL operation deadline is an upper safety bound, not a
performance claim. Long uploads may still use the separate backend path.

## Bench acceptance (not yet completed)

Use only the **already-working board firmware**. Do not flash anything for
this REPL test, and do not delete board files.

- [ ] Pico 2 W REPL CDC: Connect, send a simple expression, close/reopen
      Shell 20 times without unrequested Ctrl-C, firmware reset or COM drop.
- [ ] ESP32-S3 **physical Serial** connector: same test. Do not mistake
      native USB debugger COM for the REPL/upload COM.
- [ ] Run a harmless loop, open/close Shell and verify it is not interrupted
      by terminal opening. Explicit Ctrl-C must still work when typed.
- [ ] Repeated project upload and download; open Shell during transfer and
      verify it displays "busy" instead of reopening the port.
- [ ] Unplug/replug USB; verify bounded failure and normal manual reconnect
      without killing unrelated terminal or user processes.
- [ ] Force a subprocess error / invalid port and confirm the actual failure
      is visible rather than "[SUCCESS]".
- [ ] Set/hit/Continue breakpoint via **separate debugger COM**, confirm
      REPL changes do not affect debug transport.
- [ ] 30-second RTA and USB recovery on the existing S3 candidate before
      promoting debugger firmware.
- [ ] Run regression CI and verify no new process listener/timer leaks.

## Today’s video

**Use the build and firmware you have already proved stable** for recording,
not a PR artifact that has only passed CI. The video can show: Pico/S3 REPL,
running a script, breakpoint hit, Locals, Continue, and RTA. When this PR passes
device acceptance, the next stable Studio release can mention smoother
connection behaviour. Avoid claiming every ESP32 board is already supported.
