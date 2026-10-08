# MicroPython Studio — Local AI audit and test plan (8 October 2026)

**Branch:** `fix/local-ai-ollama-reliability`. Do not merge, publish or replace
the working debugger/REPL firmware as part of this work. Tests target the host
extension and a local Ollama server, not a physical board.

## What the audit found

1. **Unexpected heavy work:** checking Ollama status through a subprocess
   automatically rebuilt both custom models based on a string version comparison;
   an extension Modelfile watcher also reinstalled models on changes.
2. **Destructive reinstall:** `ollama_helper.py reinstall` ran `ollama rm` for
   both custom models and the user's earlier `mycoder-*` names before creating
   replacements. Partial creation failures could remove working models.
3. **False success:** the helper's `setup` and `reinstall` commands printed
   `{"success":true}` even after a failed `ollama pull/create` operation.
4. **Hardcoded model names:** AI requests always used `micro_ai-mpy` or
   `micro_ai-cpy` without a model-picker, even when Ollama had other installed
   options or used `:latest` tags.
5. **Slow/no-response behaviour:** HTTP chat had no idle timeout and could
   resolve an incomplete NDJSON stream. Ollama in-band errors were appended to
   chat text but not propagated as failure.
6. **Offline UI weakness:** Markdown/highlight scripts were loaded from external
   CDNs even though the AI feature is advertised as local/offline.
7. **Potentially unsafe code execution:** `Run` from a model-generated code
   block could execute on the connected hardware without a confirmation.

## Corrections in this development branch

- Status/model discovery calls local `http://127.0.0.1:11434/api/tags`
  directly with a five-second timeout; no Python or automatic `pip install`.
- Only explicitly pressing Initialize Model pulls/builds the two custom models.
  Recreate replaces only named models on successful creation; never deletes
  `mycoder-*` or existing `micro_ai-*` up front.
- User can select any installed Ollama model. Selection persists per workspace.
  The firmware-specific `micro_ai-mpy(:latest)` / `micro_ai-cpy(:latest)`
  remains a default if present, otherwise the installed list is used.
- Chat requests use an inactivity timeout and propagate HTTP/NDJSON errors,
  rather than reporting a failed or interrupted completion as success.
- The chat keeps a no-CDN fallback text/code renderer if external highlighting
  resources are blocked. Raw HTML emitted by the model is escaped.
- AI-generated `Run on device` actions require explicit confirmation.
- No USB/REPL serial transport, debugger protocol, firmware, marketplace
  publication or peripheral pin configuration changes are included.

## Safe on-machine acceptance

1. Start existing Ollama locally and run `ollama list`. Do not delete/rebuild
   any models. Verify Studio displays every installed model by its exact name
   (including `:latest`) and lets you switch in the dropdown.
2. Send a short question and verify tokens stream, the selected model is
   actually used, and the result stays readable with the network disconnected.
3. Stop the Ollama service. Confirm that the UI displays **Ollama Offline**
   instead of hanging, silently installing packages or rebuilding models.
4. Reopen Studio and confirm model names/files/creation dates have not changed.
5. Intentionally select a missing model by removing it through external Ollama
   administration *only on a disposable test profile*; confirm errors are
   visible and do not report chat success.
6. On connected hardware, click **Run** on a generated code block and verify
   the confirmation dialog appears before anything is sent to the MCU.
7. Ensure Studio REPL, file upload, breakpoint and RTA workflows remain stable:
   AI chat does not own or open serial ports.

## Limitations / subsequent work

- A dedicated cancellation button, structured output parsing, explicit context
  visibility controls and a truly bundled syntax highlighter require additional
  review. The fallback renderer prioritises offline availability over full
  Markdown fidelity when external CDN scripts are unavailable.
- Current prompts still impose custom MicroPython/CircuitPython library rules
  and cannot guarantee that generated GPIO mappings match arbitrary third-party
  boards. Always verify exact board schematic before running generated code.
- On-device performance, token throughput and model quality cannot be proven
  from CI; they need local Ollama testing on a real PC.

Keep this PR draft until CI and the offline/on-device confirmation checks pass.
