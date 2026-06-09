// mpyDebugger.js — webview-based MicroPython bytecode debugger panel.
//
// Spawns src/dbg_bridge.py (pyserial) to talk to the debug CDC. The webview
// shows event log + buttons for continue/step/step-in/step-out/locals.

const vscode = require('vscode');
const path = require('path');
const { spawn } = require('child_process');

let panel = null;
let bridge = null;
let bpDisposable = null;
const bpSlotMap = new Map(); // key "module:func:line" -> slot (filled on reply)
const pendingBpReplies = []; // queue of {key, fsPath, line1}
const ipToLoc = new Map();   // ip -> {fsPath, line1}
const ipToCond = new Map();  // ip -> condition string (optional)
let pendingCondEval = null;  // { ip, cond, names } while awaiting locals reply
let hlDeco = null;            // TextEditorDecorationType for current line (yellow — breakpoint)
let stepInDeco = null;        // TextEditorDecorationType for step-in line (cyan)
let lastHlEditor = null;
let lastActionWasStepIn = false; // tracks whether the last resume action was step_in

// Pop matching pending breakpoint reply by module, function, and relative line.
function popPendingBp(module, func, relLine) {
    const fnKey = `${module}:${func}`;
    const idx = pendingBpReplies.findIndex(item => item.fnKey === fnKey && (item.line1 - item.defLine) === relLine);
    if (idx >= 0) {
        return pendingBpReplies.splice(idx, 1)[0];
    }
    return pendingBpReplies.shift();
}

// Scan a python source for the nearest `def name(` at/above `line` (1-based).
// Returns {func, defLine, args} or null.
function findEnclosingFunction(text, line) {
    const lines = text.split(/\r?\n/);
    for (let i = Math.min(line - 1, lines.length - 1); i >= 0; i--) {
        const m = lines[i].match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/);
        if (m) {
            const args = m[2].split(',').map(s => s.trim().split(/[:=]/)[0].trim()).filter(Boolean);
            return { func: m[1], defLine: i + 1, args };
        }
    }
    return null;
}

// Extract local variable names (args + assignment-order) from a function body.
function extractLocalNames(text, defLine, args) {
    const lines = text.split(/\r?\n/);
    const names = [...args];
    const seen = new Set(names);
    const defIndent = (lines[defLine - 1] || '').match(/^\s*/)[0].length;
    for (let i = defLine; i < lines.length; i++) {
        const ln = lines[i];
        const indent = (ln.match(/^\s*/) || [''])[0].length;
        if (ln.trim() === '') continue;
        if (indent <= defIndent && ln.trim() !== '') break; // left the function
        const m = ln.match(/^\s*([A-Za-z_]\w*)\s*=/);
        if (m && !seen.has(m[1])) { seen.add(m[1]); names.push(m[1]); }
    }
    return names;
}

// Map module:func -> array of local names
const localNamesByFn = new Map();

