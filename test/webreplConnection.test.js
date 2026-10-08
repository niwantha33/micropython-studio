'use strict';

const assert = require('assert');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebReplClient } = require('../src/webreplClient');

function serverFrame(message) {
    const data = Buffer.from(message);
    if (data.length < 126) return Buffer.concat([Buffer.from([0x81,data.length]),data]);
    const head = Buffer.alloc(4);
    head[0] = 0x81; head[1] = 126; head.writeUInt16BE(data.length,2);
    return Buffer.concat([head,data]);
}
function wsUpgrade(headers) {
    const match = headers.match(/Sec-WebSocket-Key:\s*([^\r\n]+)/i);
    assert.ok(match, 'client did not send Sec-WebSocket-Key');
    const accept = crypto.createHash('sha1')
        .update(match[1].trim() + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    return 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n';
}

async function createServer(onData) {
    const srv = net.createServer(socket => {
        let buffer = Buffer.alloc(0), upgraded = false;
        socket.on('data', bytes => {
            buffer = Buffer.concat([buffer,bytes]);
            if (!upgraded) {
                const sep = buffer.indexOf('\r\n\r\n');
                if (sep < 0) return;
                const header = buffer.subarray(0,sep+4).toString();
                buffer = buffer.subarray(sep+4);
                upgraded = true;
                onData({type:'handshake', socket, header});
            }
            while (buffer.length >= 6) {
                const b1 = buffer[1], masked = !!(b1 & 0x80), size = b1 & 127;
                if (size >= 126 || !masked || buffer.length < 6+size) break;
                const mask = buffer.subarray(2,6), payload = Buffer.from(buffer.subarray(6,6+size));
                for (let i=0;i<size;i++) payload[i] ^= mask[i%4];
                const opcode = buffer[0] & 15;
                buffer = buffer.subarray(6+size);
                onData({type:'frame', socket, opcode, payload});
            }
        });
    });
    await new Promise((resolve,reject) => srv.once('error',reject).listen(0,'127.0.0.1',resolve));
    return srv;
}
function awaitSignal(setup, timeoutMs = 3000) {
    return new Promise((resolve,reject) => {
        const timer = setTimeout(() => reject(new Error('mock socket operation timed out')),timeoutMs);
        setup((...items) => {clearTimeout(timer); resolve(items);});
    });
}

suite('WebREPL terminal handshake, authentication and lifecycle', function() {
    this.timeout(7000);
    test('sends password in TEXT frame and connects only after server approves login', async () => {
        const received = [], secret = 'mock-password-not-logged';
        const srv = await createServer(({type,socket,header,opcode,payload}) => {
            if (type === 'handshake') {
                socket.write(wsUpgrade(header));
                socket.write(serverFrame('Pass'));
                socket.write(serverFrame('word: '));
            } else if (type === 'frame') {
                received.push({opcode,payload:payload.toString()});
                if (received.length === 1) {
                    socket.write(serverFrame('WebREPL con'));
                    socket.write(serverFrame('nected\r\n>>> '));
                }
            }
        });
        const client = new WebReplClient('127.0.0.1',secret,srv.address().port);
        try {
            const signal = await awaitSignal(done => {
                client.onConnect = () => done();
                client.onDisconnect = reason => done('failed',reason);
                client.connect();
            });
            assert.deepStrictEqual(signal,[]);
            assert.strictEqual(client.state,'connected');
            assert.strictEqual(received.length,1);
            assert.strictEqual(received[0].opcode,1);
            assert.strictEqual(received[0].payload,secret + '\r\n');
            client.sendText('help()\r\n');
            await new Promise(resolve=>setTimeout(resolve,30));
            assert.strictEqual(received[1].opcode,1);
            assert.strictEqual(received[1].payload,'help()\r\n');
        } finally { client.disconnect(); await new Promise(r=>srv.close(r)); }
    });
    test('invalid password is reported; no premature onConnect', async () => {
        const srv = await createServer(({type,socket,header}) => {
            if(type==='handshake') socket.write(wsUpgrade(header)+serverFrame('Password: ').toString('binary'),'binary');
            else socket.write(serverFrame('Access denied\r\n'));
        });
        const client = new WebReplClient('127.0.0.1','incorrect',srv.address().port);
        let connected=false;
        try {
            const result = await awaitSignal(done => {
                client.onConnect = () => {connected=true; done('connected');};
                client.onDisconnect = reason => done(reason);
                client.connect();
            });
            assert.strictEqual(connected,false);
            assert.match(result[0],/password rejected/i);
        } finally { client.disconnect(); await new Promise(r=>srv.close(r)); }
    });
    test('rejects non-101 HTTP responses instead of hanging CONNECTING', async () => {
        const srv = await createServer(({type,socket}) => {
            if(type==='handshake') socket.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
        });
        const client = new WebReplClient('127.0.0.1','ignored',srv.address().port);
        try {
            const msg = await awaitSignal(done => {
                client.onDisconnect = reason => done(reason);
                client.connect();
            });
            assert.match(msg[0],/rejected WebSocket upgrade.*404/);
        } finally { client.disconnect(); await new Promise(r=>srv.close(r)); }
    });
    test('UI waits for ready and supports real reconnect instead of webview reload', () => {
        const text=fs.readFileSync(path.join(__dirname,'..','src','webrepl_bridge.py'),'utf8');
        assert.ok(text.includes("if (msg.type === 'ready')"));
        assert.ok(text.includes("if (msg.type === 'reconnect')"));
        assert.ok(text.includes("vscodeApi.postMessage({ type: 'ready' })"));
        assert.ok(text.includes("const { WebReplClient } = require('./webreplClient')"));
        assert.ok(!text.includes('window.location.reload()'));
    });
});
