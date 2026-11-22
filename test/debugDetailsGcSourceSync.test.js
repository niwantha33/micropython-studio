'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { comparePythonSource, isInsideProject } = require('../src/deviceSourceCheck');

suite('Studio debugger details, GC safety, on-device source validation', () => {
    const root = path.resolve(__dirname, '..');
    const read = name => fs.readFileSync(path.join(root, 'src', name), 'utf8');

    test('correctly detects stale /main.py versus local while True', () => {
        const oldDevice = Buffer.from('def fxn():\n    print("hello")\n');
        const editor = 'import time\ndef fxn():\n    while True:\n        print("hello")\n        time.sleep(1)\n';
        const result = comparePythonSource(editor, oldDevice);
        assert.strictEqual(result.same, false);
        assert.strictEqual(comparePythonSource(
            'def fxn():\r\n    return 5\r\n', 'def fxn():\n    return 5\n'
        ).same, true);
        assert.strictEqual(comparePythonSource(
            Buffer.from('print("old")\n'), Buffer.from('print("new")\n')
        ).same, false);
    });

    test('local file path must stay inside chosen project, not sibling', () => {
        const folder = path.join(process.cwd(), 'project');
        assert.strictEqual(isInsideProject(folder, path.join(folder, 'main', 'main.py')), true);
        assert.strictEqual(isInsideProject(folder, path.join(folder, '..', 'other', 'main.py')), false);
        assert.strictEqual(isInsideProject(folder, folder), false);
    });

    test('explicit source check reads back MCU file before claiming successful upload', () => {
        const ext = read('extension.js');
        assert.ok(ext.includes("registerCommand('micropython-ide.verifyDeviceMain'"));
        assert.ok(ext.includes("connectionManager.catFile('/main.py')"));
        assert.ok(ext.includes("await wsQueue.run("));
        assert.ok(ext.includes("'Compare Code'"));
        assert.ok(ext.includes("'Upload Local main.py'"));
        assert.ok(ext.includes("'Show Device Copy'"));
        assert.ok(ext.includes("comparePythonSource(diskSource, updated).same"));
        assert.ok(ext.includes("sys.modules.pop"));
        assert.ok(ext.includes('Check MCU Code'));
        const verifier = ext.slice(
            ext.indexOf("registerCommand('micropython-ide.verifyDeviceMain'"),
            ext.indexOf("registerCommand('micropython-ide.openMemoryAnalyzer'")
        );
        assert.ok(verifier.indexOf("'Upload Local main.py'") <
            verifier.indexOf("'micropython-ide.uploadFileToDevice'"));
    });

    test('original detailed debugger can reopen beside the editor without restarting CDC bridge', () => {
        const dbg = read('mpyDebugger.js');
        const ext = read('extension.js');
        assert.ok(dbg.includes('function createNativeDetailPanel'));
        assert.ok(dbg.includes('result.reveal();'));
        assert.ok(dbg.includes('function showDebuggerDetails()'));
        assert.ok(dbg.includes('view = vscode.window.createWebviewPanel('));
        assert.ok(dbg.includes('vscode.ViewColumn.Beside'));
        assert.ok(dbg.includes('session.dispose()'));
        assert.strictEqual((dbg.match(/bridge = spawn\(pyCmd/g) || []).length, 1);
        assert.ok(ext.includes("'micropython-ide.showDebuggerDetails'"));
    });

    test('Memory and GC probe uses explicit consent and waits for debug release', () => {
        const mem = read('memoryAnalyzer.js');
        assert.ok(mem.includes('async function stopDebugSessionSafely(session)'));
        assert.ok(mem.includes('vscode.debug.onDidTerminateDebugSession'));
        assert.ok(mem.includes('await vscode.debug.stopDebugging(session)'));
        assert.ok(mem.includes('await ended;'));
        assert.ok(mem.includes("choice !== action"));
        assert.ok(mem.includes("this.status('Memory probe cancelled."));
        assert.ok(mem.includes('connectionManager.runCodeSilently(buildProbeScript(collect))'));
        assert.ok(mem.includes('vscode.postMessage({op:"ready"})'));
        assert.ok(mem.includes('message.op === \'ready\''));
        assert.ok(mem.includes('Manual GC changes the MCU heap'));
        assert.ok(mem.indexOf('await stopDebugSessionSafely(session)') <
            mem.indexOf('connectionManager.runCodeSilently(buildProbeScript(collect))'));
    });

    test('manifest exposes source verification and companion debugger panel commands', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        const commands = manifest.contributes.commands.map(command => command.command);
        assert.ok(commands.includes('micropython-ide.verifyDeviceMain'));
        assert.ok(commands.includes('micropython-ide.showDebuggerDetails'));
    });
});
