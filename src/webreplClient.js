'use strict';

const net = require('net');
const crypto = require('crypto');

const MAX_FRAME = 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 12000;

/**
 * WebREPL transport. MicroPython's WebREPL uses WebSocket TEXT frames for
 * password/terminal input, and BINARY frames only for file transfers.
 * This host-side client never accesses the board's filesystem or boot.py.
 */
class WebReplClient {
    constructor(host, password, port = 8266) {
        this.host = host;
        this.password = password;
        this.port = port;
        this.socket = null;
        this.onData = null;
        this.onConnect = null;
        this.onDisconnect = null;
        this._buf = Buffer.alloc(0);
        this._state = 'disconnected';
        this._authText = '';
        this._fragment = null;
        this._deadline = null;
        this._key = '';
        this._lastError = '';
    }

    get state() { return this._state; }

    connect() {
        this.disconnect();
        this._state = 'connecting';
        this._lastError = '';
        this._buf = Buffer.alloc(0);
        this._authText = '';
        this._fragment = null;
        const socket = net.createConnection({host: this.host, port: this.port});
        this.socket = socket;
        socket.setNoDelay(true);
        this._deadline = setTimeout(() => {
            this._fail('WebREPL did not complete its handshake/password login within 12 seconds. Check the server on port 8266.');
        }, HANDSHAKE_TIMEOUT_MS);
        socket.on('connect', () => {
            if (this.socket !== socket) return;
            this._key = crypto.randomBytes(16).toString('base64');
            socket.write(
                'GET / HTTP/1.1\r\n' +
                'Host: ' + this.host + ':' + this.port + '\r\n' +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                'Sec-WebSocket-Key: ' + this._key + '\r\n' +
                'Sec-WebSocket-Version: 13\r\n\r\n'
            );
        });
        socket.on('data', chunk => {
            if (this.socket !== socket || this._state === 'disconnected') return;
            try {
                this._buf = Buffer.concat([this._buf, chunk]);
                if (this._buf.length > MAX_FRAME + 20) throw new Error('WebREPL frame exceeds maximum size');
                if (this._state === 'connecting') this._parseHandshake();
                if (this._state === 'password' || this._state === 'authenticating' || this._state === 'connected') {
                    this._parseFrames();
                }
            } catch (error) { this._fail(error.message); }
        });
        socket.on('error', error => {
            if (this.socket === socket) this._fail('Cannot reach WebREPL ' + this.host + ':' + this.port + ': ' + error.message);
        });
        socket.on('close', () => {
            if (this.socket === socket && this._state !== 'disconnected')
                this._fail(this._lastError || 'WebREPL server closed the connection');
        });
    }

