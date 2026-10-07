# boot.py — MicroPython Studio dual-CDC debugger wiring.
#
# Configure the runtime debug CDC immediately during boot so Windows sees one
# stable composite USB device (built-in REPL CDC + debug CDC). Do not delay the
# USB configuration: delaying can expose a transient single-CDC device first
# and leave Windows/pyserial with stale COM handles after re-enumeration.

import sys


def _enable_dual_cdc():
    import usb.device
    from usb.device.cdc import CDCInterface

    # One initialization only. Non-blocking reads are required by trace_pump.
    # Larger TX buffering gives RTA/trace bursts room without changing the wire
    # protocol. RX only carries short debugger command frames.
    dbg_cdc = CDCInterface(timeout=0, txbuf=4096, rxbuf=512)
    usb.device.get().init(dbg_cdc, builtin_driver=True)

    import dbgref
    dbgref.cdc = dbg_cdc
    print("[boot] debug CDC registered")

    # Starting the thread is safe before the PC opens the debug COM port:
    # trace_pump waits for cdc.is_open() + DTR before touching the endpoints.
    try:
        import trace_pump
        trace_pump.start()
        print("[boot] trace_pump supervisor started")
    except Exception as e:
        sys.print_exception(e)
        print("[boot] trace_pump start failed; REPL remains available")


try:
    _enable_dual_cdc()
except Exception as e:
    sys.print_exception(e)
    print("[boot] dual-CDC setup failed, continuing with REPL only")
