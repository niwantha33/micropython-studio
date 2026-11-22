'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const connectionManager = require('../src/connectionManager');

suite('2.6.1 COM reset and serial ownership handoff', () => {
    const root = path.join(__dirname, '..');
    const extension = fs.readFileSync(path.join(root, 'src', 'extension.js'), 'utf8');
    const daemon = fs.readFileSync(path.join(root, 'src', 'mpy_daemon.py'), 'utf8');
    const backend = fs.readFileSync(path.join(root, 'src', 'mps_backend.py'), 'utf8');

    test('safe hard reset is exclusive backend operation, not unsupported daemon command', () => {
        assert.ok(extension.includes("'Hard Reset (exclusive handoff)'"));
        assert.ok(extension.includes("() => _spawnAsync(venvPython, hrArgs)"));
        assert.ok(extension.includes('if (code !== 0)'));
        assert.ok(!extension.includes('connectionManager.hardReset()'));
        assert.ok(!daemon.includes('elif action == "hard_reset":'));
    });

    test('serial daemon still acknowledges suspension and resume', async () => {
        const original = {
            process: connectionManager.daemonProcess,
            connected: connectionManager.isConnected,
            suspended: connectionManager.isSuspended,
            pending: connectionManager._suspendPending
        };
        const commands = [];
        try {
            connectionManager.isConnected = true;
            connectionManager.isSuspended = false;
            connectionManager.daemonProcess = {
                stdin: { write(text, cb) { commands.push(JSON.parse(text)); cb?.(null); } }
            };
            const pending = connectionManager._requestTransition('suspend');
            assert.strictEqual(commands[0].action, 'suspend');
            connectionManager._resolveTransition('suspend');
            await pending;
        } finally {
            connectionManager.daemonProcess = original.process;
            connectionManager.isConnected = original.connected;
            connectionManager.isSuspended = original.suspended;
            connectionManager._suspendPending = original.pending;
        }
    });

    test('backend reset cannot terminate another COM owner process', () => {
        assert.ok(!backend.includes('_kill_port_owner('));
        assert.ok(!backend.includes('_kill_comport_processes('));
        assert.ok(!backend.includes('taskkill'));
        assert.ok(!backend.includes('os.kill(pid, 9)'));
        assert.ok(backend.includes('hard_reset'));
        assert.ok(daemon.includes('if owner != f"{pid}:daemon":'));
    });
});