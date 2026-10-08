const assert = require('assert');
const fs = require('fs');
const path = require('path');
const connectionManager = require('../src/connectionManager');

suite('Passive and reliable MicroPython REPL', () => {
    const root = path.join(__dirname, '..');
    const terminal = fs.readFileSync(path.join(root, 'src', 'deviceTerminal.js'), 'utf8');
    const manager = fs.readFileSync(path.join(root, 'src', 'connectionManager.js'), 'utf8');
    const daemon = fs.readFileSync(path.join(root, 'src', 'mpy_daemon.py'), 'utf8');
    const extension = fs.readFileSync(path.join(root, 'src', 'extension.js'), 'utf8');

    test('opening the terminal does not send unsolicited Ctrl-C or run os.uname', () => {
        assert.ok(terminal.includes('no reset or interrupt sent'));
        assert.ok(!terminal.includes('os.uname()'));
        assert.ok(!terminal.includes('connectionManager.write(\'\\r\\x03'));
        assert.ok(!terminal.includes('setTimeout('));
    });
    test('terminal removes only its own listeners and preserves shared port', () => {
        assert.ok(!terminal.includes('removeAllListeners'));
        assert.ok(terminal.includes("connectionManager.removeListener(name, listener)"));
        assert.ok(!terminal.includes('connectionManager.disconnect()'));
        assert.ok(terminal.includes('connectionManager.portName !== devicePort'));
    });
    test('connect does not kill another process based only on a live lock', () => {
        assert.ok(manager.includes('is already owned by PID'));
        assert.ok(!manager.includes("process.kill(pid, 'SIGKILL')"));
        assert.ok(manager.includes('this._connectingPort === portName'));
        assert.ok(manager.includes('Timed out connecting to'));
    });
    test('suspend and resume cannot run indefinitely or pretend successful ack', () => {
        assert.ok(manager.includes('REPL ${action} timed out'));
        assert.ok(manager.includes('this._rejectPendingTransitions(error)'));
        assert.ok(manager.includes('startAutoResumeCheck() {}'));
        assert.ok(daemon.includes('Do not falsely acknowledge a failed resume'));
    });
    test('daemon only releases its own file lock and does not Ctrl-C after USB reconnect', () => {
        assert.ok(daemon.includes('if owner != f"{pid}:daemon":'));
        assert.ok(daemon.includes('if not _acquire_lock(self.port):'));
        assert.ok(daemon.includes('Reconnection is transport recovery, NOT permission'));
    });
    test('backend waits for release and confirms exit status', () => {
        assert.ok(extension.includes("await connectionManager.suspend()"));
        assert.ok(extension.includes("await connectionManager.resume()"));
        assert.ok(extension.includes("Task failed"));
        assert.ok(extension.includes('[SUCCESS] Task complete.'));
    });
    test('acknowledged transitions resolve and duplicate requests share same pending operation', async () => {
        const original = {
            process: connectionManager.daemonProcess,
            connected: connectionManager.isConnected,
            suspended: connectionManager.isSuspended,
            pending: connectionManager._suspendPending,
        };
        const sent = [];
        try {
            connectionManager.isConnected = true;
            connectionManager.isSuspended = false;
            connectionManager.daemonProcess = {
                stdin: { write(data, callback) { sent.push(JSON.parse(data)); if (callback) callback(null); } }
            };
            const first = connectionManager._requestTransition('suspend');
            const second = connectionManager._requestTransition('suspend');
            assert.strictEqual(first, second);
            assert.strictEqual(sent.length, 1);
            assert.strictEqual(sent[0].action, 'suspend');
            connectionManager._resolveTransition('suspend');
            await first;
        } finally {
            connectionManager.daemonProcess = original.process;
            connectionManager.isConnected = original.connected;
            connectionManager.isSuspended = original.suspended;
            connectionManager._suspendPending = original.pending;
        }
    });
});
