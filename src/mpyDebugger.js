// mpyDebugger.js — webview-based MicroPython bytecode debugger panel.
//
// Spawns src/dbg_bridge.py (pyserial) to talk to the debug CDC. The webview
// shows event log + buttons for continue/step/step-in/step-out/locals.

const vscode = require('vscode');
const path = require('path');
const { spawn } = require('child_process');
const wsQueue = require('./wsQueue');
const { getBuildInfo } = require('./buildInfo');

let panel = null;
let bridge = null;
let bpDisposable = null;
const bpSlotMap = new Map(); // key "module:func:line" -> Set<slot> (filled on reply)
const pendingBpReplies = []; // queue of {key, fsPath, line1, cancelled}
const ipToLoc = new Map();   // ip -> {fsPath, line1}
const ipToCond = new Map();  // ip -> condition string (optional)
let pendingCondEval = null;  // { ip, cond, names } while awaiting locals reply
let hlDeco = null;            // TextEditorDecorationType for current line (yellow — breakpoint)
let stepInDeco = null;        // TextEditorDecorationType for step-in line (cyan)
let lastActionWasStepIn = false; // tracks whether the last resume action was step_in

let rtaEvents = [];
let rtaDumpTimer = null;
const taskMap = new Map();
const funToName = new Map();

function scheduleRtaTraceDump() {
    if (rtaDumpTimer) clearTimeout(rtaDumpTimer);
    rtaDumpTimer = setTimeout(() => {
        rtaDumpTimer = null;
        dumpRtaTrace();
    }, 100);
}

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

