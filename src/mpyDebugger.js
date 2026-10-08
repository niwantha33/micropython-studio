// mpyDebugger.js — webview-based MicroPython bytecode debugger panel.
//
// Spawns src/dbg_bridge.py (pyserial) to talk to the debug CDC. The webview
// shows event log + buttons for continue/step/step-in/step-out/locals.

const vscode = require('vscode');
const path = require('path');
const { spawn } = require('child_process');
const { getBuildInfo } = require('./buildInfo');

const REQUIRED_PUMP_PROTOCOL = 5;
const REQUIRED_PUMP_BUILD = '2026-10-07-rta-viewer-v5';

let panel = null;
let bridge = null;
let bpDisposable = null;
const bpSlotMap = new Map(); // key "module:func:line" -> Set<slot> (filled on reply)
const pendingBpReplies = []; // queue of {key, fsPath, line1, cancelled}
const bpHitLocMap = new Map(); // "funPtr:ip" -> {fsPath,line1,fnKey,ip,fun,cond}
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
function resolveBreakpointRecord(fun, ip) {
    if (fun !== undefined && fun !== null) {
        const exact = bpHitLocMap.get(`${Number(fun)}:${Number(ip)}`);
        if (exact) return exact;
    }
    // Legacy firmware reports only ip. Use it only when exactly one active
    // source breakpoint has that offset; otherwise the hit is ambiguous.
    const matches = [];
    for (const rec of bpHitLocMap.values()) {
        if (rec.ip === Number(ip)) matches.push(rec);
    }
    return matches.length === 1 ? matches[0] : null;
}

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

    // A new debugger session owns the target breakpoint table, but target
    // commands are not sent until the SECOND COM/debug CDC has opened and the
    // pump answers our clear-all handshake.
    bpSlotMap.clear();
    pendingBpReplies.length = 0;
    bpHitLocMap.clear();
    localNamesByFn.clear();
    let sessionReady = false;
    let pumpVerified = false;
    let legacyPump = false;
    let supportsListBp = false;
    let rtaSupported = null;
    let startupTimer = null;
    let targetBreakpointList = [];

    function getBreakpointInfo(bp) {
        if (!(bp instanceof vscode.SourceBreakpoint)) return null;
        const fsPath = bp.location.uri.fsPath;
        if (!fsPath.endsWith('.py')) return null;
        const line1 = bp.location.range.start.line + 1;
        try {
            const fs = require('fs');
            const text = fs.readFileSync(fsPath, 'utf8');
            const fn = findEnclosingFunction(text, line1);
            if (!fn) {
                return {
                    bp, fsPath, line1,
                    file: path.basename(fsPath),
                    module: path.basename(fsPath, '.py'),
                    func: '(no enclosing def)',
                    fnKey: '',
                    defLine: null,
                    relLine: null,
                    key: `${path.basename(fsPath, '.py')}:?:${line1}`,
                    names: [],
                    enabled: bp.enabled !== false,
                    cond: (typeof bp.condition === 'string' && bp.condition.trim()) ? bp.condition.trim() : null
                };
            }
            const module = path.basename(fsPath, '.py');
            const key = `${module}:${fn.func}:${line1}`;
            return {
                bp, fsPath, line1,
                file: path.basename(fsPath),
                module,
                func: fn.func,
                fnKey: `${module}:${fn.func}`,
                defLine: fn.defLine,
                relLine: line1 - fn.defLine,
                key,
                names: extractLocalNames(text, fn.defLine, fn.args),
                enabled: bp.enabled !== false,
                cond: (typeof bp.condition === 'string' && bp.condition.trim()) ? bp.condition.trim() : null
            };
        } catch (e) {
            return null;
        }
    }

    function hasPendingRegistration(fsPath, line1) {
        return pendingBpReplies.some(p => !p.cancelled && p.fsPath === fsPath && p.line1 === line1);
    }

    function hasTargetRegistration(info) {
        if (!info) return false;
        const slots = bpSlotMap.get(info.key);
        if (slots && slots.size > 0) return true;
        for (const rec of bpHitLocMap.values()) {
            if (rec.fsPath === info.fsPath && rec.line1 === info.line1) return true;
        }
        return false;
    }

    function buildBreakpointSnapshot() {
        const items = [];
        for (const bp of vscode.debug.breakpoints) {
            const info = getBreakpointInfo(bp);
            if (!info) continue;
            const slots = Array.from(bpSlotMap.get(info.key) || []).sort((a, b) => a - b);
            let hitRec = null;
            for (const rec of bpHitLocMap.values()) {
                if (rec.fsPath === info.fsPath && rec.line1 === info.line1) {
                    hitRec = rec;
                    break;
                }
            }
            const pending = hasPendingRegistration(info.fsPath, info.line1);
            let state = 'NOT SET';
            if (!info.enabled) state = 'DISABLED';
            else if (slots.length > 0) state = 'VERIFIED';
            else if (pending) state = 'PENDING';
            items.push({
                key: info.key,
                fsPath: info.fsPath,
                file: info.file,
                line1: info.line1,
                module: info.module,
                func: info.func,
                enabled: info.enabled,
                condition: info.cond || '',
                slots,
                ip: hitRec ? hitRec.ip : null,
                fun: hitRec ? hitRec.fun : null,
                state
            });
        }
        const knownSlots = new Set();
        for (const item of items) {
            for (const slot of item.slots) knownSlots.add(slot);
        }
        for (const target of targetBreakpointList) {
            if (knownSlots.has(target.slot)) continue;
            const mappedName = funToName.get(target.fun);
            items.push({
                key: `target-only:${target.slot}`,
                fsPath: '',
                file: '(target only)',
                line1: null,
                module: '',
                func: mappedName || ('fun=0x' + Number(target.fun).toString(16)),
                enabled: true,
                condition: '',
                slots: [target.slot],
                ip: target.ip,
                fun: target.fun,
                state: 'TARGET ONLY',
                targetOnly: true
            });
        }
        items.sort((a, b) => {
            if (a.targetOnly && !b.targetOnly) return 1;
            if (!a.targetOnly && b.targetOnly) return -1;
            return String(a.file).localeCompare(String(b.file)) || ((a.line1 || 0) - (b.line1 || 0));
        });
        return items;
    }

    function postBreakpointSnapshot() {
        if (panel) panel.webview.postMessage({ evt: 'breakpoints', items: buildBreakpointSnapshot() });
    }

    function registerSourceBreakpoint(bp, announce = true) {
        const info = getBreakpointInfo(bp);
        if (!info) return;
        if (!info.enabled) {
            postBreakpointSnapshot();
            return;
        }
        if (!sessionReady) {
            postBreakpointSnapshot();
            return;
        }
        if (info.relLine === null) {
            if (panel) panel.webview.postMessage({ evt: 'error', msg: `no enclosing def for ${info.file}:${info.line1}` });
            postBreakpointSnapshot();
            return;
        }
        if (hasTargetRegistration(info) || hasPendingRegistration(info.fsPath, info.line1)) {
            postBreakpointSnapshot();
            return;
        }

        localNamesByFn.set(info.fnKey, info.names);
        pendingBpReplies.push({
            key: info.key,
            fsPath: info.fsPath,
            line1: info.line1,
            fnKey: info.fnKey,
            cond: info.cond,
            defLine: info.defLine
        });
        bridge.stdin.write(JSON.stringify({
            op: 'set_bp',
            module: info.module,
            func: info.func,
            line: info.relLine
        }) + '\n');
        if (announce && panel) {
            panel.webview.postMessage({
                evt: 'sent',
                op: `set_bp ${info.key} rel=${info.relLine}${info.cond ? ' cond=' + info.cond : ''}`
            });
        }
        postBreakpointSnapshot();
    }

    function clearSourceBreakpoint(fsPath, line1, announce = true) {
        const modName = path.basename(fsPath, '.py');
        const keysToClear = new Set();

        for (const pending of pendingBpReplies) {
            if (pending.fsPath === fsPath && pending.line1 === line1) {
                pending.cancelled = true;
                keysToClear.add(pending.key);
            }
        }
        for (const k of bpSlotMap.keys()) {
            if (k.startsWith(`${modName}:`) && k.endsWith(`:${line1}`)) {
                keysToClear.add(k);
            }
        }
        const clearedSlots = new Set();
        for (const key of keysToClear) {
            const slots = bpSlotMap.get(key);
            if (slots) {
                for (const slot of slots) {
                    clearedSlots.add(slot);
                    bridge.stdin.write(JSON.stringify({ op: 'clear_bp', slot }) + '\n');
                    if (announce && panel) {
                        panel.webview.postMessage({ evt: 'sent', op: `clear_bp slot=${slot} ${key}` });
                    }
                }
                bpSlotMap.delete(key);
            }
        }
        if (clearedSlots.size) {
            targetBreakpointList = targetBreakpointList.filter(t => !clearedSlots.has(t.slot));
        }
        for (const [hitKey, rec] of bpHitLocMap.entries()) {
            if (rec.fsPath === fsPath && rec.line1 === line1) {
                bpHitLocMap.delete(hitKey);
            }
        }
        postBreakpointSnapshot();
    }

    function findVsCodeBreakpoint(fsPath, line1) {
        return vscode.debug.breakpoints.find(bp =>
            bp instanceof vscode.SourceBreakpoint &&
            bp.location.uri.fsPath === fsPath &&
            (bp.location.range.start.line + 1) === line1
        );
    }

    function requestTaskMap() {
        try {
            bridge.stdin.write(JSON.stringify({ op: 'taskmap' }) + '\n');
            return true;
        } catch (e) {
            return false;
        }
    }

    let rtaSymRemaining = 0;
    let rtaSymRefreshActive = false;
    let rtaSymTimer = null;

    function requestSymbolMap() {
        if (rtaSymTimer) {
            clearTimeout(rtaSymTimer);
            rtaSymTimer = null;
        }
        rtaSymRemaining = 0;
        rtaSymRefreshActive = true;
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

    function scheduleNextSymbolMapChunk(delayMs = 25) {
        if (rtaSymTimer) clearTimeout(rtaSymTimer);
        rtaSymTimer = setTimeout(() => {
            rtaSymTimer = null;
            if (rtaSymRefreshActive && rtaSymRemaining > 0) {
                requestNextSymbolMapChunk();
            }
        }, delayMs);
    }

    function installCurrentBreakpoints() {
        for (const bp of vscode.debug.breakpoints) {
            registerSourceBreakpoint(bp, false);
        }
        postBreakpointSnapshot();
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

                if (msg.evt === 'transport_lost') {
                    sessionReady = false;
                    if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
                    if (panel) {
                        panel.webview.postMessage({
                            evt: 'transport_lost',
                            msg: msg.msg || 'Debug CDC transport lost'
                        });
                    }
                    try { bridge.kill(); } catch (e) {}
                    continue;
                }

                if (msg.evt === 'open' && !sessionReady) {
                    // Start with a command supported by both legacy v4 and v5.
                    // v5 appends capability metadata to this same reply; legacy
                    // pumps simply return the old "cleared all bp slots [...]".
                    try {
                        bridge.stdin.write(JSON.stringify({ op: 'clear_all_bp' }) + '\n');
                        panel.webview.postMessage({ evt: 'sent', op: 'debug CDC open; synchronizing breakpoint table' });
                        startupTimer = setTimeout(() => {
                            if (!sessionReady && panel) {
                                panel.webview.postMessage({
                                    evt: 'error',
                                    msg: 'Debug CDC opened, but clear_all_bp received no reply. The debug CDC transport or trace_pump is not responding.'
                                });
                            }
                        }, 3500);
                    } catch (e) {
                        panel.webview.postMessage({ evt: 'error', msg: 'Failed to start debugger handshake: ' + String(e) });
                    }
                }

                // Capture slot numbers from reply text: "bp N @ mod.func:line ip=..."
                if (msg.evt === 'reply' && typeof msg.text === 'string') {
                    if (!sessionReady && msg.text.startsWith('cleared all bp slots')) {
                        const cap = msg.text.match(/\spump=(\d+)\s+build=([^\s]+)\s+rta=(\d+)/);
                        if (cap) {
                            const protocol = parseInt(cap[1], 10);
                            const build = cap[2];
                            pumpVerified = protocol === REQUIRED_PUMP_PROTOCOL;
                            legacyPump = !pumpVerified;
                            supportsListBp = pumpVerified;
                            rtaSupported = cap[3] === '1';
                            panel.webview.postMessage({
                                evt: 'pump_capability',
                                protocol,
                                build,
                                expectedBuild: REQUIRED_PUMP_BUILD,
                                rtaSupported,
                                legacy: legacyPump
                            });
                        } else {
                            // Legacy pump: core breakpoint commands are fully
                            // usable; v5-only target inventory is unavailable.
                            pumpVerified = true;
                            legacyPump = true;
                            supportsListBp = false;
                            rtaSupported = null;
                            panel.webview.postMessage({
                                evt: 'pump_capability',
                                protocol: 'legacy',
                                build: 'legacy pump',
                                rtaSupported: null,
                                legacy: true
                            });
                        }
                        targetBreakpointList = [];
                        sessionReady = true;
                        if (startupTimer) {
                            clearTimeout(startupTimer);
                            startupTimer = null;
                        }
                        installCurrentBreakpoints();
                        panel.webview.postMessage({ evt: 'pump_ready', rtaSupported, legacy: legacyPump });
                    }
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
                                const funPtr = m[6] ? parseInt(m[6], 10) : null;
                                targetBreakpointList = targetBreakpointList.filter(t => t.slot !== slot);
                                targetBreakpointList.push({ slot, fun: funPtr, ip: bpIp });
                                const hitKey = funPtr !== null
                                    ? `${funPtr}:${bpIp}`
                                    : `legacy:${info.key}:${bpIp}`;
                                bpHitLocMap.set(hitKey, {
                                    fsPath: info.fsPath,
                                    line1: info.line1,
                                    fnKey: info.fnKey,
                                    ip: bpIp,
                                    fun: funPtr,
                                    cond: info.cond
                                });
                                if (funPtr !== null) {
                                    funToName.set(funPtr, info.fnKey);
                                    panel.webview.postMessage({ evt: 'fun_name', fun: funPtr, name: info.fnKey, fsPath: info.fsPath, defLine: info.defLine });
                                }
                            }
                        }
                    } else if (msg.text.startsWith("bp_list=")) {
                        const rawList = msg.text.slice("bp_list=".length);
                        const parsed = [];
                        const bpRe = /\((\d+),\s*(\d+),\s*(\d+)(?:,\s*(?:True|False|0|1))?\)/g;
                        let bm;
                        while ((bm = bpRe.exec(rawList)) !== null) {
                            parsed.push({
                                slot: parseInt(bm[1], 10),
                                fun: parseInt(bm[2], 10),
                                ip: parseInt(bm[3], 10)
                            });
                        }
                        targetBreakpointList = parsed;
                        postBreakpointSnapshot();
                    } else if (msg.text.startsWith("poked global __rta_sym_count")) {
                        const eqIdx = msg.text.indexOf("=");
                        if (eqIdx !== -1) {
                            let countText = msg.text.slice(eqIdx + 1).trim();
                            if ((countText.startsWith("'") && countText.endsWith("'")) ||
                                (countText.startsWith('"') && countText.endsWith('"'))) {
                                countText = countText.slice(1, -1);
                            }
                            rtaSymRemaining = parseInt(countText, 10) || 0;
                            if (rtaSymRemaining > 0) scheduleNextSymbolMapChunk();
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
                                scheduleNextSymbolMapChunk();
                            } else {
                                rtaSymRefreshActive = false;
                            }
                        }
                    } else if (msg.text.startsWith("taskmap=")) {
                        const valStr = msg.text.slice("taskmap=".length).trim();
                        if (valStr && valStr !== "no_asyncio" && !valStr.startsWith("err:")) {
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
                    } else {
                        const mFail = msg.text.match(/^no code on (.*)\.([^\s]+) line (\d+)/);
                        if (mFail) {
                            popPendingBp(mFail[1], mFail[2], parseInt(mFail[3], 10));
                        }
                    }
                    if (/^(?:bp |cleared bp |cleared all bp slots|no code on )/.test(msg.text)) {
                        postBreakpointSnapshot();
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
                    const loc = resolveBreakpointRecord(msg.fun, msg.ip);
                    const cond = loc ? loc.cond : null;
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
                    const loc = resolveBreakpointRecord(msg.fun, msg.ip);
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
                        rtaSupported = false;
                        if (panel) {
                            panel.webview.postMessage({ evt: 'rta_status', enabled: false });
                            panel.webview.postMessage({ evt: 'rta_capability', supported: false });
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
                const internalRtaSymbolReply =
                    msg.evt === 'reply' &&
                    typeof msg.text === 'string' &&
                    msg.text.startsWith('poked global __rta_sym_');
                const internalRtaSymbolSend =
                    msg.evt === 'sent' &&
                    msg.op === 'poke_global' &&
                    rtaSymRefreshActive;
                if (panel && !internalRtaSymbolReply && !internalRtaSymbolSend) {
                    panel.webview.postMessage(msg);
                }
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
                ed = vscode.window.visibleTextEditors.find(
                    e => e.document && e.document.fileName.endsWith('.py')
                );
            }
            if (!ed || !ed.document.fileName.endsWith('.py')) {
                panel.webview.postMessage({ evt: 'error', msg: 'open a .py file and click on a line first' });
                return;
            }
            const line1 = ed.selection.active.line + 1;
            const fsPath = ed.document.fileName;
            const existing = findVsCodeBreakpoint(fsPath, line1);
            if (existing) {
                panel.webview.postMessage({ evt: 'error', msg: `breakpoint already exists at ${path.basename(fsPath)}:${line1}` });
                postBreakpointSnapshot();
                return;
            }
            const location = new vscode.Location(
                ed.document.uri,
                new vscode.Position(line1 - 1, 0)
            );
            vscode.debug.addBreakpoints([
                new vscode.SourceBreakpoint(location, true)
            ]);
            return;
        }
        if (msg.op === 'flash_firmware') {
            vscode.commands.executeCommand('micropython-ide.flashDebugFirmware', {
                source: 'debugger',
                requireRta: rtaSupported === false
            });
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
        if (msg.op === 'bp_refresh') {
            if (supportsListBp) {
                try {
                    bridge.stdin.write(JSON.stringify({ op: 'list_bp' }) + '\n');
                } catch (e) {}
            } else if (panel) {
                panel.webview.postMessage({
                    evt: 'sent',
                    op: 'legacy pump: target-only breakpoint inventory requires pump v5'
                });
            }
            postBreakpointSnapshot();
            return;
        }
        if (msg.op === 'bp_goto') {
            const bp = findVsCodeBreakpoint(msg.fsPath, Number(msg.line1));
            if (bp) {
                vscode.workspace.openTextDocument(bp.location.uri).then(doc => {
                    vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One }).then(ed => {
                        const r = bp.location.range;
                        ed.revealRange(r, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                        ed.selection = new vscode.Selection(r.start, r.start);
                    });
                });
            }
            return;
        }
        if (msg.op === 'bp_remove') {
            const bp = findVsCodeBreakpoint(msg.fsPath, Number(msg.line1));
            if (bp) vscode.debug.removeBreakpoints([bp]);
            return;
        }
        if (msg.op === 'bp_remove_target') {
            const slot = Number(msg.slot);
            if (!Number.isInteger(slot)) return;
            try {
                bridge.stdin.write(JSON.stringify({ op: 'clear_bp', slot }) + '\n');
            } catch (e) {}
            targetBreakpointList = targetBreakpointList.filter(t => t.slot !== slot);
            postBreakpointSnapshot();
            return;
        }
        if (msg.op === 'bp_toggle') {
            const bp = findVsCodeBreakpoint(msg.fsPath, Number(msg.line1));
            if (!bp) return;
            // Clear the current target registration first so enable/disable is
            // deterministic even if VS Code emits remove/add events later.
            clearSourceBreakpoint(bp.location.uri.fsPath, bp.location.range.start.line + 1, false);
            const replacement = new vscode.SourceBreakpoint(
                bp.location,
                !!msg.enabled,
                bp.condition,
                bp.hitCondition,
                bp.logMessage
            );
            vscode.debug.removeBreakpoints([bp]);
            vscode.debug.addBreakpoints([replacement]);
            return;
        }
        if (msg.op === 'bp_clear_all') {
            const pythonBps = vscode.debug.breakpoints.filter(bp =>
                bp instanceof vscode.SourceBreakpoint &&
                bp.location.uri.fsPath.endsWith('.py')
            );
            for (const pending of pendingBpReplies) pending.cancelled = true;
            bpSlotMap.clear();
            bpHitLocMap.clear();
            targetBreakpointList = [];
            try {
                bridge.stdin.write(JSON.stringify({ op: 'clear_all_bp' }) + '\n');
            } catch (e) {}
            if (pythonBps.length) vscode.debug.removeBreakpoints(pythonBps);
            postBreakpointSnapshot();
            return;
        }
        if (msg.op === 'tasks') {
            bridge.stdin.write(JSON.stringify({ op: 'tasks' }) + '\n');
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
            requestTaskMap();
            return;
        }
        bridge.stdin.write(JSON.stringify(msg) + '\n');
    });

    // VS Code is the source of truth for Python breakpoints. Editor gutter,
    // VS Code Breakpoints view, and this debugger panel all converge here.
    bpDisposable = vscode.debug.onDidChangeBreakpoints((ev) => {
        for (const bp of ev.added) {
            registerSourceBreakpoint(bp, true);
        }

        for (const bp of ev.changed) {
            const info = getBreakpointInfo(bp);
            if (!info) continue;

            if (!info.enabled) {
                clearSourceBreakpoint(info.fsPath, info.line1, true);
                continue;
            }

            let mapped = false;
            for (const rec of bpHitLocMap.values()) {
                if (rec.fsPath === info.fsPath && rec.line1 === info.line1) {
                    rec.cond = info.cond;
                    mapped = true;
                }
            }

            if (!mapped && !hasPendingRegistration(info.fsPath, info.line1)) {
                registerSourceBreakpoint(bp, true);
            } else if (panel) {
                panel.webview.postMessage({
                    evt: 'sent',
                    op: `bp update ${info.file}:${info.line1}${info.cond ? ' cond=' + info.cond : ''}`
                });
            }
        }

        for (const bp of ev.removed) {
            if (!(bp instanceof vscode.SourceBreakpoint)) continue;
            const fsPath = bp.location.uri.fsPath;
            if (!fsPath.endsWith('.py')) continue;
            clearSourceBreakpoint(fsPath, bp.location.range.start.line + 1, true);
        }

        postBreakpointSnapshot();
    });

    panel.onDidDispose(() => {
        if (startupTimer) {
            clearTimeout(startupTimer);
            startupTimer = null;
        }
        if (rtaSymTimer) {
            clearTimeout(rtaSymTimer);
            rtaSymTimer = null;
        }
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

// Debugging never uploads boot.py, dbgref.py, trace_pump.py, or changes
// a user's MicroPython filesystem. Those helpers must be frozen in the
// matching board firmware. A legacy UF2 requires a firmware upgrade.
async function startDebugger(context, gRemoteDevicePort, venvPython) {
    const replPort = gRemoteDevicePort && gRemoteDevicePort !== '-' ? String(gRemoteDevicePort).trim() : '';
    if (!replPort) {
        vscode.window.showWarningMessage('Connect the MicroPython REPL/upload port first (Refresh Device Files).');
        return;
    }
    const pick = await vscode.window.showQuickPick([
        {
            label: '$(plug) Connect to debugger',
            description: 'Requires debugger-enabled firmware; does not upload files',
            id: 'connect',
        },
        {
            label: '$(cloud-download) Get debugger-enabled firmware',
            description: 'Open board-specific builds, requirements and installation guidance',
            id: 'firmware',
        },
    ], { placeHolder: `REPL/upload: ${replPort} | Debugger: separate port` });
    if (!pick) return;
    if (pick.id === 'firmware') {
        await vscode.commands.executeCommand('micropython-ide.flashDebugFirmware', { source: 'debugger' });
        return;
    }

    const portInput = await vscode.window.showInputBox({
        prompt: 'Dedicated debugger COM port (not the REPL/upload port); firmware must already include the debugger',
        placeHolder: 'e.g. COM13 (ESP32-S3 native USB), or Pico CDC1',
        validateInput: value => {
            const candidate = String(value || '').trim();
            if (!candidate) return 'Enter the dedicated debugger COM port.';
            if (candidate.toUpperCase() === replPort.toUpperCase()) {
                return 'This is the project REPL/upload port. The debugger requires the OTHER COM port.';
            }
            return null;
        }
    });
    if (!portInput) return;
    openDebuggerPanel(context, portInput.trim(), venvPython);
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
.panel-card-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-bottom: 1px solid var(--border-color);
  padding-bottom: 6px;
}
.panel-card-header-row h3 {
  border-bottom: 0;
  padding-bottom: 0;
}
.bp-toolbar {
  display: flex;
  gap: 6px;
}
.bp-table-wrap {
  max-height: 220px;
  overflow: auto;
}
.bp-table {
  min-width: 720px;
  font-size: 10px;
}
.bp-table th {
  text-align: left;
  color: var(--text-muted);
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 5px 6px;
  border-bottom: 1px solid var(--border-color);
  position: sticky;
  top: 0;
  background: var(--bg-card);
}
.bp-table td {
  padding: 5px 6px;
}
.bp-location {
  color: #88c0ff;
  text-decoration: underline;
  cursor: pointer;
}
.bp-state {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 700;
  border: 1px solid var(--border-color);
}
.bp-state.verified {
  color: #86efac;
  border-color: rgba(34,197,94,0.35);
}
.bp-state.pending {
  color: #fcd34d;
  border-color: rgba(245,158,11,0.35);
}
.bp-state.disabled {
  color: #94a3b8;
}
.bp-state.not-set {
  color: #fca5a5;
  border-color: rgba(244,63,94,0.35);
}
.bp-state.target-only {
  color: #fb7185;
  border-color: rgba(251,113,133,0.5);
  background: rgba(251,113,133,0.06);
}
.bp-remove {
  padding: 2px 7px;
  font-size: 10px;
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
.rta-live-badge.unsupported {
  color: #fca5a5;
  border-color: rgba(244,63,94,0.35);
  background: rgba(244,63,94,0.06);
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
.rta-kind.system {
  border-color: rgba(245,158,11,0.3);
  color: #fbbf24;
}
.rta-kind.unknown {
  border-color: rgba(148,163,184,0.25);
  color: #94a3b8;
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
          <th>Observed VM %</th>
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
  <div class="rta-note">Firmware timestamps are microseconds. Observed VM % is the share of completed MicroPython execution segments captured by RTA. It is not scheduler CPU%, task READY/BLOCKED state, or MCU idle time; those require future scheduler task-switch/idle events.</div>
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
    <div id="panel-breakpoints" class="panel-card">
      <div class="panel-card-header-row">
        <h3>Breakpoints <span id="bp-count" style="color:#64748b">(0)</span></h3>
        <div class="bp-toolbar">
          <button class="btn btn-action" style="padding:3px 7px;font-size:10px" onclick="refreshBreakpoints()">Refresh</button>
          <button class="btn btn-clear" style="padding:3px 7px;font-size:10px" onclick="clearAllBreakpoints()">Clear All</button>
        </div>
      </div>
      <div id="breakpoints-body" class="panel-card-body">(waiting for debugger)</div>
    </div>

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
let debugReady = false;
let rtaEnabled = false;
let rtaAvailable = null; // true / false / null = legacy capability unknown
const rtaProfiles = new Map();
const rtaNames = new Map();
const rtaStack = [];
let rtaEventCount = 0;
let rtaFirstTs = null;
let rtaLastTs = null;
let rtaRenderTimer = null;
let currentBreakpoints = [];

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
  { op: 'bp_refresh', label: 'Breakpoints', icon: 'bp', category: 'query', desc: 'Show and refresh active breakpoints' },
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
    const button = document.querySelector('button[data-op="' + match.op + '"]');
    if (button && button.disabled) return;
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

function refreshBreakpoints() {
  vscode.postMessage({ op: 'bp_refresh' });
  const panel = document.getElementById('panel-breakpoints');
  if (panel && panel.scrollIntoView) panel.scrollIntoView({ block: 'nearest' });
}

function clearAllBreakpoints() {
  if (!currentBreakpoints.length) return;
  vscode.postMessage({ op: 'bp_clear_all' });
}

function toggleBreakpoint(index, enabled) {
  const bp = currentBreakpoints[index];
  if (!bp || bp.targetOnly) return;
  vscode.postMessage({
    op: 'bp_toggle',
    fsPath: bp.fsPath,
    line1: bp.line1,
    enabled: !!enabled
  });
}

function removeBreakpoint(index) {
  const bp = currentBreakpoints[index];
  if (!bp) return;
  if (bp.targetOnly) {
    const slot = bp.slots && bp.slots.length ? bp.slots[0] : null;
    vscode.postMessage({ op: 'bp_remove_target', slot: slot });
    return;
  }
  vscode.postMessage({ op: 'bp_remove', fsPath: bp.fsPath, line1: bp.line1 });
}

function gotoBreakpoint(index) {
  const bp = currentBreakpoints[index];
  if (!bp || bp.targetOnly) return;
  vscode.postMessage({ op: 'bp_goto', fsPath: bp.fsPath, line1: bp.line1 });
}

function renderBreakpoints(items) {
  currentBreakpoints = Array.isArray(items) ? items : [];
  const body = document.getElementById('breakpoints-body');
  const count = document.getElementById('bp-count');
  if (count) count.textContent = '(' + currentBreakpoints.length + ')';
  if (!body) return;

  if (!currentBreakpoints.length) {
    body.innerHTML = '<div style="color:#64748b;padding:6px 0">No Python breakpoints. Set one in the editor gutter or use Set BP.</div>';
    return;
  }

  let html = '<div class="bp-table-wrap"><table class="bp-table"><thead><tr>' +
    '<th>On</th><th>Location</th><th>Function</th><th>Slot</th><th>IP</th><th>Condition</th><th>Status</th><th></th>' +
    '</tr></thead><tbody>';

  currentBreakpoints.forEach((bp, i) => {
    const stateClass = String(bp.state || 'NOT SET').toLowerCase().replace(/\s+/g, '-');
    const slots = (bp.slots && bp.slots.length) ? bp.slots.map(x => 'S' + x).join(',') : '—';
    const ip = (bp.ip === null || bp.ip === undefined) ? '—' : ('0x' + Number(bp.ip).toString(16).padStart(4, '0'));
    const condition = bp.condition ? escapeHtml(bp.condition) : '—';
    const onCell = bp.targetOnly
      ? '<span style="color:#64748b">—</span>'
      : '<input type="checkbox" ' + (bp.enabled ? 'checked' : '') + ' onchange="toggleBreakpoint(' + i + ',this.checked)" title="Enable / disable breakpoint">';
    const locationCell = bp.targetOnly
      ? '<span style="color:#fb7185">(target only)</span>'
      : '<a class="bp-location" onclick="gotoBreakpoint(' + i + ');return false">' + escapeHtml(bp.file) + ':' + bp.line1 + '</a>';
    html += '<tr>' +
      '<td>' + onCell + '</td>' +
      '<td>' + locationCell + '</td>' +
      '<td>' + escapeHtml(bp.func || '—') + '</td>' +
      '<td>' + slots + '</td>' +
      '<td>' + ip + '</td>' +
      '<td title="' + condition + '">' + condition + '</td>' +
      '<td><span class="bp-state ' + stateClass + '">' + escapeHtml(bp.state || 'NOT SET') + '</span></td>' +
      '<td><button class="btn btn-clear bp-remove" onclick="removeBreakpoint(' + i + ')">Remove</button></td>' +
      '</tr>';
  });

  html += '</tbody></table></div>';
  body.innerHTML = html;
}

function updateRtaControls(enabled) {
  rtaEnabled = !!enabled;
  const onBtn = document.querySelector('button[data-op="rta_on"]');
  const offBtn = document.querySelector('button[data-op="rta_off"]');
  const badge = document.getElementById('rta-live-badge');
  const explicitlyUnsupported = rtaAvailable === false;

  if (onBtn) {
    onBtn.disabled = !debugReady || explicitlyUnsupported || rtaEnabled;
    onBtn.title = explicitlyUnsupported
      ? 'RTA requires an RTA-capable debugger firmware'
      : (rtaAvailable === null
          ? 'Legacy pump: firmware RTA capability will be checked when RTA On is used'
          : 'Enable Real-time Analysis tracing (t)');
  }
  if (offBtn) offBtn.disabled = !debugReady || explicitlyUnsupported || !rtaEnabled;

  if (badge) {
    if (!debugReady) {
      badge.textContent = 'CHECKING';
      badge.className = 'rta-live-badge';
    } else if (rtaAvailable === false) {
      badge.textContent = 'FW REQUIRED';
      badge.className = 'rta-live-badge unsupported';
    } else if (rtaAvailable === null) {
      badge.textContent = 'LEGACY';
      badge.className = 'rta-live-badge';
    } else {
      badge.textContent = rtaEnabled ? 'LIVE' : 'OFF';
      badge.className = rtaEnabled ? 'rta-live-badge on' : 'rta-live-badge';
    }
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

function classifyRtaKind(name, kind, existingKind) {
  if (kind === 'task' || existingKind === 'task') return 'task';
  const n = String(name || '');
  if (
    n.startsWith('trace_pump.') ||
    n.startsWith('usb.device.') ||
    n.startsWith('asyncio.') ||
    n.startsWith('logging.') ||
    n.startsWith('rp2.')
  ) return 'system';
  if (kind === 'function') return 'function';
  if (existingKind && existingKind !== 'unknown') return existingKind;
  return n.startsWith('0x') ? 'unknown' : 'function';
}

function setRtaName(fun, name, kind) {
  const key = String(fun);
  const existing = rtaNames.get(key);
  const resolvedName = name || (existing && existing.name) || ('0x' + Number(fun).toString(16));
  const next = {
    name: resolvedName,
    kind: classifyRtaKind(resolvedName, kind, existing && existing.kind)
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
      kind: named ? named.kind : 'unknown',
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
    const stateText = (rtaEnabled && active) ? 'RUNNING' : '—';
    const stateClass = (rtaEnabled && active) ? 'active' : 'idle';
    const kindLabel = p.kind === 'task'
      ? 'TASK'
      : (p.kind === 'system' ? 'SYSTEM' : (p.kind === 'unknown' ? 'UNKNOWN' : 'FUNC'));
    html += '<tr>' +
      '<td><span class="rta-state"><span class="rta-state-dot ' + stateClass + '"></span>' + stateText + '</span></td>' +
      '<td class="rta-name-cell" title="' + escapeHtml(p.name) + '">' + escapeHtml(p.name) + '</td>' +
      '<td><span class="rta-kind ' + p.kind + '">' + kindLabel + '</span></td>' +
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
  if (m.evt === 'breakpoints') {
    renderBreakpoints(m.items);
  }
  else if (m.evt === 'bp_hit') {
    const funRec = (m.fun !== undefined && m.fun !== null) ? funNames[m.fun] : null;
    const funText = (m.fun !== undefined && m.fun !== null)
      ? '  fun=' + (funRec ? funRec.name : ('0x' + Number(m.fun).toString(16)))
      : '';
    add('bp', 'BP_HIT' + funText + '  ip=0x' + m.ip.toString(16).padStart(4,'0') + '  <<< paused');
    lastIp = m.ip;
  }
  else if (m.evt === 'pump_capability') {
    rtaAvailable = (m.rtaSupported === null || m.rtaSupported === undefined)
      ? null
      : !!m.rtaSupported;
    updateRtaControls(false);
    if (m.legacy) {
      add('reply', 'DEBUG PUMP · legacy compatibility mode');
    } else {
      add('reply', 'DEBUG PUMP v' + m.protocol + ' · ' + m.build);
    }
    if (rtaAvailable === false) {
      add('err', 'RTA firmware support is not present in the currently flashed UF2. Breakpoints/stepping still work.');
    }
  }
  else if (m.evt === 'pump_ready') {
    debugReady = true;
    updateRtaControls(false);
    add('reply', 'DEBUG CDC READY · breakpoint table synchronized' + (m.legacy ? ' · legacy pump' : ''));
  }
  else if (m.evt === 'transport_lost') {
    debugReady = false;
    updateRtaControls(false);
    add('err', 'DEBUG CDC LOST · ' + (m.msg || 'transport disconnected'));
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
    const isPanelDataReply = /^depth=\\d+\\s+(?:state=\\[|globals=\\{)/.test(m.text);
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
  else if (m.evt === 'rta_capability') {
    rtaAvailable = !!m.supported;
    updateRtaControls(false);
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
