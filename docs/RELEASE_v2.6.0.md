# MicroPython Studio v2.6.0 — Firmware-first MicroPython debugger

Released 8 October 2026.

## The main milestone

**Raspberry Pi Pico W frozen debugger tested on real hardware**: debugger features work without uploading separate `boot.py`, `dbgref.py` or `trace_pump.py` helpers. The firmware is installed once as a board-matched UF2, then Studio connects using the dedicated debugger USB CDC port.

**[Official Pico W debugger firmware v2.6.0](https://github.com/niwantha33/micropython_live_dbg_firmware/releases/tag/v2.6.0)**. Use this UF2 only for **Raspberry Pi Pico W**, not Pico/Pico 2/Pico 2 W or ESP32.

## Changes since older Studio releases

- **Firmware-first debugger:** `Start Debug → Connect` with no debugger-Python-file upload; `Download firmware` opens the exact board's GitHub download page.
- **Simpler UI:** short board picker and direct firmware downloads from the firmware repository's `TestBuilds/` channel.
- **Reliable REPL groundwork:** Shell opens without unsolicited Ctrl-C or automatic `os.uname()`; improved daemon connection timeouts, COM lock handling, error reporting and explicit port ownership.
- **Board pinout safety:** specific ESP32-S2/S3/C3 identities, corrected 30-pin reference, and unverified pin assignments hidden.
- **Local AI:** choose installed Ollama models, improved timeout/error handling, no surprise reinstallation of models.
- **Discoverability:** clearer Marketplace description, debugger landing page and stricter release-tag checks.

## Hardware availability and caveats

- **Pico W:** frozen debugger confirmed working without uploading helper Python files.
- **Pico, Pico 2, Pico 2 W:** CI builds exist but the newer frozen USB CDC debugger images still need board-specific physical acceptance.
- **ESP32-S3:** breakpoint/short RTA demonstration completed on split-USB hardware; long-running stability/recovery not yet certified.
- **ESP32-C3:** feasibility only; no released debugger firmware.

RTA *Observed VM %* is a fraction of observed execution-segment time, not CPU utilisation.

For Pico W, back up any existing device files and understand BOOTSEL recovery before flashing. If the board has an old, conflicting debugger `boot.py`, investigate/backup first—do not blindly delete user scripts.

## Manual publication / demonstration

- VS Code extension: https://marketplace.visualstudio.com/items?itemName=niwantha33.micropython-studio
- Pico W firmware release: https://github.com/niwantha33/micropython_live_dbg_firmware/releases/tag/v2.6.0
- Demonstration: https://www.youtube.com/watch?v=or_aG-Rhnb8
- Source: https://github.com/niwantha33/micropython-studio

Release acceptance: Studio CI tests and packaging pass; Pico W firmware tested by the maintainer on a physical Pico W. Other board candidates stay experimental.
