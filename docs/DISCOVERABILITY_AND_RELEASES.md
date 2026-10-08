# Discoverability and release-growth plan — MicroPython Studio

**Prepared 8 October 2026 · Draft PR only**. The aim is to make a genuinely
working MicroPython debugger easier to discover without forum promotion,
fabricated reviews, inflated download counts, spam or unsupported hardware claims.

## Positioning: show the real debugger first

**Primary user promise:** "Live MicroPython debugging on a Raspberry Pi Pico 2 W
in VS Code: breakpoints, stepping, variable inspection, call stacks and runtime
tracing."

The audience searches for problems, not necessarily the project's brand. Use
honest search terms like "MicroPython debugger", "Pico 2 W breakpoints",
"step through MicroPython", "RP2350 debug" in page descriptions, feature demos
and accessible captions. The Marketplace listing already uses categories
`Programming Languages` and `Debuggers`; keep both.

**What was already true:** Pico 2 W debugger has hardware testing.
**What is still experimental:** frozen firmware for other Pico variants, new
ESP32-S3 release readiness and ESP32-C3 debugger transport. Do not conflate
CI compilation with device support.

## Distribution channels that don't require forums

1. **Visual Studio Marketplace** — update the existing listing through the
   extension's `package.json` and Marketplace-rendered `README.md` in an
   approved release. Include the debugger demo in the first screen, and
   screenshots with captions when screenshots are available from genuine tests.
2. **Open VSX** — use the existing tag-driven workflow to publish the **same
   approved VSIX**. Verify publication in the destination registry after each
   release. This channel requires its namespace/publishing credentials.
3. **GitHub Pages** — canonical searchable landing page
   `micropython-live-debugger.html`, a sitemap and robots instructions,
   linked from the project README. No forum post required.
4. **GitHub repository discovery** — optionally set repository description to
   "Live on-device MicroPython debugging in VS Code: Pico breakpoints, stepping,
   variables, call stacks and runtime tracing." and topics including
   `micropython`, `debugger`, `vscode-extension`, `raspberry-pi-pico`,
   `rp2350`, `esp32`. Repo settings must be changed by an authorised user.
5. **Existing demonstration video** — use the real [Pico 2 W debugger demo]
   (https://www.youtube.com/watch?v=or_aG-Rhnb8). Add a search-focused
   description, chapter timestamps and Marketplace install link through the
   video owner's account. A hardware-proven shorter demo could follow.
6. **Natural third-party mentions** — make reproducible demos and installation
   docs available for independent makers, educators and maintainers. Avoid
   automated comments or promotional posts in communities that do not permit it.

## Automatic public releases (already partly implemented)

Existing [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs
tests, packages a VSIX, creates a GitHub release and attempts publication to
Visual Studio Marketplace and Open VSX **only on pushes of `v*` tags**.
Publishing needs authorised `VSCE_PAT` and `OVSX_PAT` secrets or supported
short-lived publishing credentials; those cannot be verified by reading source.

**Never tag unapproved code.** Before a tag:

- [ ] Merge only reviewed, hardware-accepted changes into `main`.
- [ ] Ensure Git tag `vX.Y.Z` matches `package.json` version `X.Y.Z`.
- [ ] Lint, VS Code tests, VSIX packaging and board-specific smoke tests pass.
- [ ] Document limitations, tested board/firmware versions and recovery.
- [ ] Confirm registry auth and that both Marketplace and Open VSX accept this
      publisher/namespace.
- [ ] Push an annotated version tag from the approved `main` commit.

The existing workflow then distributes approved artifacts automatically.
Avoid blind daily or weekly *Marketplace version bumps*: releasing unstable
builds for visibility hurts trust and can force unwanted user upgrades.
A scheduled CI test build is different from a stable public release.

Microsoft's publisher documentation notes global Azure DevOps PAT retirement
on **1 December 2026**; plan for supported secure identity-based publishing
or token migration before that date. Open VSX introduced trusted publishing
through GitHub Actions in September 2026.

## Measure real progress weekly (no fake downloads)

Collect actual Marketplace **acquisition trends**, ratings and feedback through
publisher reports. Record organic search positions for:
`micropython debugger`, `micropython`, `pico debugger`,
`circuitpython` and `esp32 debugger`, plus the installation-to-first-breakpoint
success and support issues. Do not report rankings without actual captures.

Target high **successful-debug-session** counts and positive user
recommendations rather than artificially boosting installation counters.
Privacy-friendly, opt-in feedback is preferable to background telemetry.

## Release-gate caveat

`feature/frozen-debugger-connect-only` PR #52 and
`fix/local-ai-ollama-reliability` PR #54 remain draft. Marketing descriptions
must not suggest those unmerged features are already in the public stable VSIX.
The published Pico firmware's legacy installation instructions remain relevant
until the new self-contained firmware passes hardware acceptance.
