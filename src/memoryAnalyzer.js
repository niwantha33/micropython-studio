'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const connectionManager = require('./connectionManager');
const queue = require('./wsQueue');
const { buildProbeScript, parseMemorySample, summarizeMemory } = require('./memoryProbe');

const MAX_SAMPLES = 500;

function htmlForMemoryAnalyzer(nonce) {
    return [
        '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1">',
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'nonce-' + nonce + '\';">',
        '<style>',
        'body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);padding:20px;max-width:1200px;margin:auto}',
        'h1{font-size:22px;margin:0 0 6px}h2{font-size:15px;margin:0 0 12px}p,.muted{color:var(--vscode-descriptionForeground)}',
        '.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:8px 12px;cursor:pointer;border-radius:4px}',
        'button:hover{background:var(--vscode-button-hoverBackground)}button:disabled{opacity:.45;cursor:wait}.quiet{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}',
        '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px;margin:18px 0}.stat,.panel{background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-panel-border);border-radius:6px;padding:14px}',
        '.value{font-size:21px;font-weight:650;font-variant-numeric:tabular-nums;margin-top:8px;overflow-wrap:anywhere}.panel{margin-bottom:14px}.plot{width:100%;height:220px}.legend{display:flex;gap:16px;flex-wrap:wrap}',
        'table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:6px 9px;border-bottom:1px solid var(--vscode-panel-border)}.scroller{overflow:auto}#message{min-height:20px}',
        '</style></head><body>',
        '<h1>Memory &amp; Garbage Collection Analyzer</h1>',
        '<p>Explicit snapshots of the MicroPython heap. Sampling never calls gc.collect(); manual GC is a separate action. The REPL must be idle because evaluation can interrupt running code.</p>',
        '<div class="toolbar"><button id="sample">Sample heap</button><button id="gc" class="quiet">Collect GC + compare</button><button id="export" class="quiet">Export CSV</button><button id="clear" class="quiet">Clear history</button></div>',
        '<div id="message" role="status" aria-live="polite"></div>',
        '<div class="grid">',
        '<div class="stat">Allocated<div id="allocated" class="value">—</div></div>',
        '<div class="stat">Free heap<div id="free" class="value">—</div></div>',
        '<div class="stat">Heap used %<div id="heapPercent" class="value">—</div></div>',
        '<div class="stat">GC threshold<div id="threshold" class="value">—</div></div>',
        '<div class="stat">Observed peak<div id="peak" class="value">—</div></div>',
        '<div class="stat">Observed growth<div id="growth" class="value">—</div></div>',
        '<div class="stat">Last manual GC reclaimed<div id="reclaimed" class="value">—</div></div>',
        '<div class="stat">Last manual GC duration<div id="gcTime" class="value">—</div></div>',
        '</div>',
        '<section class="panel"><h2>Heap history</h2><div class="legend"><span>Allocated (blue)</span><span>Free (green)</span></div><svg id="plot" class="plot" role="img" aria-label="Allocated and free heap history" viewBox="0 0 800 220" preserveAspectRatio="none"></svg><p class="muted">Observed growth is not proof of a memory leak. Runtime allocations, stack use, fragmentation and other memory pools may not be included.</p></section>',
        '<section class="panel"><h2>Snapshots</h2><div class="scroller"><table><thead><tr><th>Local time</th><th>Type</th><th>Allocated</th><th>Free</th><th>GC reclaimed</th><th>GC time</th></tr></thead><tbody id="history"></tbody></table></div></section>',
        '<script nonce="' + nonce + '">',
        '(function(){',
        'const vscode=acquireVsCodeApi();let busy=false,records=[];const $=id=>document.getElementById(id);',
        'function size(v){if(v===null||v===undefined)return "N/A";const s=v<0?"−":"";let n=Math.abs(v);for(const u of ["B","KiB","MiB"]){if(n<1024||u==="MiB")return s+(n<10?n.toFixed(1):Math.round(n).toString())+" "+u;n/=1024;}}',
        'function setBusy(v){busy=v;$("sample").disabled=v;$("gc").disabled=v;}',
        'function text(id,v){$(id).textContent=v;}',
        'function draw(){const svg=$("plot");while(svg.firstChild)svg.removeChild(svg.firstChild);',
        'const good=records.filter(r=>Number.isFinite(r.allocated)&&Number.isFinite(r.free));if(!good.length)return;',
        'const max=Math.max(1,...good.map(r=>Math.max(r.allocated,r.free)));const ns="http://www.w3.org/2000/svg";',
        'function line(key,color){const points=good.map((r,i)=>[30+(i/(Math.max(1,good.length-1)))*748,200-(r[key]/max)*175].join(",")).join(" ");const el=document.createElementNS(ns,"polyline");el.setAttribute("points",points);el.setAttribute("fill","none");el.setAttribute("stroke",color);el.setAttribute("stroke-width","2.5");svg.appendChild(el);}',
        'line("allocated","#4b9cf5");line("free","#38b58b");}',
        'function render(summary){records=summary.samples;text("allocated",size(summary.latest&&summary.latest.allocated));text("free",size(summary.latest&&summary.latest.free));text("peak",size(summary.allocatedHighWater));text("growth",size(summary.observedGrowth));',
        'const latest=summary.latest;text("heapPercent",latest&&latest.total>0&&latest.allocated!==null?(100*latest.allocated/latest.total).toFixed(1)+"%":"N/A");text("threshold",size(latest&&latest.threshold));',
        'const lastGc=records.filter(r=>r.collected).slice(-1)[0];text("reclaimed",size(lastGc&&lastGc.reclaimed));text("gcTime",lastGc&&lastGc.gcTimeUs!==null?(lastGc.gcTimeUs/1000).toFixed(2)+" ms":"N/A");',
        'const body=$("history");while(body.firstChild)body.removeChild(body.firstChild);records.slice(-40).reverse().forEach(r=>{const tr=document.createElement("tr");',
        'const vals=[new Date(r.timestamp).toLocaleTimeString(),r.collected?"Manual GC":"Snapshot",size(r.allocated),size(r.free),r.collected?size(r.reclaimed):"—",r.gcTimeUs===null?"—":(r.gcTimeUs/1000).toFixed(2)+" ms"];',
        'vals.forEach(v=>{const td=document.createElement("td");td.textContent=v;tr.appendChild(td);});body.appendChild(tr);});draw();}',
        '$("sample").onclick=()=>{if(!busy){setBusy(true);vscode.postMessage({op:"sample",collect:false});}};',
        '$("gc").onclick=()=>{if(!busy){setBusy(true);vscode.postMessage({op:"sample",collect:true});}};',
        '$("export").onclick=()=>vscode.postMessage({op:"export"});',
        '$("clear").onclick=()=>vscode.postMessage({op:"clear"});',
        'window.addEventListener("message",e=>{const m=e.data;if(m.type==="data")render(m);if(m.type==="status"){text("message",m.message);if(m.done)setBusy(false);}});',
        '})();',
        '</script></body></html>'
    ].join('\n');
}