function openDebuggerPanel(context, port) {
    if (panel) {
        panel.reveal();
        return;
    }
    panel = vscode.window.createWebviewPanel(
        'mpyDebugger',
        `MPy Debugger (${port})`,
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.webview.html = getHtml();

    hlDeco = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(255, 200, 0, 0.25)',
        isWholeLine: true,
        overviewRulerColor: '#ffa500',
        overviewRulerLane: vscode.OverviewRulerLane.Full,
    });
    stepInDeco = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(0, 180, 220, 0.25)',
        isWholeLine: true,
        overviewRulerColor: '#00b4dc',
        overviewRulerLane: vscode.OverviewRulerLane.Full,
    });

    async function highlightLine(fsPath, line1, useStepInColor) {
        try {
            const doc = await vscode.workspace.openTextDocument(fsPath);
            const ed = await vscode.window.showTextDocument(doc, { preserveFocus: false, viewColumn: vscode.ViewColumn.One });
            const range = new vscode.Range(line1 - 1, 0, line1 - 1, 0);
            const deco = useStepInColor ? stepInDeco : hlDeco;
            // clear both decorations first
            ed.setDecorations(hlDeco, []);
            ed.setDecorations(stepInDeco, []);
            ed.setDecorations(deco, [range]);
            ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            lastHlEditor = ed;
        } catch (e) { /* ignore */ }
    }
    function clearHighlight() {
        for (const ed of vscode.window.visibleTextEditors) {
            if (hlDeco) ed.setDecorations(hlDeco, []);
            if (stepInDeco) ed.setDecorations(stepInDeco, []);
        }
    }

    // Spawn the Python bridge
    const script = path.join(context.extensionPath, 'src', 'dbg_bridge.py');
    const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
    bridge = spawn(pyCmd, [script, port], { stdio: ['pipe', 'pipe', 'pipe'] });

    // Send existing breakpoints
    for (const bp of vscode.debug.breakpoints) {
        if (!(bp instanceof vscode.SourceBreakpoint)) continue;
        const loc = bp.location;
        const fsPath = loc.uri.fsPath;
        if (!fsPath.endsWith('.py')) continue;
        const line1 = loc.range.start.line + 1;
        try {
            const fs = require('fs');
            const text = fs.readFileSync(fsPath, 'utf8');
            const info = findEnclosingFunction(text, line1);
            if (!info) continue;
            const modName = path.basename(fsPath, '.py');
            const relLine = line1 - info.defLine;
            const key = `${modName}:${info.func}:${line1}`;
            const names = extractLocalNames(text, info.defLine, info.args);
            localNamesByFn.set(`${modName}:${info.func}`, names);
            const cond = (typeof bp.condition === 'string' && bp.condition.trim()) ? bp.condition.trim() : null;
            pendingBpReplies.push({ key, fsPath, line1, fnKey: `${modName}:${info.func}`, cond, defLine: info.defLine });
            const out = { op: 'set_bp', module: modName, func: info.func, line: relLine };
            bridge.stdin.write(JSON.stringify(out) + '\n');
        } catch (e) {}
    }

    let buf = '';
    bridge.stdout.on('data', (d) => {
        buf += d.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try {
                const msg = JSON.parse(line);
                // Capture slot numbers from reply text: "bp N @ mod.func:line ip=..."
                if (msg.evt === 'reply' && typeof msg.text === 'string') {
                    const m = msg.text.match(/^bp (\d+) @ (.*)\.([^:]+):(\d+) ip=(\d+)(?: fun=(\d+))?/);
                    if (m) {
                        const slot = parseInt(m[1], 10);
                        const modName = m[2];
                        const funcName = m[3];
                        const relLine = parseInt(m[4], 10);
                        const bpIp = parseInt(m[5], 10);
                        const info = popPendingBp(modName, funcName, relLine);
                        if (info) {
                            bpSlotMap.set(info.key, slot);
                            ipToLoc.set(bpIp, { fsPath: info.fsPath, line1: info.line1, fnKey: info.fnKey });
                            if (info.cond) ipToCond.set(bpIp, info.cond);
                            if (m[6]) {
                                const funPtr = m[6];
                                panel.webview.postMessage({ evt: 'fun_name', fun: funPtr, name: info.fnKey, fsPath: info.fsPath, defLine: info.defLine });
                            }
                        }
                    } else {
                        const mFail = msg.text.match(/^no code on (.*)\.([^\s]+) line (\d+)/);
                        if (mFail) {
                            popPendingBp(mFail[1], mFail[2], parseInt(mFail[3], 10));
                        }
                    }
                }
                if (msg.evt === 'bp_hit') {
                    const loc = ipToLoc.get(msg.ip);
                    const cond = ipToCond.get(msg.ip);
                    if (cond && loc) {
                        // Defer UI surface; ask for locals, evaluate, then decide.
                        pendingCondEval = { ip: msg.ip, cond, loc, names: localNamesByFn.get(loc.fnKey) || [] };
                        try { bridge.stdin.write(JSON.stringify({ op: 'locals' }) + '\n'); } catch (e) {}
                        continue; // do not forward bp_hit yet
                    }
                    if (loc) {
                        highlightLine(loc.fsPath, loc.line1, lastActionWasStepIn);
                        panel.webview.postMessage({ evt: 'names', names: localNamesByFn.get(loc.fnKey) || [] });
                    } else if (lastActionWasStepIn) {
                        // Stepped into code with no source mapping
                        panel.webview.postMessage({
                            evt: 'no_source',
                            ip: msg.ip,
                            msg: `Stepped into unmapped code at ip=0x${msg.ip.toString(16).padStart(4, '0')}. No source file available. Use Step-out (o) to return or Continue (c) to resume.`
                        });
                    }
                    lastActionWasStepIn = false;
                    panel.webview.postMessage({ evt: 'status', paused: true });
                    try { bridge.stdin.write(JSON.stringify({ op: 'locals' }) + '\n'); } catch (e) {}
                    try { bridge.stdin.write(JSON.stringify({ op: 'globals' }) + '\n'); } catch (e) {}
                }
                if (msg.evt === 'exception') {
                    panel.webview.postMessage({ evt: 'error', msg: `Exception: ${msg.msg} at ip=0x${msg.ip.toString(16)}`, ip: msg.ip });
                    panel.webview.postMessage({ evt: 'status', paused: true });
                    const loc = ipToLoc.get(msg.ip);
                    if (loc) {
                        highlightLine(loc.fsPath, loc.line1, false);
                        panel.webview.postMessage({ evt: 'names', names: localNamesByFn.get(loc.fnKey) || [] });
                    }
                    try { bridge.stdin.write(JSON.stringify({ op: 'locals' }) + '\n'); } catch (e) {}
                    try { bridge.stdin.write(JSON.stringify({ op: 'globals' }) + '\n'); } catch (e) {}
                }
                if (msg.evt === 'reply' && pendingCondEval && typeof msg.text === 'string' && msg.text.startsWith('frame=')) {
                    const pe = pendingCondEval;
                    pendingCondEval = null;
                    const fm = msg.text.match(/frame=\(([^)]+)\)\s+state=\[(.*)\]$/);
                    let passed = false, err = null;
                    if (fm) {
                        const n = parseInt(fm[1].split(',')[0]);
                        // split state respecting quotes
                        const raw = fm[2];
                        const parts = [];
                        let cur = '', q = null, depth = 0;
                        for (let i = 0; i < raw.length; i++) {
                            const c = raw[i];
                            if (q) { cur += c; if (c === q && raw[i-1] !== '\\') q = null; continue; }
                            if (c === "'" || c === '"') { q = c; cur += c; continue; }
                            if (c === '[' || c === '(') { depth++; cur += c; continue; }
                            if (c === ']' || c === ')') { depth--; cur += c; continue; }
                            if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
                            cur += c;
                        }
                        if (cur.trim()) parts.push(cur.trim());
                        const args = {};
                        for (let i = 0; i < pe.names.length; i++) {
                            const idx = n - 1 - i;
                            let v = (idx >= 0 && idx < parts.length) ? parts[idx] : 'null';
                            v = v.replace(/\bNone\b/g, 'null').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false');
                            try { args[pe.names[i]] = eval('(' + v + ')'); } catch (_) { args[pe.names[i]] = v; }
                        }
                        let js = pe.cond
                            .replace(/\band\b/g, '&&').replace(/\bor\b/g, '||').replace(/\bnot\b/g, '!')
                            .replace(/\bNone\b/g, 'null').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false');
                        try {
                            const fn = new Function(...pe.names, 'return (' + js + ')');
                            passed = !!fn(...pe.names.map(k => args[k]));
                        } catch (e) { err = String(e); }
                    }
                    if (!passed) {
                        if (err) panel.webview.postMessage({ evt: 'error', msg: 'cond error: ' + err + ' → pausing' });
                        if (err) { /* fall through to pause */ }
                        else {
                            panel.webview.postMessage({ evt: 'sent', op: `cond false @ ip=0x${pe.ip.toString(16)} → resume` });
                            try { bridge.stdin.write(JSON.stringify({ op: 'continue' }) + '\n'); } catch (e) {}
                            continue; // swallow reply
                        }
                    }
                    // surface the pause we previously suppressed
                    if (pe.loc) {
                        highlightLine(pe.loc.fsPath, pe.loc.line1);
                        panel.webview.postMessage({ evt: 'names', names: pe.names });
                    }
                    panel.webview.postMessage({ evt: 'bp_hit', ip: pe.ip });
                    panel.webview.postMessage({ evt: 'status', paused: true });
                    // forward the reply so locals table renders
                }
                if (msg.evt === 'sent' && (msg.op === 'continue' || (msg.op && msg.op.startsWith && msg.op.startsWith('step')))) {
                    if (msg.op === 'step_in') lastActionWasStepIn = true;
                    else lastActionWasStepIn = false;
                    clearHighlight();
                    panel.webview.postMessage({ evt: 'status', paused: false });
                }
                if (panel) panel.webview.postMessage(msg);
            } catch (e) {
                if (panel) panel.webview.postMessage({ evt: 'raw', text: line });
            }
        }
    });
    bridge.stderr.on('data', (d) => {
        if (panel) panel.webview.postMessage({ evt: 'stderr', text: d.toString() });
    });
    bridge.on('close', () => {
        if (panel) panel.webview.postMessage({ evt: 'closed' });
        bridge = null;
    });

    panel.webview.onDidReceiveMessage((msg) => {
        if (!bridge) return;
        if (msg.op === 'set_bp_here') {
            let ed = vscode.window.activeTextEditor;
            if (!ed || !ed.document.fileName.endsWith('.py')) {
                // Webview has focus — fall back to any visible .py editor
                ed = vscode.window.visibleTextEditors.find(
                    e => e.document && e.document.fileName.endsWith('.py')
                );
            }
            if (!ed || !ed.document.fileName.endsWith('.py')) {
                panel.webview.postMessage({ evt: 'error', msg: 'open a .py file and click on a line first' });
                return;
            }
            const line1 = ed.selection.active.line + 1;
            const text = ed.document.getText();
            const info = findEnclosingFunction(text, line1);
            if (!info) {
                panel.webview.postMessage({ evt: 'error', msg: `no enclosing def at line ${line1}` });
                return;
            }
            const modName = path.basename(ed.document.fileName, '.py');
            const relLine = line1 - info.defLine;
            const key = `${modName}:${info.func}:${line1}`;
            const names = extractLocalNames(text, info.defLine, info.args);
            localNamesByFn.set(`${modName}:${info.func}`, names);
            pendingBpReplies.push({ key, fsPath: ed.document.fileName, line1, fnKey: `${modName}:${info.func}`, defLine: info.defLine });
            const out = { op: 'set_bp', module: modName, func: info.func, line: relLine };
            bridge.stdin.write(JSON.stringify(out) + '\n');
            panel.webview.postMessage({ evt: 'sent', op: `set_bp ${modName}.${info.func}:${line1} (rel=${relLine})` });
            return;
        }
        if (msg.op === 'flash_firmware') {
            vscode.commands.executeCommand('micropython-ide.flashDebugFirmware');
            return;
        }
        if (msg.op === 'goto_frame') {
            const tgt = msg.target; // { fsPath, line }
            if (tgt && tgt.fsPath) {
                vscode.workspace.openTextDocument(tgt.fsPath).then(doc => {
                    vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One }).then(ed => {
                        const r = new vscode.Range(Math.max(0, (tgt.line || 1) - 1), 0, Math.max(0, (tgt.line || 1) - 1), 0);
                        ed.revealRange(r, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                        ed.selection = new vscode.Selection(r.start, r.start);
                    });
                });
            }
            return;
        }
        bridge.stdin.write(JSON.stringify(msg) + '\n');
    });

    // Watch VS Code's own breakpoint list; on add/remove for .py files, translate
    // to (module, func, relative_line) and send to bridge.
    bpDisposable = vscode.debug.onDidChangeBreakpoints((ev) => {
        for (const bp of ev.added) {
            if (!(bp instanceof vscode.SourceBreakpoint)) continue;
            const loc = bp.location;
            const fsPath = loc.uri.fsPath;
            if (!fsPath.endsWith('.py')) continue;
            const line1 = loc.range.start.line + 1;
            try {
                const fs = require('fs');
                const text = fs.readFileSync(fsPath, 'utf8');
                const info = findEnclosingFunction(text, line1);
                if (!info) {
                    panel.webview.postMessage({ evt: 'error', msg: `no enclosing def for ${path.basename(fsPath)}:${line1}` });
                    continue;
                }
                const modName = path.basename(fsPath, '.py');
                const relLine = line1 - info.defLine;
                const key = `${modName}:${info.func}:${line1}`;
                const names = extractLocalNames(text, info.defLine, info.args);
                localNamesByFn.set(`${modName}:${info.func}`, names);
                const cond = (typeof bp.condition === 'string' && bp.condition.trim()) ? bp.condition.trim() : null;
                pendingBpReplies.push({ key, fsPath, line1, fnKey: `${modName}:${info.func}`, cond, defLine: info.defLine });
                const out = { op: 'set_bp', module: modName, func: info.func, line: relLine };
                bridge.stdin.write(JSON.stringify(out) + '\n');
                panel.webview.postMessage({ evt: 'sent', op: `set_bp ${key} rel=${relLine}${cond ? ' cond=' + cond : ''}` });
            } catch (e) {
                panel.webview.postMessage({ evt: 'error', msg: String(e) });
            }
        }
        for (const bp of ev.changed) {
            if (!(bp instanceof vscode.SourceBreakpoint)) continue;
            const fsPath = bp.location.uri.fsPath;
            if (!fsPath.endsWith('.py')) continue;
            const line1 = bp.location.range.start.line + 1;
            const cond = (typeof bp.condition === 'string' && bp.condition.trim()) ? bp.condition.trim() : null;
            for (const [ip, l] of ipToLoc.entries()) {
                if (l.fsPath === fsPath && l.line1 === line1) {
                    if (cond) ipToCond.set(ip, cond); else ipToCond.delete(ip);
                    panel.webview.postMessage({ evt: 'sent', op: `cond ${path.basename(fsPath)}:${line1} = ${cond || '(none)'}` });
                }
            }
        }
        for (const bp of ev.removed) {
            if (!(bp instanceof vscode.SourceBreakpoint)) continue;
            const fsPath = bp.location.uri.fsPath;
            if (!fsPath.endsWith('.py')) continue;
            const line1 = bp.location.range.start.line + 1;
            const modName = path.basename(fsPath, '.py');
            // We don't know func here w/o re-scan; try any matching key.
            for (const [k, slot] of bpSlotMap.entries()) {
                if (k.startsWith(`${modName}:`) && k.endsWith(`:${line1}`)) {
                    bridge.stdin.write(JSON.stringify({ op: 'clear_bp', slot }) + '\n');
                    bpSlotMap.delete(k);
                    // also drop any ipToCond and ipToLoc entries for this location
                    for (const [ip, l] of ipToLoc.entries()) {
                        if (l.fsPath === fsPath && l.line1 === line1) {
                            ipToCond.delete(ip);
                            ipToLoc.delete(ip);
                        }
                    }
                    break;
                }
            }
        }
    });

    panel.onDidDispose(() => {
        if (bpDisposable) { bpDisposable.dispose(); bpDisposable = null; }
        if (bridge) {
            try { bridge.stdin.write(JSON.stringify({ op: 'quit' }) + '\n'); } catch (e) {}
            bridge.kill();
            bridge = null;
        }
        panel = null;
    });
}

