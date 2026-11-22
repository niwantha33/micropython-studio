# Native VS Code debugger — Pico 2 W dual USB CDC

MicroPython Studio supports a hardware **attach** workflow, not the
desktop Python virtual-environment debug runner.

## Steps

1. Select the board's REPL/upload USB interface (example COM7). Open
   Shell and confirm the >>> prompt.
2. In VS Code Run and Debug select **MicroPython Studio: Attach to hardware**
   or click Start Debug in Studio. Choose the *other* dedicated debugger
   CDC interface (example COM5).
3. Wait for verified debug CDC handshake and breakpoint registration.
4. Set a breakpoint. Run the application using its usual startup path or
   from the REPL; opening the debugger does not execute main.py.
5. Step, Continue and Stop Debug using VS Code's native controls.

Native debug uses Variables, Call Stack, Breakpoints and Debug Console.
It should **not** open a second MPy Debugger webview. The legacy panel is
still separately accessible through its explicit command.

For an existing project without launch.json use the command
**MicroPython: Configure Native Run and Debug**. It never overwrites
existing launch configurations. New MicroPython projects receive this
attach configuration automatically; CircuitPython projects do not.

Example .vscode/launch.json:

    {
      "version": "0.2.0",
      "configurations": [
        {
          "type": "micropython-studio",
          "request": "attach",
          "name": "MicroPython Studio: Attach to hardware",
          "replPort": "",
          "debugPort": ""
        }
      ]
    }

The REPL port comes from device.cfg or Studio selection; the dedicated
debug port is saved separately under the project's debug section.
Never infer the debug CDC from lowest COM or matching VID:PID.

## Test an actual local variable

Upload this to the board as main.py:

    import time

    def fxn():
        count = 0
        while True:
            count += 1
            print("Hello from Debug_Test!", count)
            time.sleep(1)

Attach Debug first, install breakpoint at count += 1, then run from REPL:

    import main
    main.fxn()

The original screenshot had no declared local variable, so an empty
Locals scope was possible. It also used sleep(1) after only import time:
that must be time.sleep(1), or a NameError follows after resuming.

## Firmware scope limitation

Some existing frozen debugger-pump builds report their own Python globals
(PUMP_PROTOCOL, _running, _thread) instead of the paused application's
module globals. Studio now labels those results unavailable instead of
misrepresenting them as user variables. Correct user-module globals and
deep call stack values require a separately qualified firmware-side fix.
A VSIX update alone cannot recover state that the frozen firmware does not send.

## Real Windows acceptance

- [ ] Run and Debug provides the MicroPython attach choice.
- [ ] No duplicate MPy Debugger editor appears for native sessions.
- [ ] COM5 debugger and COM7 REPL (or the board's actual interfaces)
      remain independent.
- [ ] Breakpoint verified, hit, stepped and continued correctly.
- [ ] Local count shows a real target value when firmware supports it.
- [ ] trace_pump globals are never advertised as application variables.
- [ ] Closing Debug releases the debugger CDC without rebooting the MCU.
- [ ] Legacy debugger panel remains available on explicit request.

Keep a working 2.6.1 VSIX and do not merge/release until hardware checks pass.
