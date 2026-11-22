# COM adapters, Dashboard pinout and guided firmware flashing

This feature branch is based on the 2.6.1 recovery PR #71. Keep the known-good
VSIX until the new branch passes physical Windows hardware tests.

## Select the right USB serial adapter

Select **Update Device Port**. Every connected CDC interface is shown, even
when two ports share the same VID:PID. The picker displays uppercase COM5
rather than com5. Choose the actual REPL port. Refresh never silently swaps
it for a lower-numbered debugger port.

When starting Debug, choose the separate **Debugger adapter (COMx)**. Its
selection is stored separately from the REPL port.

Example project device.cfg:

    [device]
    port = "COM5"
    run_transport = "usb"

    [debug]
    port = "COM13"

    [dashboard]
    pinout_board = "board-catalog-key"

The selected board-catalog-key is an actual key from pinouts.json.

## Dashboard pin selection

The selected board is saved to the dashboard section in device.cfg and loaded
on refresh/reopen. The latest Python source pin assignments are rescanned
after the webview reports it is ready; old scan results are not treated as
authoritative. This is read-only visualization, not a GPIO hardware write.

## Guided firmware flashing

Standard **Flash** menu:
1. Get a matching official MicroPython .bin image.
2. Choose a specific supported ESP family or Pico/STM32.
3. For ESP, review chip family, .bin file, serial adapter, and board-specific
   offset, then explicitly confirm before starting esptool.

Unknown offsets require Advanced mode; Erase Flash stays hidden until the
user deliberately enables Advanced. The Flash operation holds the exclusive
COM-port handoff until esptool exits.

Official full-image offsets (not ESP-IDF component offsets):
- ESP32 classic and ESP32-S2: 0x1000
- ESP32-S3, ESP32-C3, ESP32-C6 and ESP8266: 0x0

Source pages: https://micropython.org/download/ESP32_GENERIC/
https://micropython.org/download/ESP32_GENERIC_S3/
https://micropython.org/download/ESP32_GENERIC_C3/
https://micropython.org/download/ESP32_GENERIC_C6/
https://micropython.org/download/ESP8266_GENERIC/

**Important:** Firmware flashing can overwrite files. Back up the device
before flashing, and use firmware built for the exact hardware.

## Physical Windows acceptance checklist

- [ ] Select com5 manually; status and device.cfg show COM5.
- [ ] Refresh/reopen workspace/reconnect USB without selecting another CDC.
- [ ] Select REPL COM5 and Debug COM13 on a dual-CDC board; start Debug repeatedly.
- [ ] Dashboard select board, scan pins, refresh, reopen, and verify same board.
- [ ] Change GPIO use in source; refresh shows updated pin assignments.
- [ ] ESP32-S3 guided flash uses 0x0; ESP32 classic uses 0x1000.
- [ ] Flash prompts for confirmation, waits for esptool, and recovers COM.
- [ ] Advanced mode can still flash explicitly configured multi-image layouts.
- [ ] Pico W shell and mpflash still work with the recovered 2.6.1 serial layer.

Do not merge or release until this matrix passes on physical hardware.
