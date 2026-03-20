const vscode = require('vscode');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { getConfigValue } = require('./commonFxn');

// ─── Node.js WebREPL WebSocket Client ────────────────────────────────────────
// Runs entirely in the extension host — no browser-side WebSocket needed.

class WebReplClient {
    constructor(host, password, port = 8266) {
        this.host = host;
        this.password = password;
        this.port = port;
        this.socket = null;
        this._buf = Buffer.alloc(0);
        this._handshakeDone = false;
        this._authenticated = false;

        // Callbacks set by caller
        this.onData = null;          // (Buffer) → void
        this.onConnect = null;       // () → void
        this.onDisconnect = null;    // (reason: string) → void
    }

    connect() {
        this.socket = net.createConnection(this.port, this.host);
        this.socket.setTimeout(10000);

        this.socket.on('connect', () => {
            this.socket.setTimeout(0);
            const key = crypto.randomBytes(16).toString('base64');
            this.socket.write(
                `GET / HTTP/1.1\r\n` +
                `Host: ${this.host}:${this.port}\r\n` +
                `Upgrade: websocket\r\n` +
                `Connection: Upgrade\r\n` +
                `Sec-WebSocket-Key: ${key}\r\n` +
                `Sec-WebSocket-Version: 13\r\n` +
                `\r\n`
            );
        });

        this.socket.on('data', (chunk) => {
            if (!this._handshakeDone) {
                this._buf = Buffer.concat([this._buf, chunk]);
                const sep = this._buf.indexOf('\r\n\r\n');
                if (sep !== -1) {
                    this._handshakeDone = true;
                    const rest = this._buf.slice(sep + 4);
                    this._buf = Buffer.alloc(0);
                    if (rest.length > 0) this._handleWsData(rest);
                }
            } else {
                this._handleWsData(chunk);
            }
        });

        this.socket.on('timeout', () => {
            this.socket.destroy();
            if (this.onDisconnect) this.onDisconnect('Connection timed out');
        });

        this.socket.on('error', (err) => {
            if (this.onDisconnect) this.onDisconnect(err.message);
        });

        this.socket.on('close', () => {
            if (this.onDisconnect) this.onDisconnect('Disconnected');
        });
    }

    _handleWsData(chunk) {
        this._buf = Buffer.concat([this._buf, chunk]);
        while (this._buf.length >= 2) {
            const opcode = this._buf[0] & 0x0f;
            const masked = (this._buf[1] & 0x80) !== 0;
            let payloadLen = this._buf[1] & 0x7f;
            let offset = 2;

            if (payloadLen === 126) {
                if (this._buf.length < 4) return;
                payloadLen = (this._buf[2] << 8) | this._buf[3];
                offset = 4;
            } else if (payloadLen === 127) {
                if (this._buf.length < 10) return;
                payloadLen = this._buf.readUInt32BE(6);
                offset = 10;
            }

            const maskBytes = masked ? 4 : 0;
            const total = offset + maskBytes + payloadLen;
            if (this._buf.length < total) return;

            let payload = Buffer.from(this._buf.slice(offset + maskBytes, total));
            if (masked) {
                const mask = this._buf.slice(offset, offset + 4);
                for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
            }
            this._buf = this._buf.slice(total);

            if (opcode === 8) { // close frame
                this.socket.destroy();
                return;
            }
            if (opcode === 1 || opcode === 2) { // text or binary
                // Auto-authenticate
                if (!this._authenticated && payload.toString().includes('Password')) {
                    this._sendFrame(Buffer.from(this.password + '\r\n'));
                    this._authenticated = true;
                    if (this.onConnect) this.onConnect();
                } else if (this._authenticated && this.onData) {
                    this.onData(payload);
                }
            }
        }
    }

    _sendFrame(payload, opcode = 0x82) {
        if (!this.socket || this.socket.destroyed) return;
        if (typeof payload === 'string') payload = Buffer.from(payload);
        const mask = crypto.randomBytes(4);
        const masked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];

