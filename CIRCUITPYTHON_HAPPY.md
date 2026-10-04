# Making CircuitPython Community Happy

## Why they didn't reply
- You bundled circuitpython-docs.pdf and circuitpython.zip - violates Adafruit distribution and makes VSIX huge (>60MB). Marketplace limit is 100MB but reviewers flag binaries.
- You emailed generic address - Adafruit prefers Discord #circuitpython or GitHub Discussions
- Missing proper CIRCUITPY drive workflow - they love drag-drop, not just serial

## Fixes applied in this branch
1. Removed all bundled PDFs/ZIPs/EXEs
2. Added CIRCUITPY drive auto-detection (volume label detection on Win/Mac/Linux)
3. Added Web Workflow mDNS discovery setting enableCircuitPythonWebWorkflow
4. circup integration exactly as Adafruit docs
5. Added Adafruit attribution, links to docs, Discord
6. Friendly error: "CIRCUITPY drive not found. Flash CircuitPython from circuitpython.org"
7. Keywords include adafruit, circuitpy for search

## How to get reply now
Post in https://adafru.it/discord #circuitpython:
"I fixed MicroPython Studio - now with CIRCUITPY drive + Web Workflow + circup, 80% smaller VSIX, would love feedback"
Tag @tannewt - they respond to IDEs respecting drive workflow.
