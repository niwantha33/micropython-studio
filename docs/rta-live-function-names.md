# RTA function-name resolution — development design

This describes experimental, additive RTA metadata for debugger-enabled
MicroPython images. It is not a production firmware release.

## Existing data path

- The C VM hook observes live code_state->fun_bc and emits 0x05
  entry / 0x06 exit frames containing the 32-bit function identifier
  and microsecond timestamp.
- trace_pump.py drains the ring over the debug CDC connection.
- dbg_bridge.py forwards decoded events to the host extension.
- The webview combines segment timing with get_symmap() and get_taskmap()
  results, falling back to an UNKNOWN hexadecimal identifier.

The existing symbol collector sees Python functions exported from module
attributes, plus selected class members. Closures, dynamically generated
functions and functions no longer exported from modules can be absent.
The asyncio task-map helper uses implementation-specific heap offsets and
should not be generalized as a memory scanner.

## Optional frame 0x07

A separately built debug-firmware candidate can emit a live name frame:

- Frame: 0xAA 0x07 LENGTH PAYLOAD
- Payload: function_ptr:u32LE, bytecode_ptr:u32LE, context_ptr:u32LE,
  name:utf8 (1–60 bytes)
- function_ptr is the exact code_state->fun_bc identifier used for timing.
- bytecode_ptr and context_ptr are opaque identity tokens only. The host
  must not dereference them.
- The C hook reads the name from the live mp_obj_fun_bc_t using
  mp_obj_fun_bc_get_name(), not from guessed object offsets.
- Name values are simple names (e.g., get_gpio_state), not guaranteed
  module-qualified names. Runtime module lookup remains available.

A bounded 64-slot firmware cache suppresses redundant metadata and
re-emits it when the identity of a function pointer changes. Metadata
is omitted if the ring cannot fit it without crowding timing frames.

Studio explicitly opts in through the existing debugger poke_global command,
invoking dbg.rta_names_on() only if that API exists. A firmware image with
the metadata patch defaults to names OFF. Older Studio bridges will therefore
never receive new 0x07 frames. Older firmware emits no 0x07 and continues to
use the existing symbol/task lookup. The timestamp encoding and timing
calculations are unchanged.

## Safety and limitations

- Function IDs are meaningful only within their target runtime session.
  Studio clears RTA name state whenever RTA starts.
- A changed live identity at the same address invalidates an earlier
  assigned name. Unknown IDs continue displaying as UNKNOWN; never guess.
- The feature attributes bytecode *functions*, not individual asyncio
  task objects or whole-MCU CPU utilization. Accurate per-task analysis
  needs validated scheduler events, not heap-offset guesses.
- The original byte-by-byte C ring can drop data under pressure. Numeric
  identifiers outside expected target ranges may represent damaged
  records, not valid pointers. Integrity/loss reporting is separate work.
- The existing firmware workflow stages UF2 files and version provenance
  but not the matching ELF or linker map files. ELF/map data is useful
  for linked native symbols, not arbitrary MicroPython heap objects.

## Acceptance before firmware adoption

1. CI-compilation on the pinned MicroPython revision for four Pico boards.
2. Synthetic tests of 0x05/0x06/0x07 framing and malformed metadata.
3. Hardware verification: module functions, closures, class methods,
   dynamically recreated functions and asyncio coroutines.
4. Check that stepping, breakpoints, REPL, WebREPL, RTA timing and RTA
   stop behavior do not regress.
5. Measure event loss and CPU/RAM overhead during high-rate tracing.
6. Do not modify release tags, published images, user boot.py or workflow.