        let hdr;
        if (payload.length < 126) {
            hdr = Buffer.from([opcode, 0x80 | payload.length, ...mask]);
        } else if (payload.length < 65536) {
            hdr = Buffer.from([opcode, 0x80 | 126,
                (payload.length >> 8) & 0xff, payload.length & 0xff, ...mask]);
        } else {
            // 64-bit extended length (high 32 bits always 0 for sane file sizes)
            hdr = Buffer.from([opcode, 0x80 | 127,
                0, 0, 0, 0,
                (payload.length >>> 24) & 0xff, (payload.length >>> 16) & 0xff,
                (payload.length >>> 8) & 0xff, payload.length & 0xff,
                ...mask]);
        }
        this.socket.write(Buffer.concat([hdr, masked]));
    }

    send(data) { this._sendFrame(data, 0x82); }         // binary frame
    sendText(data) { this._sendFrame(data, 0x81); }     // text frame

    disconnect() {
        if (this.socket) { this.socket.destroy(); this.socket = null; }
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function findDeviceCfgPath() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    const fs = require('fs').promises;
    let current = folders[0].uri.fsPath;
    while (true) {
        const candidate = path.join(current, 'device.cfg');
        try { await fs.access(candidate); return candidate; } catch (_) {}
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
    }
}

async function resolveWebReplCredentials(devicePort) {
    const wsMatch = devicePort && devicePort.match(/^ws:([^,]+),(.+)$/);
    if (wsMatch) return { ip: wsMatch[1], password: wsMatch[2] };

    const cfgPath = await findDeviceCfgPath();
    if (!cfgPath) return null;

    const enabled  = await getConfigValue(cfgPath, 'remote', 'webrepl_enabled');
    const ip       = await getConfigValue(cfgPath, 'remote', 'webrepl_ip');
    const password = await getConfigValue(cfgPath, 'remote', 'webrepl_password');

    if (enabled === 'true' && ip) return { ip, password: password || '' };
    return null;
}

// ─── Main export ─────────────────────────────────────────────────────────────

