# Serial REPL + debugger stability: diagnosis and hardware acceptance

## Observable failure

On Pico 2 W a user ran an infinite `while True` function from the
MicroPython shell and saw no `print()` output. At the same time the native
debugger used a separate USB CDC and the detailed debugger sometimes
disappeared or became unresponsive.

The two interfaces are distinct:

- **REPL / Shell COM7** (example only) receives interactive Python and
  device stdout. It must be a single-owner serial connection shared
  safely by file tools, Run, and memory sampling.
- **Debugger COM5** (example only) receives debugger-pump commands and
  breakpoints. A pause here suspends target Python execution, so the
  REPL may legitimately show no new output until Continue/Step.

The actual COM identifiers depend on the board's Windows enumeration.

## Confirmed REPL defect

The previous `run_in_terminal` action was a synchronous call to
`exec_raw_paste(code)`, which accumulates all output until the script
terminates. It also held the command reader and a serial lock.
A nonterminating script would therefore neither stream to the terminal
nor allow the daemon's command reader to handle Ctrl+C promptly.

This patch retains the established raw-paste upload handshake but runs the
foreground program on a serial worker. Output and errors are emitted in
incremental chunks, while the command-reader thread stays responsive.

- The daemon acknowledges a foreground run only after the script is accepted.
- `terminal_input` can deliver Ctrl+C directly during execution.
- Ctrl+C received while raw-paste data is being uploaded is deferred until
  the upload completes, avoiding corrupting the MicroPython protocol.
- Concurrent raw commands or a request to surrender the COM port are
  rejected as BUSY, not allowed to interrupt the running program.
- On completion, the daemon returns to friendly REPL and the Shell
  displays the `>>>` prompt. Failed start and USB errors are reported.
- The serial recovery lock is reentrant for ordinary writes, but raw
  program execution is not automatically reconnected/reset underneath
  a running script. The host reports a transport failure instead.
- Heap/GC probes refuse a known active MCU foreground script.
- UTF-8 is decoded across serial chunks using an incremental decoder.

## Debugger crash containment

A screenshot cannot establish whether the failure is a host-side webview
exception, lost debug CDC, debugger firmware fault or an MCU hard fault.
These changes contain identifiable host-side risks without modifying the
board's frozen debugger firmware:

- Serialize JSON lines emitted by the Python debugger bridge's reader and
  command threads.
- Bound line length before parsing bridge output, reporting and closing
  malformed/oversized transports instead of accumulating unlimited data.
- When the user closes the original detailed debugger view, asynchronous
  webview messages are caught rather than becoming extension-host errors.
- Limit RTA capture history and stop excessive RTA event streams rather
  than allowing unbounded event memory usage.
- Surface a verified target PAUSED/RUNNING state to the separate Shell.
  A paused breakpoint before `print()` is not a broken REPL.

These are host reliability improvements, **not** evidence that an unknown
firmware-side crash has been fixed.

## Windows Pico 2 W verification matrix

Use the PR VSIX in a separate VS Code Extension Development Host. Keep
known-good version 2.6.1 available for rollback.

1. **Shell / idle:** set the correct REPL COM in device.cfg; open Shell.
   Expect `>>>`. Closing/reopening Shell must not reset the MCU.
2. **Interactive loop:** without debugging, run
   `import main; main.fxn()` after uploading the same main.py. Expect
   repeated printed lines every second, not an indefinitely blank Shell.
3. **Interrupt:** press Ctrl+C. Expect a KeyboardInterrupt or clean return
   to `>>>`, with no COM owner left stuck. Start another command.
4. **Run button:** use Run MCU on a local `while True` script. Output
   must stream while the script executes, without waiting for termination.
   Stop sends Ctrl+C and releases the foreground worker.
5. **Competing file/GC access:** while MCU Run is active, try a device
   file operation and the Memory & GC sampler. They must report the busy
   condition without silently breaking the loop.
6. **Native Debug:** attach only the dedicated debugger COM. Set a
   breakpoint before a `print()` line and run the function on REPL.
   The Shell should explain `PAUSED` and output should resume on
   Continue. Closing the detailed panel must not disconnect debug CDC.
7. **Disconnect/replug:** while idle, replug USB and reopen Shell.
   During a script run, a COM loss must fail visibly rather than claim
   the script is still executing.
8. **RTA load:** enable RTA for short captures; ordinary RTA data remains
   readable. Excessively fast streams must stop safely and warn.
9. **CI gate:** Node unit tests, Python fake-serial tests, lint and
   VSIX packaging must pass on the final commit.

## Scope and limitations

No automatic firmware flashing, boot.py uploads or MCU resets are included.
MicroPython code typed directly into an interactive `>>>` prompt still
uses the target's friendly REPL; the streaming worker applies to the
extension's **Run MCU** action. The debugger's paused-state banner helps
explain missing output in either mode.

Serial streaming cannot force a genuinely paused/hard-faulted MCU to
execute a `print()`. A reproducible target-side crash still needs the
debugger logs, firmware build identity, serial transport events and
physical board qualification.