function runBackend(venvPython, backendScript, args) {
    return new Promise((resolve) => {
        const full = ['"' + backendScript + '"', '--python', '"' + venvPython + '"', ...args];
        const p = spawn('"' + venvPython + '"', full, { shell: true });
        let out = '', err = '';
        p.stdout.on('data', d => out += d.toString());
        p.stderr.on('data', d => err += d.toString());
        p.on('close', code => resolve({ code, out, err }));
    });
}

async function uploadDebuggerFiles(context, replPort, venvPython) {
    const dir = path.join(context.extensionPath, 'src', 'debugger_files');
    const backend = path.join(context.extensionPath, 'src', 'mps_backend.py');
    const files = ['dbgref.py', 'trace_pump.py', 'boot.py'];
    const out = vscode.window.createOutputChannel('MPy Debugger Setup');
    out.show(true);
    out.appendLine(`Uploading debugger files to ${replPort} via mps_backend...`);
    for (const f of files) {
        out.appendLine(`  upload ${f}`);
        const src = path.join(dir, f);
        const r = await runBackend(venvPython, backend, [
            'upload', '--port', replPort,
            '--source', '"' + src + '"',
            '--dest', '/', '--overwrite'
        ]);
        if (r.out) out.appendLine(r.out.trim());
        if (r.err) out.appendLine(r.err.trim());
        if (r.code !== 0) {
            vscode.window.showErrorMessage(`Failed to upload ${f}. See "MPy Debugger Setup" output.`);
            return false;
        }
    }
    out.appendLine('Files uploaded. Now:');
    out.appendLine('  1. Install usb-device-cdc using Package Install:');
    out.appendLine('  1. Open the Shell terminal');
    out.appendLine('  2. Reset the board (Ctrl-D in REPL) so boot.py runs');
    out.appendLine('  3. Type:  import trace_pump; trace_pump.start()');
    out.appendLine('Then come back and click Connect only -> Start.');
    return true;
}

