# MicroPython Studio Debugger Globals & Locals Update Todo Checklist

We have successfully updated the MicroPython Studio VS Code debugger panel and trace pump to support interactive viewing and editing of global variables, with backwards-compatible parsing fallbacks and error protection.

## Done Checklist
- [x] **Add Globals UI Panel**: Added a dedicated **Global Variables** card and a **🌐 Globals (g)** refresh button with keybinding (`g`) to [mpyDebugger.js](file:///c:/My-Projects/micropython-studio-py/micropython-studio/src/mpyDebugger.js).
- [x] **Regex-based Globals Parser**: Replaced the custom character string parser in the webview with a safe regex-based parser to avoid infinite loops and freezing on truncated or empty serial responses.
- [x] **Fallback Locals Parser**: Modified the locals parser in the webview to accept both standard `depth=X state=[...]` and the older `frame=(...) state=[...]` formats.
- [x] **Debugger Frame Auto-Skipping**: Updated [trace_pump.py](file:///c:/My-Projects/micropython-studio-py/micropython-studio/src/debugger_files/trace_pump.py) to automatically walk up stack frames when querying or poking locals/globals to skip the debugger's own internal `trace_pump` module frames.
- [x] **ValueError Safety**: Wrapped the stack frame walking loops in `trace_pump.py` in `try...except ValueError` blocks to prevent crashes on truncated exception call stacks.

## Actions Needed on the Board
1. **Upload Updated Files**: Click the **Upload debugger files** option in the VS Code debug panel to transfer the updated [trace_pump.py](file:///c:/My-Projects/micropython-studio-py/micropython-studio/src/debugger_files/trace_pump.py) to the MicroPython board.
2. **Reboot**: Reset/Soft-reboot the board (e.g., press `Ctrl-D` in the REPL terminal).
3. **Restart pump**: Start the debugger pump again by executing `import trace_pump; trace_pump.start()`.
4. **Test & Verify**: Set a breakpoint or run code that raises an exception (like division by zero) and verify that the Locals and Global Variables populate properly in the VS Code panel!

## Pending Debugger Tasks (Real-Time Analysis - RTA)
- [ ] **Handle RTA Bridge Events**: Update the message listener in [mpyDebugger.js](file:///c:/My-Projects/micropython-studio-py/micropython-studio/src/mpyDebugger.js) to process `rta_entry` and `rta_exit` events dispatched by `dbg_bridge.py`.
- [ ] **RTA Trace Profiler**: Calculate duration differences between function entry/exit timestamps (`ts`) to profile function performance.
- [ ] **Export Trace Log**: Save/export the profiled call stack trace events to a JSON file (e.g., `rta_trace.json`) for visualization.