class MemoryAnalyzer {
    constructor(context, getPort) {
        this.context = context;
        this.getPort = getPort;
        this.samples = [];
        this.currentPort = null;
        this.panel = null;
        this.busy = false;
    }

    open() {
        if (this.panel) { this.panel.reveal(); return; }
        this.panel = vscode.window.createWebviewPanel('mpyMemoryAnalyzer', 'MicroPython Memory & GC',
            vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
        const nonce = crypto.randomBytes(16).toString('base64');
        this.panel.webview.html = htmlForMemoryAnalyzer(nonce);
        this.panel.webview.onDidReceiveMessage(async message => {
            if (message.op === 'sample') await this.sample(message.collect === true);
            else if (message.op === 'clear') {
                this.samples = [];
                this.publish();
                this.status('History cleared.');
            } else if (message.op === 'export') await this.exportCsv();
        });
        this.panel.onDidDispose(() => { this.panel = null; });
        this.publish();
    }

    publish() {
        if (!this.panel) return;
        const summary = summarizeMemory(this.samples);
        this.panel.webview.postMessage({ type: 'data', samples: this.samples, ...summary });
    }

    status(message, done = true) {
        if (this.panel) this.panel.webview.postMessage({ type: 'status', message, done });
    }

    async sample(collect) {
        if (this.busy) return;
        this.busy = true;
        try {
            const port = this.getPort();
            if (!port || port === '-' || port.startsWith('ws:')) {
                throw new Error('Select and connect the USB device REPL before sampling.');
            }
            if (!connectionManager.isConnected || connectionManager.portName !== port || connectionManager.isSuspended) {
                throw new Error('Device REPL is not idle/connected on ' + port + '. Refresh Device Files, then retry.');
            }
            if (vscode.debug.activeDebugSession?.type === 'micropython-studio') {
                throw new Error('Stop the native debug session before probing the REPL to avoid modifying paused execution.');
            }
            if (this.currentPort && this.currentPort !== port) {
                // Do not mix heap measurements from different boards in one chart.
                this.samples = [];
                this.publish();
            }
            this.currentPort = port;
            this.status(collect ? 'Running explicitly requested GC...' : 'Reading heap without collecting GC...', false);
            const output = await queue.run(async () => {
                // Connection can change while this operation waits in the queue.
                if (!connectionManager.isConnected || connectionManager.isSuspended || connectionManager.portName !== port) {
                    throw new Error('REPL connection changed while waiting to sample.');
                }
                const result = await connectionManager.runCodeSilently(buildProbeScript(collect));
                if (result.stderr?.trim()) throw new Error(result.stderr.trim().slice(0, 400));
                return result.stdout || '';
            }, 'Memory / GC snapshot', true);
            const sample = parseMemorySample(output, collect);
            this.samples.push(sample);
            if (this.samples.length > MAX_SAMPLES) this.samples.shift();
            this.publish();
            this.status(collect ? 'Manual GC completed and before/after heap counters captured.' : 'Heap sampled without forcing garbage collection.');
        } catch (error) {
            this.status('Memory analyzer: ' + error.message);
        } finally {
            this.busy = false;
        }
    }

    async exportCsv() {
        if (!this.samples.length) { this.status('No samples to export.'); return; }
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.workspace.workspaceFolders?.[0]
                ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'micropython-memory.csv')
                : undefined,
            filters: { CSV: ['csv'] }
        });
        if (!uri) return;
        const headers = ['timestamp_iso','manual_gc','allocated_before_bytes','free_before_bytes','allocated_after_bytes','free_after_bytes','heap_total_bytes','gc_duration_us','gc_reclaimed_bytes','gc_threshold_bytes'];
        const column = s => [new Date(s.timestamp).toISOString(), s.collected, s.allocatedBefore,s.freeBefore,s.allocated,s.free,s.total,s.gcTimeUs,s.reclaimed,s.threshold].map(v => v === null ? '' : v);
        const csv = [headers.join(','), ...this.samples.map(s => column(s).join(','))].join('\r\n') + '\r\n';
        try {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(csv, 'utf8'));
            this.status('CSV exported.');
        } catch (error) { this.status('CSV export failed: ' + error.message); }
    }

    dispose() {
        if (this.panel) this.panel.dispose();
    }
}

module.exports = { MemoryAnalyzer, htmlForMemoryAnalyzer };
