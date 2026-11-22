'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const connectionManager = require('../src/connectionManager');

suite('Known-good 2.6.1 serial transport compatibility', () => {
    const root = path.join(__dirname, '..');
    const daemonSource = fs.readFileSync(path.join(root, 'src', 'mpy_daemon.py'), 'utf8');
    const terminalSource = fs.readFileSync(path.join(root, 'src', 'deviceTerminal.js'), 'utf8');
    const extensionSource = fs.readFileSync(path.join(root, 'src', 'extension.js'), 'utf8');

    test('retain 2.6.1 passive shell and existing daemon protocol', () => {
        assert.ok(terminalSource.includes('no reset or interrupt sent'));
        assert.ok(terminalSource.includes('Press Enter to see the REPL prompt'));
        assert.ok(!terminalSource.includes("connectionManager.disconnect()"));
        assert.ok(daemonSource.includes('if action == "terminal_input":'));
        assert.ok(daemonSource.includes('elif action == "run_in_terminal":'));
        assert.ok(!daemonSource.includes('elif action == "hard_reset":'));
        assert.ok(!daemonSource.includes('_run_terminal_worker'));
    });

    test('interactive input passes through existing shared daemon without a second COM owner', async () => {
        const original = {
            connected: connectionManager.isConnected,
            suspended: connectionManager.isSuspended,
            process: connectionManager.daemonProcess
        };
        const frames = [];
        try {
            connectionManager.isConnected = true;
            connectionManager.isSuspended = false;
            connectionManager.daemonProcess = {
                stdin: { write(data, cb) { frames.push(JSON.parse(data)); cb?.(null); } }
            };
            await connectionManager.write(Buffer.from('\rprint(1 + 1)\r', 'utf8'));
            assert.strictEqual(frames.length, 1);
            assert.strictEqual(frames[0].action, 'terminal_input');
            assert.strictEqual(Buffer.from(frames[0].data, 'base64').toString(), '\rprint(1 + 1)\r');
            await connectionManager.runInTerminal('print(2)');
            assert.strictEqual(frames[1].action, 'run_in_terminal');
            assert.strictEqual(frames[1].code, 'print(2)');
        } finally {
            connectionManager.isConnected = original.connected;
            connectionManager.isSuspended = original.suspended;
            connectionManager.daemonProcess = original.process;
        }
    });

    test('Hard Reset uses exclusive handoff, not an unsupported daemon action', () => {
        assert.ok(extensionSource.includes("'Hard Reset (exclusive handoff)'"));
        assert.ok(!extensionSource.includes('connectionManager.hardReset()'));
        assert.ok(extensionSource.includes("await wsQueue.run("));
        assert.ok(daemonSource.includes('_release_lock(self.port)'));
    });

    test('CLI backend never kills other processes to seize COM ports', () => {
        const backend = fs.readFileSync(path.join(root, 'src', 'mps_backend.py'), 'utf8');
        assert.ok(!backend.includes('_kill_port_owner('));
        assert.ok(!backend.includes('_kill_comport_processes('));
        assert.ok(!backend.includes('taskkill'));
    });
});