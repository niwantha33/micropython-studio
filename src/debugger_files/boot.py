# boot_dual_cdc.py — upload to the Pico 2 W as `boot.py`
#
# Phase 2 proof: adds a SECOND USB-CDC interface at boot.
# After reboot, Windows should show TWO COM ports for the board.
#
# Safety:
#   - 3-second window before activation — press Ctrl-C in the REPL to abort
#   - Entire thing is try/except so failures can't brick the REPL

import time
import sys


def _enable_dual_cdc():
    import usb.device
    from usb.device.cdc import CDCInterface

    dbg_cdc = CDCInterface()
    dbg_cdc.init(timeout=0)
    usb.device.get().init(dbg_cdc, builtin_driver=True)

    import dbgref
    dbgref.cdc = dbg_cdc
    print("[boot] second CDC registered as dbgref.cdc")


try:
    print("[boot] dual-CDC enabling in 3s — Ctrl-C to skip")
    time.sleep(3)
    _enable_dual_cdc()
except KeyboardInterrupt:
    print("[boot] skipped dual-CDC (Ctrl-C)")
except Exception as e:
    sys.print_exception(e)
    print("[boot] dual-CDC setup failed, continuing with REPL only")
