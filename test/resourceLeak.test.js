const assert = require('assert');
const fs = require('fs');
const path = require('path');

suite('Resource leak regression', () => {
    test('wsQueue reuses one output channel instead of opening one per log line', () => {
        const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'wsQueue.js'), 'utf8');
        assert.ok(source.includes('let logChannel = null;'));
        assert.ok(source.includes('function getLogChannel()'));
        assert.ok(source.includes('getLogChannel().appendLine(msg)'));
        const creates = source.match(/createOutputChannel\('MicroPython IDE'\)/g) || [];
        assert.strictEqual(creates.length, 1);
    });

    test('debugger setup output channel is reused across upload attempts', () => {
        const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'mpyDebugger.js'), 'utf8');
        assert.ok(source.includes('let debugSetupOutputChannel = null;'));
        assert.ok(source.includes('function getDebugSetupOutputChannel()'));
        assert.ok(source.includes('const out = getDebugSetupOutputChannel();'));
        const creates = source.match(/createOutputChannel\('MPy Debugger Setup'\)/g) || [];
        assert.strictEqual(creates.length, 1);
    });

    test('connection and port detection logging reuse channels', () => {
        const cm = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'connectionManager.js'), 'utf8');
        const rs = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'refreshSettings.js'), 'utf8');

        assert.ok(cm.includes('function getOutputChannel()'));
        assert.ok(cm.includes('getOutputChannel().appendLine(msg)'));
        assert.strictEqual((cm.match(/createOutputChannel\('MicroPython IDE'\)/g) || []).length, 1);

        assert.ok(rs.includes('function getOutputChannel()'));
        assert.ok(rs.includes('getOutputChannel().appendLine'));
        assert.strictEqual((rs.match(/createOutputChannel\('MicroPython IDE'\)/g) || []).length, 1);
    });

    test('subprocess helpers reuse the extension-wide output channel', () => {
        const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'extension.js'), 'utf8');
        assert.ok(source.includes("const outputChannel = vscode.window.createOutputChannel('MicroPython IDE');"));
        assert.ok(!source.includes("createOutputChannel('MicroPython Studio')"));
        assert.ok(source.includes('const channel = outputChannel;'));
    });
});