async function openWebReplTerminal(context, devicePort) {
    const creds = await resolveWebReplCredentials(devicePort);
    if (!creds) {
        vscode.window.showErrorMessage(
            'WebREPL not configured. Enable it from Device Dashboard → Wi-Fi Manager.'
        );
        return;
    }

    const { ip, password } = creds;

    const panel = vscode.window.createWebviewPanel(
        'webReplTerminal',
        `WebREPL — ${ip}`,
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'resource', 'webrepl'))] }
    );

    const termJsUri = panel.webview.asWebviewUri(
        vscode.Uri.file(path.join(context.extensionPath, 'resource', 'webrepl', 'term.js'))
    );
    const fileSaverUri = panel.webview.asWebviewUri(
        vscode.Uri.file(path.join(context.extensionPath, 'resource', 'webrepl', 'FileSaver.js'))
    );
    const cssUri = panel.webview.asWebviewUri(
        vscode.Uri.file(path.join(context.extensionPath, 'resource', 'webrepl', 'webrepl.css'))
    );

    // CSP: no external network needed — all traffic goes through extension host
    const csp = [
        `default-src 'none'`,
        `style-src 'unsafe-inline' ${panel.webview.cspSource}`,
        `script-src 'unsafe-inline' ${panel.webview.cspSource}`
    ].join('; ');

    panel.webview.html = getHtml(ip, csp, termJsUri, fileSaverUri, cssUri);

    // Connect WebREPL in extension host
    const client = new WebReplClient(ip, password);

    // ── Binary file-transfer state machine ──────────────────────────────────
    // States mirror the official webrepl.js:
    //   0  = REPL mode (normal terminal)
    //   11 = PUT: waiting for first WB OK (ready to receive data)
    //   12 = PUT: waiting for second WB OK (done)
    //   21 = GET: waiting for first WB OK
    //   22 = GET: receiving data chunks (loop: send ack, receive chunk)
    //   23 = GET: waiting for final WB OK
    let binaryState  = 0;
    let putName      = '';
    let putData      = null;   // Buffer
    let getName      = '';
    let getAccum     = [];     // accumulated bytes

    /** Send the 82-byte WebREPL PUT/GET header record */
    function sendWaHeader(type, name, fileSize = 0) {
        const rec = Buffer.alloc(2 + 1 + 1 + 8 + 4 + 2 + 64);
        rec.write('WA', 0, 'ascii');
        rec[2] = type;   // 1=PUT, 2=GET
        rec.writeUInt32LE(fileSize, 12);
        rec.writeUInt16LE(name.length, 16);
        Buffer.from(name).copy(rec, 18);
        client.send(rec);
    }

    function statusMsg(html) {
        panel.webview.postMessage({ type: 'fileStatus', html });
    }

    client.onConnect = () => {
        panel.webview.postMessage({ type: 'status', state: 'connected', ip });
    };

    let incomingBuf = Buffer.alloc(0);

    /** Decode a WebREPL binary response frame from the front of incomingBuf; 
     * returns { code: number, len: number } or null if not enough data. */
    function peekResp() {
        if (incomingBuf.length < 4) return null;
        if (incomingBuf[0] === 0x57 && incomingBuf[1] === 0x42) {
            return { code: incomingBuf[2] | (incomingBuf[3] << 8), len: 4 };
        }
        return null;
    }

    /** Send the 82-byte WebREPL PUT/GET header record */
    function sendWaHeader(type, name, fileSize = 0) {
        const rec = Buffer.alloc(2 + 1 + 1 + 8 + 4 + 2 + 64);
        rec.write('WA', 0, 'ascii');
        rec[2] = type;   // 1=PUT, 2=GET
        rec.writeUInt32LE(fileSize, 12);
        rec.writeUInt16LE(name.length, 16);
        Buffer.from(name).copy(rec, 18);
        client.send(rec);
    }

    function statusMsg(html) {
        panel.webview.postMessage({ type: 'fileStatus', html });
    }

    client.onConnect = () => {
        panel.webview.postMessage({ type: 'status', state: 'connected', ip });
    };

    async function processIncoming() {
        while (incomingBuf.length > 0) {
            if (binaryState === 0) {
                // Normal REPL output → forward to terminal
                panel.webview.postMessage({ type: 'output', data: Array.from(incomingBuf) });
                incomingBuf = Buffer.alloc(0);
                return;
            }

            // ── File transfer protocol handling ──────────────────────────────
            if (binaryState === 11) {
                // PUT: board acknowledged header, now send file data
                const resp = peekResp();
                if (!resp) return; 
                incomingBuf = incomingBuf.slice(resp.len);

                if (resp.code === 0) {
                    // Send chunks with flow control to avoid ECONNRESET
                    for (let off = 0; off < putData.length; off += 1024) {
                        client.send(putData.slice(off, off + 1024));
                        if (off % 4096 === 0) { // Small pause every 4KB
                            await new Promise(r => setTimeout(r, 5));
                        }
                    }
                    binaryState = 12;
                } else {
                    statusMsg(`<span style="color:#f44">Failed to start sending ${putName}</span>`);
                    binaryState = 0;
                }

            } else if (binaryState === 12) {
                // PUT: board confirmed all data received
                const resp = peekResp();
                if (!resp) return;
                incomingBuf = incomingBuf.slice(resp.len);

                if (resp.code === 0) {
                    statusMsg(`Sent <b>${putName}</b>, ${putData.length} bytes`);
                } else {
                    statusMsg(`<span style="color:#f44">Send failed: ${putName}</span>`);
                }
                binaryState = 0;

            } else if (binaryState === 21) {
                // GET: board acknowledged header
                const resp = peekResp();
                if (!resp) return;
                incomingBuf = incomingBuf.slice(resp.len);

                if (resp.code === 0) {
                    binaryState = 22;
                    client.send(Buffer.from([0])); // ack: send next chunk
                } else {
                    statusMsg(`<span style="color:#f44">File not found: ${getName}</span>`);
                    binaryState = 0;
                }

            } else if (binaryState === 22) {
                // GET: receive data chunk [sz_lo, sz_hi, ...data]
                if (incomingBuf.length < 2) return;
                const sz = incomingBuf[0] | (incomingBuf[1] << 8);
                
                if (sz === 0) {
                    incomingBuf = incomingBuf.slice(2);
                    binaryState = 23;
                } else {
                    if (incomingBuf.length < 2 + sz) return; // Wait for full chunk
                    const chunk = incomingBuf.slice(2, 2 + sz);
                    for (let i = 0; i < chunk.length; i++) getAccum.push(chunk[i]);
                    incomingBuf = incomingBuf.slice(2 + sz);
                    
                    statusMsg(`Getting <b>${getName}</b>… ${getAccum.length} bytes`);
                    client.send(Buffer.from([0])); // ack next chunk
                    // Loop to next chunk or final status
                }

            } else if (binaryState === 23) {
                // GET: final status
                const resp = peekResp();
                if (!resp) return;
                incomingBuf = incomingBuf.slice(resp.len);

                if (resp.code === 0) {
                    statusMsg(`Got <b>${getName}</b>, ${getAccum.length} bytes`);
                    panel.webview.postMessage({
                        type: 'fileData',
                        name: getName,
                        bytes: getAccum
                    });
                } else {
                    statusMsg(`<span style="color:#f44">Get failed: ${getName}</span>`);
                }
                binaryState = 0;
            }
        }
    }

    client.onData = (buf) => {
        incomingBuf = Buffer.concat([incomingBuf, buf]);
        processIncoming();
    };

    client.onDisconnect = (reason) => {
        binaryState = 0;
        panel.webview.postMessage({ type: 'status', state: 'disconnected', reason });
    };

    // Forward keystrokes / file commands from webview → board
    panel.webview.onDidReceiveMessage((msg) => {
        if (msg.type === 'input') {
            if (binaryState !== 0) return; // ignore keystrokes during file transfer
            client.sendText(Buffer.from(msg.data));
        } else if (msg.type === 'putFile') {
            if (binaryState !== 0) return;
            putName = msg.name;
            putData = Buffer.from(msg.bytes);
            binaryState = 11;
            statusMsg(`Sending <b>${putName}</b>…`);
            sendWaHeader(1, putName, putData.length);
        } else if (msg.type === 'getFile') {
            if (binaryState !== 0) return;
            getName = msg.name;
            getAccum = [];
            binaryState = 21;
            statusMsg(`Getting <b>${getName}</b>…`);
            sendWaHeader(2, getName);
        }
    });

    panel.onDidDispose(() => client.disconnect());

    client.connect();
}