function openDebuggerPanel(context, port, venvPython) {
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
    const buildInfo = getBuildInfo(context.extensionPath, context.extensionMode);
    panel.webview.html = getHtml(buildInfo);

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
    const pyCmd = venvPython || (process.platform === 'win32' ? 'python' : 'python3');
    const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0] ? vscode.workspace.workspaceFolders[0].uri.fsPath : '';
    bridge = spawn(pyCmd, [script, port, workspaceFolder], { stdio: ['pipe', 'pipe', 'pipe'] });

    function requestTaskMap() {
        const expr = 'g=globals();exec("import sys,machine\\nM=machine.mem32\\nq=sys.modules[\'asyncio\'].core._task_queue\\nt=[]\\nwhile q.peek():t.append(q.pop())\\n__t=\',\'.join(\'%d:%s\'%(M[id(x.coro)+8],x.coro) for x in t)\\nfor x in t:q.push(x,M[id(x)+20])",g) or g.get(\'__t\')';
        try {
            bridge.stdin.write(JSON.stringify({ op: 'poke_global', name: '__t', depth: 0, expr: expr }) + '\n');
            return true;
        } catch (e) {
            return false;
        }
    }

    let rtaSymRemaining = 0;

    function requestSymbolMap() {
        rtaSymRemaining = 0;
        try {
            bridge.stdin.write(JSON.stringify({
                op: 'poke_global',
                name: '__rta_sym_count',
                depth: 0,
                expr: "__import__('trace_pump').get_symmap()"
            }) + '\n');
            return true;
        } catch (e) {
            return false;
        }
    }

    function requestNextSymbolMapChunk() {
        try {
            bridge.stdin.write(JSON.stringify({
                op: 'poke_global',
                name: '__rta_sym_chunk',
                depth: 0,
                expr: "__import__('trace_pump').get_symmap_chunk()"
            }) + '\n');
            return true;
        } catch (e) {
            return false;
        }
    }

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
                            if (info.cancelled) {
                                // The IDE breakpoint was removed before the device finished
                                // registering it. Clear the late slot immediately so it can
                                // never become a ghost breakpoint on the target.
                                bridge.stdin.write(JSON.stringify({ op: 'clear_bp', slot }) + '\n');
                                panel.webview.postMessage({ evt: 'sent', op: `clear_bp slot=${slot} (late set reply)` });
                            } else {
                                let slots = bpSlotMap.get(info.key);
                                if (!slots) {
                                    slots = new Set();
                                    bpSlotMap.set(info.key, slots);
                                }
                                slots.add(slot);
                                ipToLoc.set(bpIp, { fsPath: info.fsPath, line1: info.line1, fnKey: info.fnKey });
                                if (info.cond) ipToCond.set(bpIp, info.cond);
                                if (m[6]) {
                                    const funPtr = m[6];
                                    funToName.set(parseInt(funPtr, 10), info.fnKey);
                                    panel.webview.postMessage({ evt: 'fun_name', fun: funPtr, name: info.fnKey, fsPath: info.fsPath, defLine: info.defLine });
                                }
                            }
                        }
                    } else if (msg.text.startsWith("poked global __rta_sym_count")) {
                        const eqIdx = msg.text.indexOf("=");
                        if (eqIdx !== -1) {
                            let countText = msg.text.slice(eqIdx + 1).trim();
                            if ((countText.startsWith("'") && countText.endsWith("'")) ||
                                (countText.startsWith('"') && countText.endsWith('"'))) {
                                countText = countText.slice(1, -1);
                            }
                            rtaSymRemaining = parseInt(countText, 10) || 0;
                            if (rtaSymRemaining > 0) requestNextSymbolMapChunk();
                        }
                    } else if (msg.text.startsWith("poked global __rta_sym_chunk")) {
                        const eqIdx = msg.text.indexOf("=");
                        if (eqIdx !== -1) {
                            let mapText = msg.text.slice(eqIdx + 1).trim();
                            if ((mapText.startsWith("'") && mapText.endsWith("'")) ||
                                (mapText.startsWith('"') && mapText.endsWith('"'))) {
                                mapText = mapText.slice(1, -1);
                            }
                            let parsed = 0;
                            if (mapText && mapText !== "None") {
                                for (const item of mapText.split(",")) {
                                    const sm = item.trim().match(/^(\d+):object '([^']+)'$/);
                                    if (!sm) continue;
                                    const funPtr = parseInt(sm[1], 10);
                                    const funName = sm[2];
                                    funToName.set(funPtr, funName);
                                    panel.webview.postMessage({ evt: 'rta_name', fun: funPtr, name: funName, kind: 'function' });
                                    parsed += 1;
                                }
                            }
                            rtaSymRemaining = Math.max(0, rtaSymRemaining - parsed);
                            if (rtaSymRemaining > 0 && mapText !== "None") {
                                requestNextSymbolMapChunk();
                            }
                        }
                    } else if (msg.text.startsWith("poked global __t")) {
                        const eqIdx = msg.text.indexOf("=");
                        if (eqIdx !== -1) {
                            let valStr = msg.text.slice(eqIdx + 1).trim();
                            if (valStr.startsWith("'") || valStr.startsWith('"')) {
                                valStr = valStr.slice(1, -1);
                            }
                            if (valStr && valStr !== "no_asyncio") {
                                const chunks = valStr.split(",");
                                for (const chunk of chunks) {
                                    if (chunk.includes(":")) {
                                        const [addrStr, genStr] = chunk.split(":", 2);
                                        const funBc = parseInt(addrStr, 10);
                                        if (!isNaN(funBc)) {
                                            const m1 = genStr.match(/object '([^']+)'/);
                                            let taskName;
                                            if (m1) {
                                                taskName = m1[1];
                                            } else {
                                                const m2 = genStr.match(/object ([^\s]+)/);
                                                taskName = m2 ? m2[1] : "task";
                                            }
                                            taskMap.set(funBc, taskName);
                                            panel.webview.postMessage({ evt: 'rta_name', fun: funBc, name: taskName, kind: 'task' });
                                        }
                                    }
                                }
                            }
                        }
                    } else {
                        const mFail = msg.text.match(/^no code on (.*)\.([^\s]+) line (\d+)/);
                        if (mFail) {
                            popPendingBp(mFail[1], mFail[2], parseInt(mFail[3], 10));
                        }
                    }
                }
                if (msg.evt === 'step_line') {
                    highlightLine(msg.file, msg.line, lastActionWasStepIn);
                    lastActionWasStepIn = false;
                    panel.webview.postMessage({ evt: 'status', paused: true });
                    try { bridge.stdin.write(JSON.stringify({ op: 'locals' }) + '\n'); } catch (e) {}
                    try { bridge.stdin.write(JSON.stringify({ op: 'globals' }) + '\n'); } catch (e) {}
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
                if (msg.evt === 'reply' && typeof msg.text === 'string') {
                    if (msg.text === 'RTA trace enabled') {
                        if (rtaDumpTimer) {
                            clearTimeout(rtaDumpTimer);
                            rtaDumpTimer = null;
                        }
                        rtaEvents = [];
                        taskMap.clear();
                        requestTaskMap();
                        requestSymbolMap();
                        if (panel) panel.webview.postMessage({ evt: 'rta_status', enabled: true });
                    } else if (msg.text === 'RTA trace disabled') {
                        if (panel) panel.webview.postMessage({ evt: 'rta_status', enabled: false });
                        scheduleRtaTraceDump();
                    } else if (msg.text.startsWith('RTA unsupported by firmware:')) {
                        if (panel) {
                            panel.webview.postMessage({ evt: 'rta_status', enabled: false });
                            panel.webview.postMessage({ evt: 'error', msg: msg.text });
                        }
                        vscode.window.showWarningMessage(msg.text);
                    }
                }
                if (msg.evt === 'rta_entry') {
                    rtaEvents.push({
                        name: `fun_0x${msg.fun.toString(16).toUpperCase()}`,
                        ph: "B",
                        ts: msg.ts,
                        pid: 1,
                        tid: 1
                    });
                    if (rtaDumpTimer) scheduleRtaTraceDump();
                }
                if (msg.evt === 'rta_exit') {
                    rtaEvents.push({
                        name: `fun_0x${msg.fun.toString(16).toUpperCase()}`,
                        ph: "E",
                        ts: msg.ts,
                        pid: 1,
                        tid: 1
                    });
                    if (rtaDumpTimer) scheduleRtaTraceDump();
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
        if (msg.op === 'tasks') {
            const expr = 'g=globals();exec("import sys,machine\\nM=machine.mem32\\nq=sys.modules[\'asyncio\'].core._task_queue\\nt=[]\\nwhile q.peek():t.append(q.pop())\\n__t=\',\'.join(str(x.coro) for x in t)\\nfor x in t:q.push(x,M[id(x)+20])",g) or g.get(\'__t\')';
            bridge.stdin.write(JSON.stringify({ op: 'poke_local', slot: 0, depth: 0, expr: expr }) + '\n');
            panel.webview.postMessage({ evt: 'sent', op: 'tasks' });
            return;
        }
        if (msg.op === 'rta_resolve_names') {
            const taskOk = requestTaskMap();
            const symbolOk = requestSymbolMap();
            if (taskOk || symbolOk) {
                panel.webview.postMessage({ evt: 'sent', op: 'RTA name refresh' });
            }
            return;
        }
        if (msg.op === 'taskmap') {
            if (requestTaskMap()) {
                panel.webview.postMessage({ evt: 'sent', op: 'taskmap' });
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

            // First cancel every set request for this source location that has
            // not received its device slot yet. Its late reply will be cleared
            // immediately in the reply handler above.
            const keysToClear = new Set();
            for (const pending of pendingBpReplies) {
                if (pending.fsPath === fsPath && pending.line1 === line1) {
                    pending.cancelled = true;
                    keysToClear.add(pending.key);
                }
            }

            // Also collect every already-registered key at this location.
            // A Set of slots is used because duplicate set requests must not
            // leave an older target slot behind.
            for (const k of bpSlotMap.keys()) {
                if (k.startsWith(`${modName}:`) && k.endsWith(`:${line1}`)) {
                    keysToClear.add(k);
                }
            }

            for (const key of keysToClear) {
                const slots = bpSlotMap.get(key);
                if (slots) {
                    for (const slot of slots) {
                        bridge.stdin.write(JSON.stringify({ op: 'clear_bp', slot }) + '\n');
                        panel.webview.postMessage({ evt: 'sent', op: `clear_bp slot=${slot} ${key}` });
                    }
                    bpSlotMap.delete(key);
                }
            }

            // Drop host-side source/condition mappings even when the set reply
            // is still pending. This keeps the IDE state authoritative.
            for (const [ip, l] of ipToLoc.entries()) {
                if (l.fsPath === fsPath && l.line1 === line1) {
                    ipToCond.delete(ip);
                    ipToLoc.delete(ip);
                }
            }
        }
    });

    panel.onDidDispose(() => {
        if (bpDisposable) { bpDisposable.dispose(); bpDisposable = null; }
        if (rtaEvents.length > 0) {
            dumpRtaTrace();
        }
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
        const full = [backendScript, '--python', venvPython, ...args];
        const p = spawn(venvPython, full);
        let out = '', err = '';
        let settled = false;
        const finish = (code) => {
            if (settled) return;
            settled = true;
            resolve({ code, out, err });
        };
        p.stdout.on('data', d => out += d.toString());
        p.stderr.on('data', d => err += d.toString());
        p.on('error', e => {
            err += e.message;
            finish(null);
        });
        p.on('close', finish);
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
        const r = await wsQueue.run(() => runBackend(venvPython, backend, [
            'upload', '--port', replPort,
            '--source', src,
            '--dest', '/', '--overwrite'
        ]), `Upload debugger file ${f}`);
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
    openDebuggerPanel(context, port, venvPython);
}

function getHtml(buildInfo) {
    const rawBuildDate = String(buildInfo?.buildDate || 'unknown');
    const buildDate = rawBuildDate === 'development'
        ? 'development'
        : rawBuildDate.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
    const safeVersion = String(buildInfo?.version || 'unknown').replace(/[^0-9A-Za-z._+-]/g, '');
    const safeCommit = String(buildInfo?.commitShort || 'unknown').replace(/[^0-9A-Za-z._-]/g, '');
    const safeBuildDate = buildDate.replace(/[^0-9A-Za-z:._+\- Z]/g, '');
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
.header-title-wrap {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.build-identity {
  font-family: var(--font-mono);
  font-size: 9px;
  color: #64748b;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
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
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  transform: none;
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

/* Live RTA Viewer */
.rta-viewer {
  background: linear-gradient(180deg, rgba(217,70,239,0.06), rgba(21,24,36,0.92));
  border: 1px solid rgba(217,70,239,0.22);
  border-radius: 10px;
  overflow: hidden;
}
.rta-viewer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-color);
  background: rgba(255,255,255,0.02);
}
.rta-title-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.rta-title {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #f5d0fe;
}
.rta-live-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: 999px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  color: var(--text-muted);
  border: 1px solid var(--border-color);
  background: rgba(255,255,255,0.03);
}
.rta-live-badge.on {
  color: #86efac;
  border-color: rgba(34,197,94,0.35);
  background: rgba(34,197,94,0.08);
}
.rta-live-badge.on::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 8px rgba(34,197,94,0.8);
}
.rta-viewer-actions {
  display: flex;
  gap: 6px;
}
.rta-kpis {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  background: var(--border-color);
  border-bottom: 1px solid var(--border-color);
}
.rta-kpi {
  min-width: 0;
  background: var(--bg-card);
  padding: 9px 12px;
}
.rta-kpi-label {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--text-muted);
  text-transform: uppercase;
}
.rta-kpi-value {
  margin-top: 3px;
  font-family: var(--font-mono);
  font-size: 14px;
  color: var(--text-main);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rta-table-wrap {
  max-height: 260px;
  overflow: auto;
  background: var(--bg-input);
}
.rta-table {
  min-width: 900px;
  font-family: var(--font-mono);
  font-size: 10px;
}
.rta-table th {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 7px 8px;
  text-align: left;
  color: var(--text-muted);
  background: #11131d;
  border-bottom: 1px solid var(--border-color);
  font-size: 9px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.rta-table td {
  padding: 6px 8px;
  border-bottom: 1px solid rgba(255,255,255,0.035);
  white-space: nowrap;
}
.rta-table tbody tr:hover {
  background: rgba(255,255,255,0.025);
}
.rta-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.rta-state-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #475569;
}
.rta-state-dot.active {
  background: #22c55e;
  box-shadow: 0 0 7px rgba(34,197,94,0.75);
}
.rta-state-dot.idle {
  background: #64748b;
}
.rta-kind {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 999px;
  border: 1px solid rgba(99,102,241,0.25);
  color: #a5b4fc;
  font-size: 9px;
}
.rta-kind.task {
  border-color: rgba(6,182,212,0.3);
  color: #67e8f9;
}
.rta-name-cell {
  color: #e2e8f0;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rta-load {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 120px;
}
.rta-load-track {
  width: 72px;
  height: 5px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(255,255,255,0.08);
}
.rta-load-fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #8b5cf6, #d946ef);
}
.rta-load-text {
  width: 42px;
  text-align: right;
  color: #e9d5ff;
}
.rta-empty {
  padding: 18px !important;
  text-align: center;
  color: var(--text-muted);
}
.rta-note {
  padding: 7px 12px;
  color: #64748b;
  font-size: 9px;
  line-height: 1.4;
  border-top: 1px solid var(--border-color);
  background: rgba(255,255,255,0.015);
}
@media (max-width: 800px) {
  .rta-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rta-viewer-header { align-items: flex-start; flex-direction: column; }
}

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
  <div class="header-title-wrap">
    <div class="header-title">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
      MicroPython Bytecode Debugger
    </div>
    <div class="build-identity">Studio v${safeVersion} · Build ${safeBuildDate} · Commit ${safeCommit}</div>
  </div>
  <div class="header-right">
    <div id="status" class="status-badge running">
      <span class="status-dot"></span>
      <span class="status-text">running</span>
    </div>
  </div>
