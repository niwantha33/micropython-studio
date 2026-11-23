'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

suite('Interactive Shell output through the real terminal controller', () => {
    test('saved com7 reuses COM7 and forwards main.fxn output and Ctrl+C', async () => {
        const manager = new EventEmitter();
        Object.assign(manager, {
            isConnected: true, portName: 'COM7', isSuspended: false,
            isLocked: false, isScriptRunning: false
        });
        let connects = 0, pty, terminal;
        const writes = [], output = [];
        manager.connect = async () => { connects++; };
        manager.write = async data => { writes.push(data); };
        const module = { exports: {} };
        class OutputEmitter {
            constructor() { this.event = listener => { this.listener = listener; }; }
            fire(value) { this.listener?.(value); }
            dispose() {}
        }
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/deviceTerminal.js'), 'utf8'), {
            module, exports: module.exports, Buffer,
            require(name) {
                if (name === './connectionManager') return manager;
                if (name === './stopExecution') return {
                    stopExecution: async port => {
                        assert.strictEqual(port, 'com7');
                        writes.push(Buffer.from([3]));
                    }
                };
                if (name === './debugExecutionState') return {
                    onDebugExecutionState: () => ({ dispose() {} }),
                    getDebugExecutionState: () => ({ status: 'detached' })
                };
                if (name === 'vscode') return {
                    EventEmitter: OutputEmitter,
                    window: { createTerminal(options) {
                        pty = options.pty;
                        pty.onDidWrite(value => output.push(value));
                        terminal = { show() {}, dispose() { pty.close(); } };
                        return terminal;
                    } }
                };
                return require(name.startsWith('./') ? '../src/' + name.slice(2) : name);
            }
        });
        await module.exports.openDeviceTerminal({}, 'com7');
        await pty.open();
        assert.strictEqual(connects, 0, 'case differences must not reconnect/reset the shared CDC');
        output.length = 0;
        await pty.handleInput('main.fxn()\r');
        for (const part of [Buffer.from('first\r\n'), Buffer.from([0xc3]), Buffer.from([0xa9]), Buffer.from('\r\nsecond\r\n')]) {
            manager.emit('data', part);
        }
        assert.strictEqual(output.join(''), 'first\r\né\r\nsecond\r\n');
        assert.strictEqual(manager.isScriptRunning, false, 'direct REPL execution requires no Run-button bookkeeping');
        await pty.handleInput('\x03');
        assert.strictEqual(writes[0].toString(), 'main.fxn()\r');
        assert.strictEqual(writes[1][0], 3);
        // Raw operations may mark the REPL busy. Ctrl+C must still reach
        // the emergency Stop path while ordinary input stays blocked.
        manager.isLocked = true;
        await pty.handleInput('print("blocked")\r');
        assert.strictEqual(writes.length, 2, 'busy REPL must not accept ordinary input');
        await pty.handleInput('\x03');
        assert.strictEqual(writes.length, 3, 'Ctrl+C must bypass the busy-input gate');
        assert.strictEqual(writes[2][0], 3);
        terminal.dispose();
        assert.strictEqual(manager.listenerCount('data'), 0);
    });
});