async function startDebugger(context, gRemoteDevicePort, venvPython) {
    const replPort = gRemoteDevicePort && gRemoteDevicePort !== '-' ? gRemoteDevicePort : '';
    if (!replPort) {
        vscode.window.showWarningMessage('Connect a device first (Refresh Device Files).');
        return;
    }
    const pick = await vscode.window.showQuickPick(
        [
            { label: '$(cloud-upload) Upload debugger files', description: 'Copy boot.py, dbgref.py, trace_pump.py to device', id: 'upload' },
            { label: '$(plug) Connect only', description: 'Skip upload — device already set up', id: 'connect' },
        ],
        { placeHolder: `REPL port: ${replPort}` }
    );
    if (!pick) return;
    if (pick.id === 'upload') {
        const ok = await uploadDebuggerFiles(context, replPort, venvPython);
        if (!ok) return;
    }
    const port = await vscode.window.showInputBox({
        prompt: 'Debug CDC port (the SECOND COM port Windows shows for the board)',
        placeHolder: 'e.g. COM3',
    });
    if (!port) return;
    openDebuggerPanel(context, port);
}

function getHtml() {
    return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<style>
:root {
  --bg-app: #0f111a;
  --bg-card: #151824;
  --bg-card-hover: #1e2233;
  --bg-input: #0a0b10;
  --border-color: rgba(255, 255, 255, 0.08);
  --border-hover: rgba(99, 102, 241, 0.4);
  --border-focus: #6366f1;
  --text-main: #f1f5f9;
  --text-muted: #94a3b8;
  --accent-primary: #6366f1;
  --accent-primary-hover: #4f46e5;
  --accent-success: #10b981;
  --accent-warning: #f59e0b;
  --accent-error: #f43f5e;
  --accent-cyan: #06b6d4;
  --accent-purple: #d946ef;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-mono: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;
}

* { box-sizing: border-box; }
body {
  font-family: var(--font-sans);
  background: var(--bg-app);
  color: var(--text-main);
  margin: 0;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100vh;
  overflow: hidden;
}

/* Scrollbar Customization */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: var(--bg-app); }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }

