# WebREPL Pico W bench test — PR #59

**Test on the existing firmware. Do not reflash, reinstall frozen debugger modules, overwrite `boot.py`, or delete `webrepl_cfg.py`.**

This branch fixes two independent problems:
1. The WebREPL host console previously used binary frames for login, did not verify authentication, and could start before the webview was ready.
2. Dashboard **Enable Wireless Access** used a separate serial subprocess, could hang, overwrote `boot.py`, hardcoded a WebREPL password and did **not** save `device.cfg` until an unrelated “Switch” action.

## What users need to know

WebREPL is **optional**. USB REPL and the frozen debugger work without it. For wireless access, the board must have Wi-Fi connected, MicroPython's WebREPL listener must be running, and the PC must have an IP route to the board with TCP port **8266** permitted. Merely displaying a Wi-Fi IP in the Dashboard does not prove that the PC can connect to WebREPL.

Some user-defined `boot.py` recovery logic intentionally skips Wi-Fi/WebREPL when USB activity is detected. Do not overwrite that boot script or promise WebREPL starts automatically. If a PC and board use different IP ranges, communication may still work through a router, but it needs a working route. An unreachable port is a **network/server** issue, not proof the debugger is broken.

## Safe workflow

1. Keep the Pico W on the existing **USB REPL COM** (CDC0). Leave the frozen debugger on its separate USB CDC port.
2. In **Device Dashboard → Wi-Fi Manager**, ensure STA is already connected and shows an IPv4 address.
3. **Important for your Pico 2 W test:** if the Dashboard title says `Device: WebREPL 10.20.100.198` but the USB REPL is still connected on COM8, leave COM8 connected. The Dashboard now checks the **actual daemon COM port** instead of refusing the wireless Dashboard selection. If serial reports `WebREPL server started`, the listener already exists and must not be restarted.
4. Tick **Enable Wireless Access (WebREPL)**. Enter a *WebREPL-only* password in the VS Code masked password prompt (different from your router's password).
5. When the listener is NOT running, Dashboard calls `webrepl.start(password=...)` in device RAM through the **existing shared serial daemon**. This does **not** modify `boot.py`, `webrepl_cfg.py`, `main.py` or flash contents.
6. After confirming an existing listener or a new start, Studio saves local project `device.cfg` entries for IP, password and `webrepl_enabled=true`. Do not commit the project config file, which contains credentials.
7. Open **WebREPL** in the Studio status bar. Verify CONNECTED after authenticating. Type `print(1+1)`; expected response: `2`.
8. Try **Reconnect**. Test a wrong password by changing only local project settings; restore correct password afterwards. Incorrect passwords must show a failure, not CONNECTED.
9. Use **Stop WebREPL** to stop the *current* WebREPL listener, without modifying user files. WebREPL is session-only and needs starting again through USB after a board reboot.

### Diagnostics

If Studio reports **USB REPL is not connected**, open its built-in Shell and select the correct COM port before enabling.

If WebREPL shows **connection refused**, test the board's actual IP and port from the host PowerShell:

```powershell
Test-NetConnection <your-board-IP> -Port 8266
```

If the status stays **CONNECTING**, close/reopen the WebREPL tab to test the host webview lifecycle; the connection now has a 12-second handshake/login deadline and a **Reconnect** button.

If Dashboard shows a **WebREPL failed** message, copy only the error; **do not share the password**, which should not be printed to the Output channel.

### Known limitations

- `device.cfg` must be present in your project workspace so connection settings can be saved.
- This is *not* persistent WebREPL boot auto-start. Automatic start would require a separate explicit design compatible with frozen debugger firmware.
- The board must have a MicroPython firmware including `webrepl` and an active network STA interface.
- Only runtime start and stop are in scope; do not merge until the actual Pico W WebREPL TCP handshake, interactive REPL and file transfer have been tested.

**Existing boot configuration:** The Pico 2 W screenshot shows an existing `boot.py` that starts WebREPL automatically. This PR does not change that file. If auto-start is already configured, WebREPL may start again on a subsequent boot; 'session-only' describes Studio's new setup operation, not a guarantee about existing `boot.py` code.
