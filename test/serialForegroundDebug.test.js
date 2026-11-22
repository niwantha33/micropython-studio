'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const singleton = require('../src/connectionManager');
const Manager = Object.getPrototypeOf(singleton).constructor;
const { getDebugExecutionState, setDebugExecutionState, onDebugExecutionState } =
    require('../src/debugExecutionState');

suite('Serial foreground output and native-debug pause safety', () => {
    let manager, sent;

    setup(() => {
        manager = new Manager();
        manager.isConnected = true;
        manager.portName = 'COM7';
        sent = [];
        manager.daemonProcess = {
            stdin: {
                write(value, callback) {
                    sent.push(JSON.parse(value));
                    if (callback) callback(null);
                }
            }
        };
    });

    teardown(() => {
        manager._rejectForegroundStart(new Error('Test cleanup'));
        setDebugExecutionState({ status: 'detached' });
    });

    test('Run MCU returns a start acknowledgement while script is still executing', async () => {
        const promise = manager.runInTerminal('while True: print(1)');
        assert.strictEqual(sent.length, 1);
        assert.strictEqual(sent[0].action, 'run_in_terminal');
        assert.strictEqual(manager.isScriptRunning, false);
        assert.ok(manager._foregroundPending);
        manager._handleDaemonMessage({ type: 'terminal_run_started' }, () => {}, () => {}, true);
        await promise;
        assert.strictEqual(manager.isScriptRunning, true);
        await assert.rejects(manager.runCodeSilently('gc.collect()'), /MCU program is running/);
        await assert.rejects(manager.runInTerminal('print(2)'), /already running/);
        await manager.write(Buffer.from([3]));
        assert.strictEqual(sent[1].action, 'terminal_input');
        assert.strictEqual(Buffer.from(sent[1].data, 'base64')[0], 3);
        manager._handleDaemonMessage({
            type: 'terminal_run_finished', success: true
        }, () => {}, () => {}, true);
        assert.strictEqual(manager.isScriptRunning, false);
    });

    test('failed start is reported, never silently shown as running', async () => {
        const request = manager.runInTerminal('print(1)');
        manager._handleDaemonMessage({
            type: 'terminal_run_finished', success: false,
            error: 'Cannot enter raw REPL'
        }, () => {}, () => {}, true);
        await assert.rejects(request, /Cannot enter raw REPL/);
        assert.strictEqual(manager.isScriptRunning, false);
        assert.strictEqual(manager._foregroundPending, null);
    });

    test('busy suspend request fails immediately without a false suspended state', async () => {
        const request = manager.suspend();
        assert.strictEqual(sent[0].action, 'suspend');
        manager._handleDaemonMessage({
            type: 'transition_error', action: 'suspend',
            message: 'Foreground MCU script running'
        }, () => {}, () => {}, true);
        await assert.rejects(request, /Foreground MCU script running/);
        assert.strictEqual(manager.isSuspended, false);
    });

    test('debug pause state informs shell and clears on detach', () => {
        const changes = [];
        const listener = onDebugExecutionState(value => changes.push(value));
        try {
            setDebugExecutionState({
                status: 'paused', debugPort: 'COM5', replPort: 'COM7',
                location: { path: 'main.py', line: 7 }
            });
            assert.strictEqual(getDebugExecutionState().status, 'paused');
            assert.strictEqual(getDebugExecutionState().location.line, 7);
            setDebugExecutionState({ status: 'running', debugPort: 'COM5', replPort: 'COM7' });
            assert.strictEqual(getDebugExecutionState().status, 'running');
            setDebugExecutionState({ status: 'detached' });
            assert.strictEqual(changes.at(-1).status, 'detached');
        } finally {
            listener.dispose();
        }
        const shell = fs.readFileSync(path.join(__dirname, '..', 'src', 'deviceTerminal.js'), 'utf8');
        assert.ok(shell.includes('No new print() output appears until Continue or Step'));
    });

    test('daemon must not use blocking raw-paste result for foreground MCU scripts', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'mpy_daemon.py'), 'utf8');
        const start = src.indexOf('elif action == "run_in_terminal"');
        const end = src.indexOf('elif action == "suspend"', start);
        const block = src.slice(start, end);
        assert.ok(block.includes('threading.Thread('));
        assert.ok(!block.includes('stdout, stderr = self.exec_raw_paste(code)'));
        assert.ok(src.includes('def _stream_raw_execution(self)'));
        assert.ok(src.includes('if foreground and b"\\x03" in data'));
    });
});
