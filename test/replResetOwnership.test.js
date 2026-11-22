'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const connectionManager = require('../src/connectionManager');
const wsQueue = require('../src/wsQueue');

suite('Shared COM reset and REPL ownership regression', () => {
    const root = path.join(__dirname, '..');
    const extension = fs.readFileSync(path.join(root, 'src', 'extension.js'), 'utf8');
    const daemon = fs.readFileSync(path.join(root, 'src', 'mpy_daemon.py'), 'utf8');
    const backend = fs.readFileSync(path.join(root, 'src', 'mps_backend.py'), 'utf8');

    test('hard reset goes through active daemon rather than second serial owner', () => {
        assert.ok(extension.includes('connectionManager.hardReset()'));
        assert.ok(extension.includes("'Hard Reset (shared REPL)', true"));
        assert.ok(extension.includes('if (code !== 0)'));
        assert.ok(daemon.includes('elif action == "hard_reset":'));
        assert.ok(daemon.includes('self.send_event("reset_result"'));
        assert.ok(daemon.includes('self._lock = threading.RLock()'));
        assert.ok(!backend.includes('_kill_port_owner('));
        assert.ok(!backend.includes('_kill_comport_processes('));
        assert.ok(!backend.includes('taskkill'));
        assert.ok(!backend.includes('os.kill(pid, 9)'));
    });

    test('acknowledged reset resolves once and duplicate requests share the same promise', async () => {
        const original = {
            connected: connectionManager.isConnected,
            suspended: connectionManager.isSuspended,
            process: connectionManager.daemonProcess,
            pending: connectionManager._resetPending,
            next: connectionManager._nextReqId,
        };
        const commands = [];
        try {
            connectionManager.isConnected = true;
            connectionManager.isSuspended = false;
            connectionManager._resetPending = null;
            connectionManager.daemonProcess = {
                stdin: { write(data, cb) { commands.push(JSON.parse(data)); if (cb) cb(null); } }
            };
            const first = connectionManager.hardReset();
            const same = connectionManager.hardReset();
            assert.strictEqual(first, same);
            assert.strictEqual(commands.length, 1);
            assert.strictEqual(commands[0].action, 'hard_reset');
            connectionManager._handleDaemonMessage(
                { type: 'reset_result', id: commands[0].id, success: true },
                () => {}, () => {}, true
            );
            await first;
            assert.strictEqual(connectionManager._resetPending, null);
        } finally {
            if (connectionManager._resetPending) {
                clearTimeout(connectionManager._resetPending.timer);
                connectionManager._resetPending = null;
            }
            connectionManager.isConnected = original.connected;
            connectionManager.isSuspended = original.suspended;
            connectionManager.daemonProcess = original.process;
            connectionManager._resetPending = original.pending;
            connectionManager._nextReqId = original.next;
        }
    });

    test('reset failure from daemon is reported rather than mistaken for success', async () => {
        const old = {
            connected: connectionManager.isConnected,
            suspended: connectionManager.isSuspended,
            process: connectionManager.daemonProcess,
            pending: connectionManager._resetPending,
        };
        let message;
        try {
            connectionManager.isConnected = true;
            connectionManager.isSuspended = false;
            connectionManager._resetPending = null;
            connectionManager.daemonProcess = {
                stdin: { write(data, callback) { message = JSON.parse(data); callback?.(null); } }
            };
            const pending = connectionManager.hardReset();
            connectionManager._handleDaemonMessage(
                { type: 'reset_result', id: message.id, success: false, error: 'port busy' },
                () => {}, () => {}, true
            );
            await assert.rejects(pending, /port busy/);
        } finally {
            if (connectionManager._resetPending) clearTimeout(connectionManager._resetPending.timer);
            connectionManager._resetPending = old.pending;
            connectionManager.isConnected = old.connected;
            connectionManager.isSuspended = old.suspended;
            connectionManager.daemonProcess = old.process;
        }
    });

    test('do not wait twelve seconds on our own suspended lock', async () => {
        const old = {
            port: connectionManager.portName,
            connected: connectionManager.isConnected,
            suspended: connectionManager.isSuspended,
        };
        let called = false;
        try {
            connectionManager.portName = 'COM999';
            connectionManager.isConnected = true;
            connectionManager.isSuspended = true;
            await assert.rejects(
                wsQueue.run(async () => { called = true; }, 'Hard Reset'),
                /suspended by another device operation/
            );
            assert.strictEqual(called, false);
        } finally {
            connectionManager.portName = old.port;
            connectionManager.isConnected = old.connected;
            connectionManager.isSuspended = old.suspended;
        }
    });
});
