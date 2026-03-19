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

    /** Decode a WebREPL binary response frame; returns numeric code or -1 */
    function decodeResp(buf) {
        if (buf.length >= 4 && buf[0] === 0x57 && buf[1] === 0x42) {
            return buf[2] | (buf[3] << 8);
        }
        return -1;
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

    client.onData = (buf) => {
        if (binaryState === 0) {
            // Normal REPL output → forward to terminal
            panel.webview.postMessage({ type: 'output', data: Array.from(buf) });
            return;
        }

        // ── File transfer protocol handling ──────────────────────────────
        const code = decodeResp(buf);

        if (binaryState === 11) {
            // PUT: board acknowledged header, now send file data
            if (code === 0) {
                for (let off = 0; off < putData.length; off += 1024) {
                    client.send(putData.slice(off, off + 1024));
                }
                binaryState = 12;
            } else {
                statusMsg(`<span style="color:#f44">Failed to start sending ${putName}</span>`);
                binaryState = 0;
            }

        } else if (binaryState === 12) {
            // PUT: board confirmed all data received
            if (code === 0) {
                statusMsg(`Sent <b>${putName}</b>, ${putData.length} bytes`);
            } else {
                statusMsg(`<span style="color:#f44">Send failed: ${putName}</span>`);
            }
            binaryState = 0;

        } else if (binaryState === 21) {
            // GET: board acknowledged header
            if (code === 0) {
                binaryState = 22;
                client.send(Buffer.from([0])); // ack: send next chunk
            } else {
                statusMsg(`<span style="color:#f44">File not found: ${getName}</span>`);
                binaryState = 0;
            }

        } else if (binaryState === 22) {
            // GET: receive data chunk [sz_lo, sz_hi, ...data]
            if (buf.length >= 2) {
                const sz = buf[0] | (buf[1] << 8);
                if (sz === 0) {
                    binaryState = 23;
                } else if (buf.length === 2 + sz) {
                    const chunk = buf.slice(2);
                    for (let i = 0; i < chunk.length; i++) getAccum.push(chunk[i]);
                    statusMsg(`Getting <b>${getName}</b>… ${getAccum.length} bytes`);
                    client.send(Buffer.from([0])); // ack next chunk
                } else {
                    // Malformed — abort
                    statusMsg(`<span style="color:#f44">Protocol error getting ${getName}</span>`);
                    binaryState = 0;
                }
            }

        } else if (binaryState === 23) {
            // GET: final status
            if (code === 0) {
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
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <title>WebREPL — ${ip}</title>
    <link rel="stylesheet" href="${cssUri}">
    <style>
        * { box-sizing: border-box; }
        body { display:flex; flex-direction:column; height:100vh; overflow:hidden; margin:0; }
        .toolbar { flex-shrink:0; display:flex; align-items:center; gap:8px;
                   padding:5px 8px; background:#252526; border-bottom:1px solid #3c3c3c; }
        #status-dot { width:9px; height:9px; border-radius:50%; background:#f44; display:inline-block; }
        #status-dot.ok { background:#4c4; }
        #status-text { font-size:12px; color:#9d9d9d; }
        #main-area { display:flex; flex:1; overflow:hidden; }
        #term-wrap { flex:1; overflow:hidden; padding:4px 2px; }
        #sidebar { width:210px; flex-shrink:0; overflow-y:auto; padding:4px;
                   border-left:1px solid #3c3c3c; }
    </style>
</head>
<body>
<div class="toolbar">
    <span id="status-dot"></span>
    <span id="status-text">Connecting to ${ip}:8266...</span>
</div>
<div id="main-area">
    <div id="term-wrap"><div id="term"></div></div>
    <div id="sidebar">
        <div class="file-box">
            <strong>Send file to device</strong><br>
            <input type="file" id="put-file-select" style="margin:4px 0;width:100%">
            <div id="put-file-list" style="color:#9d9d9d;font-size:11px;margin:2px 0"></div>
            <input type="button" value="Send to device" id="put-file-button"
                   onclick="putFile()" style="width:100%;margin-top:4px" disabled>
        </div>
        <div class="file-box" style="margin-top:6px">
            <strong>Get file from device</strong><br>
            <input type="text" id="get_filename" placeholder="/main.py"
                   style="width:100%;margin:4px 0">
            <input type="button" value="Get from device" onclick="getFile()"
                   style="width:100%;margin-top:2px">
        </div>
        <div class="file-box" id="file-status" style="margin-top:6px">
            <span style="color:#9d9d9d;font-size:11px">(file transfer status)</span>
        </div>
    </div>
</div>

<script src="${termJsUri}"></script>
<script src="${fileSaverUri}"></script>
<script>
const vscodeApi = acquireVsCodeApi();

// ── Terminal setup ──────────────────────────────────────────────────────────
function calcSize() {
    return [
        Math.max(80, Math.min(200, (window.innerWidth - 230) / 7.2) | 0),
        Math.max(20, Math.min(80,  (window.innerHeight - 60) / 14) | 0)
    ];
}

var term;
window.onload = function() {
    var [cols, rows] = calcSize();
    term = new Terminal({ cols, rows, useStyle: true, screenKeys: true, cursorBlink: true });
    term.open(document.getElementById('term'));
    term.on('data', function(data) {
        var bytes = Array.from(new TextEncoder().encode(data));
        vscodeApi.postMessage({ type: 'input', data: bytes });
    });
};

window.addEventListener('resize', function() {
    if (term) { var [c,r] = calcSize(); term.resize(c,r); }
});

// ── Message bridge from extension host ─────────────────────────────────────
window.addEventListener('message', function(event) {
    const msg = event.data;
    if (msg.type === 'output') {
        // Convert byte array back to string for the terminal
        const str = String.fromCharCode.apply(null, msg.data);
        term.write(str);
    } else if (msg.type === 'status') {
        const dot = document.getElementById('status-dot');
        const txt = document.getElementById('status-text');
        if (msg.state === 'connected') {
            dot.className = 'ok';
            txt.textContent = 'Connected to ${ip}:8266';
            term.write('\\x1b[32mWebREPL connected\\x1b[m\\r\\n');
        } else {
            dot.className = '';
            txt.textContent = 'Disconnected: ' + (msg.reason || '');
            term.write('\\x1b[31m\\r\\nDisconnected\\x1b[m\\r\\n');
        }
    } else if (msg.type === 'fileStatus') {
        document.getElementById('file-status').innerHTML =
            '<span style="font-size:11px">' + msg.html + '</span>';
    } else if (msg.type === 'fileData') {
        // File received from device — trigger browser save dialog
        saveAs(new Blob([new Uint8Array(msg.bytes)], {type:'application/octet-stream'}), msg.name);
    }
});

// ── File transfer ───────────────────────────────────────────────────────────
var _putName = null, _putData = null;

document.getElementById('put-file-select').addEventListener('change', function(evt) {
    var f = evt.target.files[0];
    if (!f) return;
    _putName = f.name;
    var reader = new FileReader();
    reader.onload = function(e) {
        _putData = new Uint8Array(e.target.result);
        document.getElementById('put-file-list').textContent = f.name + ' - ' + _putData.length + ' bytes';
        document.getElementById('put-file-button').disabled = false;
    };
    reader.readAsArrayBuffer(f);
});

function putFile() {
    if (!_putName || !_putData) return;
    document.getElementById('file-status').innerHTML = 'Sending ' + _putName + '...';
    vscodeApi.postMessage({ type: 'putFile', name: _putName, bytes: Array.from(_putData) });
}

function getFile() {
    var name = document.getElementById('get_filename').value.trim();
    if (!name) return;
    document.getElementById('file-status').innerHTML = 'Getting ' + name + '...';
    vscodeApi.postMessage({ type: 'getFile', name });
}
</script>
</body>
</html>`;
}

module.exports = { openWebReplTerminal };