/* Header & Status Indicator */
.header-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--border-color);
  padding-bottom: 12px;
}
.header-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-main);
  display: flex;
  align-items: center;
  gap: 8px;
}
.status-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  padding: 4px 10px;
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border-color);
  transition: all 0.3s ease;
}
.status-badge.running {
  color: var(--accent-success);
  border-color: rgba(16, 185, 129, 0.3);
  background: rgba(16, 185, 129, 0.06);
}
.status-badge.paused {
  color: var(--accent-warning);
  border-color: rgba(245, 158, 11, 0.3);
  background: rgba(245, 158, 11, 0.06);
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}
.status-badge.running .status-dot {
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
  70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }
  100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
}

/* Button & Controls Bar */
.controls-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  background: var(--bg-card);
  padding: 8px;
  border-radius: 8px;
  border: 1px solid var(--border-color);
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-main);
  border: 1px solid var(--border-color);
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 500;
  transition: all 0.2s;
}
.btn:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: var(--text-muted);
}
.btn:active {
  transform: scale(0.98);
}
.btn-control {
  border-color: rgba(99, 102, 241, 0.3);
  color: var(--text-main);
}
.btn-control:hover {
  background: rgba(99, 102, 241, 0.1);
  border-color: var(--accent-primary);
}
.btn-action {
  border-color: rgba(6, 182, 212, 0.3);
}
.btn-action:hover {
  background: rgba(6, 182, 212, 0.1);
  border-color: var(--accent-cyan);
}
.btn-system {
  margin-left: auto;
  border-color: rgba(245, 158, 11, 0.3);
}
.btn-system:hover {
  background: rgba(245, 158, 11, 0.1);
  border-color: var(--accent-warning);
}
.btn-clear {
  border-color: var(--border-color);
}
.btn-clear:hover {
  background: rgba(244, 63, 94, 0.1);
  border-color: var(--accent-error);
  color: var(--accent-error);
}
.btn-icon svg {
  width: 14px;
  height: 14px;
  display: block;
}

/* Dashboard Grid Layout */
.dashboard-grid {
  display: grid;
  grid-template-columns: 1.2fr 1fr;
  gap: 16px;
  flex: 1;
  min-height: 0;
}
@media (max-width: 800px) {
  .dashboard-grid {
    grid-template-columns: 1fr;
    overflow-y: auto;
  }
}

/* Terminal / Log Panel */
.panel-terminal {
  display: flex;
  flex-direction: column;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
}
.panel-terminal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: rgba(255, 255, 255, 0.02);
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-color);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
}
#log {
  flex: 1;
  padding: 12px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  overflow-y: auto;
  background: var(--bg-input);
  color: #c9d1d9;
  white-space: pre-wrap;
}

/* Cards & State Panels */
.panels-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
  min-height: 0;
}
.panel-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.panel-card h3 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-bottom: 1px solid var(--border-color);
  padding-bottom: 6px;
}
.panel-card-body {
  font-family: var(--font-mono);
  font-size: 11px;
  min-height: 40px;
}

/* Custom States / Output Classes */
.bp { color: var(--accent-warning); font-weight: 600; }
.reply { color: var(--accent-success); }
.err { color: var(--accent-error); font-weight: 600; }
.sent { color: var(--accent-primary); }
.rta { color: var(--accent-purple); font-weight: 500; }