// ─── Webview HTML ─────────────────────────────────────────────────────────────

function getHtml(ip, csp, termJsUri, fileSaverUri, cssUri) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WebREPL — ${ip}</title>
    <link rel="stylesheet" href="${cssUri}">
</head>
<body>

<header class="header">
    <div class="device-info">
        <span style="font-weight: 600; font-size: 13px;">WebREPL Console</span>
        <div class="status-badge">
            <span id="status-dot"></span>
            <span id="status-text">Connecting...</span>
        </div>
        <span style="font-size: 11px; opacity: 0.7;">${ip}</span>
    </div>
    <div class="header-actions">
        <button onclick="window.location.reload()" title="Hard Refresh UI">Refresh</button>
    </div>
</header>

<div id="main-area">
    <div id="term-wrap">
        <div id="term"></div>
    </div>
    
    <aside id="sidebar">
        <div>
            <span class="section-title">Transfer Controls</span>
            <div class="card">
                <div class="file-input-group">
                    <label style="font-size: 11px; opacity: 0.8;">Send to Device</label>
                    <input type="file" id="put-file-select" title="Choose file to upload">
                    <div id="put-file-list" style="color:var(--vscode-descriptionForeground); font-size:10px; margin-top:2px">No file selected</div>
                    <button id="put-file-button" class="btn" onclick="putFile()" disabled>
                        <span>↑</span> Upload File
                    </button>
                </div>
                
                <div class="file-input-group" style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border-color);">
                    <label style="font-size: 11px; opacity: 0.8;">Download from Device</label>
                    <input type="text" id="get_filename" placeholder="/main.py">
                    <button class="btn" onclick="getFile()">
                        <span>↓</span> Download File
                    </button>
                </div>
            </div>
        </div>

        <div>
            <span class="section-title">Transfer Status</span>
            <div class="card" id="file-status-container">
                <div id="file-status">Ready</div>
            </div>
        </div>

        <div style="margin-top: auto;">
            <div style="font-size: 10px; opacity: 0.5; text-align: center;">
                MicroPython Studio WebREPL v1.1
            </div>
        </div>
    </aside>