</div>

<div class="controls-bar" id="controls-container">
  <!-- Dynamic configuration-driven buttons will render here -->
</div>

<div id="rta-viewer" class="rta-viewer">
  <div class="rta-viewer-header">
    <div class="rta-title-wrap">
      <span class="rta-title">LIVE RTA · TASK / FUNCTION VIEWER</span>
      <span id="rta-live-badge" class="rta-live-badge">OFF</span>
    </div>
    <div class="rta-viewer-actions">
      <button class="btn btn-action" style="padding:4px 8px" onclick="send('rta_resolve_names')" title="Refresh asyncio task and function names">Refresh Names</button>
      <button class="btn btn-clear" style="padding:4px 8px" onclick="resetRtaProfiler()" title="Clear local RTA statistics">Reset Stats</button>
    </div>
  </div>
  <div class="rta-kpis">
    <div class="rta-kpi"><div class="rta-kpi-label">Events</div><div id="rta-kpi-events" class="rta-kpi-value">0</div></div>
    <div class="rta-kpi"><div class="rta-kpi-label">Functions / Tasks</div><div id="rta-kpi-functions" class="rta-kpi-value">0</div></div>
    <div class="rta-kpi"><div class="rta-kpi-label">Trace Span</div><div id="rta-kpi-span" class="rta-kpi-value">—</div></div>
    <div class="rta-kpi"><div class="rta-kpi-label">Highest Runtime</div><div id="rta-kpi-hot" class="rta-kpi-value">—</div></div>
  </div>
  <div class="rta-table-wrap">
    <table class="rta-table">
      <thead>
        <tr>
          <th>State</th>
          <th>Task / Function</th>
          <th>Type</th>
          <th>Activations</th>
          <th>Runtime %</th>
          <th>Total</th>
          <th>Average</th>
          <th>Max</th>
          <th>Last</th>
        </tr>
      </thead>
      <tbody id="rta-table-body">
        <tr><td class="rta-empty" colspan="9">RTA is off. Click RTA On to begin live profiling.</td></tr>
      </tbody>
    </table>
  </div>
  <div class="rta-note">Firmware timestamps are microseconds. Runtime % is the share of observed exclusive RTA time; it is not claimed as exact scheduler CPU% until the firmware emits scheduler task-switch/idle events.</div>
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
let rtaEnabled = false;
const rtaProfiles = new Map();
const rtaNames = new Map();
const rtaStack = [];
let rtaEventCount = 0;
let rtaFirstTs = null;
let rtaLastTs = null;
let rtaRenderTimer = null;