/* Table Styling */
table {
  width: 100%;
  border-collapse: collapse;
}
td {
  padding: 6px 8px;
  border-bottom: 1px solid rgba(255,255,255,0.03);
  vertical-align: top;
}
td.k {
  color: var(--accent-primary);
  width: 90px;
  font-weight: 600;
}
td.v, td.vg {
  cursor: pointer;
  outline: none;
  transition: all 0.2s;
  border-radius: 4px;
}
td.v:hover, td.vg:hover {
  background: var(--bg-card-hover);
  color: var(--text-main);
}
td.v:focus, td.vg:focus {
  background: var(--bg-input);
  border: 1px solid var(--border-focus);
  cursor: text;
}

/* Inputs & Form styling */
.poke-form {
  display: grid;
  grid-template-columns: 1.2fr 1.5fr 0.6fr auto;
  gap: 8px;
  align-items: center;
}
.input-field {
  background: var(--bg-input);
  color: var(--text-main);
  border: 1px solid var(--border-color);
  padding: 6px 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  border-radius: 6px;
  width: 100%;
  transition: border-color 0.2s;
}
.input-field:hover { border-color: var(--border-hover); }
.input-field:focus { border-color: var(--border-focus); outline: none; }
</style>
</head><body>

<div class="header-bar">
  <div class="header-title">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
    MicroPython Bytecode Debugger
  </div>
  <div id="status" class="status-badge running">
    <span class="status-dot"></span>
    <span class="status-text">running</span>
  </div>
</div>

<div class="controls-bar" id="controls-container">
  <!-- Dynamic configuration-driven buttons will render here -->
</div>

<div class="dashboard-grid">
  <div class="panel-terminal">
    <div class="panel-terminal-header">
      <span>DEBUG CONSOLE / PORT LOG</span>
      <button class="btn btn-clear" style="padding: 2px 6px; font-size: 10px;" onclick="document.getElementById('log').innerHTML=''">Clear Log</button>
    </div>
    <div id="log"></div>
  </div>

  <div class="panels-container">
    <div id="panel-locals" class="panel-card">
      <h3>Locals / Frame</h3>
      <div id="locals-body" class="panel-card-body">(not paused)</div>
    </div>
    
    <div id="panel-globals" class="panel-card">
      <h3>Global Variables</h3>
      <div id="globals-body" class="panel-card-body">(not paused)</div>
    </div>
    
    <div id="panel-stack" class="panel-card">
      <h3>Call Stack</h3>
      <div id="stack-body" class="panel-card-body">(empty)</div>
    </div>

    <div id="panel-poke-global" class="panel-card">
      <h3>Poke Global Variable</h3>
      <div class="poke-form">
        <input type="text" id="poke-global-name" class="input-field" placeholder="Variable Name">
        <input type="text" id="poke-global-expr" class="input-field" placeholder="Expression (e.g. 42)">
        <input type="number" id="poke-global-depth" class="input-field" placeholder="Depth" value="0" title="Stack Frame Depth">
        <button class="btn btn-action" onclick="pokeGlobal()">Poke</button>
      </div>
    </div>
  </div>
</div>

<script>
const vscode = acquireVsCodeApi();

// Global HTML Escaper
const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const log = document.getElementById('log');
let currentNames = [];
const funNames = {};
let lastIp = 0;

// Configuration list of commands to enable modular scaling
const COMMANDS = [
  { op: 'continue', label: 'Continue', key: 'c', icon: 'play', category: 'control', desc: 'Resume script execution' },
  { op: 'step', label: 'Step Over', key: 's', icon: 'step-over', category: 'control', desc: 'Execute next statement' },
  { op: 'step_in', label: 'Step In', key: 'i', icon: 'step-in', category: 'control', desc: 'Step inside function call' },
  { op: 'step_out', label: 'Step Out', key: 'o', icon: 'step-out', category: 'control', desc: 'Step out of active function' },
  { op: 'locals', label: 'Locals', key: 'l', icon: 'locals', category: 'query', desc: 'Fetch local variables' },
  { op: 'globals', label: 'Globals', key: 'g', icon: 'globals', category: 'query', desc: 'Fetch global variables' },
  { op: 'call_stack', label: 'Call Stack', key: 'k', icon: 'stack', category: 'query', desc: 'Fetch debugger stack frame' },
  { op: 'rta_on', label: 'RTA On', key: 't', icon: 'rta-on', category: 'action', desc: 'Enable Real-time Analysis tracing' },
  { op: 'rta_off', label: 'RTA Off', key: 'y', icon: 'rta-off', category: 'action', desc: 'Disable Real-time Analysis tracing' },
  { op: 'set_bp_here', label: 'Set BP', icon: 'bp', category: 'action', desc: 'Add breakpoint at editor cursor' },
  { op: 'flash_firmware', label: 'Download Firmware', icon: 'flash', category: 'system', desc: 'Flash board debugger binary' }
];

// SVG Icons mapping
const ICONS = {
  'play': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3" fill="currentColor"/></svg>',
  'step-over': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>',
  'step-in': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>',
  'step-out': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  'locals': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/></svg>',
  'globals': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4 10 15.3 15.3 0 014-10M2 12h20"/></svg>',
  'stack': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  'rta-on': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/><circle cx="20" cy="8" r="2" fill="currentColor"/></svg>',
  'rta-off': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/><line x1="18" y1="6" x2="22" y2="10"/><line x1="22" y1="6" x2="18" y2="10"/></svg>',
  'bp': '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="12" r="8"/></svg>',
  'flash': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>'
};