    _parseHandshake() {
        const i = this._buf.indexOf('\r\n\r\n');
        if (i < 0) {
            if (this._buf.length > 8192) throw new Error('WebREPL HTTP handshake too large');
            return;
        }
        const text = this._buf.subarray(0, i + 4).toString('ascii');
        this._buf = this._buf.subarray(i + 4);
        if (!/^HTTP\/1\.[01] 101(?: |\r\n)/.test(text)) {
            const status = text.split('\r\n')[0].slice(0, 160);
            throw new Error('WebREPL rejected WebSocket upgrade: ' + status);
        }
        const headers = {};
        for (const row of text.split('\r\n').slice(1)) {
            const colon = row.indexOf(':');
            if (colon > 0) headers[row.slice(0,colon).toLowerCase()] = row.slice(colon+1).trim();
        }
        const expected = crypto.createHash('sha1')
            .update(this._key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        if (headers['sec-websocket-accept'] !== expected)
            throw new Error('Invalid WebREPL WebSocket handshake');
        this._state = 'password';
    }

    _parseFrames() {
        while (this._buf.length >= 2) {
            const b0 = this._buf[0], b1 = this._buf[1];
            const opcode = b0 & 15, fin = !!(b0 & 128);
            let size = b1 & 127, off = 2;
            if (size === 126) {
                if (this._buf.length < 4) return;
                size = this._buf.readUInt16BE(2);
                off = 4;
            } else if (size === 127) {
                if (this._buf.length < 10) return;
                const high = this._buf.readUInt32BE(2), low = this._buf.readUInt32BE(6);
                if (high !== 0) throw new Error('WebREPL frame too large');
                size = low; off = 10;
            }
            if (size > MAX_FRAME) throw new Error('WebREPL frame too large');
            const masked = !!(b1 & 128);
            if (masked) throw new Error('WebREPL server must not mask frames');
            if (this._buf.length < off + size) return;
            const data = this._buf.subarray(off,off+size);
            this._buf = this._buf.subarray(off+size);

            if (opcode === 8) { this._fail('WebREPL server closed the connection'); return; }
            if (opcode === 9) { this._sendFrame(data, 10); continue; } // ping -> pong
            if (opcode === 10) continue;
            if (opcode === 0) {
                if (!this._fragment) throw new Error('Unexpected continuation frame');
                this._fragment.parts.push(data);
                this._fragment.size += data.length;
                if (this._fragment.size > MAX_FRAME) throw new Error('WebREPL fragmented message too large');
                if (!fin) continue;
                const joined = Buffer.concat(this._fragment.parts);
                const type = this._fragment.type;
                this._fragment = null;
                this._handleMessage(joined, type);
                continue;
            }
            if (opcode !== 1 && opcode !== 2) throw new Error('Invalid WebREPL frame opcode');
            if (!fin) {
                this._fragment = {type: opcode, parts:[data], size: data.length};
                continue;
            }
            this._handleMessage(data, opcode);
        }
    }

    _handleMessage(data, opcode) {
        if (this._state === 'connected') {
            this.onData?.(Buffer.from(data));
            return;
        }
        if (opcode !== 1) throw new Error('Unexpected binary response during WebREPL login');
        // Prompt and acknowledgement can arrive in separate packets/frames.
        this._authText += data.toString('utf8');
        if (this._authText.length > 8192) throw new Error('WebREPL login message too large');
        if (this._state === 'password') {
            if (/Password:\s*/i.test(this._authText)) {
                this._authText = '';
                this._state = 'authenticating';
                this.sendText(this.password + '\r\n');
            }
        } else if (this._state === 'authenticating') {
            if (/Access denied|invalid password|authentication failed/i.test(this._authText)) {
                this._fail('WebREPL password rejected. Check device.cfg and the board WebREPL configuration.');
                return;
            }
            if (/WebREPL connected|>>> ?/.test(this._authText)) {
                this._state = 'connected';
                clearTimeout(this._deadline);
                this._deadline = null;
                const welcome = this._authText;
                this._authText = '';
                this.onConnect?.();
                if (welcome) this.onData?.(Buffer.from(welcome, 'utf8'));
            }
        }
    }

    _sendFrame(data, opcode = 2) {
        if (!this.socket || this.socket.destroyed) throw new Error('WebREPL socket is disconnected');
        const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const mask = crypto.randomBytes(4);
        const encrypted = Buffer.allocUnsafe(payload.length);
        for (let i=0; i<payload.length; i++) encrypted[i] = payload[i] ^ mask[i%4];
        let hdr;
        if (payload.length < 126) hdr = Buffer.from([0x80|opcode,0x80|payload.length,...mask]);
        else if (payload.length < 65536) hdr = Buffer.from([0x80|opcode,0x80|126,
            payload.length >>> 8, payload.length & 255,...mask]);
        else hdr = Buffer.from([0x80|opcode,0x80|127,0,0,0,0,
            (payload.length >>>24)&255,(payload.length>>>16)&255,
            (payload.length>>>8)&255,payload.length&255,...mask]);
        return this.socket.write(Buffer.concat([hdr, encrypted]));
    }

    send(data) { if (this._state !== 'connected') throw new Error('WebREPL is not authenticated'); this._sendFrame(data,2); }
    sendText(data) {
        if (this._state !== 'connected' && this._state !== 'authenticating')
            throw new Error('WebREPL is not ready');
        this._sendFrame(data,1);
    }
    sendAsync(data) {
        return new Promise((resolve,reject) => {
            try {
                if (this._state !== 'connected') throw new Error('WebREPL is not authenticated');
                if (this._sendFrame(data,2)) resolve();
                else this.socket.once('drain',resolve);
            } catch(e) { reject(e); }
        });
    }
    _fail(message) {
        if (this._state === 'disconnected') return;
        this._lastError = message;
        this._state = 'disconnected';
        clearTimeout(this._deadline);
        this._deadline = null;
        const socket = this.socket;
        this.socket = null;
        if (socket) socket.destroy();
        this.onDisconnect?.(message);
    }
    disconnect() {
        if (this._state === 'disconnected') return;
        this._state = 'disconnected';
        clearTimeout(this._deadline);
        this._deadline = null;
        if (this.socket) this.socket.destroy();
        this.socket = null;
    }
}
module.exports = { WebReplClient, HANDSHAKE_TIMEOUT_MS };
