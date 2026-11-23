'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function fixture() {
    const processes = [], views = [], events = [], timers = new Set();
    const vscode = {
        ViewColumn: { Beside: 2 },
        workspace: { workspaceFolders: [] },
        debug: { breakpoints: [], onDidChangeBreakpoints() { return { dispose() {} }; } },
        window: { createWebviewPanel() {
            let dispose;
            const view = {
                webview: { postMessage() { return Promise.resolve(true); },
                    onDidReceiveMessage() { return { dispose() {} }; } },
                reveal() {}, onDidDispose(fn) { dispose = fn; },
                dispose() { dispose?.(); }
            };
            views.push(view);
            return view;
        } }
    };
    const spawn = () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = new EventEmitter();
        child.commands = [];
        child.stdin.write = (line, callback) => {
            child.commands.push(JSON.parse(line));
            callback?.(null);
            return true;
        };
        child.kill = () => { child.killed = true; };
        processes.push(child);
        return child;
    };
    const module = { exports: {} };
    const source = fs.readFileSync(path.join(__dirname, '../src/mpyDebugger.js'), 'utf8');
    vm.runInNewContext(source, {
        module, exports: module.exports, Buffer, console,
        setTimeout(fn, ms) { const timer = { fn, ms, unref() {} }; timers.add(timer); return timer; },
        clearTimeout(timer) { timers.delete(timer); },
        require(name) {
            if (name === 'vscode') return vscode;
            if (name === 'child_process') return { spawn };
            if (name === './buildInfo') return { getBuildInfo: () => ({}) };
            return require(name.startsWith('./') ? '../src/' + name.slice(2) : name);
        }
    });
    const api = module.exports;
    const open = () => api.connectNativeDebugger({ extensionPath: '/extension' }, 'COM5', 'python', event => events.push(event));
    return { api, processes, views, events, timers, open };
}

suite('Debugger process lifecycle (real controller with fake child transport)', () => {
    test('detach gives Python time to release paused firmware before fallback kill', () => {
        const f = fixture();
        f.open();
        const first = f.processes[0];
        f.api.disconnectNativeDebugger();
        assert.strictEqual(first.commands.at(-1).op, 'quit');
        assert.ok(!first.killed, 'quit must reach Python before terminating its process');
        const timer = [...f.timers].find(t => t.ms === 2000);
        assert.ok(timer, 'unresponsive bridges still need bounded shutdown');
        timer.fn();
        assert.strictEqual(first.killed, true);
    });

    test('old child close and late stdout cannot terminate or command a new session', () => {
        const f = fixture();
        f.open();
        const first = f.processes[0];
        f.api.disconnectNativeDebugger();
        f.open();
        const next = f.processes[1];
        f.events.length = 0;
        first.stdout.emit('data', Buffer.from('{"evt":"open"}\n'));
        first.emit('close', 0, null);
        assert.strictEqual(next.commands.length, 0);
        assert.strictEqual(f.events.length, 0);
        assert.strictEqual(f.api.sendNativeCommand('continue'), true);
        assert.strictEqual(next.commands.at(-1).op, 'continue');
        f.api.disconnectNativeDebugger();
    });

    test('broken debugger stdin is handled without an uncaught pipe error', () => {
        const f = fixture();
        f.open();
        const child = f.processes[0];
        assert.doesNotThrow(() => child.stdin.emit('error', new Error('write EPIPE')));
        assert.ok(f.events.some(e => e.evt === 'transport_lost' && e.msg.includes('EPIPE')));
        f.api.disconnectNativeDebugger();
    });
});