// Render controls dynamically on startup
function renderButtons() {
  const container = document.getElementById('controls-container');
  container.innerHTML = '';
  COMMANDS.forEach(cmd => {
    const btn = document.createElement('button');
    btn.className = 'btn btn-' + cmd.category;
    btn.title = cmd.desc + (cmd.key ? ' (' + cmd.key + ')' : '');
    btn.onclick = () => send(cmd.op);

    const iconSpan = document.createElement('span');
    iconSpan.className = 'btn-icon';
    iconSpan.innerHTML = ICONS[cmd.icon] || '';

    const labelSpan = document.createElement('span');
    labelSpan.className = 'btn-label';
    labelSpan.textContent = cmd.label;

    btn.appendChild(iconSpan);
    btn.appendChild(labelSpan);
    container.appendChild(btn);
  });
}

// Global hotkey binding logic mapped to CONFIG commands
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.contentEditable === 'true') return;
  const match = COMMANDS.find(cmd => cmd.key === e.key);
  if (match) {
    e.preventDefault();
    send(match.op);
  }
});

function add(cls, text) {
  const line = document.createElement('div');
  line.className = cls;
  line.textContent = text;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function send(op) { vscode.postMessage({op}); }

function pokeGlobal() {
  const nameEl = document.getElementById('poke-global-name');
  const exprEl = document.getElementById('poke-global-expr');
  const depthEl = document.getElementById('poke-global-depth');
  const name = nameEl.value.trim();
  const expr = exprEl.value.trim();
  const depth = parseInt(depthEl.value || '0', 10);
  if (!name || !expr) {
    add('err', 'Poke Global: Name and Expression are required.');
    return;
  }
  vscode.postMessage({ op: 'poke_global', name: name, expr: expr, depth: depth });
  nameEl.value = '';
  exprEl.value = '';
}

document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[data-fun]');
  if (!a) return;
  e.preventDefault();
  const rec = funNames[a.getAttribute('data-fun')];
  if (rec && rec.fsPath) {
    vscode.postMessage({ op: 'goto_frame', target: { fsPath: rec.fsPath, line: rec.defLine } });
  }
});

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.evt === 'bp_hit') {
    add('bp', 'BP_HIT  ip=0x' + m.ip.toString(16).padStart(4,'0') + '  <<< paused');
    lastIp = m.ip;
  }
  else if (m.evt === 'no_source') {
    add('err', '⚠ ' + m.msg);
    document.getElementById('locals-body').innerHTML = '<div style="color:#ffa500;padding:8px;">⚠ No source file mapped for this location.<br>Use <b>Step-out (o)</b> to return to your code or <b>Continue (c)</b> to resume execution.</div>';
  }
  else if (m.evt === 'trace') add('', 'trace   ip=0x' + m.ip.toString(16).padStart(4,'0') + '  op=0x' + m.op.toString(16).padStart(2,'0'));
  else if (m.evt === 'rta_entry' || m.evt === 'rta_exit') {
    const isEntry = m.evt === 'rta_entry';
    const rec = funNames[m.fun];
    const fnName = rec ? rec.name : ('0x' + m.fun.toString(16));
    const dirIcon = isEntry ? '→ ENTER' : '← EXIT';
    const timeStr = m.ts + 'ms';
    add('rta', `RTA: ${dirIcon} ${fnName} at ${timeStr}`);
  }
  else if (m.evt === 'reply') {
    add('reply', 'REPLY  ' + m.text);
    
    // Parse globals
    const globIdx = m.text.indexOf("globals={");
    if (globIdx !== -1) {
      let str = m.text.slice(globIdx + 9);
      if (str.endsWith("}")) {
        str = str.slice(0, -1);
      }
      const g_dict = {};
      const re = /['"]([^'"]+)['"]\\s*:\\s*('(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*"|[^\\s,{}]+)/g;
      let match;
      while ((match = re.exec(str)) !== null) {
        const k = match[1];
        let v = match[2];
        if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
          v = v.slice(1, -1);
        }
        g_dict[k] = v;
      }
      let html = '<table>';
      const keys = Object.keys(g_dict).sort();
      keys.forEach(k => {
        const val = g_dict[k];
        html += '<tr><td class="k">' + k + '</td><td class="vg" contenteditable="true" data-name="' + k + '" data-val="' + val.replace(/"/g, '&quot;') + '">' + escapeHtml(val) + '</td></tr>';
      });
      html += '</table>';
      document.getElementById('globals-body').innerHTML = keys.length ? html : '(empty)';
    }

    const sm = m.text.match(/^stack=\\[(.*)\\]$/);
    if (sm) {
      const inner = sm[1];
      const frames = [];
      const re = /\\((\\d+),\\s*(\\d+)\\)/g;
      let mm;
      while ((mm = re.exec(inner)) !== null) frames.push({fun: mm[1], ip: parseInt(mm[2])});
      let html = '<table>';
      frames.forEach((f, i) => {
        const rec = funNames[f.fun];
        if (rec) {
          html += '<tr><td class="k">#' + i + '</td><td><a href="#" data-fun="' + f.fun + '" style="color:#88c0ff;text-decoration:underline">' + rec.name + '</a> <span style="color:#888">ip=0x' + f.ip.toString(16).padStart(4,'0') + '</span></td></tr>';
        } else {
          html += '<tr><td class="k">#' + i + '</td><td><span style="color:#888">fun=0x' + parseInt(f.fun).toString(16) + ' ip=0x' + f.ip.toString(16).padStart(4,'0') + '</span></td></tr>';
        }
      });
      html += '</table>';
      document.getElementById('stack-body').innerHTML = frames.length ? html : '(empty)';
    }
    const lm = m.text.match(/(?:frame=\\(([^)]+)\\)\\s+)?state=\\[(.*)\\]/);
    if (lm) {
      const state = (function(s){
        const out = []; let buf = ''; let q = null; let depth = 0;
        for (let i = 0; i < s.length; i++) {
          const c = s[i];
          if (q) { buf += c; if (c === q && s[i-1] !== '\\\\') q = null; continue; }
          if (c === "'" || c === '"') { q = c; buf += c; continue; }
          if (c === '[' || c === '(') { depth++; buf += c; continue; }
          if (c === ']' || c === ')') { depth--; buf += c; continue; }
          if (c === ',' && depth === 0) { out.push(buf.trim()); buf = ''; continue; }
          buf += c;
        }
        if (buf.trim()) out.push(buf.trim());
        return out;
      })(lm[2]);
      let n = state.length;
      let ipVal = lastIp;
      if (lm[1]) {
        const fr = lm[1].split(',').map(s => s.trim());
        n = parseInt(fr[0]);
        ipVal = parseInt(fr[2]);
      }
      let html = '<table>';
      html += '<tr><td class="k">ip</td><td>0x' + ipVal.toString(16).padStart(4,'0') + '</td></tr>';
      // locals: state[n-1-i] for local i
      for (let i = 0; i < currentNames.length; i++) {
        const idx = n - 1 - i;
        const val = (idx >= 0 && idx < state.length) ? state[idx] : '?';
        html += '<tr><td class="k">' + currentNames[i] + '</td><td class="v" contenteditable="true" data-slot="' + i + '" data-val="' + val.replace(/"/g, '&quot;') + '">' + escapeHtml(val) + '</td></tr>';
      }
      html += '<tr><td class="k">raw</td><td style="color:#888">[' + lm[2] + ']</td></tr>';
      html += '</table>';
      document.getElementById('locals-body').innerHTML = html;
    }
  }
  else if (m.evt === 'sent') add('sent', '→ ' + m.op);
  else if (m.evt === 'error') {
    add('err', 'ERR ' + m.msg);
    if (m.ip) lastIp = m.ip;
  }
  else if (m.evt === 'closed') add('err', '(bridge closed)');
  else if (m.evt === 'open') add('reply', 'connected to ' + m.port);
  else if (m.evt === 'names') { currentNames = m.names || []; }
  else if (m.evt === 'fun_name') { funNames[m.fun] = { name: m.name, fsPath: m.fsPath, defLine: m.defLine }; }
  else if (m.evt === 'status') {
    const el = document.getElementById('status');
    const badge = document.querySelector('.status-badge');
    const textEl = badge.querySelector('.status-text');
    if (m.paused) {
      textEl.textContent = 'paused';
      badge.className = 'status-badge paused';
    }
    else {
      textEl.textContent = 'running';
      badge.className = 'status-badge running';
      document.getElementById('locals-body').innerHTML = '(not paused)';
      document.getElementById('globals-body').innerHTML = '(not paused)';
    }
  }
  else add('', JSON.stringify(m));
});

