# WebREPL Pico W bench test — PR #59

**Test on the existing firmware. Do not reflash, reinstall frozen debugger modules, overwrite `boot.py`, or delete `webrepl_cfg.py`.**

This branch fixes two independent problems:
1. The WebREPL host console previously used binary frames for login, did not verify authentication, and could start before the webview was ready.
2. Dashboard **Enable Wireless Access** used a separate serial subprocess, could hang, overwrote `boot.py`, hardcoded a WebREPL password and did **not** save `device.cfg` until an unrelated “Switch” action.

## Safe workflow

1. Keep the Pico W on the existing **USB REPL COM** (CDC0). Leave the frozen debugger on its separate USB CDC port.
2. In **Device Dashboard → Wi-Fi Manager**, ensure STA is already connected and shows an IPv4 address.
3. Tick **Enable Wireless Access (WebREPL)**. Enter a *WebREPL-only* password in the VS Code masked password prompt (different from your router's password).
4. Dashboard calls `webrepl.start(password=...)` in device RAM through the **existing shared serial daemon**. This does **not** modify `boot.py`, `webrepl_cfg.py`, `main.py` or flash contents.
5. After a confirmed start, Studio saves local project `device.cfg` entries for IP, password and `webrepl_enabled=true`. Do not commit the project config file, which contains credentials.
6. Open **WebREPL** in the Studio status bar. Verify CONNECTED after authenticating. Type `print(1+1)`; expected response: `2`.
7. Try **Reconnect**. Test a wrong password by changing only local project settings; restore correct password afterwards. Incorrect passwords must show a failure, not CONNECTED.
8. Use **Stop WebREPL** to stop the *current* WebREPL listener, without modifying user files. WebREPL is session-only and needs starting again through USB after a board reboot.

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
