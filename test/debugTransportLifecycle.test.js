'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function fixture(withBreakpoint = false) {
    const processes = [], views = [], events = [], logs = [], timers = new Set();
    const vscode = {
        SourceBreakpoint: class { constructor() {
            this.enabled = true;
            this.location = { uri: { fsPath: '/test/main.py' }, range: { start: { line: 2 } } };
        } },
        ViewColumn: { Beside: 2 },
        workspace: { workspaceFolders: [] },
        debug: { breakpoints: [], onDidChangeBreakpoints() { return { dispose() {} }; } },
        window: { createOutputChannel() { return { appendLine(line) { logs.push(line); } }; }, createWebviewPanel() {
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
    if (withBreakpoint) vscode.debug.breakpoints.push(new vscode.SourceBreakpoint());
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
            if (name === 'fs') return { readFileSync(file, ...args) {
                if (file === '/test/main.py') return 'def fxn():\n    while True:\n        print("hello")\n';
                return fs.readFileSync(file, ...args);
            } };
            return require(name.startsWith('./') ? '../src/' + name.slice(2) : name);
        }
    });
    const api = module.exports;
    const open = () => api.connectNativeDebugger({ extensionPath: '/extension' }, 'COM5', 'python', event => events.push(event));
    return { api, processes, views, events, logs, timers, open };
}

suite('Debugger process lifecycle (real controller with fake child transport)', () => {
    test('detach lets Python clean up without automatically resuming the application', () => {
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

    test('a legacy locals reply confirms transport when clear-all is unsupported', () => {
        const f = fixture(true);
        f.open();
        const child = f.processes[0];
        child.stdout.emit('data', Buffer.from('{"evt":"open","port":"COM5"}\n'));
        assert.strictEqual(child.commands[0].op, 'clear_all_bp');
        [...f.timers].find(t => t.ms === 2000).fn();
        assert.strictEqual(child.commands.at(-1).op, 'locals');
        child.stdout.emit('data', Buffer.from('{"evt":"reply","text":"(not paused)"}\n'));
        assert.ok(f.events.some(e => e.evt === 'pump_ready' && e.legacy));
        const registration = child.commands.find(c => c.op === 'set_bp');
        assert.ok(registration, 'Legacy attach must register the actual source breakpoint');
        assert.strictEqual(registration.module, 'main');
        assert.strictEqual(registration.func, 'fxn');
        assert.strictEqual(registration.line, 2);
        child.stdout.emit('data', Buffer.from('{"evt":"reply","text":"bp 0 @ main.fxn:2 ip=8 fun=123"}\n'));
        assert.ok(f.events.some(e => e.evt === 'breakpoints' && e.items.some(bp => bp.state === 'VERIFIED')));
        child.stdout.emit('data', Buffer.from('{"evt":"bp_hit","ip":8,"fun":123}\n'));
        assert.ok(f.events.some(e => e.evt === 'bp_hit' && e.location?.line === 3));
        assert.ok(!child.commands.some(c => c.op === 'continue'));
        f.api.disconnectNativeDebugger();
    });

    test('unresponsive firmware retains diagnosis instead of closing the debug session', () => {
        const f = fixture();
        f.open();
        const child = f.processes[0];
        assert.ok(f.views[0].webview.html.includes('<span class="status-text">connecting</span>'));
        child.stdout.emit('data', Buffer.from('{"evt":"open","port":"COM5"}\n'));
        [...f.timers].find(t => t.ms === 8000).fn();
        assert.ok(f.events.some(e => e.evt === 'handshake_timeout'));
        assert.ok(!f.events.some(e => e.evt === 'closed' || e.evt === 'error'));
        assert.ok(f.logs.some(line => line.includes('firmware did not answer')));
        assert.ok(!child.killed);
        f.api.disconnectNativeDebugger();
        assert.ok(f.logs.length > 0, 'Closing the view must preserve the Output log');
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
