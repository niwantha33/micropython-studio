'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const connectionManager = require('../src/connectionManager');
const wsQueue = require('../src/wsQueue');

suite('Single-owner serial stream across Studio features', () => {
    const root = path.join(__dirname, '..');
    const daemon = fs.readFileSync(path.join(root, 'src', 'mpy_daemon.py'), 'utf8');
    const extension = fs.readFileSync(path.join(root, 'src', 'extension.js'), 'utf8');
    const terminal = fs.readFileSync(path.join(root, 'src', 'deviceTerminal.js'), 'utf8');

    test('host handles Run acknowledgement, stream lifecycle and duplicate Run', async () => {
        const before = {
            connected: connectionManager.isConnected,
            suspended: connectionManager.isSuspended,
            running: connectionManager.isScriptRunning,
            process: connectionManager.daemonProcess,
            pending: connectionManager._runStartPending,
            next: connectionManager._nextReqId
        };
        const commands = [];
        try {
            connectionManager.isConnected = true;
            connectionManager.isSuspended = false;
            connectionManager.isScriptRunning = false;
            connectionManager.daemonProcess = {
                stdin: { write(text, callback) { commands.push(JSON.parse(text)); callback?.(null); } }
            };
            const pending = connectionManager.runInTerminal('while True: pass');
            const duplicate = connectionManager.runInTerminal('print("second")');
            assert.strictEqual(pending, duplicate);
            assert.strictEqual(commands.length, 1);
            assert.strictEqual(commands[0].action, 'run_in_terminal');
            connectionManager._handleDaemonMessage(
                { type: 'run_started', success: true, id: commands[0].id },
                () => {}, () => {}, true
            );
            await pending;
            assert.strictEqual(connectionManager.isScriptRunning, true);
            await assert.rejects(
                () => connectionManager.runCodeSilently('print(1)'),
                /REPL is busy/
            );
            await assert.rejects(
                () => wsQueue.run(async () => {}, 'Read File', true),
                /MCU script is running/
            );
            connectionManager._handleDaemonMessage({ type: 'run_finished' },
                () => {}, () => {}, true);
            assert.strictEqual(connectionManager.isScriptRunning, false);
        } finally {
            if (connectionManager._runStartPending) {
                clearTimeout(connectionManager._runStartPending.timer);
            }
            connectionManager.isConnected = before.connected;
            connectionManager.isSuspended = before.suspended;
            connectionManager.isScriptRunning = before.running;
            connectionManager.daemonProcess = before.process;
            connectionManager._runStartPending = before.pending;
            connectionManager._nextReqId = before.next;
        }
    });

    test('an invalid or busy Run fails immediately with an explicit error', async () => {
        const before = {
            connected: connectionManager.isConnected,
            suspended: connectionManager.isSuspended,
            running: connectionManager.isScriptRunning,
            process: connectionManager.daemonProcess,
            pending: connectionManager._runStartPending
        };
        try {
            connectionManager.isConnected = true;
            connectionManager.isSuspended = false;
            connectionManager.isScriptRunning = false;
            let command;
            connectionManager.daemonProcess = {
                stdin: { write(text, cb) { command = JSON.parse(text); cb?.(null); } }
            };
            const pending = connectionManager.runInTerminal('print(1)');
            connectionManager._handleDaemonMessage({
                type: 'run_started', id: command.id, success: false, error: 'serial busy'
            }, () => {}, () => {}, true);
            await assert.rejects(pending, /serial busy/);
            assert.strictEqual(connectionManager.isScriptRunning, false);
        } finally {
            if (connectionManager._runStartPending) clearTimeout(connectionManager._runStartPending.timer);
            connectionManager.isConnected = before.connected;
            connectionManager.isSuspended = before.suspended;
            connectionManager.isScriptRunning = before.running;
            connectionManager.daemonProcess = before.process;
            connectionManager._runStartPending = before.pending;
        }
    });

    test('Stop does not silently reboot or compete for port ownership', () => {
        const stop = extension.slice(extension.indexOf('// Stop must interrupt the MCU'),
            extension.indexOf('    async function cpUploadFiles'));
        assert.ok(stop.includes("connectionManager.write(Buffer.from('\\r\\x03'))"));
        assert.ok(!stop.includes("executeCommand('micropython-ide.hardResetDevice')"));
        assert.ok(extension.includes("wsQueue.run(() => connectionManager.runInTerminal(code)"));
        assert.ok(daemon.includes('target=self._run_terminal_worker'));
        assert.ok(daemon.includes('self._stream_raw_execution()'));
        assert.ok(daemon.includes('self._event_lock'));
        assert.ok(terminal.includes("new StringDecoder('utf8')"));
    });
});