</div>

<script src="${termJsUri}"></script>
<script src="${fileSaverUri}"></script>
<script>
const vscodeApi = acquireVsCodeApi();

// --- Terminal setup ---
function calcSize() {
    const wrap = document.getElementById('term-wrap');
    return [
        Math.max(80, Math.min(220, (wrap.clientWidth - 24) / 7.2) | 0),
        Math.max(20, Math.min(100, (wrap.clientHeight - 24) / 14) | 0)
    ];
}

var term;
window.onload = function() {
    var [cols, rows] = calcSize();
    term = new Terminal({ 
        cols: cols, 
        rows: rows, 
        useStyle: true, 
        screenKeys: true, 
        cursorBlink: true,
        theme: {
            background: '#1e1e1e',
            foreground: '#cccccc',
            cursor: '#aeafad',
            selection: '#3a3d41'
        }
    });
    term.open(document.getElementById('term'));
    term.on('data', function(data) {
        var bytes = Array.from(new TextEncoder().encode(data));
        vscodeApi.postMessage({ type: 'input', data: bytes });
    });
    
    // Initial focus
    setTimeout(() => term.focus(), 100);
};

window.addEventListener('resize', function() {
    if (term) { var [c,r] = calcSize(); term.resize(c,r); }
});

// --- Message bridge ---
window.addEventListener('message', function(event) {
    const msg = event.data;
    if (msg.type === 'output') {
        const str = new TextDecoder().decode(new Uint8Array(msg.data));
        term.write(str);
    } else if (msg.type === 'status') {
        const dot = document.getElementById('status-dot');
        const txt = document.getElementById('status-text');
        if (msg.state === 'connected') {
            dot.className = 'ok';
            txt.textContent = 'CONNECTED';
            term.write('\\x1b[38;5;48m✔ WebREPL connected to ${ip}\\x1b[m\\r\\n');
        } else {
            dot.className = '';
            txt.textContent = 'DISCONNECTED';
            term.write('\\x1b[38;5;203m✘ Disconnected: ' + (msg.reason || 'Server closed') + '\\x1b[m\\r\\n');
        }
    } else if (msg.type === 'fileStatus') {
        document.getElementById('file-status').innerHTML = msg.html;
    } else if (msg.type === 'fileData') {
        saveAs(new Blob([new Uint8Array(msg.bytes)], {type:'application/octet-stream'}), msg.name);
    }
});

// --- File transfer ---
var _putName = null, _putData = null;

document.getElementById('put-file-select').addEventListener('change', function(evt) {
    var f = evt.target.files[0];
    if (!f) return;
    _putName = f.name;
    var reader = new FileReader();
    reader.onload = function(e) {
        _putData = new Uint8Array(e.target.result);
        document.getElementById('put-file-list').textContent = f.name + ' (' + (_putData.length/1024).toFixed(1) + ' KB)';
        document.getElementById('put-file-button').disabled = false;
    };
    reader.readAsArrayBuffer(f);
});

function putFile() {
    if (!_putName || !_putData) return;
    document.getElementById('file-status').innerHTML = '<span class="file-status-icon">⌛</span> Sending...';
    vscodeApi.postMessage({ type: 'putFile', name: _putName, bytes: Array.from(_putData) });
}

function getFile() {
    var name = document.getElementById('get_filename').value.trim();
    if (!name) return;
    document.getElementById('file-status').innerHTML = '<span class="file-status-icon">⌛</span> Requesting...';
    vscodeApi.postMessage({ type: 'getFile', name });
}
</script>
</body>
</html>`;
}

module.exports = { openWebReplTerminal };
