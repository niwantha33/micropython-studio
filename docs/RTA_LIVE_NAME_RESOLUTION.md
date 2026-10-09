# Live RTA function names: linker map versus runtime identifiers

Status: **experimental design for hardware evaluation only**. Do not flash or publish new firmware solely because CI builds it.

## What the address represents

The RTA firmware emits a 32-bit `code_state->fun_bc` value in each `rta_entry`/`rta_exit` event (0x05/0x06). It is the **MicroPython function object identity**. It is not a C return address, instruction pointer, asyncio task pointer or executable section offset.

For example, the debugger may display `0x200344d0` as UNKNOWN. `0x200...` is an SRAM-space address on RP2350, but exact classification requires the matching board firmware's linker memory ranges and current GC heap layout. **For this pinned RP2 MicroPython revision, `ports/rp2/main.c` explicitly calls `gc_init(&__GcHeapStart, &__GcHeapEnd)`**, so those exact linker symbols mark the default GC heap bounds (subject to optional PSRAM configuration). A linker map only describes statically linked objects/sections; it does **not** label transient Python functions allocated from the GC heap. A heap region check can classify the address range, **not** recover a function name.

The code backing a function (bytecode/frozen code) may be in flash, but the address carried in the RTA packet identifies the **function object**. Running `addr2line` or `nm` on that heap address will generally not produce a meaningful Python function name.

## Existing safe runtime fallback

Studio already requests the bundled `trace_pump.get_symmap()` map and an asyncio task map at RTA startup. `get_symmap()` enumerates exported functions in `sys.modules` and public class methods. This cannot guarantee that it discovers locally nested functions, function instances retained only by closures, already-finished tasks or coroutines not in the ready-task queue.

## Proposed bounded VM-native solution

The pinned MicroPython revision has `mp_obj_fun_bc_get_name(const mp_obj_fun_bc_t *)`, which extracts the qstr name from the bytecode prelude. The VM's `code_state->fun_bc` value is already a valid executing object pointer. A candidate C hook can obtain the name **at the moment the function executes**, without accepting a raw pointer from the host or scanning arbitrary memory.

The prototype emits **a standard existing 0x03 text reply**, once per observed symbol-cache entry:

```text
rta_name=200344d0:get_gpio_state
```

The Studio host converts the bounded reply to the existing `rta_name` webview event. Older firmware remains compatible (no names are emitted; the existing symbol/task map remains active). Older Studio versions may show the extra reply line as plain debug text. The debugger wire commands, breakpoint semantics and RTA timing calculation are unchanged.

Safety and limitations:

- Validity comes from the active VM code state, **never** from a host-provided hex address. Do not expose a general-purpose heap dereference command.
- Name emission is bounded (72 bytes) and preflights ring capacity to avoid a partial framed message. A 128-slot direct-mapped cache avoids per-switch linear scans and permits safe re-emission after eviction.
- Only the simple Python function name is recovered. Duplicate `update` functions in different modules can share a display name, but their addresses remain distinct. The existing module/task mapping may provide qualified names.
- Build variants differ. Treat C symbol data from `firmware.elf`/`firmware.map` as version-specific and never use one board's map for another board.
- Calling a function-name helper, even without allocation, adds some VM tracing overhead. Measure the event overhead and ring loss counts on the **actual Pico 2 W** before acceptance.
- The frozen firmware pipeline currently pins the Studio `trace_pump.py` source at a specific commit; changes to Studio alone do **not** update already-flashed firmware.

## Non-destructive linker-map checks (WSL)

After building the **exact** source and board, these commands can show static linker symbols and section layout:

```bash
cd ~/micropython/ports/rp2/build-RPI_PICO2_W
ls -lh firmware.elf firmware.map
arm-none-eabi-nm -n firmware.elf | grep -E '__GcHeap(Start|End)|mp_obj_fun_bc_get_name|rta_'
grep -nE '(__GcHeapStart|__GcHeapEnd|\.bss|\.data|\.text)' firmware.map | head -n 45
```

Map filename may vary; check the actual build directory rather than assuming `firmware.map` is always present. Use the ELF from the **same image** running on the board. Do not run heap pointer values through `addr2line` and present the result as a decoded Python function.

## Acceptance evidence

1. Existing unmodified Pico 2 W firmware works with the modified host and still receives RTA events.
2. Test candidate reports names for formerly unknown heap-backed functions (including an active nested coroutine) without crash, corrupted framing or changed REPL/debugger connections.
3. Check 1000+ RTA events, stream-loss counters, On/Off toggles, debugger breakpoints, Wi-Fi and USB REPL recovery.
4. Verify at least one method and repeated coroutine creation; pointer reuse must not silently misattribute names.
5. Compare RTA overhead with and without optional name messages. No publication/merge to stable until physical acceptance.
