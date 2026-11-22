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
            process: connectionManager.daemonProcess,
            scriptRunning: connectionManager.isScriptRunning
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
            // The new daemon worker must ACK an accepted foreground run;
            // a write to stdin alone is not enough to claim the MCU ran it.
            const started = connectionManager.runInTerminal('print(2)');
            assert.strictEqual(frames[1].action, 'run_in_terminal');
            assert.strictEqual(frames[1].code, 'print(2)');
            connectionManager._handleDaemonMessage(
                { type: 'terminal_run_started' }, () => {}, () => {}, true);
            await started;
            assert.strictEqual(connectionManager.isScriptRunning, true);
            connectionManager._handleDaemonMessage(
                { type: 'terminal_run_finished', success: true }, () => {}, () => {}, true);
        } finally {
            connectionManager.isConnected = original.connected;
            connectionManager.isSuspended = original.suspended;
            connectionManager.daemonProcess = original.process;
            connectionManager.isScriptRunning = original.scriptRunning;
        }
    });

    test('Hard Reset uses exclusive handoff, not an unsupported daemon action', () => {
        assert.ok(extensionSource.includes("'Hard Reset (exclusive handoff)'"));
        assert.ok(!extensionSource.includes('connectionManager.hardReset()'));
        assert.ok(extensionSource.includes("await wsQueue.run("));
        assert.ok(daemonSource.includes('_release_lock(self.port)'));
    });

    test('MCU execution does not outrun opening the REPL terminal', () => {
        const shellFirst = extensionSource.indexOf('await openDeviceTerminal(context, runPort);');
        const runNext = extensionSource.indexOf("await wsQueue.run(() => connectionManager.runInTerminal(code)");
        assert.ok(shellFirst > 0 && runNext > shellFirst,
            'The PTY/REPL must be ready before a short script can print');
        assert.ok(terminalSource.includes('await ready;'),
            'Opening a terminal must await VS Code PTY connection');
        assert.ok(terminalSource.includes('settleReady(err);'),
            'Failed serial connections must reject readiness, not silently succeed');
        assert.ok(terminalSource.includes('await connectionManager.connect(devicePort);'),
            'Reopening a disconnected terminal must actually reconnect');
    });

    test('COM case changes do not tear down the shared serial daemon', () => {
        const managerSource = fs.readFileSync(path.join(root, 'src', 'connectionManager.js'), 'utf8');
        assert.ok(managerSource.includes('samePort(this.portName, portName)'));
        assert.ok(managerSource.includes('samePort(this._connectingPort, portName)'));
        assert.ok(extensionSource.includes('samePort(connectionManager.portName, runPort)'));
    });

    test('CLI backend never kills other processes to seize COM ports', () => {
        const backend = fs.readFileSync(path.join(root, 'src', 'mps_backend.py'), 'utf8');
        assert.ok(!backend.includes('_kill_port_owner('));
        assert.ok(!backend.includes('_kill_comport_processes('));
        assert.ok(!backend.includes('taskkill'));
    });
});