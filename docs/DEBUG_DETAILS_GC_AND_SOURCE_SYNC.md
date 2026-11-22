# Native Debugger Details, Memory/GC, and Device Source Synchronisation

## Native debugger: preserve the original advanced interface

Starting the VS Code native MicroPython debugger now opens the established
**MPy Debugger Details** webview to the side of the source editor.

This is the full historical debugger view: breakpoints, live command log,
Locals, Globals, Call Stack, RTA, tasks, protocol and firmware information.
It was built over many iterations and is not replaced by the reduced VS
Code Variables/Call Stack pane.

The two views share **one** Python debugger bridge and **one** debug-CDC COM
port. The user's normal REPL remains on its separately configured COM port.

If you close the detailed panel, native DAP debugging continues. Choose
**MicroPython: Show Detailed Debugger Panel** to reopen it. Ending the native
debug session releases its debugger CDC.

## Why Memory & GC showed N/A

Memory & GC requires a connected serial REPL. Its safe probe switches briefly
into raw REPL (which sends Ctrl+C). In particular, it must never run
transparently over a paused native debug session or a live infinite loop.

When native debugging is active, clicking **Sample heap** or
**Collect GC + compare** now presents a confirmation about stopping native
debug and the possible interruption. The operation waits for actual VS Code
debug termination before touching the REPL. Cancel leaves everything alone.

- Sample heap reads GC memory counters; it does not intentionally call gc.collect().
- Collect GC + compare deliberately invokes gc.collect() and measures before/after.
- The user must verify that the REPL is idle (>>>), or explicitly agree to
  an interruption. A paused program cannot simultaneously be heap-probed via
  the existing REPL protocol without affecting execution.
- Inaccessible or unsupported counters remain N/A; the UI reports why.
- When the analyzer webview is opened, a ready handshake publishes status
  and stored samples so its controls don't appear silently empty.

Accurate memory monitoring **while a program is running without interrupting
it** would require an independent target-side telemetry protocol or a
separately qualified firmware capability. This PR does not pretend otherwise.

## Why main.fxn() prints once instead of looping

The editor and the Pico filesystem are distinct. Updating local
main/main.py does not update the Pico's /main.py. In addition, an already
imported module is cached in sys.modules.

If the editor has:

    import time

    def fxn():
        while True:
            print("Hello from Debug_Test!")
            time.sleep(1)

but /main.py still has the earlier one-print function, then at the REPL
calling main.fxn() will print once and return to >>>. That does not prove
the loop interpreter is faulty.

Use **MicroPython: Check Device main.py Against Editor** (or the Check MCU
Code status button). The command:
1. Requires you to confirm the REPL is idle: comparing on-device files
   uses raw REPL and can interrupt a running program.
2. Reads /main.py and compares it with the local editor (normalising CRLF).
3. If they differ, offers to show a side-by-side diff or **explicitly**
   upload the local file through the existing file-upload workflow.
4. After an upload, reads /main.py back and checks that it really matches.
   No success is shown without verification.
5. Explains that a cached import still needs to be discarded or reloaded.

At an idle REPL, after uploading:

    import sys
    sys.modules.pop("main", None)
    import main
    main.fxn()

Use Ctrl+C to stop a real while True loop. No automatic hard reset, upload
or firmware flashing is performed by simply attaching the debugger.

## Acceptance checks (Pico 2 W / real Windows hardware)

- [ ] Start native Debug. Full original MPy Debugger Details appears beside
      source, as well as native VS Code breakpoint/stepping views.
- [ ] Only one debug bridge owns the debugger CDC; REPL remains independent.
- [ ] Close and reopen detailed panel without losing native Debug session.
- [ ] Confirm Memory & GC active-debug modal can be cancelled without probe.
- [ ] Consent stops Debug, waits for termination, then samples a confirmed
      idle REPL. Manual GC records pre/post counters and elapsed time.
- [ ] Check local main.py versus an intentionally older /main.py and verify
      mismatch detection, diff, explicit upload, and verified readback.
- [ ] Reload cached main module and confirm multiple prints until Ctrl+C.
- [ ] Failed or unavailable COM ports produce errors rather than false success.
- [ ] Keep known-good 2.6.1 backup until hardware qualification.