// Configuration list of commands to enable modular scaling
const COMMANDS = [
  { op: 'continue', label: 'Continue', key: 'c', icon: 'play', category: 'control', desc: 'Resume script execution' },
  { op: 'step', label: 'Step Over', key: 's', icon: 'step-over', category: 'control', desc: 'Execute next statement' },
  { op: 'step_in', label: 'Step In', key: 'i', icon: 'step-in', category: 'control', desc: 'Step inside function call' },
  { op: 'step_out', label: 'Step Out', key: 'o', icon: 'step-out', category: 'control', desc: 'Step out of active function' },
  { op: 'locals', label: 'Locals', key: 'l', icon: 'locals', category: 'query', desc: 'Fetch local variables' },
  { op: 'globals', label: 'Globals', key: 'g', icon: 'globals', category: 'query', desc: 'Fetch global variables' },
  { op: 'call_stack', label: 'Call Stack', key: 'k', icon: 'stack', category: 'query', desc: 'Fetch debugger stack frame' },
  { op: 'tasks', label: 'Tasks', icon: 'stack', category: 'query', desc: 'Query running asyncio tasks' },
  { op: 'taskmap', label: 'Task Map', icon: 'globals', category: 'query', desc: 'Map asyncio task pointers to names' },
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
    btn.dataset.op = cmd.op;
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

function updateRtaControls(enabled) {
  rtaEnabled = !!enabled;
  const onBtn = document.querySelector('button[data-op="rta_on"]');
  const offBtn = document.querySelector('button[data-op="rta_off"]');
  const badge = document.getElementById('rta-live-badge');
  if (onBtn) onBtn.disabled = rtaEnabled;
  if (offBtn) offBtn.disabled = !rtaEnabled;
  if (badge) {
    badge.textContent = rtaEnabled ? 'LIVE' : 'OFF';
    badge.className = rtaEnabled ? 'rta-live-badge on' : 'rta-live-badge';
  }
}

function rtaTsDiff(end, start) {
  const e = Number(end) >>> 0;
  const s = Number(start) >>> 0;
  return e >= s ? (e - s) : (0x100000000 - s + e);
}

function formatRtaTime(value) {
  const us = Number(value) || 0;
  if (us >= 1000000) return (us / 1000000).toFixed(us >= 10000000 ? 1 : 2) + ' s';
  if (us >= 1000) return (us / 1000).toFixed(us >= 100000 ? 1 : 2) + ' ms';
  if (us >= 100) return us.toFixed(0) + ' µs';
  if (us >= 10) return us.toFixed(1) + ' µs';
  return us.toFixed(2) + ' µs';
}

function setRtaName(fun, name, kind) {
  const key = String(fun);
  const existing = rtaNames.get(key);
  const next = {
    name: name || (existing && existing.name) || ('0x' + Number(fun).toString(16)),
    kind: ((existing && existing.kind === 'task') || kind === 'task')
      ? 'task'
      : (kind || (existing && existing.kind) || 'function')
  };
  rtaNames.set(key, next);
  const profile = rtaProfiles.get(key);
  if (profile) {
    profile.name = next.name;
    profile.kind = next.kind;
  }
  scheduleRtaRender();
}

function getRtaProfile(fun) {
  const key = String(fun);
  let profile = rtaProfiles.get(key);
  if (!profile) {
    const named = rtaNames.get(key);
    profile = {
      fun: Number(fun),
      name: named ? named.name : ('0x' + Number(fun).toString(16)),
      kind: named ? named.kind : 'function',
      calls: 0,
      totalExclusive: 0,
      totalInclusive: 0,
      max: 0,
      last: 0,
      lastTs: 0
    };
    rtaProfiles.set(key, profile);
  }
  return profile;
}

function resetRtaProfiler() {
  rtaProfiles.clear();
  rtaStack.length = 0;
  rtaEventCount = 0;
  rtaFirstTs = null;
  rtaLastTs = null;
  renderRtaProfiler();
}

function scheduleRtaRender() {
  if (rtaRenderTimer) return;
  rtaRenderTimer = setTimeout(() => {
    rtaRenderTimer = null;
    renderRtaProfiler();
  }, 100);
}

function handleRtaEvent(m) {
  rtaEventCount += 1;
  if (rtaFirstTs === null) rtaFirstTs = Number(m.ts) >>> 0;
  rtaLastTs = Number(m.ts) >>> 0;

  if (m.evt === 'rta_entry') {
    getRtaProfile(m.fun);
    rtaStack.push({ fun: Number(m.fun), start: Number(m.ts) >>> 0, childTime: 0 });
    scheduleRtaRender();
    return;
  }

  let matchIndex = -1;
  for (let i = rtaStack.length - 1; i >= 0; i--) {
    if (rtaStack[i].fun === Number(m.fun)) {
      matchIndex = i;
      break;
    }
  }
  if (matchIndex < 0) {
    scheduleRtaRender();
    return;
  }

  const frame = rtaStack[matchIndex];
  const duration = rtaTsDiff(m.ts, frame.start);
  const exclusive = Math.max(0, duration - frame.childTime);

  // Drop the matched frame plus any malformed deeper frames. Normal traces
  // always match the top frame; this keeps the viewer resilient to loss.
  rtaStack.splice(matchIndex);

  if (rtaStack.length > 0) {
    rtaStack[rtaStack.length - 1].childTime += duration;
  }

  const profile = getRtaProfile(m.fun);
  profile.calls += 1;
  profile.totalExclusive += exclusive;
  profile.totalInclusive += duration;
  profile.last = duration;
  profile.max = Math.max(profile.max, duration);
  profile.lastTs = Number(m.ts) >>> 0;
  scheduleRtaRender();
}

function isRtaActive(fun) {
  const n = Number(fun);
  for (let i = rtaStack.length - 1; i >= 0; i--) {
    if (rtaStack[i].fun === n) return true;
  }
  return false;
}

function renderRtaProfiler() {
  const body = document.getElementById('rta-table-body');
  if (!body) return;

  const profiles = Array.from(rtaProfiles.values());
  const totalExclusive = profiles.reduce((sum, p) => sum + p.totalExclusive, 0);
  profiles.sort((a, b) =>
    (b.totalExclusive - a.totalExclusive) ||
    (b.max - a.max) ||
    (b.calls - a.calls)
  );

  document.getElementById('rta-kpi-events').textContent = String(rtaEventCount);
  document.getElementById('rta-kpi-functions').textContent = String(profiles.length);
  document.getElementById('rta-kpi-span').textContent =
    (rtaFirstTs !== null && rtaLastTs !== null) ? formatRtaTime(rtaTsDiff(rtaLastTs, rtaFirstTs)) : '—';
  document.getElementById('rta-kpi-hot').textContent = profiles.length ? profiles[0].name : '—';

  if (!profiles.length) {
    body.innerHTML = '<tr><td class="rta-empty" colspan="9">' +
      (rtaEnabled ? 'Waiting for RTA function activity…' : 'RTA is off. Click RTA On to begin live profiling.') +
      '</td></tr>';
    return;
  }

  let html = '';
  const visible = profiles.slice(0, 60);
  for (const p of visible) {
    const active = isRtaActive(p.fun);
    const pct = totalExclusive > 0 ? (p.totalExclusive * 100 / totalExclusive) : 0;
    const avg = p.calls > 0 ? (p.totalInclusive / p.calls) : 0;
    html += '<tr>' +
      '<td><span class="rta-state"><span class="rta-state-dot ' + (active ? 'active' : 'idle') + '"></span>' + (active ? 'ACTIVE' : 'IDLE') + '</span></td>' +
      '<td class="rta-name-cell" title="' + escapeHtml(p.name) + '">' + escapeHtml(p.name) + '</td>' +
      '<td><span class="rta-kind ' + (p.kind === 'task' ? 'task' : '') + '">' + (p.kind === 'task' ? 'TASK' : 'FUNC') + '</span></td>' +
      '<td>' + p.calls + '</td>' +
      '<td><div class="rta-load"><div class="rta-load-track"><div class="rta-load-fill" style="width:' + Math.min(100, pct).toFixed(1) + '%"></div></div><span class="rta-load-text">' + pct.toFixed(1) + '%</span></div></td>' +
      '<td>' + formatRtaTime(p.totalInclusive) + '</td>' +
      '<td>' + formatRtaTime(avg) + '</td>' +
      '<td>' + formatRtaTime(p.max) + '</td>' +
      '<td>' + formatRtaTime(p.last) + '</td>' +
      '</tr>';
  }
  if (profiles.length > visible.length) {
    html += '<tr><td class="rta-empty" colspan="9">Showing top ' + visible.length + ' of ' + profiles.length + ' by observed runtime.</td></tr>';
  }
  body.innerHTML = html;
}

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
    handleRtaEvent(m);
  }
  else if (m.evt === 'reply') {
    // Locals/globals replies feed the dedicated panels; do not duplicate large
    // internal state dictionaries in the Debug Console.
    const isPanelDataReply = /^depth=\d+\s+(?:state=\[|globals=\{)/.test(m.text);
    if (!isPanelDataReply) {
      add('reply', 'REPLY  ' + m.text);
    }
    
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
  else if (m.evt === 'rta_status') {
    if (m.enabled) {
      resetRtaProfiler();
    } else {
      // Firmware stops emission before it can safely close the final segment
      // from the pump core. Drop only the live stack; keep completed statistics.
      rtaStack.length = 0;
    }
    updateRtaControls(m.enabled);
    renderRtaProfiler();
    add('rta', m.enabled ? 'RTA: ON (device confirmed)' : 'RTA: OFF (device confirmed)');
  }
  else if (m.evt === 'sent') add('sent', '→ ' + m.op);
  else if (m.evt === 'error') {
    add('err', 'ERR ' + m.msg);
    if (m.ip) lastIp = m.ip;
  }
  else if (m.evt === 'closed') add('err', '(bridge closed)');
  else if (m.evt === 'open') add('reply', 'connected to ' + m.port);
  else if (m.evt === 'names') { currentNames = m.names || []; }
  else if (m.evt === 'rta_name') { setRtaName(m.fun, m.name, m.kind || 'task'); }
  else if (m.evt === 'fun_name') {
    funNames[m.fun] = { name: m.name, fsPath: m.fsPath, defLine: m.defLine };
    setRtaName(m.fun, m.name, 'function');
  }
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
updateRtaControls(false);
renderRtaProfiler();

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

function dumpRtaTrace() {
    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceFolder) return;
        const filePath = path.join(workspaceFolder, 'rta_trace.json');
        
        let currentTid = 1;
        let nextTid = 2;
        const taskTidMap = new Map();
        
        // Deep copy rtaEvents
        const events = JSON.parse(JSON.stringify(rtaEvents));
        
        for (const ev of events) {
            if (ev.ph === "B" || ev.ph === "E") {
                let funPtr = -1;
                if (ev.name.startsWith("fun_0x")) {
                    funPtr = parseInt(ev.name.replace("fun_0x", ""), 16);
                }
                
                if (ev.ph === "B") {
                    if (taskMap.has(funPtr)) {
                        if (!taskTidMap.has(funPtr)) {
                            taskTidMap.set(funPtr, nextTid);
                            nextTid++;
                        }
                        currentTid = taskTidMap.get(funPtr);
                    }
                    ev.tid = currentTid;
                } else if (ev.ph === "E") {
                    ev.tid = currentTid;
                    if (taskMap.has(funPtr)) {
                        currentTid = 1; // Return to scheduler
                    }
                }
                
                // Resolve name
                if (funToName.has(funPtr)) {
                    ev.name = funToName.get(funPtr);
                } else if (taskMap.has(funPtr)) {
                    ev.name = taskMap.get(funPtr);
                }
            }
        }
        
        // Inject metadata for threads (similar to python insert(0, ...))
        const metadata = [];
        for (const [funPtr, tid] of taskTidMap.entries()) {
            const name = taskMap.get(funPtr) || `task_0x${funPtr.toString(16)}`;
            metadata.push({
                name: "thread_name",
                ph: "M",
                pid: 1,
                tid: tid,
                args: { name: name }
            });
        }
        
        const finalEvents = [...metadata, ...events];
        
        const fs = require('fs');
        fs.writeFileSync(filePath, JSON.stringify(finalEvents, null, 2));
        vscode.window.showInformationMessage(`Saved ${finalEvents.length} RTA events to rta_trace.json`);
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to save RTA events: ${err}`);
    }
}

module.exports = { startDebugger };