// Setup dynamic elements on load
renderButtons();

document.addEventListener('keydown', (e) => {
  if (e.target.classList.contains('v')) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const slot = e.target.getAttribute('data-slot');
      const expr = e.target.textContent.trim();
      const oldVal = e.target.getAttribute('data-val');
      if (expr !== oldVal) {
        vscode.postMessage({ op: 'poke_local', slot: parseInt(slot, 10), expr: expr });
      }
      e.target.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.target.textContent = e.target.getAttribute('data-val');
      e.target.blur();
    }
  }
});
document.addEventListener('focusout', (e) => {
  if (e.target.classList.contains('v')) {
    const slot = e.target.getAttribute('data-slot');
    const expr = e.target.textContent.trim();
    const oldVal = e.target.getAttribute('data-val');
    if (expr !== oldVal) {
      vscode.postMessage({ op: 'poke_local', slot: parseInt(slot, 10), expr: expr });
    }
  }
});
document.addEventListener('keydown', (e) => {
  if (e.target.classList.contains('vg')) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const name = e.target.getAttribute('data-name');
      const expr = e.target.textContent.trim();
      const oldVal = e.target.getAttribute('data-val');
      if (expr !== oldVal) {
        vscode.postMessage({ op: 'poke_global', name: name, expr: expr, depth: 0 });
      }
      e.target.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.target.textContent = e.target.getAttribute('data-val');
      e.target.blur();
    }
  }
});
document.addEventListener('focusout', (e) => {
  if (e.target.classList.contains('vg')) {
    const name = e.target.getAttribute('data-name');
    const expr = e.target.textContent.trim();
    const oldVal = e.target.getAttribute('data-val');
    if (expr !== oldVal) {
      vscode.postMessage({ op: 'poke_global', name: name, expr: expr, depth: 0 });
    }
  }
});
document.getElementById('poke-global-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') pokeGlobal();
});
document.getElementById('poke-global-expr').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') pokeGlobal();
});
</script>
</body></html>`;
}

module.exports = { startDebugger };
