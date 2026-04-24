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
let hlDeco = null;            // TextEditorDecorationType for current line
let lastHlEditor = null;

// Scan a python source for the nearest `def name(` at/above `line` (1-based).
// Returns {func, defLine, args} or null.
function findEnclosingFunction(text, line) {
    const lines = text.split(/\r?\n/);
    for (let i = Math.min(line - 1, lines.length - 1); i >= 0; i--) {
        const m = lines[i].match(/^\s*def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/);
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

    async function highlightLine(fsPath, line1) {
        try {
            const doc = await vscode.workspace.openTextDocument(fsPath);
            const ed = await vscode.window.showTextDocument(doc, { preserveFocus: false, viewColumn: vscode.ViewColumn.One });
            const range = new vscode.Range(line1 - 1, 0, line1 - 1, 0);
            ed.setDecorations(hlDeco, [range]);
            ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            lastHlEditor = ed;
        } catch (e) { /* ignore */ }
    }
    function clearHighlight() {
        if (lastHlEditor && hlDeco) lastHlEditor.setDecorations(hlDeco, []);
    }

    // Spawn the Python bridge
    const script = path.join(context.extensionPath, 'src', 'dbg_bridge.py');
    const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
    bridge = spawn(pyCmd, [script, port], { stdio: ['pipe', 'pipe', 'pipe'] });

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
                    const m = msg.text.match(/^bp (\d+) @ ([^:]+):(\d+) ip=(\d+)/);
                    if (m && pendingBpReplies.length) {
                        const info = pendingBpReplies.shift();
                        bpSlotMap.set(info.key, parseInt(m[1], 10));
                        ipToLoc.set(parseInt(m[4], 10), { fsPath: info.fsPath, line1: info.line1, fnKey: info.fnKey });
                    }
                }
                if (msg.evt === 'bp_hit') {
                    const loc = ipToLoc.get(msg.ip);
                    if (loc) {
                        highlightLine(loc.fsPath, loc.line1);
                        panel.webview.postMessage({ evt: 'names', names: localNamesByFn.get(loc.fnKey) || [] });
                    }
                    panel.webview.postMessage({ evt: 'status', paused: true });
                    // auto-fetch locals
                    try { bridge.stdin.write(JSON.stringify({ op: 'locals' }) + '\n'); } catch (e) {}
                }
                if (msg.evt === 'sent' && (msg.op === 'continue' || (msg.op && msg.op.startsWith && msg.op.startsWith('step')))) {
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
            pendingBpReplies.push({ key, fsPath: ed.document.fileName, line1, fnKey: `${modName}:${info.func}` });
            const out = { op: 'set_bp', module: modName, func: info.func, line: relLine };
            bridge.stdin.write(JSON.stringify(out) + '\n');
            panel.webview.postMessage({ evt: 'sent', op: `set_bp ${modName}.${info.func}:${line1} (rel=${relLine})` });
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
                pendingBpReplies.push({ key, fsPath, line1, fnKey: `${modName}:${info.func}` });
                const out = { op: 'set_bp', module: modName, func: info.func, line: relLine };
                bridge.stdin.write(JSON.stringify(out) + '\n');
                panel.webview.postMessage({ evt: 'sent', op: `set_bp ${key} rel=${relLine}` });
            } catch (e) {
                panel.webview.postMessage({ evt: 'error', msg: String(e) });
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
<html><head><style>
body { font-family: monospace; background: #1e1e1e; color: #ddd; margin: 0; padding: 8px; }
button { background: #2d2d2d; color: #ddd; border: 1px solid #555; padding: 6px 12px; margin: 2px; cursor: pointer; }
button:hover { background: #3d3d3d; }
#log { border: 1px solid #333; height: 40vh; overflow-y: scroll; padding: 6px; font-size: 12px; white-space: pre-wrap; }
#locals { border: 1px solid #444; background:#252525; margin-top:6px; padding:6px; font-size:12px; min-height:80px; }
#locals h3 { margin: 0 0 4px 0; font-size: 12px; color: #8fbc8f; }
#locals table { width: 100%; border-collapse: collapse; }
#locals td { padding: 2px 6px; border-bottom: 1px solid #333; }
#locals td.k { color: #88c0ff; width: 80px; }
.bp { color: #ffa500; }
.reply { color: #8fbc8f; }
.err { color: #f88; }
.sent { color: #88f; }
</style></head><body>
<div id="status" style="padding:6px; font-weight:bold; font-size:14px;">▶ running</div>
<div>
  <button onclick="send('continue')">▶ Continue (c)</button>
  <button onclick="send('step')">↷ Step-over (s)</button>
  <button onclick="send('step_in')">↴ Step-in (i)</button>
  <button onclick="send('step_out')">↵ Step-out (o)</button>
  <button onclick="send('locals')">{ } Locals (l)</button>
  <button onclick="send('call_stack')">☰ Call Stack (k)</button>
  <button onclick="send('set_bp_here')">● Set BP at cursor</button>
  <button onclick="document.getElementById('log').innerHTML=''">Clear</button>
</div>
<div id="log"></div>
<div id="locals"><h3>Locals / Frame</h3><div id="locals-body">(not paused)</div></div>
<div id="locals"><h3>Call Stack</h3><div id="stack-body">(empty)</div></div>
<script>
const vscode = acquireVsCodeApi();
const log = document.getElementById('log');
let currentNames = [];
function add(cls, text) {
  const line = document.createElement('div');
  line.className = cls;
  line.textContent = text;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}
function send(op) { vscode.postMessage({op}); }
window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.evt === 'bp_hit') add('bp', 'BP_HIT  ip=0x' + m.ip.toString(16).padStart(4,'0') + '  <<< paused');
  else if (m.evt === 'trace') add('', 'trace   ip=0x' + m.ip.toString(16).padStart(4,'0') + '  op=0x' + m.op.toString(16).padStart(2,'0'));
  else if (m.evt === 'reply') {
    add('reply', 'REPLY  ' + m.text);
    const sm = m.text.match(/^stack=\\[(.*)\\]$/);
    if (sm) {
      const inner = sm[1];
      const frames = [];
      const re = /\\((\\d+),\\s*(\\d+)\\)/g;
      let mm;
      while ((mm = re.exec(inner)) !== null) frames.push({fun: mm[1], ip: parseInt(mm[2])});
      let html = '<table>';
      frames.forEach((f, i) => {
        html += '<tr><td class="k">#' + i + '</td><td>fun=0x' + parseInt(f.fun).toString(16) + ' ip=0x' + f.ip.toString(16).padStart(4,'0') + '</td></tr>';
      });
      html += '</table>';
      document.getElementById('stack-body').innerHTML = frames.length ? html : '(empty)';
    }
    const fm = m.text.match(/frame=\\(([^)]+)\\)\\s+state=\\[([^\\]]*)\\]/);
    if (fm) {
      const fr = fm[1].split(',').map(s => s.trim());
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
      })(fm[2]);
      const n = parseInt(fr[0]);
      let html = '<table>';
      html += '<tr><td class="k">ip</td><td>0x' + parseInt(fr[2]).toString(16).padStart(4,'0') + '</td></tr>';
      // locals: state[n-1-i] for local i
      for (let i = 0; i < currentNames.length; i++) {
        const idx = n - 1 - i;
        const val = (idx >= 0 && idx < state.length) ? state[idx] : '?';
        html += '<tr><td class="k">' + currentNames[i] + '</td><td>' + val + '</td></tr>';
      }
      html += '<tr><td class="k">raw</td><td style="color:#888">[' + fm[2] + ']</td></tr>';
      html += '</table>';
      document.getElementById('locals-body').innerHTML = html;
    }
  }
  else if (m.evt === 'sent') add('sent', '→ ' + m.op);
  else if (m.evt === 'error') add('err', 'ERR ' + m.msg);
  else if (m.evt === 'closed') add('err', '(bridge closed)');
  else if (m.evt === 'open') add('reply', 'connected to ' + m.port);
  else if (m.evt === 'names') { currentNames = m.names || []; }
  else if (m.evt === 'status') {
    const el = document.getElementById('status');
    if (m.paused) { el.textContent = '⏸ PAUSED'; el.style.color = '#ffa500'; }
    else { el.textContent = '▶ running'; el.style.color = '#8fbc8f'; }
  }
  else add('', JSON.stringify(m));
});
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'c') send('continue');
  else if (e.key === 's') send('step');
  else if (e.key === 'i') send('step_in');
  else if (e.key === 'o') send('step_out');
  else if (e.key === 'l') send('locals');
  else if (e.key === 'k') send('call_stack');
});
</script>
</body></html>`;
}

module.exports = { startDebugger };
